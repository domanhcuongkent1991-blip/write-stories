import { randomUUID } from "node:crypto";
import type { AuditIssue, AuditProvenance, AuditResult } from "../agents/continuity.js";
import type { ReviseMode, ReviseOutput } from "../agents/reviser.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import type { ChapterIntent, ChapterMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import type { LengthSpec } from "../models/length-governance.js";
import { countChapterLength, isOutsideHardRange } from "../utils/length-metrics.js";
import { computeChapterContentHash, type AuditReAuditTelemetry } from "../audit/chapter-audit-evaluator.js";
import type { ChapterAuditEvaluation } from "../audit/chapter-audit-evaluator.js";
import { decideAudit, evaluateRevisionCandidate } from "../audit/audit-policy.js";
import { toAuditIssuesFromSurface, validateVietnameseSurface } from "../agents/vietnamese-surface-validator.js";
import { createAuditRun, type AuditRunV1 } from "../audit/audit-run.js";
import {
  applyVietnameseLocalRepair,
  type LocalRepairTelemetry,
} from "../utils/vietnamese-local-repair.js";
import {
  buildCandidateRejectionEvidence,
  type CandidateRejectionEvidence,
} from "./candidate-rejection-evidence.js";
import { runWithProviderCallStage } from "../llm/provider-call-telemetry.js";

export interface ChapterReviewCycleUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChapterReviewCycleControlInput {
  readonly chapterIntent: string;
  readonly chapterMemo?: ChapterMemo;
  readonly chapterIntentData?: ChapterIntent;
  readonly contextPackage: ContextPackage;
  readonly ruleStack: RuleStack;
}

export interface ChapterReviewCycleResult {
  readonly finalContent: string;
  readonly finalWordCount: number;
  readonly preAuditWordCount: number;
  readonly revised: boolean;
  readonly auditResult: AuditResult;
  readonly totalUsage: ChapterReviewCycleUsage;
  readonly postReviseCount: number;
  readonly repairApplied: boolean;
  readonly revisionAttempts?: number;
  readonly auditRuns?: ReadonlyArray<AuditRunV1>;
  readonly reviserTokenUsage?: ChapterReviewCycleUsage;
  readonly auditorTokenUsage?: ChapterReviewCycleUsage;
  readonly localRepair?: LocalRepairTelemetry;
}

const DEFAULT_MAX_REVIEW_ITERATIONS = 1;
// Hard ceiling so a configured retry budget can never run away; must be >=
// the default CLI writing.reviewRetries (2) for the configured budget to apply.
const MAX_REVIEW_ITERATIONS_CAP = 2;
const VIETNAMESE_SPELLING_SIGNAL_RE = /(?:vietnamese spelling|spelling|typo|orthograph|chính tả|lỗi\s+(?:lặp từ\s+)?đánh máy|đánh máy)/iu;

function bindVietnameseAuditorSpellingFindings(
  content: string,
  issues: ReadonlyArray<AuditIssue>,
): { readonly findings: ReadonlyArray<AuditIssue>; readonly invalid: boolean } {
  const findings: AuditIssue[] = [];
  let invalid = false;

  for (const issue of issues) {
    const signal = `${issue.ruleId ?? ""} ${issue.category} ${issue.description}`;
    if (!VIETNAMESE_SPELLING_SIGNAL_RE.test(signal)) continue;
    // The auditor claims a spelling error only at warning/critical severity
    // with an exact-replacement hint. An informational "nothing found" line
    // is commentary, not a claim, and must not invalidate the binding.
    if (issue.severity === "info" && !issue.repairHint) continue;

    const hint = issue.repairHint;
    if (!hint || hint.kind !== "exact-replacement" || hint.targetText === hint.replacementText) {
      invalid = true;
      continue;
    }

    const occurrenceOffsets: number[] = [];
    let from = 0;
    while (true) {
      const offset = content.indexOf(hint.targetText, from);
      if (offset < 0) break;
      occurrenceOffsets.push(offset);
      from = offset + hint.targetText.length;
    }
    if (
      occurrenceOffsets.length === 0
      || hint.occurrenceIndexes.some((index) => index < 1 || index > occurrenceOffsets.length)
    ) {
      invalid = true;
      continue;
    }

    const firstOffset = occurrenceOffsets[hint.occurrenceIndexes[0]! - 1]!;
    const contextStart = Math.max(0, firstOffset - 40);
    const contextEnd = Math.min(content.length, firstOffset + hint.targetText.length + 40);
    findings.push({
      ...issue,
      severity: "critical",
      category: "vi-known-spelling",
      ruleId: "vi-auditor-spelling",
      repairScope: "local",
      repairTarget: "prose",
      verification: "verified",
      evidence: {
        ...issue.evidence,
        contentHash: computeChapterContentHash(content),
      },
      repairHint: {
        ...hint,
        context: content.slice(contextStart, contextEnd),
      },
    });
  }

  return { findings, invalid };
}

function asEvaluation(result: AuditResult, content: string): ChapterAuditEvaluation {
  const decision = result.decision ?? (result.passed ? "pass" : "fail");
  return {
    decision,
    passed: decision === "pass",
    findings: result.issues,
    parseFailed: result.parseFailed === true,
    parseFailedReason: result.parseFailedReason,
    overallScore: result.overallScore,
    contentHash: result.contentHash ?? computeChapterContentHash(content),
    tokenUsage: result.tokenUsage,
    provenance: result.provenance,
  };
}

interface ReviewSnapshot {
  readonly content: string;
  readonly wordCount: number;
  readonly auditResult: AuditResult;
  readonly score: number;
  readonly lengthInRange: boolean;
}

export interface RevisionCandidateSettlement {
  readonly valid: boolean;
  readonly rejectionReason?: string;
  readonly rejectionEvidence?: CandidateRejectionEvidence;
  /** Deterministic/state findings computed from the exact settled candidate truth. */
  readonly stateFindings?: ReadonlyArray<AuditIssue>;
  readonly truthFileOverrides?: {
    readonly currentState?: string;
    readonly ledger?: string;
    readonly hooks?: string;
  };
}

export async function runChapterReviewCycle(params: {
  readonly book: Pick<{ genre: string }, "genre">;
  readonly bookDir: string;
  readonly bookId?: string;
  readonly chapterNumber: number;
  readonly initialOutput: Pick<WriteChapterOutput, "content" | "wordCount" | "postWriteErrors">;
  readonly reducedControlInput?: ChapterReviewCycleControlInput;
  readonly lengthSpec: LengthSpec;
  readonly initialUsage: ChapterReviewCycleUsage;
  readonly initialStateFindings?: ReadonlyArray<AuditIssue>;
  readonly initialTruthFileOverrides?: RevisionCandidateSettlement["truthFileOverrides"];
  readonly createReviser: () => {
    reviseChapter: (
      bookDir: string,
      chapterContent: string,
      chapterNumber: number,
      issues: ReadonlyArray<AuditIssue>,
      mode?: ReviseMode,
      genre?: string,
      options?: {
        chapterIntent?: string;
        chapterMemo?: ChapterMemo;
        chapterIntentData?: ChapterIntent;
        contextPackage?: ContextPackage;
        ruleStack?: RuleStack;
        lengthSpec?: LengthSpec;
      },
    ) => Promise<ReviseOutput>;
  };
  readonly auditor: {
    auditChapter: (
      bookDir: string,
      chapterContent: string,
      chapterNumber: number,
      genre?: string,
      options?: {
        temperature?: number;
        chapterIntent?: string;
        chapterMemo?: ChapterMemo;
        contextPackage?: ContextPackage;
        ruleStack?: RuleStack;
        truthFileOverrides?: RevisionCandidateSettlement["truthFileOverrides"];
      },
    ) => Promise<AuditResult>;
  };
  readonly normalizePostWriteSurface?: (chapterContent: string) => string;
  readonly assertChapterContentNotEmpty: (content: string, stage: string) => void;
  readonly addUsage: (
    left: ChapterReviewCycleUsage,
    right?: ChapterReviewCycleUsage,
  ) => ChapterReviewCycleUsage;
  readonly analyzeAITells: (content: string) => { issues: ReadonlyArray<AuditIssue> };
  readonly analyzeSensitiveWords: (content: string) => {
    found: ReadonlyArray<{ severity: string }>;
    issues: ReadonlyArray<AuditIssue>;
  };
  /** Re-run deterministic post-write checks (chapter-ref, paragraph shape, etc.) on any content. */
  readonly runPostWriteChecks?: (content: string) => ReadonlyArray<AuditIssue>;
  readonly maxReviewIterations?: number;
  readonly autoRevisionAllowed?: boolean;
  /** Opt-in score-fail repair floor forwarded to the audit policy. */
  readonly scoreRepairFloorScore?: number;
  readonly operationId?: string;
  readonly attemptId?: string;
  readonly settleRevisionCandidate?: (
    normalizedContent: string,
    output: ReviseOutput,
  ) => RevisionCandidateSettlement | Promise<RevisionCandidateSettlement>;
  readonly retainRejectedCandidate?: (input: {
    readonly content: string;
    readonly contentHash: string;
    readonly wordCount: number;
    readonly reason: string;
    readonly rejectionEvidence: CandidateRejectionEvidence;
  }) => void | Promise<void>;
  /** @deprecated Use settleRevisionCandidate so post-audit can bind to candidate truth. */
  readonly stateSettlementValid?: (output: ReviseOutput) => boolean | Promise<boolean>;
  readonly logWarn: (message: { zh: string; en: string }) => void;
  readonly logStage: (message: { zh: string; en: string }) => void;
}): Promise<ChapterReviewCycleResult> {
  let totalUsage = params.initialUsage;
  let reviserTokenUsage: ChapterReviewCycleUsage | undefined;
  let auditorTokenUsage: ChapterReviewCycleUsage | undefined;
  let finalContent = params.normalizePostWriteSurface?.(params.initialOutput.content)
    ?? params.initialOutput.content;
  let finalWordCount = countChapterLength(finalContent, params.lengthSpec.countingMode);
  // The working draft each repair iteration edits. It diverges from
  // finalContent (the durable canonical chapter) until a candidate passes the
  // shared acceptance gate; rejected interim results roll forward as the base
  // for the next iteration while the canonical chapter stays untouched.
  let workingContent = finalContent;
  const preAuditWordCount = finalWordCount;
  let assessmentCount = 0;
  const auditRunOperationId = params.operationId ?? randomUUID();
  const auditRunAttemptId = params.attemptId ?? randomUUID();
  const auditAssessments: Array<{ content: string; auditResult: AuditResult }> = [];
  let revisionAttempts = 0;
  let revisionCandidateProduced = false;
  let revisionCandidateIdentity: {
    readonly candidateContentHash: string;
    readonly candidateWordCount: number;
  } | undefined;
  let revisionRejectionReason: string | undefined;
  let localRepair: LocalRepairTelemetry | undefined;

  // Convert initial postWriteErrors into AuditIssues as fallback when runPostWriteChecks isn't provided.
  const initialPostWriteIssues: ReadonlyArray<AuditIssue> = toAuditIssuesFromSurface(
    params.initialOutput.postWriteErrors,
  );

  params.assertChapterContentNotEmpty(finalContent, "draft generation");

  // ---------------------------------------------------------------------------
  // Helper: assess a chapter (audit + deterministic checks + length + score)
  // ---------------------------------------------------------------------------
  const assess = async (
    content: string,
    options?: {
      temperature?: number;
      stateFindings?: ReadonlyArray<AuditIssue>;
      truthFileOverrides?: RevisionCandidateSettlement["truthFileOverrides"];
    },
  ): Promise<{ auditResult: AuditResult; score: number; lengthInRange: boolean }> => {
    const provenance: AuditProvenance = {
      source: "pipeline-runner",
      operationId: auditRunOperationId,
      attemptId: auditRunAttemptId,
      phase: assessmentCount === 0 ? "initial" : "post-revision",
    };
    const rawLlmAudit = await runWithProviderCallStage(
      assessmentCount === 0 ? "initial-auditor" : "post-candidate-auditor",
      () => params.auditor.auditChapter(
        params.bookDir,
        content,
        params.chapterNumber,
        params.book.genre,
        params.reducedControlInput
          ? { ...params.reducedControlInput, ...(options ?? {}) }
          : options,
      ),
    );
    const spellingBinding = params.lengthSpec.countingMode === "vi_wordlike_tokens_v1"
      ? bindVietnameseAuditorSpellingFindings(content, rawLlmAudit.issues)
      : { findings: [] as ReadonlyArray<AuditIssue>, invalid: false };
    let llmAudit: AuditResult = spellingBinding.invalid
      ? {
          ...rawLlmAudit,
          passed: false,
          parseFailed: true,
          parseFailedReason: "spelling-binding-invalid",
          summary: `${rawLlmAudit.summary} Vietnamese spelling finding lacked a valid exact content binding.`.trim(),
        }
      : rawLlmAudit;
    totalUsage = params.addUsage(totalUsage, llmAudit.tokenUsage);
    if (llmAudit.tokenUsage) {
      auditorTokenUsage = params.addUsage(
        auditorTokenUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        llmAudit.tokenUsage,
      );
    }
    // One bounded in-run re-audit: a full second audit attempt when the first
    // could not be parsed or bound. The verdict-repair inside auditChapter is
    // format recovery only; this re-issues the audit itself. Fail-closed is
    // preserved — if the re-audit also fails to parse, its fail-closed result
    // stands.
    let reAudit: AuditReAuditTelemetry | undefined;
    if (llmAudit.parseFailed === true) {
      const reAuditRaw = await runWithProviderCallStage(
        "re-audit",
        () => params.auditor.auditChapter(
          params.bookDir,
          content,
          params.chapterNumber,
          params.book.genre,
          params.reducedControlInput
            ? { ...params.reducedControlInput, ...(options ?? {}) }
            : options,
        ),
      );
      const reAuditSpelling = params.lengthSpec.countingMode === "vi_wordlike_tokens_v1"
        ? bindVietnameseAuditorSpellingFindings(content, reAuditRaw.issues)
        : { findings: [] as ReadonlyArray<AuditIssue>, invalid: false };
      const reAuditLlm: AuditResult = reAuditSpelling.invalid
        ? {
            ...reAuditRaw,
            passed: false,
            parseFailed: true,
            parseFailedReason: "spelling-binding-invalid",
            summary: `${reAuditRaw.summary} Vietnamese spelling finding lacked a valid exact content binding.`.trim(),
          }
        : reAuditRaw;
      totalUsage = params.addUsage(totalUsage, reAuditLlm.tokenUsage);
      if (reAuditLlm.tokenUsage) {
        auditorTokenUsage = params.addUsage(
          auditorTokenUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          reAuditLlm.tokenUsage,
        );
      }
      reAudit = {
        attempted: true,
        priorParseFailedReason: llmAudit.parseFailedReason ?? "unparseable-output",
      };
      llmAudit = { ...reAuditLlm, reAudit };
    }
    const aiTellsResult = params.analyzeAITells(content);
    const sensitiveResult = params.analyzeSensitiveWords(content);
    const hasBlockedWords = sensitiveResult.found.some((item) => item.severity === "block");
    const wordCount = countChapterLength(content, params.lengthSpec.countingMode);
    const lengthInRange = !isOutsideHardRange(wordCount, params.lengthSpec);
    // Deterministic post-write checks: run every round, not just the first.
    // If runPostWriteChecks is provided, use it; otherwise fall back to initial postWriteErrors.
    const postWriteIssues = params.runPostWriteChecks
      ? params.runPostWriteChecks(content)
      : initialPostWriteIssues;

    const deterministicFindings = [
      ...aiTellsResult.issues,
      ...sensitiveResult.issues,
      ...postWriteIssues,
      ...(llmAudit.hostFindings ?? []),
      ...spellingBinding.findings,
    ]
      .map((issue) => issue.repairTarget ? issue : { ...issue, repairTarget: "prose" as const });
    const evaluation = decideAudit({
      content,
      lengthSpec: params.lengthSpec,
      llmAudit,
      deterministicFindings,
      stateFindings: options?.stateFindings ?? [],
      operation: assessmentCount === 0 ? "audit" : "re-audit",
      revisionAttempts,
      maxRevisionAttempts: 1,
      autoRevisionAllowed: params.autoRevisionAllowed ?? true,
      provenance,
    }, {
      operation: assessmentCount === 0 ? "audit" : "re-audit",
      autoRevisionAllowed: params.autoRevisionAllowed ?? true,
      revisionAttempts,
      maxRevisionAttempts: 1,
      ...(params.scoreRepairFloorScore !== undefined
        ? { scoreRepairFloorScore: params.scoreRepairFloorScore }
        : {}),
    });
    assessmentCount += 1;
    const auditResult: AuditResult = {
      ...llmAudit,
      passed: evaluation.passed,
      issues: evaluation.findings,
      summary: llmAudit.summary,
      parseFailed: llmAudit.parseFailed,
      parseFailedReason: llmAudit.parseFailedReason,
      reAudit: llmAudit.reAudit,
      overallScore: evaluation.overallScore,
      tokenUsage: llmAudit.tokenUsage,
      decision: evaluation.decision,
      contentHash: evaluation.contentHash,
      provenance: evaluation.provenance,
    };
    auditAssessments.push({ content, auditResult });

    const score = evaluation.overallScore ?? 0;

    return { auditResult, score, lengthInRange };
  };

  const isPassed = (assessment: { auditResult: AuditResult; score: number; lengthInRange: boolean }): boolean =>
    assessment.auditResult.decision === "pass"
    && assessment.auditResult.passed
    && assessment.lengthInRange;

  // ---------------------------------------------------------------------------
  // Scoring loop: assess → revise → assess. Quality repair is hard-bounded by
  // MAX_REVIEW_ITERATIONS_CAP; legacy retry configuration is parse-only input.
  // ---------------------------------------------------------------------------
  const maxReviewIterations = params.autoRevisionAllowed === false
    ? 0
    : Math.min(MAX_REVIEW_ITERATIONS_CAP, Math.max(0, Math.floor(params.maxReviewIterations ?? DEFAULT_MAX_REVIEW_ITERATIONS)));
  params.logStage({ zh: "审计草稿", en: "auditing draft" });
  const initial = await assess(finalContent, {
    stateFindings: params.initialStateFindings,
    truthFileOverrides: params.initialTruthFileOverrides,
  });

  const filterRepairIssues = (issues: ReadonlyArray<AuditIssue>): ReadonlyArray<AuditIssue> => {
    // Preferred-range drift is telemetry only. Passing it to the reviser can
    // turn an exact local repair into an unnecessary full-chapter rewrite.
    const actionableIssues = issues.filter((issue) => issue.ruleId !== "length.soft-range");
    const hasLocalHardLength = actionableIssues.some((issue) => issue.ruleId === "length.hard-range" && issue.verification === "verified");
    if (!hasLocalHardLength) return actionableIssues;
    return actionableIssues.filter((issue) => !(issue.source === "llm" && /length|字数|长度|word|độ dài|số từ|word count/i.test(`${issue.category} ${issue.description}`)));
  };

  const snapshots: ReviewSnapshot[] = [{
    content: finalContent,
    wordCount: finalWordCount,
    auditResult: initial.auditResult,
    score: initial.score,
    lengthInRange: initial.lengthInRange,
  }];

  let currentAudit = initial;
  let postReviseCount = 0;

  const buildAuditRuns = (): ReadonlyArray<AuditRunV1> => {
    if (!params.bookId || auditAssessments.length === 0) return [];
    const now = new Date().toISOString();
    const runs: AuditRunV1[] = [];
    const initial = auditAssessments[0]!;
    const initialEvaluation = asEvaluation(initial.auditResult, initial.content);
    const candidate = auditAssessments[1];
    runs.push(createAuditRun({
      bookId: params.bookId,
      chapterNumber: params.chapterNumber,
      operation: "write",
      phase: "initial",
      contentHash: initialEvaluation.contentHash,
      evaluation: initialEvaluation,
      length: {
        count: countChapterLength(initial.content, params.lengthSpec.countingMode),
        countingMode: params.lengthSpec.countingMode,
        target: params.lengthSpec.target,
        softMin: params.lengthSpec.softMin,
        softMax: params.lengthSpec.softMax,
        hardMin: params.lengthSpec.hardMin,
        hardMax: params.lengthSpec.hardMax,
      },
      startedAt: now,
      completedAt: now,
      durationMs: 0,
      operationId: auditRunOperationId,
      attemptId: auditRunAttemptId,
      canonicalCommitOutcome: candidate && finalContent !== initial.content ? "superseded" : "terminal-commit",
      revision: {
        attempted: revisionAttempts > 0,
        candidateProduced: revisionCandidateProduced,
        ...(candidate
          ? {
              candidateContentHash: asEvaluation(candidate.auditResult, candidate.content).contentHash,
              candidateWordCount: countChapterLength(candidate.content, params.lengthSpec.countingMode),
            }
          : revisionCandidateIdentity),
        accepted: Boolean(candidate && finalContent === candidate.content),
        ...(revisionRejectionReason ? { rejectionReason: revisionRejectionReason } : {}),
      },
      localRepair,
    }));
    if (candidate) {
      const candidateEvaluation = asEvaluation(candidate.auditResult, candidate.content);
      runs.push(createAuditRun({
        bookId: params.bookId,
        chapterNumber: params.chapterNumber,
        operation: "revise",
        phase: "post-revision",
        contentHash: candidateEvaluation.contentHash,
        evaluation: candidateEvaluation,
        length: {
          count: countChapterLength(candidate.content, params.lengthSpec.countingMode),
          countingMode: params.lengthSpec.countingMode,
          target: params.lengthSpec.target,
          softMin: params.lengthSpec.softMin,
          softMax: params.lengthSpec.softMax,
          hardMin: params.lengthSpec.hardMin,
          hardMax: params.lengthSpec.hardMax,
        },
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        operationId: auditRunOperationId,
        attemptId: auditRunAttemptId,
        canonicalCommitOutcome: finalContent === candidate.content ? "terminal-commit" : "rejected",
        revision: {
          attempted: true,
          candidateProduced: true,
          candidateContentHash: candidateEvaluation.contentHash,
          candidateWordCount: countChapterLength(candidate.content, params.lengthSpec.countingMode),
          accepted: finalContent === candidate.content,
          ...(finalContent !== candidate.content
            ? { rejectionReason: revisionRejectionReason ?? "candidate rejected by shared acceptance gate" }
            : {}),
        },
        localRepair,
      }));
    }
    return runs;
  };

  if (initial.auditResult.parseFailed) {
    params.logWarn({
      zh: "审稿输出解析失败，跳过自动修稿以避免误改正文",
      en: "Audit output parsing failed; skipping automatic repair to avoid rewriting valid prose from an unreliable audit.",
    });
    return {
      finalContent,
      finalWordCount,
      preAuditWordCount,
      revised: false,
      auditResult: initial.auditResult,
      totalUsage,
      postReviseCount,
      repairApplied: false,
      revisionAttempts,
      auditRuns: buildAuditRuns(),
      ...(reviserTokenUsage ? { reviserTokenUsage } : {}),
      ...(auditorTokenUsage ? { auditorTokenUsage } : {}),
      ...(localRepair ? { localRepair } : {}),
    };
  }

  if (initial.auditResult.decision === "repair-required") {
    for (let iteration = 0; iteration < maxReviewIterations; iteration++) {
      params.logStage({
        zh: `修复轮次 ${iteration + 1}/${maxReviewIterations}（当前 ${currentAudit.score} 分）`,
        en: `repair iteration ${iteration + 1}/${maxReviewIterations} (current score: ${currentAudit.score})`,
      });

      const repairIssues = filterRepairIssues(currentAudit.auditResult.issues);
      const localRepairResult = params.lengthSpec.countingMode === "vi_wordlike_tokens_v1"
        ? applyVietnameseLocalRepair(workingContent, repairIssues)
        : undefined;
      if (localRepairResult?.kind === "rejected") {
        localRepair = localRepairResult.telemetry;
        revisionRejectionReason = `deterministic local repair rejected: ${localRepairResult.code}`;
        params.logWarn({
          zh: "确定性拼写修复无法安全应用，保留原章节",
          en: "Deterministic spelling repair could not be applied safely; retaining the canonical chapter.",
        });
        break;
      }

      const localBaseContent = localRepairResult?.kind === "applied"
        ? localRepairResult.content
        : workingContent;
      if (localRepairResult?.kind === "applied") {
        localRepair = localRepairResult.telemetry;
      }
      const structuralIssues = repairIssues.filter((issue) => {
        const isAppliedLocalSpelling = localRepairResult?.kind === "applied"
          && issue.repairHint?.kind === "exact-replacement"
          && VIETNAMESE_SPELLING_SIGNAL_RE.test(
            `${issue.ruleId ?? ""} ${issue.category} ${issue.description}`,
          );
        return !isAppliedLocalSpelling
          && issue.repairTarget !== "runtime-state"
          && issue.repairTarget !== "next-plan";
      });

      let reviseOutput: ReviseOutput;
      if (structuralIssues.length === 0 && localRepairResult?.kind === "applied") {
        reviseOutput = {
          revisedContent: localBaseContent,
          wordCount: countChapterLength(localBaseContent, params.lengthSpec.countingMode),
          fixedIssues: [...localRepairResult.fixedFindingIds],
          repairKind: "deterministic-exact",
        };
      } else if (structuralIssues.length > 0) {
        const reviser = params.createReviser();
        revisionAttempts += 1;
        const structuralOutput = await runWithProviderCallStage(
          "structural-revision",
          () => reviser.reviseChapter(
            params.bookDir,
            localBaseContent,
            params.chapterNumber,
            structuralIssues,
            "auto",
            params.book.genre,
            { ...params.reducedControlInput, lengthSpec: params.lengthSpec },
          ),
        );
        reviseOutput = { ...structuralOutput, repairKind: "llm-structural" };
        totalUsage = params.addUsage(totalUsage, reviseOutput.tokenUsage);
        if (reviseOutput.tokenUsage) {
          reviserTokenUsage = params.addUsage(
            reviserTokenUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            reviseOutput.tokenUsage,
          );
        }
      } else {
        revisionRejectionReason = "no prose repair is safe for the remaining state blocker";
        params.logWarn({
          zh: "剩余阻断项属于运行时状态，不能作为正文修订指令",
          en: "Remaining blockers belong to runtime state and cannot be sent as prose revision instructions.",
        });
        break;
      }

      let revisedContent = params.normalizePostWriteSurface?.(reviseOutput.revisedContent)
        ?? reviseOutput.revisedContent;
      revisionCandidateProduced = revisedContent.length > 0 && revisedContent !== workingContent;
      if (!revisionCandidateProduced) {
        revisionRejectionReason = revisedContent.length === 0
          ? "revision candidate was empty"
          : "revision candidate was unchanged";
        params.logWarn({
          zh: `修复轮次 ${iteration + 1} 未产出新内容，退出循环`,
          en: `repair iteration ${iteration + 1} produced no new content, exiting loop`,
        });
        break;
      }

      // Output-language guard. A reviser that answered in another language is
      // not a repair candidate: settling it, auditing it, or rolling it forward
      // as the next base only burns provider budget and lets its
      // vi-output-language-mismatch findings be written to index.json as if they
      // described the canonical chapter. The canonical draft already cleared the
      // writer post-write gate, so this guard judges candidates only.
      const outputLanguageViolations = params.lengthSpec.countingMode === "vi_wordlike_tokens_v1"
        ? validateVietnameseSurface(revisedContent)
          .filter((violation) => violation.rule === "vi-output-language-mismatch")
        : [];
      if (outputLanguageViolations.length > 0) {
        revisionRejectionReason = "candidate rejected: output language is not Vietnamese";
        params.logWarn({
          zh: "修复候选并非越南语，直接丢弃，不进入结算与审稿，保留原章节",
          en: "Revision candidate is not Vietnamese; discarded before settlement and audit, keeping the canonical chapter.",
        });
        await params.retainRejectedCandidate?.({
          content: revisedContent,
          contentHash: computeChapterContentHash(revisedContent),
          wordCount: countChapterLength(revisedContent, params.lengthSpec.countingMode),
          reason: revisionRejectionReason,
          rejectionEvidence: buildCandidateRejectionEvidence({
            rejectionCode: "audit-failed",
            ownerClass: "AUDIT",
            findings: toAuditIssuesFromSurface(outputLanguageViolations).map((issue) => ({
              ...issue,
              // decideAudit is fail-closed on a critical finding with no
              // repairTarget, so the language blocker must carry one.
              repairTarget: issue.repairTarget ?? "prose",
            })),
            fallbackDescription: revisionRejectionReason,
          }),
        });

        if (iteration + 1 >= maxReviewIterations) break;
        // workingContent and currentAudit stay on the canonical chapter: the next
        // iteration must retry the repair from canonical, not from this draft.
        continue;
      }

      revisionCandidateIdentity = {
        candidateContentHash: computeChapterContentHash(revisedContent),
        candidateWordCount: countChapterLength(revisedContent, params.lengthSpec.countingMode),
      };

      params.assertChapterContentNotEmpty(revisedContent, `repair iteration ${iteration + 1}`);
      let candidateWordCount = revisionCandidateIdentity.candidateWordCount;
      const canonicalWordCount = countChapterLength(workingContent, params.lengthSpec.countingMode);
      let candidateInHardRange = !isOutsideHardRange(candidateWordCount, params.lengthSpec);
      // An overlong canonical draft must move back into the hard range before
      // we spend state-settlement and re-audit budget on it. Rejecting a
      // non-reducing or still-overlong candidate here keeps the durable
      // chapter unchanged and makes the failure reason explicit.
      if (
        params.lengthSpec.countingMode === "vi_wordlike_tokens_v1"
        && canonicalWordCount > params.lengthSpec.hardMax
        && (!candidateInHardRange || candidateWordCount >= canonicalWordCount)
      ) {
        revisionRejectionReason = !candidateInHardRange
          ? `revision candidate remains outside the hard length range (${candidateWordCount})`
          : `revision candidate did not reduce the overlong draft (${candidateWordCount} >= ${canonicalWordCount})`;
        params.logWarn({
          zh: `修复候选仍未回到硬性篇幅范围（${candidateWordCount} 字），保留原章节`,
          en: `revision candidate remains outside the hard length range (${candidateWordCount}); retaining the canonical chapter`,
        });
        await params.retainRejectedCandidate?.({
          content: revisedContent,
          contentHash: revisionCandidateIdentity.candidateContentHash,
          wordCount: candidateWordCount,
          reason: revisionRejectionReason,
          rejectionEvidence: buildCandidateRejectionEvidence({
            rejectionCode: "audit-failed",
            ownerClass: "AUDIT",
            findings: currentAudit.auditResult.issues,
            fallbackDescription: revisionRejectionReason,
          }),
        });

        if (iteration + 1 >= maxReviewIterations) break;
        // Roll the partially-reduced candidate forward so the next iteration
        // keeps trimming from it instead of restarting from the overlong draft.
        workingContent = revisedContent;
        continue;
      }
      let candidateSettlement: RevisionCandidateSettlement = { valid: true };
      if (params.settleRevisionCandidate) {
        candidateSettlement = await params.settleRevisionCandidate(revisedContent, reviseOutput);
      } else if (params.stateSettlementValid) {
        candidateSettlement = {
          valid: await params.stateSettlementValid({ ...reviseOutput, revisedContent }),
        };
      }
      if (!candidateSettlement.valid) {
        revisionRejectionReason = candidateSettlement.rejectionReason ?? "state settlement is invalid";
        params.logWarn({
          zh: "修复候选的状态结算无效，保留原章节",
          en: "Revision candidate state settlement is invalid; retaining the canonical chapter.",
        });
        await params.retainRejectedCandidate?.({
          content: revisedContent,
          contentHash: revisionCandidateIdentity?.candidateContentHash ?? computeChapterContentHash(revisedContent),
          wordCount: countChapterLength(revisedContent, params.lengthSpec.countingMode),
          reason: revisionRejectionReason,
          rejectionEvidence: candidateSettlement.rejectionEvidence
            ?? buildCandidateRejectionEvidence({
              rejectionCode: "state-validation-failed",
              ownerClass: "STATE_SETTLEMENT",
              findings: candidateSettlement.stateFindings ?? [],
              fallbackDescription: revisionRejectionReason,
            }),
        });
        break;
      }
      const revisedWordCount = candidateWordCount;

      // Re-assess revised content. If REVISED_CONTENT drifted on length,
      // lengthInRange will be false → isPassed fails → bestSnapshot picks
      // the earlier in-range version. No in-loop normalize needed.
      const nextAssessment = await assess(revisedContent, {
        temperature: 0,
        stateFindings: candidateSettlement.stateFindings,
        truthFileOverrides: candidateSettlement.truthFileOverrides,
      });

      snapshots.push({
        content: revisedContent,
        wordCount: revisedWordCount,
        auditResult: nextAssessment.auditResult,
        score: nextAssessment.score,
        lengthInRange: nextAssessment.lengthInRange,
      });

      const revisionAcceptance = evaluateRevisionCandidate({
        before: asEvaluation(currentAudit.auditResult, workingContent),
        after: asEvaluation(nextAssessment.auditResult, revisedContent),
        beforeContentHash: computeChapterContentHash(workingContent),
        afterContentHash: computeChapterContentHash(revisedContent),
        stateSettlementValid: true,
      });

      // Candidate is canonical only after the shared acceptance gate passes.
      if (isPassed(nextAssessment) && revisionAcceptance.accepted) {
        revisionRejectionReason = undefined;
        params.logStage({
          zh: `修复后达到通过线（${nextAssessment.score} 分），退出循环`,
          en: `repair reached pass threshold (${nextAssessment.score}), exiting loop`,
        });
        finalContent = revisedContent;
        finalWordCount = revisedWordCount;
        postReviseCount = revisedWordCount;
        currentAudit = nextAssessment;
        break;
      }

      params.logWarn({
        zh: `修复候选未通过验收（${revisionAcceptance.rejectionReason ?? "未达到通过线"}），保留原章节`,
        en: `revision candidate rejected (${revisionAcceptance.rejectionReason ?? "acceptance gate not met"}); retaining the canonical chapter`,
      });
      revisionRejectionReason = revisionAcceptance.rejectionReason ?? "candidate rejected by shared acceptance gate";
      await params.retainRejectedCandidate?.({
        content: revisedContent,
        contentHash: revisionCandidateIdentity.candidateContentHash,
        wordCount: revisedWordCount,
        reason: revisionRejectionReason,
        rejectionEvidence: buildCandidateRejectionEvidence({
          rejectionCode: "audit-failed",
          ownerClass: "AUDIT",
          findings: nextAssessment.auditResult.issues,
          fallbackDescription: revisionRejectionReason,
        }),
      });

      // result.auditResult must keep describing the canonical chapter, so
      // currentAudit only moves forward together with the working draft.
      if (iteration + 1 >= maxReviewIterations) break;
      // Keep the improved (though not yet passing) candidate as the base for
      // the next iteration; the canonical chapter stays unchanged until the
      // shared acceptance gate passes.
      workingContent = revisedContent;
      currentAudit = nextAssessment;
      continue;
    }
  }

  return {
    finalContent,
    finalWordCount,
    preAuditWordCount,
    revised: snapshots.length > 1 && finalContent !== params.initialOutput.content,
    auditResult: currentAudit.auditResult,
    totalUsage,
    postReviseCount,
    repairApplied: snapshots.length > 1 && finalContent !== params.initialOutput.content,
    revisionAttempts,
    auditRuns: buildAuditRuns(),
    ...(reviserTokenUsage ? { reviserTokenUsage } : {}),
    ...(auditorTokenUsage ? { auditorTokenUsage } : {}),
    ...(localRepair ? { localRepair } : {}),
  };
}
