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
}

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
    return evaluation.overallScore >= 85 ? withDecision(evaluation, "pass") : withDecision(evaluation, "fail");
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
  if (!input.stateSettlementValid) return { accepted: false, rejectionReason: "state settlement is invalid" };
  if (input.beforeContentHash === input.afterContentHash) return { accepted: false, rejectionReason: "candidate content is unchanged" };
  if (input.after.decision !== "pass" || input.after.passed !== true || (input.after.overallScore ?? 0) < 85) {
    return { accepted: false, rejectionReason: "candidate did not pass the acceptance gate" };
  }
  if ((input.after.overallScore ?? 0) < (input.before.overallScore ?? 0) - 3) {
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

export { type ChapterAuditEvaluation } from "./chapter-audit-evaluator.js";
