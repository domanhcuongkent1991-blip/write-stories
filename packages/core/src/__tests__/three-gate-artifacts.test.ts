import { describe, expect, it } from "vitest";
import {
  createAuditReport,
  createCommitDecision,
  createDraftArtifact,
  createRepairCandidate,
  createValidationReport,
} from "../pipeline/three-gate-contracts.js";

const lineage = {
  provider: "fake-provider",
  model: "fixture-model",
  transport: "responses" as const,
};

describe("three-gate artifact contracts", () => {
  it("creates an immutable draft with source checkpoint and provider lineage", () => {
    const draft = createDraftArtifact({
      draftId: "draft-1",
      runId: "run-1",
      bookId: "book-1",
      chapterNumber: 1,
      parentCanonicalCheckpoint: { hash: "parent-hash", chapterNumber: 0 },
      contentHash: "draft-hash",
      contentLength: { count: 1200, countingMode: "vietnamese" },
      provider: lineage,
      createdAt: "2026-09-02T00:00:00.000Z",
      storagePath: "artifacts/drafts/draft-1.json",
    });

    expect(Object.isFrozen(draft)).toBe(true);
    expect(draft.schemaVersion).toBe(1);
    expect(draft.parentCanonicalCheckpoint.chapterNumber).toBe(0);
    expect(draft.provider.model).toBe("fixture-model");
  });

  it("requires a no-secret assertion and binds validation to the draft hash", () => {
    const report = createValidationReport({
      validatorVersion: "validator-v1",
      checks: [{ id: "language", passed: true }],
      hardBlockers: [],
      warnings: [],
      contentHash: "draft-hash",
      sourceDraftHash: "draft-hash",
      noSecretAssertion: true,
    });

    expect(Object.isFrozen(report)).toBe(true);
    expect(report.noSecretAssertion).toBe(true);
    expect(() => createValidationReport({
      validatorVersion: "validator-v1",
      checks: [],
      hardBlockers: [],
      warnings: [],
      contentHash: "changed-hash",
      sourceDraftHash: "draft-hash",
      noSecretAssertion: true,
    })).toThrow(/content hash/i);
  });

  it("keeps audit disposition separate from severity and preserves repair hints", () => {
    const report = createAuditReport({
      auditorVersion: "auditor-v1",
      findings: [{
        ruleId: "VI.SPELLING.001",
        category: "Vietnamese Spelling",
        severity: "critical",
        disposition: "repair-required",
        description: "A verified spelling error requires an exact replacement.",
        repairHint: { targetText: "sai", replacementText: "đúng" },
      }],
      contentHash: "draft-hash",
      auditedAt: "2026-09-02T00:00:00.000Z",
    });

    expect(report.findings[0]?.disposition).toBe("repair-required");
    expect(report.findings[0]?.repairHint?.replacementText).toBe("đúng");
    expect(() => createAuditReport({
      auditorVersion: "auditor-v1",
      findings: [{
        ruleId: "VI.SPELLING.001",
        category: "Vietnamese Spelling",
        severity: "critical",
        disposition: "repair-required",
        description: "Missing exact replacement.",
      }],
      contentHash: "draft-hash",
      auditedAt: "2026-09-02T00:00:00.000Z",
    })).toThrow(/repair hint/i);
  });

  it("allows repair candidates only as new hashes with bounded attempts", () => {
    const candidate = createRepairCandidate({
      candidateId: "candidate-1",
      sourceDraftHash: "draft-hash",
      changedCandidateHash: "candidate-hash",
      requestedFindingIds: ["VI.SPELLING.001"],
      repairAttempt: 1,
      diffSummary: "Replaced one verified spelling error.",
      validation: { passed: true, sourceDraftHash: "candidate-hash" },
      audit: { passed: true, unresolvedBlockerCount: 0 },
      acceptance: "accepted",
    });

    expect(Object.isFrozen(candidate)).toBe(true);
    expect(candidate.changedCandidateHash).not.toBe(candidate.sourceDraftHash);
    expect(() => createRepairCandidate({
      ...candidate,
      repairAttempt: 0,
    })).toThrow(/attempt/i);
  });

  it("does not allow a ready commit with blockers or failed invariants", () => {
    expect(() => createCommitDecision({
      decision: "ready-for-commit",
      unresolvedBlockers: ["QUALITY_BLOCKED"],
      acceptedWarnings: [],
      canonicalCheckpointBeforeCommit: { hash: "parent-hash", chapterNumber: 0 },
      finalInvariants: { aligned: true, passed: true },
      atomicCommit: { status: "not-started" },
      rollbackReference: "run-1",
    })).toThrow(/blocker/i);

    const preview = createCommitDecision({
      decision: "preview",
      unresolvedBlockers: [],
      acceptedWarnings: [],
      canonicalCheckpointBeforeCommit: { hash: "parent-hash", chapterNumber: 0 },
      finalInvariants: { aligned: true, passed: true },
      atomicCommit: { status: "not-started" },
      rollbackReference: "run-1",
    });
    expect(preview.atomicCommit.status).toBe("not-started");
  });
});
