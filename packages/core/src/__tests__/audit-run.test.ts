import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AuditRunV1Schema,
  assertAuditRunWriteOnce,
  createAuditRun,
  createAuditRunIdentity,
  createAuditRunWrite,
  markInitialRunSuperseded,
  serializeAuditRun,
} from "../audit/audit-run.js";

function run() {
  const operationId = randomUUID();
  const attemptId = randomUUID();
  return {
    schemaVersion: 1 as const,
    kind: "audit-run-v1" as const,
    operationId,
    attemptId,
    operation: "write" as const,
    phase: "initial" as const,
    bookId: "book-safe",
    chapterNumber: 7,
    startedAt: "2026-08-29T00:00:00.000Z",
    completedAt: "2026-08-29T00:00:01.000Z",
    durationMs: 1000,
    contentHash: "a".repeat(64),
    length: {
      count: 1000,
      countingMode: "vi_wordlike_tokens_v1" as const,
      target: 1000,
      softMin: 900,
      softMax: 1100,
      hardMin: 800,
      hardMax: 1200,
    },
    decision: "pass" as const,
    passed: true,
    findings: [{
      severity: "info" as const,
      category: "style",
      description: "kept",
      suggestion: "none",
      evidence: { contentHash: "a".repeat(64), excerpt: "x".repeat(2000) },
    }],
    revision: { attempted: false, candidateProduced: false, accepted: false },
    canonicalCommitOutcome: "terminal-commit" as const,
    retryCounts: { transport: 0, output: 0, quality: 0 },
  };
}

describe("AuditRunV1", () => {
  it("parses and serializes an allowlisted run without sensitive fields", () => {
    const value = { ...run(), prompt: "do not persist", apiKey: "secret", headers: { authorization: "secret" } };
    expect(() => AuditRunV1Schema.parse(value)).toThrow();

    const serialized = serializeAuditRun(run());
    expect(JSON.parse(serialized)).toEqual(AuditRunV1Schema.parse(JSON.parse(serialized)));
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("chain-of-thought");
    expect(JSON.parse(serialized).findings[0].evidence.excerpt.length).toBeLessThanOrEqual(500);
  });

  it("uses UUID identity and a path made only from chapter, UUID and phase", () => {
    const value = run();
    const write = createAuditRunWrite(value);
    expect(createAuditRunIdentity(value)).toBe(`${value.attemptId}:initial:${value.contentHash}`);
    expect(write.relativePath).toBe(`story/audit/runs/chapter-0007/${value.attemptId}.initial.audit-run-v1.json`);
    expect(write.relativePath).not.toContain(value.bookId);
  });

  it("treats the same attempt, phase and hash as idempotent and rejects a hash conflict", () => {
    const value = run();
    expect(assertAuditRunWriteOnce(value, { ...value })).toBe("idempotent");
    expect(() => assertAuditRunWriteOnce(value, { ...value, contentHash: "b".repeat(64) })).toThrowError(
      expect.objectContaining({ code: "STATE_PREFLIGHT_FAILED" }),
    );
  });

  it("marks the initial run superseded when a post-revision run exists", () => {
    const initial = run();
    const post = { ...run(), attemptId: initial.attemptId, phase: "post-revision" as const };
    expect(markInitialRunSuperseded(initial, post).canonicalCommitOutcome).toBe("superseded");
  });

  it("persists parse failure provenance while legacy runs remain compatible", () => {
    const legacy = run();
    expect(AuditRunV1Schema.parse(JSON.parse(serializeAuditRun(legacy))).parseFailed).toBeUndefined();

    const value = createAuditRun({
      bookId: legacy.bookId,
      chapterNumber: legacy.chapterNumber,
      operation: "write",
      phase: "initial",
      contentHash: legacy.contentHash,
      evaluation: {
        decision: "inconclusive",
        passed: false,
        findings: [],
        parseFailed: true,
        contentHash: legacy.contentHash,
      },
      length: legacy.length,
      startedAt: legacy.startedAt,
      completedAt: legacy.completedAt,
      durationMs: legacy.durationMs,
      operationId: legacy.operationId,
      attemptId: legacy.attemptId,
    });

    expect(value.parseFailed).toBe(true);
    expect(JSON.parse(serializeAuditRun(value))).toMatchObject({ parseFailed: true });
  });
});
