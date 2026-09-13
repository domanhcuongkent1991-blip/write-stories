import { describe, expect, it } from "vitest";
import { applyMinorAuditAcceptance, decideAudit, evaluateRevisionCandidate, normalizeLegacyRevisionGate } from "../audit/audit-policy.js";
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

  it("fails closed when a verified critical blocker has no repair target", () => {
    const result = decideAudit(input({
      deterministicFindings: [{
        severity: "critical",
        category: "state",
        description: "broken invariant",
        suggestion: "inspect",
        ruleId: "state.invariant",
        evidence: { contentHash },
      }],
    }), {
      operation: "write",
      autoRevisionAllowed: true,
      revisionAttempts: 0,
      maxRevisionAttempts: 1,
    });

    expect(result).toMatchObject({ decision: "fail", passed: false });
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
    expect(result.findings.find((finding) => finding.ruleId === "continuity.character")?.verification)
      .toBe("unverified");
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

  it("accepts a hard-length repair when the passing audit score dips within the quality floor", () => {
    const overlongContent = Array.from({ length: 16 }, (_, index) => `từ${index}`).join(" ");
    const before = decideAudit(input({
      content: overlongContent,
      llmAudit: { passed: true, overallScore: 98, summary: "ok", issues: [] },
    }), { operation: "write", autoRevisionAllowed: true, revisionAttempts: 0, maxRevisionAttempts: 1 });
    const repairedContent = "Nội dung chương đã được rút gọn và vẫn đầy đủ nguyên nhân kết quả.\n";
    const after = decideAudit(input({
      content: repairedContent,
      operation: "re-audit",
      llmAudit: { passed: true, overallScore: 92, summary: "ok", issues: [] },
    }), {
      operation: "re-audit",
      autoRevisionAllowed: false,
      revisionAttempts: 1,
      maxRevisionAttempts: 1,
    });

    expect(before.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "length.hard-range", severity: "critical", verification: "verified" }),
    ]));
    expect(evaluateRevisionCandidate({
      before,
      after,
      beforeContentHash: before.contentHash,
      afterContentHash: after.contentHash,
      stateSettlementValid: true,
    })).toEqual({ accepted: true });
  });
});

describe("applyMinorAuditAcceptance", () => {
  const base = {
    passed: false,
    decision: "fail",
    overallScore: 92,
    issues: [{
      severity: "critical",
      category: "Chapter Memo Drift Check",
      description: "The chapter does not visibly deliver the required scene.",
      suggestion: "Add the scene.",
    }],
    summary: "fail",
  };

  it("accepts a single minor-issue fail at or above the score floor when enabled", () => {
    const accepted = applyMinorAuditAcceptance(base, { enabled: true });
    expect(accepted.passed).toBe(true);
    expect(accepted.decision).toBe("pass");
    expect(accepted.minorAccepted).toBe(true);
    expect(accepted.minorNotes).toEqual(["[Chapter Memo Drift Check] The chapter does not visibly deliver the required scene."]);
    expect(accepted.issues.some((issue) => issue.category === "minor-acceptance")).toBe(true);
  });

  it("leaves the verdict untouched when disabled", () => {
    expect(applyMinorAuditAcceptance(base, { enabled: false })).toEqual(base);
  });

  it("refuses scores below the floor", () => {
    expect(applyMinorAuditAcceptance({ ...base, overallScore: 89 }, { enabled: true })).toEqual({
      ...base,
      overallScore: 89,
    });
  });

  it("refuses more than one blocking issue", () => {
    expect(applyMinorAuditAcceptance({
      ...base,
      issues: [
        base.issues[0],
        { severity: "critical", category: "POV Consistency Check", description: "second", suggestion: "x" },
      ],
    }, { enabled: true })).toMatchObject({ passed: false, decision: "fail" });
  });

  it("refuses categories outside the minor policy", () => {
    expect(applyMinorAuditAcceptance({
      ...base,
      issues: [{ severity: "critical", category: "Hook Check", description: "carry-over missing", suggestion: "x" }],
    }, { enabled: true })).toMatchObject({ passed: false, decision: "fail" });
  });

  it("refuses parse failures and inconclusive verdicts", () => {
    expect(applyMinorAuditAcceptance({ ...base, parseFailed: true }, { enabled: true })).toMatchObject({
      passed: false,
      parseFailed: true,
    });
    expect(applyMinorAuditAcceptance({ ...base, decision: "inconclusive" }, { enabled: true })).toMatchObject({
      passed: false,
      decision: "inconclusive",
    });
  });

  it("accepts POV and transition categories by name, case-insensitively", () => {
    for (const category of ["POV Consistency Check", "Transition Continuity"]) {
      const accepted = applyMinorAuditAcceptance({
        ...base,
        issues: [{ severity: "critical", category, description: "note", suggestion: "x" }],
      }, { enabled: true });
      expect(accepted.minorAccepted).toBe(true);
    }
  });
});
