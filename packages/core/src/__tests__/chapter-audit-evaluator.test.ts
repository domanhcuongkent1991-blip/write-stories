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
