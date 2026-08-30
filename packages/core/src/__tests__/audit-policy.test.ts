import { describe, expect, it } from "vitest";
import { decideAudit, evaluateRevisionCandidate, normalizeLegacyRevisionGate } from "../audit/audit-policy.js";
import { computeChapterContentHash } from "../audit/chapter-audit-evaluator.js";

const content = "Nội dung chương.\n";
const contentHash = computeChapterContentHash(content);
const lengthSpec = {
  target: 10,
  softMin: 8,
  softMax: 12,
  hardMin: 1,
  hardMax: 15,
  countingMode: "vi_wordlike_tokens_v1" as const,
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    content,
    lengthSpec,
    llmAudit: { passed: true, overallScore: 90, summary: "ok", issues: [] },
    deterministicFindings: [],
    stateFindings: [],
    operation: "audit" as const,
    revisionAttempts: 0,
    maxRevisionAttempts: 1,
    autoRevisionAllowed: true,
    ...overrides,
  };
}

describe("decideAudit", () => {
  it("passes only a complete score-qualified evaluation without verified blockers", () => {
    expect(decideAudit(input(), {
      operation: "audit",
      autoRevisionAllowed: true,
      revisionAttempts: 0,
      maxRevisionAttempts: 1,
    })).toMatchObject({ decision: "pass", passed: true });
  });

  it("requests one repair for a verified blocker with current evidence and a repair target", () => {
    const result = decideAudit(input({
      deterministicFindings: [{
        severity: "critical",
        category: "length",
        description: "too short",
        suggestion: "expand",
        ruleId: "length.hard-range",
        repairTarget: "prose",
        evidence: { contentHash },
      }],
    }), {
      operation: "write",
      autoRevisionAllowed: true,
      revisionAttempts: 0,
      maxRevisionAttempts: 1,
      legacyRevisionGate: "always",
    });

    expect(result).toMatchObject({ decision: "repair-required", passed: false });
  });

  it("does not spend a second quality revision", () => {
    const result = decideAudit(input({
      operation: "re-audit",
      revisionAttempts: 1,
      deterministicFindings: [{
        severity: "critical",
        category: "state",
        description: "still broken",
        suggestion: "repair",
        ruleId: "state.fact",
        repairTarget: "runtime-state",
      }],
    }), {
      operation: "re-audit",
      autoRevisionAllowed: true,
      revisionAttempts: 1,
      maxRevisionAttempts: 9,
    });

    expect(result.decision).toBe("fail");
  });

  it.each([
    { llmAudit: { passed: false, parseFailed: true, summary: "bad", issues: [] } },
    { llmAudit: { passed: true, summary: "missing score", issues: [] } },
  ])("is inconclusive for insufficient evaluator data", (overrides) => {
    expect(decideAudit(input(overrides), {
      operation: "audit",
      autoRevisionAllowed: true,
      revisionAttempts: 0,
      maxRevisionAttempts: 1,
    })).toMatchObject({ decision: "inconclusive", passed: false });
  });

  it("keeps an uncorroborated LLM finding without turning it into a blocker", () => {
    const result = decideAudit(input({
      llmAudit: {
        passed: false,
        overallScore: 90,
        summary: "claim",
        issues: [{
          severity: "critical",
          category: "continuity",
          description: "uncorroborated",
          suggestion: "inspect",
          ruleId: "continuity.character",
          repairTarget: "prose",
        }],
      },
    }), {
      operation: "audit",
      autoRevisionAllowed: true,
      revisionAttempts: 0,
      maxRevisionAttempts: 1,
    });

    expect(result.decision).toBe("pass");
    expect(result.findings[0]?.verification).toBe("unverified");
  });
});

describe("revision acceptance", () => {
  it("normalizes the legacy always gate to strict", () => {
    expect(normalizeLegacyRevisionGate("always")).toBe("strict");
  });

  it("accepts only an improved, changed, state-valid candidate", () => {
    const before = decideAudit(input({
      deterministicFindings: [{
        severity: "critical",
        category: "length",
        description: "short",
        suggestion: "expand",
        ruleId: "length.hard-range",
        repairTarget: "prose",
      }],
    }), { operation: "write", autoRevisionAllowed: true, revisionAttempts: 0, maxRevisionAttempts: 1 });
    const after = decideAudit(input({ content: "Nội dung chương đã sửa.\n", operation: "re-audit" }), {
      operation: "re-audit",
      autoRevisionAllowed: false,
      revisionAttempts: 1,
      maxRevisionAttempts: 1,
    });

    expect(evaluateRevisionCandidate({
      before,
      after,
      beforeContentHash: before.contentHash,
      afterContentHash: after.contentHash,
      stateSettlementValid: true,
    })).toEqual({ accepted: true });
  });
});
