import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AtomicFileWrite } from "../utils/atomic-file-set.js";
import {
  AUDIT_PARSE_FAILURE_REASONS,
  type AuditDecision,
  type AuditOperation,
  type AuditPhase,
  type ChapterAuditEvaluation,
} from "./chapter-audit-evaluator.js";
import type { AuditIssue, AuditProvenance } from "../agents/continuity.js";
import { LocalRepairTelemetrySchema, type LocalRepairTelemetry } from "../utils/vietnamese-local-repair.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const UuidSchema = z.string().uuid();
const AuditIssueSchema = z.object({
  severity: z.enum(["critical", "warning", "info"]),
  category: z.string(),
  description: z.string(),
  suggestion: z.string(),
  repairScope: z.enum(["local", "structural", "unknown"]).optional(),
  ruleId: z.string().optional(),
  findingId: z.string().optional(),
  fingerprint: z.string().min(1).optional(),
  source: z.enum(["deterministic", "state", "llm"]).optional(),
  verification: z.enum(["verified", "unverified", "stale"]).optional(),
  evidence: z.object({
    contentHash: HashSchema,
    excerpt: z.string().max(500).optional(),
    stateRef: z.string().optional(),
  }).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  repairTarget: z.enum(["prose", "runtime-state", "next-plan"]).optional(),
  lifecycle: z.enum(["open", "resolved", "superseded", "expired"]).optional(),
  ttlChapters: z.number().int().positive().optional(),
  confidence: z.number().min(0).max(1).optional(),
  repairHint: z.object({
    kind: z.literal("exact-replacement"),
    targetText: z.string().min(1).max(200),
    replacementText: z.string().min(1).max(200),
    occurrenceIndexes: z.array(z.number().int().positive()).min(1).max(100),
    context: z.string().max(500),
  }).strict().optional(),
}).strict();

const ProvenanceSchema = z.object({
  source: z.string().optional(),
  operationId: z.string().optional(),
  attemptId: z.string().optional(),
  phase: z.enum(["initial", "post-revision", "manual"]).optional(),
}).strict();

export const AuditRunV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("audit-run-v1"),
  operationId: UuidSchema,
  attemptId: UuidSchema,
  operation: z.enum(["write", "audit", "revise", "re-audit"]),
  phase: z.enum(["initial", "post-revision", "manual"]),
  bookId: z.string().min(1),
  chapterNumber: z.number().int().min(1),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  contentHash: HashSchema,
  length: z.object({
    count: z.number().int().nonnegative(),
    countingMode: z.enum(["zh_chars", "en_words", "vi_wordlike_tokens_v1"]),
    target: z.number().int().min(1),
    softMin: z.number().int().min(1),
    softMax: z.number().int().min(1),
    hardMin: z.number().int().min(1),
    hardMax: z.number().int().min(1),
  }).strict(),
  decision: z.enum(["pass", "repair-required", "fail", "inconclusive"]),
  passed: z.boolean(),
  parseFailed: z.boolean().optional(),
  parseFailedReason: z.enum(AUDIT_PARSE_FAILURE_REASONS).optional(),
  reAudit: z.object({
    attempted: z.literal(true),
    priorParseFailedReason: z.enum(AUDIT_PARSE_FAILURE_REASONS),
  }).optional(),
  overallScore: z.number().min(0).max(100).optional(),
  findings: z.array(AuditIssueSchema),
  revision: z.object({
    attempted: z.boolean(),
    candidateProduced: z.boolean(),
    candidateContentHash: HashSchema.optional(),
    candidateWordCount: z.number().int().nonnegative().optional(),
    accepted: z.boolean(),
    rejectionReason: z.string().optional(),
  }).strict(),
  canonicalCommitOutcome: z.enum(["terminal-commit", "superseded", "rejected", "unchanged", "not-committed"]),
  provenance: ProvenanceSchema.optional(),
  retryCounts: z.object({ transport: z.number().int().nonnegative(), output: z.number().int().nonnegative(), quality: z.number().int().nonnegative() }).strict(),
  tokenUsage: z.object({ promptTokens: z.number().int().nonnegative(), completionTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative() }).strict().optional(),
  localRepair: LocalRepairTelemetrySchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.passed !== (value.decision === "pass")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["passed"], message: "passed is derived from decision" });
  }
});

export type AuditRunV1 = z.infer<typeof AuditRunV1Schema>;

export function createAuditRunIdentity(run: Pick<AuditRunV1, "attemptId" | "phase" | "contentHash">): string {
  return `${run.attemptId}:${run.phase}:${run.contentHash}`;
}

function truncateIssue(issue: AuditIssue): AuditIssue {
  const evidence = issue.evidence?.excerpt && issue.evidence.excerpt.length > 500
    ? { ...issue.evidence, excerpt: issue.evidence.excerpt.slice(0, 500) }
    : issue.evidence;
  const repairHint = issue.repairHint
    ? {
        ...issue.repairHint,
        context: issue.repairHint.context.slice(0, 500),
      }
    : undefined;
  return evidence !== issue.evidence || repairHint !== issue.repairHint
    ? { ...issue, ...(evidence ? { evidence } : {}), ...(repairHint ? { repairHint } : {}) }
    : issue;
}

export function serializeAuditRun(run: AuditRunV1): string {
  // Parsing through the strict schema is the allowlist: prompts, headers, secrets and CoT are rejected.
  const sanitized = { ...run, findings: run.findings.map(truncateIssue) };
  return `${JSON.stringify(AuditRunV1Schema.parse(sanitized), null, 2)}\n`;
}

export function auditRunRelativePath(run: Pick<AuditRunV1, "chapterNumber" | "attemptId" | "phase">): string {
  UuidSchema.parse(run.attemptId);
  z.enum(["initial", "post-revision", "manual"]).parse(run.phase);
  if (!Number.isInteger(run.chapterNumber) || run.chapterNumber < 1) {
    throw new Error("Audit run chapter number must be a positive integer");
  }
  const chapter = String(run.chapterNumber).padStart(4, "0");
  return `story/audit/runs/chapter-${chapter}/${run.attemptId}.${run.phase}.audit-run-v1.json`;
}

export function createAuditRunWrite(run: AuditRunV1): AtomicFileWrite {
  return { relativePath: auditRunRelativePath(run), content: serializeAuditRun(run) };
}

export function createAuditRun(input: {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly operation: AuditOperation;
  readonly phase: AuditPhase;
  readonly contentHash: string;
  readonly evaluation: ChapterAuditEvaluation;
  readonly length: AuditRunV1["length"];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly revision?: AuditRunV1["revision"];
  readonly canonicalCommitOutcome?: AuditRunV1["canonicalCommitOutcome"];
  readonly retryCounts?: AuditRunV1["retryCounts"];
  readonly localRepair?: LocalRepairTelemetry;
  readonly operationId?: string;
  readonly attemptId?: string;
}): AuditRunV1 {
  if (input.contentHash !== input.evaluation.contentHash) {
    const error = Object.assign(new Error("Audit run content hash does not match evaluation"), { code: "STATE_PREFLIGHT_FAILED" });
    throw error;
  }
  return AuditRunV1Schema.parse({
    schemaVersion: 1,
    kind: "audit-run-v1",
    operationId: input.operationId ?? randomUUID(),
    attemptId: input.attemptId ?? randomUUID(),
    operation: input.operation,
    phase: input.phase,
    bookId: input.bookId,
    chapterNumber: input.chapterNumber,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.durationMs,
    contentHash: input.contentHash,
    length: input.length,
    decision: input.evaluation.decision,
    passed: input.evaluation.passed,
    parseFailed: input.evaluation.parseFailed,
    parseFailedReason: input.evaluation.parseFailedReason,
    reAudit: input.evaluation.reAudit,
    overallScore: input.evaluation.overallScore,
    findings: input.evaluation.findings.map(truncateIssue),
    revision: input.revision ?? { attempted: false, candidateProduced: false, accepted: false },
    canonicalCommitOutcome: input.canonicalCommitOutcome ?? "not-committed",
    provenance: input.evaluation.provenance,
    retryCounts: input.retryCounts ?? { transport: 0, output: 0, quality: 0 },
    tokenUsage: input.evaluation.tokenUsage,
    localRepair: input.localRepair,
  });
}

export function assertAuditRunWriteOnce(existing: AuditRunV1, incoming: AuditRunV1): "idempotent" | "new" {
  if (
    existing.chapterNumber !== incoming.chapterNumber
    || existing.attemptId !== incoming.attemptId
    || existing.phase !== incoming.phase
  ) {
    return "new";
  }
  if (serializeAuditRun(existing) === serializeAuditRun(incoming)) return "idempotent";
  const error = Object.assign(new Error("Audit run identity conflicts with existing immutable evidence"), { code: "STATE_PREFLIGHT_FAILED" });
  throw error;
}

export function markInitialRunSuperseded(initial: AuditRunV1, postRevision: AuditRunV1): AuditRunV1 {
  if (initial.attemptId !== postRevision.attemptId || postRevision.phase !== "post-revision") return initial;
  return { ...initial, canonicalCommitOutcome: "superseded" };
}

export const getAuditRunRelativePath = auditRunRelativePath;
