import { describe, expect, it } from "vitest";
import {
  canonicalizeChapterProse,
  computeAuditFingerprint,
  computeChapterContentHash,
  evaluateChapterAudit,
} from "../audit/chapter-audit-evaluator.js";

const lengthSpec = {
  target: 10,
  softMin: 8,
  softMax: 12,
  hardMin: 1,
  hardMax: 15,
  countingMode: "vi_wordlike_tokens_v1" as const,
};

const viShortLengthSpec = {
  target: 1150,
  softMin: 1000,
  softMax: 1300,
  hardMin: 1000,
  hardMax: 1500,
  countingMode: "vi_wordlike_tokens_v1" as const,
};

describe("chapter audit canonicalization", () => {
  it("normalizes line endings, BOM and Unicode while excluding non-prose Markdown", () => {
    const crlf = "\uFEFF---\r\ntitle: Một chương\r\n---\r\n# Tiêu đề\r\nCa\u0301nh  cửa mở.\r\n```ts\r\nconst secret = true;\r\n```\r\n";
    const lf = "Cánh  cửa mở.\n";

    expect(canonicalizeChapterProse(crlf)).toBe(lf);
    expect(computeChapterContentHash(crlf)).toBe(computeChapterContentHash(lf));
  });

  it("preserves whitespace inside prose lines and detects a one-character change", () => {
    expect(canonicalizeChapterProse("A  B\n")).toBe("A  B\n");
    expect(computeChapterContentHash("A  B\n")).not.toBe(computeChapterContentHash("A B\n"));
    expect(computeChapterContentHash("A  B\n")).not.toBe(computeChapterContentHash("A  C\n"));
  });
});

describe("evaluateChapterAudit", () => {
  function evaluateVietnameseLength(count: number) {
    return evaluateChapterAudit({
      content: `${"Một ".repeat(count)}câu.`,
      lengthSpec: viShortLengthSpec,
      operation: "audit",
      revisionAttempts: 0,
      maxRevisionAttempts: 1,
      autoRevisionAllowed: false,
      deterministicFindings: [],
      stateFindings: [],
      llmAudit: { passed: true, overallScore: 95, summary: "clean", issues: [] },
    });
  }

  it("accepts Vietnamese chapters inside the preferred range", () => {
    const result = evaluateVietnameseLength(1150);

    expect(result.decision).toBe("pass");
    expect(result.findings).toEqual([]);
  });

  it("warns but does not fail Vietnamese chapters above the preferred range", () => {
    const result = evaluateVietnameseLength(1350);

    expect(result.decision).toBe("pass");
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: "length.soft-range",
        severity: "warning",
        verification: "verified",
      }),
    ]));
  });

  it("blocks Vietnamese chapters below the lower bound or above the safety ceiling", () => {
    for (const count of [950, 1550]) {
      const result = evaluateVietnameseLength(count);

      expect(result.decision).toBe("repair-required");
      expect(result.passed).toBe(false);
      expect(result.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          ruleId: "length.hard-range",
          severity: "critical",
          verification: "verified",
        }),
      ]));
    }
  });

  it("marks LLM-only findings unverified and keeps the supplied audit metadata", () => {
    const content = "Một câu chuyện.\n";
    const result = evaluateChapterAudit({
      content,
      lengthSpec,
      operation: "audit",
      revisionAttempts: 0,
      maxRevisionAttempts: 1,
      autoRevisionAllowed: true,
      deterministicFindings: [],
      stateFindings: [],
      llmAudit: {
        passed: false,
        overallScore: 91,
        parseFailed: false,
        summary: "review",
        tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        issues: [{
          severity: "critical",
          category: "continuity",
          description: "model-only claim",
          suggestion: "inspect",
          ruleId: "continuity.character",
          repairTarget: "prose",
        }],
      },
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      source: "llm",
      verification: "unverified",
      evidence: { contentHash: computeChapterContentHash(content) },
    });
    expect(result.overallScore).toBe(91);
    expect(result.tokenUsage?.totalTokens).toBe(15);
  });

  it("returns inconclusive when a caller-provided hash does not match content", () => {
    const result = evaluateChapterAudit({
      content: "current",
      contentHash: "0".repeat(64),
      lengthSpec,
      operation: "audit",
      revisionAttempts: 0,
      maxRevisionAttempts: 1,
      autoRevisionAllowed: true,
      deterministicFindings: [],
      stateFindings: [],
      llmAudit: { passed: true, overallScore: 90, summary: "ok", issues: [] },
    });

    expect(result).toMatchObject({ decision: "inconclusive", passed: false });
  });

  it("preserves stale evidence hash instead of rewriting its provenance", () => {
    const staleHash = "f".repeat(64);
    const result = evaluateChapterAudit({
      content: "current",
      lengthSpec,
      operation: "audit",
      revisionAttempts: 0,
      maxRevisionAttempts: 1,
      autoRevisionAllowed: true,
      deterministicFindings: [{
        severity: "critical",
        category: "state",
        description: "stale fact",
        suggestion: "recheck",
        ruleId: "state.fact",
        evidence: { contentHash: staleHash, stateRef: "story/current_state.md#fact" },
      }],
      stateFindings: [],
      llmAudit: { passed: true, overallScore: 90, summary: "ok", issues: [] },
    });

    expect(result.findings[0]).toMatchObject({
      verification: "stale",
      evidence: { contentHash: staleHash, stateRef: "story/current_state.md#fact" },
    });
  });

  it("preserves an explicit unverified deterministic warning for heuristic checks", () => {
    const content = "Heuristic hook prose check.";
    const result = evaluateChapterAudit({
      content,
      operation: "audit",
      revisionAttempts: 0,
      maxRevisionAttempts: 1,
      autoRevisionAllowed: false,
      deterministicFindings: [{
        severity: "warning",
        category: "hook-keyword",
        description: "No matching keyword was found.",
        suggestion: "Review the prose manually.",
        verification: "unverified",
      }],
      stateFindings: [],
      llmAudit: { passed: true, overallScore: 90, summary: "ok", issues: [] },
    });

    expect(result.findings[0]).toMatchObject({
      source: "deterministic",
      verification: "unverified",
    });
  });
});

describe("computeAuditFingerprint", () => {
  it("uses structural identity only and changes when the invariant changes", () => {
    const base = {
      ruleId: "state.fact",
      entityIds: ["hero", "hook-1"],
      invariant: "inventory.nonnegative",
      description: "Vietnamese prose",
      chapterNumber: 7,
      model: "model-a",
      language: "vi",
    };

    const fingerprint = computeAuditFingerprint(base);
    expect(fingerprint).toBe(computeAuditFingerprint({
      ...base,
      description: "completely different prose",
      chapterNumber: 99,
      model: "model-b",
      language: "en",
    }));
    expect(fingerprint).not.toContain("prose");
    expect(fingerprint).not.toBe(computeAuditFingerprint({ ...base, invariant: "inventory.exists" }));
  });
});
