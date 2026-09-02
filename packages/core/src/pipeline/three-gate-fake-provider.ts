import {
  assertViPipelineOperationAllowed,
  createAuditReport,
  createCommitDecision,
  createDraftArtifact,
  createRepairCandidate,
  createValidationReport,
  describePipelineError,
  resolveViPipelineMode,
  ViPipelineModePolicyError,
  type AuditReport,
  type CommitDecision,
  type DraftArtifact,
  type RepairCandidate,
  type ValidationReport,
  type ViPipelineMode,
} from "./three-gate-contracts.js";

export type FakeProviderScenario =
  | "success"
  | "reasoning-only"
  | "empty"
  | "malformed"
  | "partial"
  | "timeout"
  | "transport"
  | "hard-range"
  | "repair-required"
  | "quality-blocked";

export interface FakeProviderOptions {
  readonly mode: ViPipelineMode | string;
  readonly bookId?: string;
  readonly canaryBookIds?: ReadonlyArray<string>;
  readonly promotionApproved?: boolean;
  readonly defaultOn?: boolean;
}

export interface FakeProviderScenarioResult {
  readonly scenario: FakeProviderScenario;
  readonly mode: ReturnType<typeof resolveViPipelineMode>;
  readonly providerAccepted: boolean;
  readonly disposition: "preview" | "committed" | "repair-required" | "blocked";
  readonly canonicalCommit: boolean;
  readonly errorCode?: string;
  readonly artifacts: {
    readonly draft?: DraftArtifact;
    readonly validation?: ValidationReport;
    readonly audit?: AuditReport;
    readonly repair?: RepairCandidate;
    readonly commit?: CommitDecision;
  };
}

const PROVIDER_ERROR_CODES: Partial<Record<FakeProviderScenario, Parameters<typeof describePipelineError>[0]>> = {
  "reasoning-only": "PROVIDER_REASONING_ONLY",
  empty: "PROVIDER_EMPTY",
  malformed: "PROVIDER_MALFORMED",
  partial: "PROVIDER_PARTIAL_RESPONSE",
  timeout: "PROVIDER_TIMEOUT",
  transport: "PROVIDER_TRANSPORT",
};

const MATRIX_SCENARIOS: ReadonlyArray<FakeProviderScenario> = [
  "success",
  "reasoning-only",
  "empty",
  "malformed",
  "partial",
  "timeout",
  "transport",
  "hard-range",
  "repair-required",
  "quality-blocked",
];

function createDraft(): DraftArtifact {
  return createDraftArtifact({
    draftId: "fake-draft-1",
    runId: "fake-run-1",
    bookId: "book-1",
    chapterNumber: 1,
    parentCanonicalCheckpoint: { hash: "parent-hash", chapterNumber: 0 },
    contentHash: "fake-draft-hash",
    contentLength: { count: 1200, countingMode: "vietnamese" },
    provider: { provider: "fake-provider", model: "fixture-model", transport: "responses" },
    createdAt: "2026-09-02T00:00:00.000Z",
    storagePath: "artifacts/drafts/fake-draft-1.json",
  });
}

function createPassingValidation(hash: string): ValidationReport {
  return createValidationReport({
    validatorVersion: "fake-validator-v1",
    checks: [{ id: "language", passed: true }, { id: "structure", passed: true }],
    hardBlockers: [],
    warnings: [],
    contentHash: hash,
    sourceDraftHash: hash,
    noSecretAssertion: true,
  });
}

function createCommit(mode: "preview" | "committed"): CommitDecision {
  return createCommitDecision({
    decision: mode,
    unresolvedBlockers: [],
    acceptedWarnings: [],
    canonicalCheckpointBeforeCommit: { hash: "parent-hash", chapterNumber: 0 },
    finalInvariants: { aligned: true, passed: true },
    atomicCommit: { status: mode === "committed" ? "committed" : "not-started" },
    rollbackReference: "fake-run-1",
  });
}

export function runThreeGateFakeProviderScenario(
  scenario: FakeProviderScenario,
  options: FakeProviderOptions,
): FakeProviderScenarioResult {
  const mode = resolveViPipelineMode(options.mode);
  const providerErrorCode = PROVIDER_ERROR_CODES[scenario];
  if (providerErrorCode) {
    return {
      scenario,
      mode,
      providerAccepted: false,
      disposition: "blocked",
      canonicalCommit: false,
      errorCode: describePipelineError(providerErrorCode, "provider").code,
      artifacts: {},
    };
  }

  const draft = createDraft();
  if (scenario === "hard-range") {
    const validation = createValidationReport({
      validatorVersion: "fake-validator-v1",
      checks: [{ id: "hard-range", passed: false }],
      hardBlockers: ["HARD_RANGE_FAIL"],
      warnings: [],
      contentHash: draft.contentHash,
      sourceDraftHash: draft.contentHash,
      noSecretAssertion: true,
    });
    return {
      scenario,
      mode,
      providerAccepted: true,
      disposition: "blocked",
      canonicalCommit: false,
      errorCode: "HARD_RANGE_FAIL",
      artifacts: { draft, validation },
    };
  }

  const validation = createPassingValidation(draft.contentHash);
  if (scenario === "quality-blocked") {
    const audit = createAuditReport({
      auditorVersion: "fake-auditor-v1",
      findings: [{
        ruleId: "VI.QUALITY.001",
        category: "continuity",
        severity: "critical",
        disposition: "blocked",
        description: "Verified structural blocker.",
      }],
      contentHash: draft.contentHash,
      auditedAt: "2026-09-02T00:00:00.000Z",
    });
    return {
      scenario,
      mode,
      providerAccepted: true,
      disposition: "blocked",
      canonicalCommit: false,
      errorCode: "QUALITY_BLOCKED",
      artifacts: { draft, validation, audit },
    };
  }

  if (scenario === "repair-required") {
    const audit = createAuditReport({
      auditorVersion: "fake-auditor-v1",
      findings: [{
        ruleId: "VI.SPELLING.001",
        category: "Vietnamese Spelling",
        severity: "critical",
        disposition: "repair-required",
        description: "Verified local spelling repair.",
        repairHint: { targetText: "sai", replacementText: "đúng" },
      }],
      contentHash: draft.contentHash,
      auditedAt: "2026-09-02T00:00:00.000Z",
    });
    const repair = createRepairCandidate({
      candidateId: "fake-candidate-1",
      sourceDraftHash: draft.contentHash,
      changedCandidateHash: "fake-candidate-hash",
      requestedFindingIds: ["VI.SPELLING.001"],
      repairAttempt: 1,
      diffSummary: "Replaced one verified spelling error.",
      validation: { passed: true, sourceDraftHash: "fake-candidate-hash" },
      audit: { passed: true, unresolvedBlockerCount: 0 },
      acceptance: "needs-review",
    });
    return {
      scenario,
      mode,
      providerAccepted: true,
      disposition: "repair-required",
      canonicalCommit: false,
      errorCode: "QUALITY_REPAIR_REQUIRED",
      artifacts: { draft, validation, audit, repair },
    };
  }

  if (mode.mode !== "preview") {
    try {
      assertViPipelineOperationAllowed({
        mode,
        operation: "write",
        bookId: options.bookId,
        canaryBookIds: options.canaryBookIds,
        promotionApproved: options.promotionApproved,
        defaultOn: options.defaultOn,
      });
    } catch (error) {
      return {
        scenario,
        mode,
        providerAccepted: true,
        disposition: "blocked",
        canonicalCommit: false,
        errorCode: error instanceof ViPipelineModePolicyError ? error.code : "DEFAULT_NOT_APPROVED",
        artifacts: { draft, validation },
      };
    }
  }

  const commitMode = mode.mode === "preview" ? "preview" : "committed";
  const commit = createCommit(commitMode);
  return {
    scenario,
    mode,
    providerAccepted: true,
    disposition: commitMode,
    canonicalCommit: commitMode === "committed",
    artifacts: { draft, validation, audit: createAuditReport({
      auditorVersion: "fake-auditor-v1",
      findings: [],
      contentHash: draft.contentHash,
      auditedAt: "2026-09-02T00:00:00.000Z",
    }), commit },
  };
}

export function runThreeGateFakeProviderMatrix(
  options: FakeProviderOptions,
): ReadonlyArray<FakeProviderScenarioResult> {
  return Object.freeze(MATRIX_SCENARIOS.map((scenario) => runThreeGateFakeProviderScenario(scenario, options)));
}
