import { createHash } from "node:crypto";
import type { LengthSpec } from "../models/length-governance.js";
import type { AuditIssue, AuditProvenance, AuditResult } from "../agents/continuity.js";
import {
  countChapterLength,
  formatLengthCount,
  isOutsideHardRange,
  isOutsideSoftRange,
} from "../utils/length-metrics.js";

export type AuditDecision = "pass" | "repair-required" | "fail" | "inconclusive";
export type AuditOperation = "write" | "audit" | "revise" | "re-audit";
export type AuditPhase = "initial" | "post-revision" | "manual";
export type AuditSource = "deterministic" | "state" | "llm";
export type AuditVerification = "verified" | "unverified" | "stale";

/**
 * Stable IDs for every fail-closed path that marks an audit result parseFailed.
 * Evidence summaries and repair feedback key off these values; they are part
 * of the qualification evidence contract, so treat them as immutable.
 */
export const AUDIT_PARSE_FAILURE_REASONS = [
  "unparseable-output",
  "transition-check-missing",
  "consistent-with-evidence",
  "inconsistent-without-evidence",
  "evidence-not-bound",
  "spelling-binding-invalid",
] as const;
export type AuditParseFailureReason = (typeof AUDIT_PARSE_FAILURE_REASONS)[number];

/** Telemetry for the bounded in-run re-audit: present only when a second full audit was issued after a parse failure. */
export interface AuditReAuditTelemetry {
  readonly attempted: true;
  readonly priorParseFailedReason: AuditParseFailureReason;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChapterAuditEvaluation {
  readonly decision: AuditDecision;
  readonly passed: boolean;
  readonly findings: ReadonlyArray<AuditIssue>;
  readonly parseFailed: boolean;
  /** Stable binder-branch ID when parseFailed is true. */
  readonly parseFailedReason?: AuditParseFailureReason;
  /** Present when the bounded in-run re-audit ran for this assessment. */
  readonly reAudit?: AuditReAuditTelemetry;
  readonly overallScore?: number;
  readonly contentHash: string;
  readonly tokenUsage?: TokenUsage;
  readonly provenance?: AuditProvenance;
}

export interface ChapterAuditEvaluationInput {
  readonly content: string;
  readonly contentHash?: string;
  readonly lengthSpec?: LengthSpec;
  readonly llmAudit: AuditResult;
  readonly deterministicFindings: ReadonlyArray<AuditIssue>;
  readonly stateFindings: ReadonlyArray<AuditIssue>;
  readonly operation: AuditOperation;
  readonly revisionAttempts: number;
  readonly maxRevisionAttempts: number;
  readonly autoRevisionAllowed: boolean;
  readonly provenance?: AuditProvenance;
}

/** Remove transport-only Markdown from the prose hash without changing inline whitespace. */
export function canonicalizeChapterProse(content: string): string {
  const normalized = content.replace(/\r\n?/g, "\n").replace(/^\uFEFF/u, "").normalize("NFC");
  const lines = normalized.split("\n");
  let index = 0;
  if (lines[0]?.trim() === "---") {
    index = 1;
    while (index < lines.length && lines[index]?.trim() !== "---") index += 1;
    if (index < lines.length) index += 1;
  }
  let inFence = false;
  const prose: string[] = [];

  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const marker = line.trim();
    if (/^(```|~~~)/u.test(marker)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^#{1,6}\s+/u.test(marker)) continue;
    if (marker === "---" || marker === "...") continue;
    prose.push(line);
  }

  return prose.join("\n");
}

export function computeChapterContentHash(content: string): string {
  return createHash("sha256").update(canonicalizeChapterProse(content), "utf8").digest("hex");
}

export interface AuditFingerprintInput {
  readonly ruleId?: string;
  readonly entityIds?: ReadonlyArray<string>;
  readonly invariant?: string;
  readonly category?: string;
  readonly repairTarget?: string;
  readonly [key: string]: unknown;
}

/** Stable issue identity. Deliberately excludes prose, chapter, model and language. */
export function computeAuditFingerprint(input: AuditFingerprintInput): string {
  const entityIds = [
    ...(input.entityIds ?? []),
    ...(typeof input.entityId === "string" ? [input.entityId] : []),
    ...(typeof input.hookId === "string" ? [input.hookId] : []),
    ...(Array.isArray(input.factIds) ? input.factIds.filter((value): value is string => typeof value === "string") : []),
  ];
  const canonical = JSON.stringify({
    ruleId: input.ruleId ?? input.category ?? "unknown",
    entityIds: [...new Set(entityIds)].sort(),
    invariant: input.invariant ?? "",
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function normalizedIssue(
  issue: AuditIssue,
  source: AuditSource,
  contentHash: string,
  occurrence: number,
): AuditIssue {
  const stale = issue.evidence?.contentHash !== undefined && issue.evidence.contentHash !== contentHash;
  const verification: AuditVerification = stale
    ? "stale"
    : issue.verification === "unverified" ? "unverified"
    : source === "llm" ? "unverified" : "verified";
  const ruleId = issue.ruleId ?? issue.category;
  const fingerprint = issue.fingerprint ?? computeAuditFingerprint({ ruleId, category: issue.category, repairTarget: issue.repairTarget });
  return {
    ...issue,
    ruleId,
    findingId: issue.findingId ?? `${fingerprint}:${occurrence}`,
    fingerprint,
    source,
    verification,
    evidence: issue.evidence
      ? { ...issue.evidence, contentHash: issue.evidence.contentHash ?? contentHash }
      : { contentHash },
    repairScope: issue.repairScope ?? (ruleId === "length.hard-range" ? "structural" : undefined),
    repairTarget: issue.repairTarget ?? (ruleId === "length.hard-range" ? "prose" : undefined),
  };
}

export function evaluateChapterAudit(input: ChapterAuditEvaluationInput): ChapterAuditEvaluation {
  const contentHash = computeChapterContentHash(input.content);
  if (input.contentHash !== undefined && input.contentHash !== contentHash) {
    return {
      decision: "inconclusive",
      passed: false,
      findings: [],
      parseFailed: false,
      overallScore: input.llmAudit.overallScore,
      contentHash,
      tokenUsage: input.llmAudit.tokenUsage,
      provenance: input.provenance,
    };
  }

  const suppliedDeterministic = [...input.deterministicFindings];
  if (input.lengthSpec) {
    const count = countChapterLength(input.content, input.lengthSpec.countingMode);
    const isVietnamese = input.lengthSpec.countingMode === "vi_wordlike_tokens_v1";
    if (
      isVietnamese
      && isOutsideSoftRange(count, input.lengthSpec)
      && !isOutsideHardRange(count, input.lengthSpec)
    ) {
      suppliedDeterministic.unshift({
        severity: "warning",
        category: "length",
        description: `Chapter length ${formatLengthCount(count, input.lengthSpec.countingMode)} is outside the preferred range ${input.lengthSpec.softMin}-${input.lengthSpec.softMax}.`,
        suggestion: "Prefer the chapter's target range unless the additional length is required for continuity.",
        ruleId: "length.soft-range",
        repairScope: "structural",
        repairTarget: "prose",
      });
    }
    if (isOutsideHardRange(count, input.lengthSpec)) {
      suppliedDeterministic.unshift({
        severity: "critical",
        category: "length",
        description: `Chapter length ${formatLengthCount(count, input.lengthSpec.countingMode)} is outside the hard range ${input.lengthSpec.hardMin}-${input.lengthSpec.hardMax}.`,
        suggestion: "Revise the chapter into the hard length range.",
        ruleId: "length.hard-range",
        repairScope: "structural",
        repairTarget: "prose",
      });
    }
  }
  const deterministic = suppliedDeterministic.map((issue, index) => normalizedIssue(issue, "deterministic", contentHash, index));
  const state = input.stateFindings.map((issue, index) => normalizedIssue(issue, "state", contentHash, deterministic.length + index));
  const corroboratedFingerprints = new Set([...deterministic, ...state].map((issue) => issue.fingerprint));
  // A corroborated LLM finding inherits the host finding's repairTarget. Without
  // this it stays `undefined` while carrying `verified`, and the policy treats a
  // missing repairTarget as unrepairable — so a chapter whose finding the host
  // had already scoped to "prose" would fail closed for the wrong reason.
  const hostRepairTargetByFingerprint = new Map<string, NonNullable<AuditIssue["repairTarget"]>>();
  for (const issue of [...deterministic, ...state]) {
    if (issue.fingerprint !== undefined && issue.repairTarget !== undefined) {
      hostRepairTargetByFingerprint.set(issue.fingerprint, issue.repairTarget);
    }
  }
  const llm = input.llmAudit.issues.map((issue, index) => {
    const normalized = normalizedIssue(issue, "llm", contentHash, deterministic.length + state.length + index);
    if (normalized.fingerprint === undefined || !corroboratedFingerprints.has(normalized.fingerprint)) return normalized;
    const hostRepairTarget = hostRepairTargetByFingerprint.get(normalized.fingerprint);
    return {
      ...normalized,
      verification: "verified" as const,
      ...(normalized.repairTarget === undefined && hostRepairTarget !== undefined
        ? { repairTarget: hostRepairTarget }
        : {}),
    };
  });
  const findings = [...deterministic, ...state, ...llm];
  const parseFailed = input.llmAudit.parseFailed === true;
  // Mirror of the policy verdict, kept in sync with decideAudit: a verified
  // critical finding is the only deterministic blocker. The LLM score is not a
  // gate here — decideAudit owns the final decision, including the opt-in
  // repair-floor routing.
  const decision: AuditDecision = parseFailed
    ? "inconclusive"
    : input.llmAudit.overallScore === undefined
      ? "inconclusive"
      : findings.some((issue) => issue.verification === "verified" && issue.severity === "critical")
        ? "repair-required"
        : "pass";

  return {
    decision,
    passed: decision === "pass",
    findings,
    parseFailed,
    ...(parseFailed ? { parseFailedReason: input.llmAudit.parseFailedReason } : {}),
    ...(input.llmAudit.reAudit ? { reAudit: input.llmAudit.reAudit } : {}),
    overallScore: input.llmAudit.overallScore,
    contentHash,
    tokenUsage: input.llmAudit.tokenUsage,
    provenance: input.provenance,
  };
}

// Descriptive aliases kept for callers that use the older terminology.
export const canonicalizeChapterText = canonicalizeChapterProse;
export const hashChapterText = computeChapterContentHash;
export const stableAuditFingerprint = computeAuditFingerprint;
