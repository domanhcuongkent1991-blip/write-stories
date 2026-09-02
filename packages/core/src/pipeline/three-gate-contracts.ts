/**
 * Behavior-neutral contracts for the three-gate rollout.
 *
 * This module deliberately has no provider, state-manager, or filesystem
 * dependencies. It is safe to use from tests and orchestration boundaries
 * before the new pipeline path is allowed to write canonical state.
 */

export const VI_PIPELINE_MODES = ["legacy", "preview", "canary", "default"] as const;

export type ViPipelineMode = (typeof VI_PIPELINE_MODES)[number];

export type PipelineModeSource = "default" | "explicit" | "invalid";

export interface ViPipelineModeResolution {
  readonly mode: ViPipelineMode;
  readonly source: PipelineModeSource;
  readonly diagnostic?: "CONFIG_INVALID";
}

const VI_PIPELINE_MODE_SET: ReadonlySet<string> = new Set(VI_PIPELINE_MODES);

/**
 * Resolve untrusted configuration without ever enabling a new mode by
 * accident. Empty strings and non-string values are invalid configuration;
 * an omitted value is the documented legacy default.
 */
export function resolveViPipelineMode(value: unknown): ViPipelineModeResolution {
  if (value === undefined || value === null) {
    return { mode: "legacy", source: "default" };
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (VI_PIPELINE_MODE_SET.has(normalized)) {
      return { mode: normalized as ViPipelineMode, source: "explicit" };
    }
  }

  return {
    mode: "legacy",
    source: "invalid",
    diagnostic: "CONFIG_INVALID",
  };
}

export type ViPipelineOperation =
  | "read"
  | "audit"
  | "create"
  | "plan"
  | "compose"
  | "write"
  | "draft"
  | "revise"
  | "repair"
  | "resync";

export type ViPipelineModePolicyErrorCode =
  | "PREVIEW_NO_WRITE"
  | "CANARY_BOOK_NOT_ALLOWED"
  | "DEFAULT_NOT_APPROVED";

export interface ViPipelineOperationPolicyInput {
  readonly mode: ViPipelineModeResolution;
  readonly operation: ViPipelineOperation;
  readonly bookId?: string;
  readonly canaryBookIds?: ReadonlyArray<string>;
  readonly promotionApproved?: boolean;
  readonly defaultOn?: boolean;
}

export class ViPipelineModePolicyError extends Error {
  constructor(
    readonly code: ViPipelineModePolicyErrorCode,
    readonly operation: ViPipelineOperation,
  ) {
    super(`${code}: ${operation}`);
    this.name = "ViPipelineModePolicyError";
  }
}

const MUTATING_OPERATIONS: ReadonlySet<ViPipelineOperation> = new Set([
  "create",
  "plan",
  "compose",
  "write",
  "draft",
  "audit",
  "revise",
  "repair",
  "resync",
]);

/**
 * Enforce the rollout policy before an operation can reach a provider or a
 * canonical writer. The legacy mode remains fully compatible; every newer
 * mode fails closed until its explicit activation conditions are supplied.
 */
export function assertViPipelineOperationAllowed(
  input: ViPipelineOperationPolicyInput,
): void {
  if (!MUTATING_OPERATIONS.has(input.operation)) return;

  switch (input.mode.mode) {
    case "legacy":
      return;
    case "preview":
      throw new ViPipelineModePolicyError("PREVIEW_NO_WRITE", input.operation);
    case "canary":
      if (!input.bookId || !input.canaryBookIds?.includes(input.bookId)) {
        throw new ViPipelineModePolicyError("CANARY_BOOK_NOT_ALLOWED", input.operation);
      }
      return;
    case "default":
      if (input.promotionApproved !== true || input.defaultOn !== true) {
        throw new ViPipelineModePolicyError("DEFAULT_NOT_APPROVED", input.operation);
      }
      return;
  }
}

export type IntegrationGateDecision = "MERGEABLE_OFF" | "HOLD_INTEGRATION";
export type ActivationGateDecision =
  | "ACTIVATABLE_INTERNAL"
  | "ACTIVATABLE_DETERMINISTIC"
  | "HOLD_ACTIVATION";
export type ProviderGateDecision = "PROVIDER_PASSED" | "PROVIDER_INCONCLUSIVE" | "PROVIDER_FAILED" | "NOT_REQUIRED";
export type PromotionGateDecision = "PROMOTABLE_DEFAULT" | "HOLD_PROMOTION";

export interface ThreeGateDecisionInput {
  readonly integration: {
    readonly requiredChecksPassed: boolean;
    readonly legacyDefaultVerified: boolean;
    readonly boundaryOffVerified: boolean;
    readonly securityPassed: boolean;
  };
  readonly activation: {
    readonly deterministicSuitePassed: boolean;
    readonly providerCanary: "passed" | "inconclusive" | "failed" | "not-required";
  };
  readonly promotion: {
    readonly exactShaVerified: boolean;
    readonly liveQualificationPassed: boolean;
    readonly chapterResultsComplete: boolean;
    readonly unresolvedBlockers: number;
    readonly stateAligned: boolean;
    readonly recoveryPassed: boolean;
    readonly evidenceSafe: boolean;
  };
}

export interface ThreeGateDecision {
  readonly integration: IntegrationGateDecision;
  readonly activation: ActivationGateDecision;
  readonly provider: ProviderGateDecision;
  readonly promotion: PromotionGateDecision;
}

/**
 * Evaluate each gate without collapsing them into an aggregate score. A
 * deterministic-only activation remains useful evidence, but it cannot be
 * promoted while the provider result is inconclusive.
 */
export function evaluateThreeGateDecision(input: ThreeGateDecisionInput): ThreeGateDecision {
  assertNonNegativeInteger(input.promotion.unresolvedBlockers, "promotion.unresolvedBlockers");

  const integration: IntegrationGateDecision =
    input.integration.requiredChecksPassed
    && input.integration.legacyDefaultVerified
    && input.integration.boundaryOffVerified
    && input.integration.securityPassed
      ? "MERGEABLE_OFF"
      : "HOLD_INTEGRATION";

  const provider: ProviderGateDecision = {
    passed: "PROVIDER_PASSED",
    inconclusive: "PROVIDER_INCONCLUSIVE",
    failed: "PROVIDER_FAILED",
    "not-required": "NOT_REQUIRED",
  }[input.activation.providerCanary] as ProviderGateDecision;

  let activation: ActivationGateDecision = "HOLD_ACTIVATION";
  if (input.activation.deterministicSuitePassed) {
    if (provider === "PROVIDER_INCONCLUSIVE") {
      activation = "ACTIVATABLE_DETERMINISTIC";
    } else if (provider === "PROVIDER_PASSED" || provider === "NOT_REQUIRED") {
      activation = "ACTIVATABLE_INTERNAL";
    }
  }

  const promotionPassed =
    integration === "MERGEABLE_OFF"
    && activation === "ACTIVATABLE_INTERNAL"
    && input.promotion.exactShaVerified
    && input.promotion.liveQualificationPassed
    && input.promotion.chapterResultsComplete
    && input.promotion.unresolvedBlockers === 0
    && input.promotion.stateAligned
    && input.promotion.recoveryPassed
    && input.promotion.evidenceSafe;

  return deepFreeze({
    integration,
    activation,
    provider,
    promotion: promotionPassed ? "PROMOTABLE_DEFAULT" : "HOLD_PROMOTION",
  });
}

export const THREE_GATE_ARTIFACT_SCHEMA_VERSION = 1 as const;

export interface CanonicalCheckpoint {
  readonly hash: string;
  readonly chapterNumber: number;
}

export interface ContentLengthMetadata {
  readonly count: number;
  readonly countingMode: string;
}

export interface ProviderLineage {
  readonly provider: string;
  readonly model: string;
  readonly transport: "chat" | "responses";
  readonly requestId?: string;
  readonly attempt?: number;
}

export interface DraftArtifact {
  readonly schemaVersion: typeof THREE_GATE_ARTIFACT_SCHEMA_VERSION;
  readonly draftId: string;
  readonly runId: string;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly parentCanonicalCheckpoint: CanonicalCheckpoint;
  readonly contentHash: string;
  readonly contentLength: ContentLengthMetadata;
  readonly provider: ProviderLineage;
  readonly createdAt: string;
  readonly storagePath: string;
}

export interface DraftArtifactInput extends Omit<DraftArtifact, "schemaVersion"> {}

export type ValidationCheck = {
  readonly id: string;
  readonly passed: boolean;
  readonly detail?: string;
};

export interface ValidationReport {
  readonly schemaVersion: typeof THREE_GATE_ARTIFACT_SCHEMA_VERSION;
  readonly validatorVersion: string;
  readonly checks: ReadonlyArray<ValidationCheck>;
  readonly hardBlockers: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly passed: boolean;
  readonly contentHash: string;
  readonly sourceDraftHash: string;
  readonly noSecretAssertion: true;
}

export interface ValidationReportInput extends Omit<ValidationReport, "schemaVersion" | "passed"> {}

export type AuditDisposition = "blocked" | "repair-required" | "warning" | "passed";
export type AuditSeverity = "critical" | "warning" | "info";

export interface AuditRepairHint {
  readonly targetText: string;
  readonly replacementText: string;
}

export interface AuditFinding {
  readonly ruleId: string;
  readonly category: string;
  readonly severity: AuditSeverity;
  readonly disposition: AuditDisposition;
  readonly description: string;
  readonly evidence?: string;
  readonly repairHint?: AuditRepairHint;
}

export interface AuditReport {
  readonly schemaVersion: typeof THREE_GATE_ARTIFACT_SCHEMA_VERSION;
  readonly auditorVersion: string;
  readonly findings: ReadonlyArray<AuditFinding>;
  readonly contentHash: string;
  readonly auditedAt: string;
  readonly passed: boolean;
  readonly unresolvedBlockerCount: number;
}

export interface AuditReportInput extends Omit<AuditReport, "schemaVersion" | "passed" | "unresolvedBlockerCount"> {}

export type RepairAcceptance = "accepted" | "rejected" | "needs-review";

export interface RepairCandidate {
  readonly schemaVersion: typeof THREE_GATE_ARTIFACT_SCHEMA_VERSION;
  readonly candidateId: string;
  readonly sourceDraftHash: string;
  readonly changedCandidateHash: string;
  readonly requestedFindingIds: ReadonlyArray<string>;
  readonly repairAttempt: number;
  readonly diffSummary: string;
  readonly validation: {
    readonly passed: boolean;
    readonly sourceDraftHash: string;
  };
  readonly audit: {
    readonly passed: boolean;
    readonly unresolvedBlockerCount: number;
  };
  readonly acceptance: RepairAcceptance;
}

export interface RepairCandidateInput extends Omit<RepairCandidate, "schemaVersion"> {}

export type CommitDecisionKind =
  | "preview"
  | "needs-review"
  | "blocked"
  | "ready-for-commit"
  | "committed";

export interface CommitDecision {
  readonly schemaVersion: typeof THREE_GATE_ARTIFACT_SCHEMA_VERSION;
  readonly decision: CommitDecisionKind;
  readonly unresolvedBlockers: ReadonlyArray<string>;
  readonly acceptedWarnings: ReadonlyArray<string>;
  readonly canonicalCheckpointBeforeCommit: CanonicalCheckpoint;
  readonly finalInvariants: {
    readonly aligned: boolean;
    readonly passed: boolean;
  };
  readonly atomicCommit: {
    readonly status: "not-started" | "committed" | "failed";
    readonly transactionId?: string;
  };
  readonly rollbackReference: string;
}

export interface CommitDecisionInput extends Omit<CommitDecision, "schemaVersion"> {}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function createDraftArtifact(input: DraftArtifactInput): DraftArtifact {
  assertNonEmpty(input.draftId, "draftId");
  assertNonEmpty(input.runId, "runId");
  assertNonEmpty(input.bookId, "bookId");
  assertNonNegativeInteger(input.chapterNumber, "chapterNumber");
  assertNonEmpty(input.parentCanonicalCheckpoint.hash, "parentCanonicalCheckpoint.hash");
  assertNonNegativeInteger(input.parentCanonicalCheckpoint.chapterNumber, "parentCanonicalCheckpoint.chapterNumber");
  assertNonEmpty(input.contentHash, "contentHash");
  assertNonNegativeInteger(input.contentLength.count, "contentLength.count");
  assertNonEmpty(input.contentLength.countingMode, "contentLength.countingMode");
  assertNonEmpty(input.provider.provider, "provider.provider");
  assertNonEmpty(input.provider.model, "provider.model");
  assertNonEmpty(input.createdAt, "createdAt");
  assertNonEmpty(input.storagePath, "storagePath");
  return deepFreeze({ schemaVersion: THREE_GATE_ARTIFACT_SCHEMA_VERSION, ...input });
}

export function createValidationReport(input: ValidationReportInput): ValidationReport {
  assertNonEmpty(input.validatorVersion, "validatorVersion");
  assertNonEmpty(input.contentHash, "contentHash");
  assertNonEmpty(input.sourceDraftHash, "sourceDraftHash");
  if (input.contentHash !== input.sourceDraftHash) {
    throw new Error("Validation content hash must match the source draft hash.");
  }
  if (input.noSecretAssertion !== true) {
    throw new Error("Validation report requires a no-secret assertion.");
  }
  const passed = input.hardBlockers.length === 0 && input.checks.every((check) => check.passed);
  return deepFreeze({ schemaVersion: THREE_GATE_ARTIFACT_SCHEMA_VERSION, ...input, passed });
}

export function createAuditReport(input: AuditReportInput): AuditReport {
  assertNonEmpty(input.auditorVersion, "auditorVersion");
  assertNonEmpty(input.contentHash, "contentHash");
  assertNonEmpty(input.auditedAt, "auditedAt");
  for (const finding of input.findings) {
    assertNonEmpty(finding.ruleId, "finding.ruleId");
    assertNonEmpty(finding.category, "finding.category");
    assertNonEmpty(finding.description, "finding.description");
    if (finding.disposition === "repair-required" && !finding.repairHint) {
      throw new Error(`Audit finding ${finding.ruleId} requires a repair hint.`);
    }
  }
  const unresolvedBlockerCount = input.findings.filter(
    (finding) => finding.disposition === "blocked" || finding.disposition === "repair-required",
  ).length;
  return deepFreeze({
    schemaVersion: THREE_GATE_ARTIFACT_SCHEMA_VERSION,
    ...input,
    passed: unresolvedBlockerCount === 0,
    unresolvedBlockerCount,
  });
}

export function createRepairCandidate(input: RepairCandidateInput): RepairCandidate {
  assertNonEmpty(input.candidateId, "candidateId");
  assertNonEmpty(input.sourceDraftHash, "sourceDraftHash");
  assertNonEmpty(input.changedCandidateHash, "changedCandidateHash");
  if (input.sourceDraftHash === input.changedCandidateHash) {
    throw new Error("Repair candidate must have a changed candidate hash.");
  }
  if (!Number.isInteger(input.repairAttempt) || input.repairAttempt < 1 || input.repairAttempt > 3) {
    throw new Error("Repair attempt must be a bounded integer from 1 through 3.");
  }
  if (input.validation.sourceDraftHash !== input.changedCandidateHash) {
    throw new Error("Repair validation must bind to the changed candidate hash.");
  }
  return deepFreeze({ schemaVersion: THREE_GATE_ARTIFACT_SCHEMA_VERSION, ...input });
}

export function createCommitDecision(input: CommitDecisionInput): CommitDecision {
  if (input.decision === "ready-for-commit" && input.unresolvedBlockers.length > 0) {
    throw new Error("Ready-for-commit decision cannot contain unresolved blockers.");
  }
  if (input.decision === "ready-for-commit" && (!input.finalInvariants.aligned || !input.finalInvariants.passed)) {
    throw new Error("Ready-for-commit decision requires passing final invariants.");
  }
  if (input.decision === "committed" && input.atomicCommit.status !== "committed") {
    throw new Error("Committed decision requires a successful atomic commit.");
  }
  return deepFreeze({ schemaVersion: THREE_GATE_ARTIFACT_SCHEMA_VERSION, ...input });
}

export type PipelineStage =
  | "provider"
  | "writer"
  | "validator"
  | "audit"
  | "repair"
  | "committer"
  | "orchestrator"
  | "recovery"
  | "environment";

export type PipelineErrorFamily =
  | "provider-contract"
  | "provider-transport"
  | "provider-http"
  | "parse-language"
  | "integrity"
  | "quality-blocker"
  | "quality-repair"
  | "warning"
  | "state-recovery"
  | "security"
  | "environment"
  | "configuration";

export type PipelineUserDisposition =
  | "retry"
  | "repair"
  | "review"
  | "recover"
  | "diagnose"
  | "rollback"
  | "fallback";

export type PipelineRetryPolicy = "bounded" | "policy" | "none" | "controlled";

export type PipelineErrorCode =
  | "PROVIDER_REASONING_ONLY"
  | "PROVIDER_EMPTY"
  | "PROVIDER_MALFORMED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_PARTIAL_RESPONSE"
  | "PROVIDER_TRANSPORT"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_MODEL_UNAVAILABLE"
  | "PARSE_INVALID"
  | "LANGUAGE_INVALID"
  | "STRUCTURE_INVALID"
  | "HARD_RANGE_FAIL"
  | "CONTENT_HASH_MISMATCH"
  | "CHAPTER_NUMBER_MISMATCH"
  | "QUALITY_BLOCKED"
  | "SPELLING_CRITICAL"
  | "HOOK_BLOCKER"
  | "QUALITY_REPAIR_REQUIRED"
  | "SPELLING_REPAIR_REQUIRED"
  | "HOOK_REPAIR_REQUIRED"
  | "QUALITY_WARNING"
  | "PREFERRED_RANGE_WARNING"
  | "STATE_MISMATCH"
  | "ATOMIC_COMMIT_FAILED"
  | "STALE_LOCK"
  | "RESUME_INVALID"
  | "SECRET_DETECTED"
  | "UNSAFE_PATH"
  | "UNTRUSTED_ARTIFACT"
  | "EPERM_DIST_WRITE"
  | "RUNTIME_MISSING"
  | "PROCESS_HUNG"
  | "CONFIG_INVALID";

export interface PipelineErrorDescriptor {
  readonly code: PipelineErrorCode;
  readonly family: PipelineErrorFamily;
  readonly stage: PipelineStage;
  readonly retryable: boolean;
  readonly retryPolicy: PipelineRetryPolicy;
  readonly repairable: boolean;
  readonly canonicalCommitAllowed: boolean;
  readonly userDisposition: PipelineUserDisposition;
  readonly evidenceRef?: string;
}

interface PipelineErrorDefinition {
  readonly family: PipelineErrorFamily;
  readonly retryable: boolean;
  readonly retryPolicy: PipelineRetryPolicy;
  readonly repairable: boolean;
  readonly canonicalCommitAllowed: boolean;
  readonly userDisposition: PipelineUserDisposition;
}

const PIPELINE_ERROR_DEFINITIONS: Record<PipelineErrorCode, PipelineErrorDefinition> = {
  PROVIDER_REASONING_ONLY: {
    family: "provider-contract",
    retryable: true,
    retryPolicy: "bounded",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "retry",
  },
  PROVIDER_EMPTY: {
    family: "provider-contract",
    retryable: true,
    retryPolicy: "bounded",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "retry",
  },
  PROVIDER_MALFORMED: {
    family: "provider-contract",
    retryable: true,
    retryPolicy: "bounded",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "retry",
  },
  PROVIDER_TIMEOUT: {
    family: "provider-transport",
    retryable: true,
    retryPolicy: "bounded",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "retry",
  },
  PROVIDER_PARTIAL_RESPONSE: {
    family: "provider-transport",
    retryable: true,
    retryPolicy: "bounded",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "retry",
  },
  PROVIDER_TRANSPORT: {
    family: "provider-transport",
    retryable: true,
    retryPolicy: "bounded",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "retry",
  },
  PROVIDER_HTTP_ERROR: {
    family: "provider-http",
    retryable: true,
    retryPolicy: "policy",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "retry",
  },
  PROVIDER_MODEL_UNAVAILABLE: {
    family: "provider-http",
    retryable: false,
    retryPolicy: "none",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "diagnose",
  },
  PARSE_INVALID: {
    family: "parse-language",
    retryable: false,
    retryPolicy: "none",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "review",
  },
  LANGUAGE_INVALID: {
    family: "parse-language",
    retryable: false,
    retryPolicy: "none",
    repairable: true,
    canonicalCommitAllowed: false,
    userDisposition: "repair",
  },
  STRUCTURE_INVALID: {
    family: "parse-language",
    retryable: false,
    retryPolicy: "none",
    repairable: true,
    canonicalCommitAllowed: false,
    userDisposition: "repair",
  },
  HARD_RANGE_FAIL: {
    family: "integrity",
    retryable: false,
    retryPolicy: "none",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "review",
  },
  CONTENT_HASH_MISMATCH: {
    family: "integrity",
    retryable: false,
    retryPolicy: "none",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "rollback",
  },
  CHAPTER_NUMBER_MISMATCH: {
    family: "integrity",
    retryable: false,
    retryPolicy: "none",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "review",
  },
  QUALITY_BLOCKED: {
    family: "quality-blocker",
    retryable: false,
    retryPolicy: "none",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "review",
  },
  SPELLING_CRITICAL: {
    family: "quality-blocker",
    retryable: false,
    retryPolicy: "none",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "review",
  },
  HOOK_BLOCKER: {
    family: "quality-blocker",
    retryable: false,
    retryPolicy: "none",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "review",
  },
  QUALITY_REPAIR_REQUIRED: {
    family: "quality-repair",
    retryable: false,
    retryPolicy: "none",
    repairable: true,
    canonicalCommitAllowed: false,
    userDisposition: "repair",
  },
  SPELLING_REPAIR_REQUIRED: {
    family: "quality-repair",
    retryable: false,
    retryPolicy: "none",
    repairable: true,
    canonicalCommitAllowed: false,
    userDisposition: "repair",
  },
  HOOK_REPAIR_REQUIRED: {
    family: "quality-repair",
    retryable: false,
    retryPolicy: "none",
    repairable: true,
    canonicalCommitAllowed: false,
    userDisposition: "repair",
  },
  QUALITY_WARNING: {
    family: "warning",
    retryable: false,
    retryPolicy: "none",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "review",
  },
  PREFERRED_RANGE_WARNING: {
    family: "warning",
    retryable: false,
    retryPolicy: "none",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "review",
  },
  STATE_MISMATCH: {
    family: "state-recovery",
    retryable: false,
    retryPolicy: "controlled",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "recover",
  },
  ATOMIC_COMMIT_FAILED: {
    family: "state-recovery",
    retryable: false,
    retryPolicy: "controlled",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "recover",
  },
  STALE_LOCK: {
    family: "state-recovery",
    retryable: false,
    retryPolicy: "controlled",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "recover",
  },
  RESUME_INVALID: {
    family: "state-recovery",
    retryable: false,
    retryPolicy: "controlled",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "recover",
  },
  SECRET_DETECTED: {
    family: "security",
    retryable: false,
    retryPolicy: "none",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "rollback",
  },
  UNSAFE_PATH: {
    family: "security",
    retryable: false,
    retryPolicy: "none",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "rollback",
  },
  UNTRUSTED_ARTIFACT: {
    family: "security",
    retryable: false,
    retryPolicy: "none",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "rollback",
  },
  EPERM_DIST_WRITE: {
    family: "environment",
    retryable: true,
    retryPolicy: "controlled",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "diagnose",
  },
  RUNTIME_MISSING: {
    family: "environment",
    retryable: false,
    retryPolicy: "controlled",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "diagnose",
  },
  PROCESS_HUNG: {
    family: "environment",
    retryable: true,
    retryPolicy: "controlled",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "diagnose",
  },
  CONFIG_INVALID: {
    family: "configuration",
    retryable: false,
    retryPolicy: "none",
    repairable: false,
    canonicalCommitAllowed: false,
    userDisposition: "fallback",
  },
};

export function describePipelineError(
  code: PipelineErrorCode,
  stage: PipelineStage,
  evidenceRef?: string,
): PipelineErrorDescriptor {
  const definition = PIPELINE_ERROR_DEFINITIONS[code];
  return {
    code,
    ...definition,
    ...(evidenceRef ? { evidenceRef } : {}),
    stage,
  };
}

export type ChapterPipelineState =
  | "CREATED"
  | "PROVIDER_READY"
  | "DRAFT_CREATED"
  | "VALIDATED"
  | "AUDITED"
  | "BLOCKED"
  | "QUALITY_BLOCKED"
  | "REPAIR_REQUIRED"
  | "REPAIR_CANDIDATE_CREATED"
  | "REVALIDATED"
  | "PREVIEW_WITH_WARNINGS"
  | "READY_FOR_COMMIT"
  | "COMMITTED"
  | "PROVIDER_BLOCKED"
  | "PARSE_BLOCKED"
  | "SAFETY_BLOCKED"
  | "STATE_BLOCKED"
  | "RECOVERY_REQUIRED"
  | "CANCELLED"
  | "ENVIRONMENT_BLOCKED";

const ALLOWED_CHAPTER_TRANSITIONS: Record<ChapterPipelineState, readonly ChapterPipelineState[]> = {
  CREATED: ["PROVIDER_READY", "PROVIDER_BLOCKED", "ENVIRONMENT_BLOCKED", "CANCELLED"],
  PROVIDER_READY: ["DRAFT_CREATED", "PROVIDER_BLOCKED", "PARSE_BLOCKED", "ENVIRONMENT_BLOCKED", "CANCELLED"],
  DRAFT_CREATED: ["VALIDATED", "PARSE_BLOCKED", "SAFETY_BLOCKED", "ENVIRONMENT_BLOCKED", "CANCELLED"],
  VALIDATED: ["AUDITED", "SAFETY_BLOCKED", "STATE_BLOCKED", "CANCELLED"],
  AUDITED: [
    "BLOCKED",
    "QUALITY_BLOCKED",
    "REPAIR_REQUIRED",
    "PREVIEW_WITH_WARNINGS",
    "READY_FOR_COMMIT",
    "PROVIDER_BLOCKED",
    "PARSE_BLOCKED",
    "SAFETY_BLOCKED",
    "STATE_BLOCKED",
    "RECOVERY_REQUIRED",
    "ENVIRONMENT_BLOCKED",
    "CANCELLED",
  ],
  BLOCKED: ["RECOVERY_REQUIRED", "CANCELLED"],
  QUALITY_BLOCKED: ["RECOVERY_REQUIRED", "CANCELLED"],
  REPAIR_REQUIRED: ["REPAIR_CANDIDATE_CREATED", "QUALITY_BLOCKED", "BLOCKED", "CANCELLED"],
  REPAIR_CANDIDATE_CREATED: ["REVALIDATED", "RECOVERY_REQUIRED", "CANCELLED"],
  REVALIDATED: [
    "BLOCKED",
    "QUALITY_BLOCKED",
    "REPAIR_REQUIRED",
    "READY_FOR_COMMIT",
    "SAFETY_BLOCKED",
    "STATE_BLOCKED",
    "CANCELLED",
  ],
  PREVIEW_WITH_WARNINGS: ["READY_FOR_COMMIT", "RECOVERY_REQUIRED", "CANCELLED"],
  READY_FOR_COMMIT: ["COMMITTED", "STATE_BLOCKED", "RECOVERY_REQUIRED", "CANCELLED"],
  COMMITTED: [],
  PROVIDER_BLOCKED: ["RECOVERY_REQUIRED", "CANCELLED"],
  PARSE_BLOCKED: ["RECOVERY_REQUIRED", "CANCELLED"],
  SAFETY_BLOCKED: ["RECOVERY_REQUIRED", "CANCELLED"],
  STATE_BLOCKED: ["RECOVERY_REQUIRED", "CANCELLED"],
  RECOVERY_REQUIRED: ["PROVIDER_READY", "DRAFT_CREATED", "VALIDATED", "AUDITED", "CANCELLED"],
  CANCELLED: [],
  ENVIRONMENT_BLOCKED: ["RECOVERY_REQUIRED", "CANCELLED"],
};

export class ChapterStateTransitionError extends Error {
  readonly code = "STATE_TRANSITION_FORBIDDEN" as const;

  constructor(
    readonly from: ChapterPipelineState,
    readonly to: ChapterPipelineState,
  ) {
    super(`STATE_TRANSITION_FORBIDDEN: ${from} -> ${to}`);
    this.name = "ChapterStateTransitionError";
  }
}

export function isAllowedChapterTransition(
  from: ChapterPipelineState,
  to: ChapterPipelineState,
): boolean {
  return ALLOWED_CHAPTER_TRANSITIONS[from].includes(to);
}

export function assertChapterTransition(
  from: ChapterPipelineState,
  to: ChapterPipelineState,
): void {
  if (!isAllowedChapterTransition(from, to)) {
    throw new ChapterStateTransitionError(from, to);
  }
}
