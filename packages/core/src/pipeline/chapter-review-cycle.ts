import { randomUUID } from "node:crypto";
import type { AuditIssue, AuditProvenance, AuditResult } from "../agents/continuity.js";
import type { ReviseMode, ReviseOutput } from "../agents/reviser.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import type { ChapterIntent, ChapterMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import type { LengthSpec } from "../models/length-governance.js";
import { countChapterLength, isOutsideHardRange } from "../utils/length-metrics.js";
import { computeChapterContentHash } from "../audit/chapter-audit-evaluator.js";
import type { ChapterAuditEvaluation } from "../audit/chapter-audit-evaluator.js";
import { decideAudit, evaluateRevisionCandidate } from "../audit/audit-policy.js";
import { createAuditRun, type AuditRunV1 } from "../audit/audit-run.js";

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
}

const DEFAULT_MAX_REVIEW_ITERATIONS = 1;
const PASS_SCORE_THRESHOLD = 85;

function asEvaluation(result: AuditResult, content: string): ChapterAuditEvaluation {
  const decision = result.decision ?? (result.passed ? "pass" : "fail");
  return {
    decision,
    passed: decision === "pass",
    findings: result.issues,
    parseFailed: result.parseFailed === true,
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
  readonly operationId?: string;
  readonly attemptId?: string;
  readonly settleRevisionCandidate?: (
    normalizedContent: string,
    output: ReviseOutput,
  ) => RevisionCandidateSettlement | Promise<RevisionCandidateSettlement>;
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

  // Convert initial postWriteErrors into AuditIssues as fallback when runPostWriteChecks isn't provided.
  const initialPostWriteIssues: ReadonlyArray<AuditIssue> = params.initialOutput.postWriteErrors.map((violation) => ({
    severity: "critical" as const,
    category: violation.rule,
    description: violation.description,
    suggestion: violation.suggestion,
  }));

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
    const llmAudit = await params.auditor.auditChapter(
      params.bookDir,
      content,
      params.chapterNumber,
      params.book.genre,
      params.reducedControlInput
        ? { ...params.reducedControlInput, ...(options ?? {}) }
        : options,
    );
    totalUsage = params.addUsage(totalUsage, llmAudit.tokenUsage);
    if (llmAudit.tokenUsage) {
      auditorTokenUsage = params.addUsage(
        auditorTokenUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        llmAudit.tokenUsage,
      );
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

    const deterministicFindings = [...aiTellsResult.issues, ...sensitiveResult.issues, ...postWriteIssues]
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
    });
    assessmentCount += 1;
    const auditResult: AuditResult = {
      ...llmAudit,
      passed: evaluation.passed,
      issues: evaluation.findings,
      summary: llmAudit.summary,
      parseFailed: llmAudit.parseFailed,
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
    && assessment.score >= PASS_SCORE_THRESHOLD
    && assessment.lengthInRange;

  // ---------------------------------------------------------------------------
  // Scoring loop: assess → revise → assess. Quality repair is hard-bounded to
  // one automatic attempt; legacy retry configuration is parse-only input.
  // ---------------------------------------------------------------------------
  const maxReviewIterations = params.autoRevisionAllowed === false
    ? 0
    : Math.min(DEFAULT_MAX_REVIEW_ITERATIONS, Math.max(0, Math.floor(params.maxReviewIterations ?? DEFAULT_MAX_REVIEW_ITERATIONS)));
  params.logStage({ zh: "审计草稿", en: "auditing draft" });
  const initial = await assess(finalContent);

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
    };
  }

  if (initial.auditResult.decision === "repair-required") {
    for (let iteration = 0; iteration < maxReviewIterations; iteration++) {
      params.logStage({
        zh: `修复轮次 ${iteration + 1}/${maxReviewIterations}（当前 ${currentAudit.score} 分）`,
        en: `repair iteration ${iteration + 1}/${maxReviewIterations} (current score: ${currentAudit.score})`,
      });

      const reviser = params.createReviser();
      revisionAttempts = 1;
      const reviseOutput = await reviser.reviseChapter(
        params.bookDir,
        finalContent,
        params.chapterNumber,
        currentAudit.auditResult.issues,
        "auto",
        params.book.genre,
        { ...params.reducedControlInput, lengthSpec: params.lengthSpec },
      );
      totalUsage = params.addUsage(totalUsage, reviseOutput.tokenUsage);
      if (reviseOutput.tokenUsage) {
        reviserTokenUsage = params.addUsage(
          reviserTokenUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          reviseOutput.tokenUsage,
        );
      }

      const revisedContent = params.normalizePostWriteSurface?.(reviseOutput.revisedContent)
        ?? reviseOutput.revisedContent;
      revisionCandidateProduced = revisedContent.length > 0 && revisedContent !== finalContent;
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

      revisionCandidateIdentity = {
        candidateContentHash: computeChapterContentHash(revisedContent),
        candidateWordCount: countChapterLength(revisedContent, params.lengthSpec.countingMode),
      };

      params.assertChapterContentNotEmpty(revisedContent, `repair iteration ${iteration + 1}`);
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
        break;
      }
      const revisedWordCount = countChapterLength(revisedContent, params.lengthSpec.countingMode);

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
        before: asEvaluation(currentAudit.auditResult, finalContent),
        after: asEvaluation(nextAssessment.auditResult, revisedContent),
        beforeContentHash: computeChapterContentHash(finalContent),
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
      break;
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
  };
}
