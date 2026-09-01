import { z } from "zod";
import { LengthTelemetrySchema } from "./length-governance.js";
import { TokenUsageSchema } from "./input-governance.js";
import { LocalRepairTelemetrySchema } from "../utils/vietnamese-local-repair.js";
import { ProviderCallTelemetrySchema } from "../llm/provider-call-telemetry.js";

export const AuditDecisionSchema = z.enum(["pass", "repair-required", "fail", "inconclusive"]);
export type AuditDecision = z.infer<typeof AuditDecisionSchema>;

export const AuditProvenanceSchema = z.object({
  source: z.string().optional(),
  operationId: z.string().min(1).optional(),
  attemptId: z.string().min(1).optional(),
  phase: z.enum(["initial", "post-revision", "manual"]).optional(),
}).strict();
export type AuditProvenance = z.infer<typeof AuditProvenanceSchema>;

export const ChapterStatusSchema = z.enum([
  "card-generated",
  "drafting",
  "drafted",
  "auditing",
  "audit-passed",
  "audit-failed",
  "state-degraded",
  "revising",
  "needs-revision",
  "ready-for-review",
  "approved",
  "rejected",
  "published",
  "imported",
]);
export type ChapterStatus = z.infer<typeof ChapterStatusSchema>;

export const ChapterMetaSchema = z.object({
  number: z.number().int().min(1),
  title: z.string(),
  status: ChapterStatusSchema,
  wordCount: z.number().int().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  auditIssues: z.array(z.string()).default([]),
  lengthWarnings: z.array(z.string()).default([]),
  reviewNote: z.string().optional(),
  detectionScore: z.number().min(0).max(1).optional(),
  detectionProvider: z.string().optional(),
  detectedAt: z.string().datetime().optional(),
  lengthTelemetry: LengthTelemetrySchema.optional(),
  auditDecision: AuditDecisionSchema.optional(),
  auditAttemptId: z.string().uuid().optional(),
  auditRunPaths: z.array(z.string().min(1)).optional(),
  verifiedBlockerCount: z.number().int().min(0).optional(),
  revisionAttempts: z.number().int().min(0).optional(),
  revisionOutcome: z.enum(["not-needed", "accepted", "rejected", "inconclusive"]).optional(),
  revisionRejectionReason: z.string().optional(),
  auditProvenance: AuditProvenanceSchema.optional(),
  tokenUsage: z.object({
    promptTokens: z.number().int().default(0),
    completionTokens: z.number().int().default(0),
    totalTokens: z.number().int().default(0),
  }).optional(),
  tokenUsageByAgent: z.object({
    planner: TokenUsageSchema.optional(),
    writer: TokenUsageSchema.optional(),
    auditor: TokenUsageSchema.optional(),
    reviser: TokenUsageSchema.optional(),
  }).optional(),
  tokenUsageBySource: z.record(z.string(), z.number().int().nonnegative()).optional(),
  localRepair: LocalRepairTelemetrySchema.optional(),
  providerCallTelemetry: ProviderCallTelemetrySchema.optional(),
});

export type ChapterMeta = z.infer<typeof ChapterMetaSchema>;
