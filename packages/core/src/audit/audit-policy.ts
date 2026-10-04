import {
  evaluateChapterAudit,
  type AuditDecision,
  type ChapterAuditEvaluation,
  type ChapterAuditEvaluationInput,
} from "./chapter-audit-evaluator.js";

export interface AuditPolicyContext {
  readonly operation: ChapterAuditEvaluationInput["operation"];
  readonly autoRevisionAllowed: boolean;
  readonly revisionAttempts: number;
  readonly maxRevisionAttempts: number;
  readonly legacyRevisionGate?: "strict" | "lenient" | "always";
  /**
   * @deprecated Score-based repair routing was removed: the self-reported score
   * no longer gates any verdict. The field is still accepted so existing
   * `inkos.json` files keep validating, but it no longer influences decisions.
   */
  readonly scoreRepairFloorScore?: number;
}

/**
 * Advisory-only quality gate. The LLM self-reported score is retained for
 * reporting and for the opt-in repair-floor routing below, but it no longer
 * decides pass/fail: with zero verified critical blockers a chapter passes.
 * Scores vary far more between identical runs than the gap this threshold
 * measures, so gating on it looped chapters indefinitely.
 */
export const PASS_MIN_SCORE = 85;

export function normalizeLegacyRevisionGate(gate: AuditPolicyContext["legacyRevisionGate"]): "strict" | "lenient" | undefined {
  if (gate === "always") return "strict";
  return gate;
}

function withDecision(evaluation: ChapterAuditEvaluation, decision: AuditDecision): ChapterAuditEvaluation {
  return { ...evaluation, decision, passed: decision === "pass" };
}

export function decideAudit(
  evaluationInput: ChapterAuditEvaluationInput,
  context: AuditPolicyContext,
): ChapterAuditEvaluation {
  const evaluation = evaluateChapterAudit(evaluationInput);
  if (evaluation.parseFailed || evaluation.overallScore === undefined) return withDecision(evaluation, "inconclusive");
  if (evaluation.findings.some((finding) => finding.verification === "stale")) return withDecision(evaluation, "inconclusive");

  const blockers = evaluation.findings.filter((finding) => finding.verification === "verified" && finding.severity === "critical");
  if (blockers.length === 0) {
    // Deterministic contract: no verified critical finding means the chapter is
    // structurally sound. The LLM score stays advisory — reported for the
    // operator, never a gate. Routing low-scoring chapters into a repair loop
    // on score alone only added oscillation, because the score swings by more
    // between identical runs than the gap being measured.
    return withDecision(evaluation, "pass");
  }
  if (blockers.some((finding) => finding.repairTarget === undefined || finding.evidence?.contentHash !== evaluation.contentHash)) {
    return withDecision(evaluation, "fail");
  }
  const revisionBudget = context.autoRevisionAllowed && context.revisionAttempts < Math.min(1, context.maxRevisionAttempts);
  return revisionBudget ? withDecision(evaluation, "repair-required") : withDecision(evaluation, "fail");
}

export interface RevisionCandidateResult {
  readonly accepted: boolean;
  readonly rejectionReason?: string;
}

export function evaluateRevisionCandidate(input: {
  readonly before: ChapterAuditEvaluation;
  readonly after: ChapterAuditEvaluation;
  readonly beforeContentHash: string;
  readonly afterContentHash: string;
  readonly stateSettlementValid: boolean;
}): RevisionCandidateResult {
  if (input.stateSettlementValid === false) return { accepted: false, rejectionReason: "state settlement is invalid" };
  if (input.beforeContentHash === input.afterContentHash) return { accepted: false, rejectionReason: "candidate content is unchanged" };
  // The candidate must clear the same deterministic bar a canonical chapter has
  // to clear: `after.decision` is already "pass" only when it carries no
  // verified critical blocker, so no separate score test is applied here.
  if (input.after.decision !== "pass" || input.after.passed !== true) {
    return { accepted: false, rejectionReason: "candidate did not pass the acceptance gate" };
  }
  const beforeHasHardLengthBlocker = input.before.findings.some((finding) =>
    finding.ruleId === "length.hard-range"
    && finding.verification === "verified"
    && finding.severity === "critical",
  );
  if (
    !beforeHasHardLengthBlocker
    && (input.after.overallScore ?? 0) < (input.before.overallScore ?? 0) - 3
  ) {
    return { accepted: false, rejectionReason: "candidate score regressed by more than three points" };
  }
  if (input.after.findings.some((finding) => finding.verification === "verified" && finding.severity === "critical")) {
    return { accepted: false, rejectionReason: "candidate retains a verified critical finding" };
  }
  const beforeBlockers = new Set(input.before.findings.filter((f) => f.verification === "verified" && f.severity === "critical").map((f) => f.fingerprint ?? f.findingId));
  const afterBlockers = input.after.findings.filter((f) => f.verification === "verified" && f.severity === "critical");
  if (beforeBlockers.size > 0 && afterBlockers.some((f) => beforeBlockers.has(f.fingerprint ?? f.findingId))) {
    return { accepted: false, rejectionReason: "verified blocker was not resolved" };
  }
  return { accepted: true };
}

export const MINOR_AUDIT_ACCEPTANCE_MAX_ISSUES = 1;
export const MINOR_AUDIT_ACCEPTANCE_CATEGORIES: ReadonlyArray<string> = Object.freeze([
  "chapter memo drift check",
  "pov consistency check",
  "transition continuity",
]);

interface MinorAcceptanceAuditLike {
  readonly passed: boolean;
  readonly parseFailed?: boolean;
  readonly decision?: string;
  readonly overallScore?: number;
  readonly issues: ReadonlyArray<{
    readonly severity: string;
    readonly category?: string;
    readonly description?: string;
    readonly suggestion?: string;
  }>;
}

/**
 * Minor-audit acceptance: a fail verdict whose blocking issues are all small,
 * human-fixable prose notes (memo drift / POV / transition) and at most one such
 * issue may be accepted as `pass` with the notes carried on the result. The
 * score is reported but no longer gates the decision. Everything else stays
 * fail-closed: parse failures, inconclusive verdicts, Hook Check/state/surface/
 * length issues, or more than one blocking issue never qualify.
 */
export function applyMinorAuditAcceptance<T extends MinorAcceptanceAuditLike>(
  auditResult: T,
  options: { readonly enabled: boolean },
): T & { minorAccepted?: boolean; minorNotes?: ReadonlyArray<string> } {
  if (!options.enabled || auditResult.passed || auditResult.parseFailed === true) return auditResult;
  if (auditResult.decision !== "fail" && auditResult.decision !== "repair-required") return auditResult;
  const score = auditResult.overallScore;
  const blocking = auditResult.issues.filter((issue) => issue.severity === "critical" || issue.severity === "error");
  if (blocking.length === 0 || blocking.length > MINOR_AUDIT_ACCEPTANCE_MAX_ISSUES) return auditResult;
  const offPolicy = blocking.filter((issue) => {
    const category = (issue.category ?? "").trim().toLowerCase();
    return !MINOR_AUDIT_ACCEPTANCE_CATEGORIES.includes(category);
  });
  if (offPolicy.length > 0) return auditResult;
  const notes = blocking.map((issue) => `[${issue.category}] ${issue.description ?? ""}`.trim());
  const acceptanceNote = {
    severity: "warning" as const,
    category: "minor-acceptance",
    description: `Chapter accepted under the minor-audit acceptance policy (score ${score ?? "n/a"}): ${notes.join(" | ")}`,
    suggestion: "Human review recommended; the noted issues are non-blocking prose-level notes.",
  };
  return {
    ...auditResult,
    passed: true,
    decision: "pass",
    minorAccepted: true,
    minorNotes: notes,
    issues: [...auditResult.issues, acceptanceNote],
  } as T & { minorAccepted?: boolean; minorNotes?: ReadonlyArray<string> };
}

export { type ChapterAuditEvaluation } from "./chapter-audit-evaluator.js";
