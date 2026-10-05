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

  describe("score-fail repair routing", () => {
    const repairableFinding = {
      severity: "critical" as const,
      category: "Chapter Memo Drift Check",
      description: "Scene 3 lacks the required measured values.",
      suggestion: "Add the promised measurements.",
      ruleId: "memo-drift",
      repairTarget: "prose" as const,
      verification: "unverified" as const,
    };

    // Regression corpus: the LLM self-reported score is advisory only. These
    // are real observed scores from the Vietnamese pipeline, where an identical
    // chapter scored 90, 80 and 58 across runs while carrying no verified
    // critical finding. Gating pass/fail on that number looped chapters for
    // 9+ revise rounds chasing a value that never held still.
    it("passes a low-scoring chapter that carries no verified critical finding", () => {
      const result = decideAudit(input({
        llmAudit: { passed: false, overallScore: 58, summary: "needs work", issues: [repairableFinding] },
      }), {
        operation: "audit",
        autoRevisionAllowed: true,
        revisionAttempts: 0,
        maxRevisionAttempts: 1,
      });

      expect(result).toMatchObject({ decision: "pass", passed: true });
    });

    it("does not route a low score to repair even inside a legacy opt-in floor", () => {
      const result = decideAudit(input({
        llmAudit: { passed: false, overallScore: 82, summary: "needs work", issues: [repairableFinding] },
      }), {
        operation: "audit",
        autoRevisionAllowed: true,
        revisionAttempts: 0,
        maxRevisionAttempts: 1,
        scoreRepairFloorScore: 75,
      });

      expect(result).toMatchObject({ decision: "pass", passed: true });
    });

    it("passes at the same low score even when no revision budget remains", () => {
      const result = decideAudit(input({
        llmAudit: { passed: false, overallScore: 78, summary: "needs work", issues: [repairableFinding] },
      }), {
        operation: "re-audit",
        autoRevisionAllowed: false,
        revisionAttempts: 1,
        maxRevisionAttempts: 1,
      });

      expect(result).toMatchObject({ decision: "pass", passed: true });
    });

    it("passes when the only findings are informational", () => {
      const result = decideAudit(input({
        llmAudit: {
          passed: false,
          overallScore: 70,
          summary: "flat pacing",
          issues: [{ severity: "info" as const, category: "Pacing Check", description: "flat beat", suggestion: "" }],
        },
      }), {
        operation: "audit",
        autoRevisionAllowed: true,
        revisionAttempts: 0,
        maxRevisionAttempts: 1,
      });

      expect(result).toMatchObject({ decision: "pass", passed: true });
    });

    it("keeps a passing score passing regardless of the floor flag", () => {
      expect(decideAudit(input(), {
        operation: "audit",
        autoRevisionAllowed: true,
        revisionAttempts: 0,
        maxRevisionAttempts: 1,
        scoreRepairFloorScore: 75,
      })).toMatchObject({ decision: "pass", passed: true });
    });

    it("still routes a verified critical finding to repair, whatever the score", () => {
      const result = decideAudit(input({
        llmAudit: { passed: false, overallScore: 99, summary: "clean", issues: [] },
        stateFindings: [{
          severity: "critical",
          category: "hook-runtime-contradiction",
          description: "Expected hook H008 to resolve, but runtime evidence records defer.",
          suggestion: "Settle the hook or update the chapter intent.",
          ruleId: "hook.expected-operation",
          source: "state",
          verification: "verified",
          evidence: { contentHash },
          repairTarget: "runtime-state",
        }],
      }), {
        operation: "audit",
        autoRevisionAllowed: true,
        revisionAttempts: 0,
        maxRevisionAttempts: 1,
      });

      expect(result).toMatchObject({ decision: "repair-required", passed: false });
    });

    it("still refuses an unverified-only critical finding no matter the score", () => {
      const result = decideAudit(input({
        llmAudit: { passed: false, overallScore: 100, summary: "claims disaster", issues: [repairableFinding] },
      }), {
        operation: "audit",
        autoRevisionAllowed: true,
        revisionAttempts: 0,
        maxRevisionAttempts: 1,
      });

      expect(result).toMatchObject({ decision: "pass", passed: true });
    });
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

  it("accepts a single minor blocking issue whatever the score", () => {
    expect(applyMinorAuditAcceptance({ ...base, overallScore: 89 }, { enabled: true }))
      .toMatchObject({ passed: true, decision: "pass", minorAccepted: true });
  });

  it("accepts a single minor blocking issue even with no score reported", () => {
    expect(applyMinorAuditAcceptance({ ...base, overallScore: undefined }, { enabled: true }))
      .toMatchObject({ passed: true, decision: "pass", minorAccepted: true });
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
