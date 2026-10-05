import { describe, expect, it, vi } from "vitest";
import { bindVietnameseAuditorProperNounFindings, runChapterReviewCycle } from "../pipeline/chapter-review-cycle.js";
import { computeChapterContentHash } from "../audit/chapter-audit-evaluator.js";
import { countChapterLength } from "../utils/length-metrics.js";
import type { AuditResult, AuditIssue } from "../agents/continuity.js";
import type { LengthSpec } from "../models/length-governance.js";

const LENGTH_SPEC: LengthSpec = {
  target: 220,
  softMin: 190,
  softMax: 250,
  hardMin: 160,
  hardMax: 280,
  countingMode: "zh_chars",
};

const VI_LENGTH_SPEC: LengthSpec = {
  target: 1150,
  softMin: 1100,
  softMax: 1300,
  hardMin: 1000,
  hardMax: 1800,
  countingMode: "vi_wordlike_tokens_v1",
};

const ZERO_USAGE: { promptTokens: number; completionTokens: number; totalTokens: number } = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

const DETERMINISTIC_REPAIR: AuditIssue = {
  severity: "critical",
  category: "deterministic-repair",
  description: "deterministic blocker",
  suggestion: "repair prose",
  repairTarget: "prose",
};

function createAuditResult(overrides?: Partial<AuditResult>): AuditResult {
  return {
    passed: true,
    issues: [],
    summary: "clean",
    overallScore: 90,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures for the Vietnamese output-language guard on revision candidates.
// ---------------------------------------------------------------------------

/** Plain Vietnamese prose with real diacritics; 86 sentences = 1145 vi wordlike tokens, inside VI_LENGTH_SPEC. */
const VI_CHAPTER_SENTENCES: ReadonlyArray<string> = [
  "Gió đêm thổi ngang qua vòm tháp cổ, mang theo mùi muối biển mặn.",
  "Lâm Hàn đứng bên lan can, mắt nhìn xuống mặt nước đen như mực.",
  "Cô gái trẻ ngồi co ro ở góc thuyền, hai tay ôm chặt chiếc túi vải.",
  "Tiếng chuông chùa vọng xa trong sương sớm mờ mịt bốn phía.",
  "Anh nhìn cô, ánh mắt dịu lại trước khi quay sang bờ bên kia.",
  "Mưa bắt đầu rơi, từng giọt gõ lên mặt tàu gỗ cũ kỹ.",
  "Ngọn lửa trong bếp lá bùng lên rồi tắt ngúm trong tích tắc.",
  "Con đường lát đá rêu xanh ướt nước dẫn vào rừng thông.",
  "Bà cụ ngồi khoanh tay, nhìn cô chằm chằm không nói một lời nào.",
  "Cuốn sách cổ trên bàn bật ra những trang giấy ố vàng khắc chữ.",
  "Ngoài kia, chói lửa đỏ rực xuống mái nhà vàng vọt của thị trấn.",
  "Đường phố vắng tanh, chỉ có tiếng bước chân vọng lại trên nền đá.",
  "Cô đưa tay nhận lấy phong thư, ngón tay hơi run một chút.",
  "Mùi hương hoa nhài thoang thoảng bay trong gió chiều.",
  "Anh gật đầu, ánh mắt kiên định nhìn về phía cuối đường.",
];

const VI_CANONICAL_CHAPTER = Array.from(
  { length: 86 },
  (_unused, index) => VI_CHAPTER_SENTENCES[index % VI_CHAPTER_SENTENCES.length],
).join(" ");

/** Distinctive marker so assertions can prove the non-Vietnamese draft never reached the auditor. */
const ENGLISH_CANDIDATE_MARKER = "ENGLISH-CANDIDATE-MARKER-Q7";

const ENGLISH_CANDIDATE_SENTENCES: ReadonlyArray<string> = [
  "the stranger in the grey coat refused to answer a single question about the night that followed",
  "he walked the length of the empty pier without once turning his head toward the lamp",
  "the harbour master said nothing and only turned the page of his weather ledger",
  "every sailor on the deck had learned long ago not to ask about the ninth lantern",
  "the fog came in off the water and swallowed the masts one after another",
  "she counted the seconds between the bell strokes and lost track after the seventh",
  "a rope snapped somewhere below and the sound travelled up through the planks",
  "he wrote the number on his palm and then washed it off with cold seawater",
  "the man in the grey coat refused to explain where he had learned the old names",
  "by midnight the whole pier was empty and the lantern had gone out on its own",
];

/** 8 sentences = 512 Latin chars, 0 Vietnamese marked chars, so vi-output-language-mismatch fires. */
const ENGLISH_CANDIDATE = `${ENGLISH_CANDIDATE_MARKER}. ${Array.from(
  { length: 8 },
  (_unused, index) => ENGLISH_CANDIDATE_SENTENCES[index % ENGLISH_CANDIDATE_SENTENCES.length],
).join(". ")}.`;

const baseParams = {
  book: { genre: "xuanhuan" },
  bookDir: "/tmp/book",
  chapterNumber: 1,
  lengthSpec: LENGTH_SPEC,
  reducedControlInput: undefined,
  initialUsage: ZERO_USAGE,
  assertChapterContentNotEmpty: () => undefined,
  addUsage: (left: typeof ZERO_USAGE, right?: typeof ZERO_USAGE) => ({
    promptTokens: left.promptTokens + (right?.promptTokens ?? 0),
    completionTokens: left.completionTokens + (right?.completionTokens ?? 0),
    totalTokens: left.totalTokens + (right?.totalTokens ?? 0),
  }),
  analyzeAITells: () => ({ issues: [] as AuditIssue[] }),
  analyzeSensitiveWords: () => ({ found: [] as Array<{ severity: "warn" | "block" }>, issues: [] as AuditIssue[] }),
  logWarn: () => undefined,
  logStage: () => undefined,
} as const;

describe("runChapterReviewCycle v9", () => {
  it("merges initial truth findings and overrides into the first assessment", async () => {
    const content = "b".repeat(200);
    const stateFinding: AuditIssue = {
      severity: "critical",
      category: "hook-runtime-contradiction",
      description: "The initial settlement resolves a hook that the prose leaves open.",
      suggestion: "Repair runtime truth before revising prose.",
      source: "state",
      verification: "verified",
      repairTarget: "runtime-state",
      evidence: { contentHash: computeChapterContentHash(content), stateRef: "runtime:hook:H006" },
    };
    const truthFileOverrides = {
      currentState: "validated state",
      ledger: "validated ledger",
      hooks: "validated hooks",
    };
    const auditChapter = vi.fn().mockResolvedValue(createAuditResult({
      passed: true,
      decision: "pass",
      overallScore: 95,
    }));

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: { content, wordCount: content.length, postWriteErrors: [] },
      initialStateFindings: [stateFinding],
      initialTruthFileOverrides: truthFileOverrides,
      createReviser: () => ({ reviseChapter: vi.fn() }),
      auditor: { auditChapter },
      maxReviewIterations: 0,
    });

    expect(auditChapter.mock.calls[0]?.[4]?.truthFileOverrides).toEqual(truthFileOverrides);
    expect(result.auditResult.decision).toBe("repair-required");
    expect(result.auditResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "hook-runtime-contradiction", verification: "verified" }),
    ]));
  });

  it("aggregates auditor usage across initial and post-revision assessments", async () => {
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        decision: "repair-required",
        overallScore: 70,
        issues: [DETERMINISTIC_REPAIR],
        tokenUsage: { promptTokens: 11, completionTokens: 3, totalTokens: 14 },
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        decision: "pass",
        overallScore: 95,
        tokenUsage: { promptTokens: 17, completionTokens: 5, totalTokens: 22 },
      }));
    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "b".repeat(200),
        wordCount: 200,
        postWriteErrors: [{ rule: "deterministic", severity: "error", description: "repair", suggestion: "repair" }],
      },
      auditor: { auditChapter },
      createReviser: () => ({ reviseChapter: vi.fn().mockResolvedValue({
        revisedContent: "a".repeat(200),
        wordCount: 200,
        fixedIssues: [],
        updatedState: "",
        updatedLedger: "",
        updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      }) }),
    });
    expect(auditChapter).toHaveBeenCalledTimes(2);
    expect(result.auditorTokenUsage).toEqual({ promptTokens: 28, completionTokens: 8, totalTokens: 36 });
  });

  it("feeds postWriteErrors as extra issues into first assessment", async () => {
    // postWriteErrors are critical → auditResult.passed forced false
    // even though LLM says passed=true. This triggers the repair loop.
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({ overallScore: 90, passed: true }))
      .mockResolvedValueOnce(createAuditResult({ overallScore: 92, passed: true }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent: "a".repeat(200),
      wordCount: 200,
      fixedIssues: ["fixed"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });
    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "b".repeat(200),
        wordCount: 200,
        postWriteErrors: [{
          rule: "chapter-number-reference",
          description: "contains chapter ref",
          suggestion: "remove it",
          severity: "error",
        }],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      // Simulates: the reviser fixed the chapter-ref, so re-check returns empty
      runPostWriteChecks: (content) =>
        content === "b".repeat(200)
          ? [{ severity: "critical" as const, category: "chapter-number-reference", description: "contains chapter ref", suggestion: "remove it" }]
          : [],
    });

    // After repair, postWriteChecks on the revised content returns empty → issue gone
    expect(result.auditResult.issues.some(i => i.category === "chapter-number-reference")).toBe(false);
    // The loop should have run at least once to fix the critical postWriteError
    expect(reviseChapter).toHaveBeenCalled();
    expect(reviseChapter.mock.calls[0]?.[4]).toBe("auto");
  });

  it("does not auto-revise when audit output parsing failed", async () => {
    const originalContent = "b".repeat(200);
    const auditChapter = vi.fn().mockResolvedValue(createAuditResult({
      passed: false,
      overallScore: 0,
      parseFailed: true,
      summary: "审稿输出解析失败",
      issues: [{
        severity: "critical",
        category: "系统错误",
        description: "审稿输出格式异常，无法解析为 JSON",
        suggestion: "检查模型输出格式",
      }],
    }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent: "a".repeat(200),
      wordCount: 200,
      fixedIssues: ["should not run"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });
    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: originalContent,
        wordCount: originalContent.length,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      maxReviewIterations: 1,
    });

    expect(reviseChapter).not.toHaveBeenCalled();
    expect(result.finalContent).toBe(originalContent);
    expect(result.revised).toBe(false);
    expect(result.auditResult.parseFailed).toBe(true);
  });

  it("re-audits once when the first audit cannot parse and accepts the recovered verdict", async () => {
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 0,
        parseFailed: true,
        parseFailedReason: "unparseable-output",
        summary: "审稿输出解析失败",
      }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, decision: "pass", overallScore: 92 }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent: "a".repeat(200),
      wordCount: 200,
      fixedIssues: [],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });
    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "b".repeat(200),
        wordCount: 200,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      maxReviewIterations: 1,
    });

    expect(auditChapter).toHaveBeenCalledTimes(2);
    expect(result.auditResult.parseFailed).not.toBe(true);
    expect(result.auditResult.reAudit).toEqual({ attempted: true, priorParseFailedReason: "unparseable-output" });
    expect(result.auditResult.decision).toBe("pass");
    expect(reviseChapter).not.toHaveBeenCalled();
  });

  it("keeps the fail-closed result when the re-audit also cannot parse", async () => {
    const auditChapter = vi.fn().mockResolvedValue(createAuditResult({
      passed: false,
      overallScore: 0,
      parseFailed: true,
      parseFailedReason: "evidence-not-bound",
      summary: "transition evidence did not bind",
    }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent: "a".repeat(200),
      wordCount: 200,
      fixedIssues: ["should not run"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });
    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "b".repeat(200),
        wordCount: 200,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      maxReviewIterations: 1,
    });

    expect(auditChapter).toHaveBeenCalledTimes(2);
    expect(result.auditResult.parseFailed).toBe(true);
    expect(result.auditResult.parseFailedReason).toBe("evidence-not-bound");
    expect(result.auditResult.reAudit).toEqual({ attempted: true, priorParseFailedReason: "evidence-not-bound" });
    expect(result.revised).toBe(false);
  });

  it("turns hard-range drift into an explicit reviser issue and only passes after repair", async () => {
    const shortDraft = "短".repeat(80);
    const repairedDraft = "修".repeat(220);
    const auditChapter = vi.fn().mockResolvedValue(createAuditResult({ passed: true, overallScore: 90 }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent: repairedDraft,
      wordCount: repairedDraft.length,
      fixedIssues: ["length-budget"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: shortDraft,
        wordCount: shortDraft.length,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
    });

    expect(reviseChapter.mock.calls[0]?.[3]).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "length", ruleId: "length.hard-range", severity: "critical" }),
    ]));
    expect((reviseChapter.mock.calls[0]?.[3] ?? []).filter(
      (issue: AuditIssue) => issue.ruleId === "length.hard-range",
    )).toHaveLength(1);
    expect(result.finalContent).toBe(repairedDraft);
    expect(result.auditResult.passed).toBe(true);
    expect(result.repairApplied).toBe(true);
    expect(result.auditResult.issues.filter((issue) => issue.ruleId === "length.hard-range")).toHaveLength(0);
  });

  it("rejects an overlong revision without spending a second structural call", async () => {
    const original = "nguyên bản ".repeat(1900);
    const candidate = "bản sửa ".repeat(1900);
    const auditChapter = vi.fn().mockResolvedValue(createAuditResult({ passed: true, overallScore: 95 }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent: candidate,
      wordCount: candidate.length,
      fixedIssues: ["length-budget"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });
    const settleRevisionCandidate = vi.fn().mockResolvedValue({ valid: true });

    const result = await runChapterReviewCycle({
      ...baseParams,
      lengthSpec: VI_LENGTH_SPEC,
      initialOutput: { content: original, wordCount: original.length, postWriteErrors: [] },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      settleRevisionCandidate,
    });

    expect(reviseChapter).toHaveBeenCalledTimes(1);
    expect(settleRevisionCandidate).not.toHaveBeenCalled();
    expect(auditChapter).toHaveBeenCalledTimes(1);
    expect(result.finalContent).toBe(original);
    expect(result.revised).toBe(false);
    expect(result.auditResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "length.hard-range", severity: "critical" }),
    ]));
  });

  it("does not use a second Vietnamese length-rescue call before settlement", async () => {
    const words = (count: number, prefix: string) => Array.from(
      { length: count },
      (_, index) => `${prefix}${index}`,
    ).join(" ");
    const original = words(2100, "goc");
    const firstCandidate = words(1850, "sua");
    const rescuedCandidate = words(1200, "gon");
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({ passed: true, overallScore: 96 }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, overallScore: 95 }));
    const reviseChapter = vi.fn()
      .mockResolvedValueOnce({
        revisedContent: firstCandidate,
        wordCount: 1550,
        fixedIssues: ["length-budget"],
        tokenUsage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        revisedContent: rescuedCandidate,
        wordCount: 1200,
        fixedIssues: ["length-rescue"],
        tokenUsage: ZERO_USAGE,
      });
    const settleRevisionCandidate = vi.fn().mockResolvedValue({ valid: true });

    const result = await runChapterReviewCycle({
      ...baseParams,
      bookId: "book-vi-rescue",
      lengthSpec: VI_LENGTH_SPEC,
      initialOutput: { content: original, wordCount: 2100, postWriteErrors: [] },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      settleRevisionCandidate,
    });

    expect(reviseChapter).toHaveBeenCalledTimes(1);
    expect(settleRevisionCandidate).not.toHaveBeenCalled();
    expect(result.finalContent).toBe(original);
    expect(result.revised).toBe(false);
  });

  it("rejects a longer Vietnamese revision without a second provider call", async () => {
    const words = (count: number, prefix: string) => Array.from(
      { length: count },
      (_, index) => `${prefix}${index}`,
    ).join(" ");
    const original = words(1859, "goc");
    const worseCandidate = words(1891, "dai");
    const rescuedCandidate = words(1200, "gon");
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({ passed: true, overallScore: 96 }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, overallScore: 95 }));
    const reviseChapter = vi.fn()
      .mockResolvedValueOnce({
        revisedContent: worseCandidate,
        wordCount: 1691,
        fixedIssues: ["length-budget"],
        tokenUsage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        revisedContent: rescuedCandidate,
        wordCount: 1200,
        fixedIssues: ["length-rescue"],
        tokenUsage: ZERO_USAGE,
      });
    const settleRevisionCandidate = vi.fn().mockResolvedValue({ valid: true });

    const result = await runChapterReviewCycle({
      ...baseParams,
      bookId: "book-vi-worse-revision-rescue",
      lengthSpec: VI_LENGTH_SPEC,
      initialOutput: { content: original, wordCount: 1859, postWriteErrors: [] },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      settleRevisionCandidate,
    });

    expect(reviseChapter).toHaveBeenCalledTimes(1);
    expect(settleRevisionCandidate).not.toHaveBeenCalled();
    expect(result.finalContent).toBe(original);
    expect(result.revised).toBe(false);
  });

  it("accepts a 1533-word Vietnamese chapter with a warning and no length repair", async () => {
    const draft = Array.from({ length: 1533 }, (_, index) => `tu${index}`).join(" ");
    const auditChapter = vi.fn().mockResolvedValue(createAuditResult({ passed: true, overallScore: 92 }));
    const reviseChapter = vi.fn();

    const result = await runChapterReviewCycle({
      ...baseParams,
      lengthSpec: VI_LENGTH_SPEC,
      initialOutput: { content: draft, wordCount: 1533, postWriteErrors: [] },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
    });

    expect(reviseChapter).not.toHaveBeenCalled();
    expect(result.finalWordCount).toBe(1533);
    expect(result.auditResult.decision).toBe("pass");
    expect(result.auditResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "length.soft-range", severity: "warning" }),
    ]));
  });

  it("binds and applies an exact spelling repair without constructing the Reviser", async () => {
    const filler = Array.from({ length: 1428 }, (_, index) => `từ${index}`).join(" ");
    const original = `${filler} cụm từ sai`;
    const candidate = `${filler} cụm từ đúng`;
    const spellingIssue: AuditIssue = {
      severity: "info",
      category: "Style Check",
      description: "Xuất hiện lỗi đánh máy: 'cụm từ sai'.",
      suggestion: "Thay bằng 'cụm từ đúng'.",
      repairScope: "local",
      repairHint: {
        kind: "exact-replacement",
        targetText: "cụm từ sai",
        replacementText: "cụm từ đúng",
        occurrenceIndexes: [1],
        context: "... cụm từ sai ...",
      },
    };
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({ passed: true, overallScore: 94, issues: [spellingIssue] }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, overallScore: 95, issues: [] }));
    const reviseChapter = vi.fn();
    const createReviser = vi.fn(() => ({ reviseChapter }));
    const settleRevisionCandidate = vi.fn(async () => ({ valid: true }));

    const result = await runChapterReviewCycle({
      ...baseParams,
      lengthSpec: VI_LENGTH_SPEC,
      initialOutput: { content: original, wordCount: 1431, postWriteErrors: [] },
      createReviser,
      auditor: { auditChapter },
      settleRevisionCandidate,
    });

    expect(createReviser).not.toHaveBeenCalled();
    expect(reviseChapter).not.toHaveBeenCalled();
    expect(settleRevisionCandidate).toHaveBeenCalledWith(candidate, expect.objectContaining({
      repairKind: "deterministic-exact",
    }));
    expect(result.finalContent).toBe(candidate);
    expect(result.auditResult.decision).toBe("pass");
    expect(result.localRepair).toMatchObject({ applied: true, patchCount: 1 });
  });

  it("routes a host-bound transition contradiction through the bounded revision cycle", async () => {
    const original = Array.from({ length: 1150 }, (_, index) => `gốc${index}`).join(" ");
    const candidate = Array.from({ length: 1150 }, (_, index) => `sửa${index}`).join(" ");
    const transitionFinding: AuditIssue = {
      severity: "critical",
      category: "Transition Continuity",
      description: "Mực nước đổi từ 1,22m sang 1,34m mà không có nguyên nhân.",
      suggestion: "Giữ mốc đã chốt hoặc mô tả nguyên nhân thay đổi.",
      ruleId: "continuity.transition",
      source: "deterministic",
      verification: "verified",
      repairScope: "structural",
      repairTarget: "prose",
      lifecycle: "open",
    };
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 92,
        hostFindings: [transitionFinding],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        overallScore: 95,
        hostFindings: [],
      }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent: candidate,
      wordCount: 1150,
      fixedIssues: ["transition"],
      tokenUsage: ZERO_USAGE,
    });

    const result = await runChapterReviewCycle({
      ...baseParams,
      lengthSpec: VI_LENGTH_SPEC,
      initialOutput: { content: original, wordCount: 1150, postWriteErrors: [] },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      settleRevisionCandidate: async () => ({ valid: true }),
    });

    expect(reviseChapter.mock.calls[0]?.[3]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: "continuity.transition",
        verification: "verified",
        repairScope: "structural",
      }),
    ]));
    expect(auditChapter).toHaveBeenCalledTimes(2);
    expect(result.finalContent).toBe(candidate);
    expect(result.auditResult.decision).toBe("pass");
  });

  it("applies local spelling first and then spends exactly one structural revision call", async () => {
    const filler = Array.from({ length: 1140 }, (_, index) => `từ${index}`).join(" ");
    const original = `${filler} lầy bơi`;
    const patched = `${filler} bãi bùn đất lầy lội`;
    const structurallyRevised = `${patched} với nguyên nhân chuyển cảnh rõ ràng`;
    const spellingIssue: AuditIssue = {
      severity: "info",
      category: "Lỗi chính tả",
      description: "Cụm lầy bơi bị sai.",
      suggestion: "Thay đúng cụm từ.",
      repairScope: "local",
      repairHint: {
        kind: "exact-replacement",
        targetText: "lầy bơi",
        replacementText: "bãi bùn đất lầy lội",
        occurrenceIndexes: [1],
        context: "lầy bơi",
      },
    };
    const structuralIssue: AuditIssue = {
      severity: "critical",
      category: "continuity",
      description: "Chuyển cảnh thiếu nguyên nhân.",
      suggestion: "Bổ sung nguyên nhân chuyển cảnh.",
      source: "deterministic",
      verification: "verified",
      repairScope: "structural",
      repairTarget: "prose",
    };
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 80,
        issues: [spellingIssue],
        hostFindings: [structuralIssue],
      }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, overallScore: 95, issues: [] }));
    const reviseChapter = vi.fn(async (
      _bookDir,
      content: string,
      _chapter,
      issues: ReadonlyArray<AuditIssue>,
    ) => {
      expect(content).toBe(patched);
      expect(issues).toEqual([expect.objectContaining({ category: "continuity" })]);
      return {
        revisedContent: structurallyRevised,
        wordCount: 1150,
        fixedIssues: ["continuity"],
        tokenUsage: ZERO_USAGE,
      };
    });

    const result = await runChapterReviewCycle({
      ...baseParams,
      lengthSpec: VI_LENGTH_SPEC,
      initialOutput: { content: original, wordCount: 1142, postWriteErrors: [] },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      settleRevisionCandidate: async () => ({ valid: true }),
    });

    expect(reviseChapter).toHaveBeenCalledTimes(1);
    expect(auditChapter).toHaveBeenCalledTimes(2);
    expect(result.finalContent).toBe(structurallyRevised);
    expect(result.localRepair).toMatchObject({ applied: true, patchCount: 1 });
  });

  it("does not accept a revision while the host-bound transition contradiction remains", async () => {
    const original = Array.from({ length: 1150 }, (_, index) => `gốc${index}`).join(" ");
    const candidate = Array.from({ length: 1150 }, (_, index) => `sửa${index}`).join(" ");
    const transitionFinding: AuditIssue = {
      severity: "critical",
      category: "Transition Continuity",
      description: "Trạng thái chuyển tiếp vẫn mâu thuẫn.",
      suggestion: "Sửa nguyên nhân hoặc giữ trạng thái trước.",
      ruleId: "continuity.transition",
      source: "deterministic",
      verification: "verified",
      repairScope: "structural",
      repairTarget: "prose",
    };
    const auditChapter = vi.fn().mockResolvedValue(createAuditResult({
      passed: false,
      overallScore: 92,
      hostFindings: [transitionFinding],
    }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent: candidate,
      wordCount: 1150,
      fixedIssues: [],
      tokenUsage: ZERO_USAGE,
    });

    const result = await runChapterReviewCycle({
      ...baseParams,
      bookId: "book-rejected-candidate",
      lengthSpec: VI_LENGTH_SPEC,
      initialOutput: { content: original, wordCount: 1150, postWriteErrors: [] },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      settleRevisionCandidate: async () => ({ valid: true }),
    });

    expect(reviseChapter).toHaveBeenCalledTimes(1);
    expect(auditChapter).toHaveBeenCalledTimes(2);
    expect(result.finalContent).toBe(original);
    expect(result.auditResult.decision).toBe("repair-required");
    expect(result.auditRuns?.map((run) => run.phase)).toEqual(["initial", "post-revision"]);
    expect(result.auditRuns?.[0]?.canonicalCommitOutcome).toBe("terminal-commit");
    expect(result.auditRuns?.[1]?.canonicalCommitOutcome).toBe("rejected");
    expect(result.auditRuns?.[1]?.revision.accepted).toBe(false);
  });

  it("returns inconclusive instead of rewriting when an auditor spelling target is not in the chapter", async () => {
    const original = Array.from({ length: 1150 }, (_, index) => `tu${index}`).join(" ");
    const auditChapter = vi.fn().mockResolvedValue(createAuditResult({
      passed: true,
      overallScore: 94,
      issues: [{
        severity: "info",
        category: "Style Check",
        description: "Xuất hiện lỗi đánh máy.",
        suggestion: "Sửa cụm từ.",
        repairScope: "local",
        repairHint: {
          kind: "exact-replacement",
          targetText: "không tồn tại",
          replacementText: "cụm đúng",
          occurrenceIndexes: [1],
          context: "không tồn tại",
        },
      }],
    }));
    const reviseChapter = vi.fn();

    const result = await runChapterReviewCycle({
      ...baseParams,
      lengthSpec: VI_LENGTH_SPEC,
      initialOutput: { content: original, wordCount: 1150, postWriteErrors: [] },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
    });

    expect(reviseChapter).not.toHaveBeenCalled();
    expect(result.auditResult.decision).toBe("inconclusive");
    expect(result.finalContent).toBe(original);
  });

  it("treats an informational clean spelling report as commentary, not a failed binding", async () => {
    const original = Array.from({ length: 1150 }, (_, index) => `tu${index}`).join(" ");
    const auditChapter = vi.fn().mockResolvedValue(createAuditResult({
      passed: true,
      overallScore: 94,
      issues: [{
        severity: "info",
        category: "Vietnamese Spelling",
        description: "Không phát hiện lỗi chính tả tiếng Việt đủ chắc chắn để báo cáo theo yêu cầu exact-replacement.",
        suggestion: "",
      }],
    }));
    const reviseChapter = vi.fn();

    const result = await runChapterReviewCycle({
      ...baseParams,
      lengthSpec: VI_LENGTH_SPEC,
      initialOutput: { content: original, wordCount: 1150, postWriteErrors: [] },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
    });

    expect(reviseChapter).not.toHaveBeenCalled();
    expect(result.auditResult.decision).toBe("pass");
    expect(result.auditResult.parseFailed).toBeUndefined();
  });

  it("accepts a low-scoring chapter without spending a revision", async () => {
    const original = Array.from({ length: 1150 }, (_, index) => `gốc${index}`).join(" ");
    const memoDriftIssue: AuditIssue = {
      severity: "critical",
      category: "Chapter Memo Drift Check",
      description: "Cảnh 3 thiếu các trị số đo mà memo đã cam kết.",
      suggestion: "Bổ sung trị số đo vào cảnh niêm phong.",
    };
    // Real observed score for this pipeline: the same chapter scored 90, 80 and
    // 58 across runs. A score alone must not buy a rewrite.
    const auditChapter = vi.fn().mockResolvedValue(createAuditResult({
      passed: false,
      overallScore: 58,
      issues: [memoDriftIssue],
    }));
    const reviseChapter = vi.fn();

    const result = await runChapterReviewCycle({
      ...baseParams,
      bookId: "book-score-advisory",
      lengthSpec: VI_LENGTH_SPEC,
      initialOutput: { content: original, wordCount: 1150, postWriteErrors: [] },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      settleRevisionCandidate: async () => ({ valid: true }),
      scoreRepairFloorScore: 72,
    });

    expect(reviseChapter).not.toHaveBeenCalled();
    expect(auditChapter).toHaveBeenCalledTimes(1);
    expect(result.auditResult.decision).toBe("pass");
    expect(result.auditResult.overallScore).toBe(58);
    expect(result.finalContent).toBe(original);
  });

  it("still spends the bounded revision on a verified critical finding", async () => {
    // In-range prose: an out-of-range draft adds its own verified
    // length.hard-range blocker and would mask what this test is about.
    const original = Array.from({ length: 260 }, (_, index) => `gốc ${index} nội dung chương.`).join(" ");
    const candidate = Array.from({ length: 260 }, (_, index) => `sửa ${index} nội dung chương.`).join(" ");
    const memoDriftIssue: AuditIssue = {
      severity: "critical",
      category: "Chapter Memo Drift Check",
      description: "Cảnh 3 thiếu các trị số đo mà memo đã cam kết.",
      suggestion: "Bổ sung trị số đo vào cảnh niêm phong.",
    };
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 82,
        issues: [memoDriftIssue],
        // Deterministic bucket: this is the finding that actually blocks.
        hostFindings: [memoDriftIssue],
      }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, overallScore: 91, issues: [] }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent: candidate,
      wordCount: 1150,
      fixedIssues: ["Chapter Memo Drift Check"],
      tokenUsage: ZERO_USAGE,
    });

    const result = await runChapterReviewCycle({
      ...baseParams,
      bookId: "book-verified-repair",
      lengthSpec: VI_LENGTH_SPEC,
      initialOutput: { content: original, wordCount: countChapterLength(original, VI_LENGTH_SPEC.countingMode), postWriteErrors: [] },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      settleRevisionCandidate: async () => ({ valid: true }),
    });

    expect(reviseChapter).toHaveBeenCalledTimes(1);
    expect(auditChapter).toHaveBeenCalledTimes(2);
    expect(result.finalContent).toBe(candidate);
    expect(result.auditResult.decision).toBe("pass");
  });

  it("returns initial and post-revision audit runs with one shared attempt identity", async () => {
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({ passed: false, overallScore: 40 }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, overallScore: 95 }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent: "修".repeat(220),
      wordCount: 220,
      fixedIssues: ["fixed"],
      tokenUsage: ZERO_USAGE,
    });

    const result = await runChapterReviewCycle({
      ...baseParams,
      bookId: "book-1",
      initialOutput: { content: "原".repeat(200), wordCount: 200, postWriteErrors: [] },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      runPostWriteChecks: (content) => content.startsWith("原") ? [DETERMINISTIC_REPAIR] : [],
    });

    expect(result.auditRuns?.map((run) => run.phase)).toEqual(["initial", "post-revision"]);
    expect(result.auditRuns?.[0]?.attemptId).toBe(result.auditRuns?.[1]?.attemptId);
    expect(result.auditRuns?.[0]?.canonicalCommitOutcome).toBe("superseded");
    expect(result.auditRuns?.[1]?.canonicalCommitOutcome).toBe("terminal-commit");
    expect(result.auditRuns?.[0]?.provenance).toMatchObject({
      source: "pipeline-runner",
      operationId: result.auditRuns?.[0]?.operationId,
      attemptId: result.auditRuns?.[0]?.attemptId,
      phase: "initial",
    });
    expect(result.auditRuns?.[1]?.provenance).toMatchObject({
      source: "pipeline-runner",
      operationId: result.auditRuns?.[0]?.operationId,
      attemptId: result.auditRuns?.[0]?.attemptId,
      phase: "post-revision",
    });
  });

  it("normalizes a candidate before settlement and binds post-audit to its settled truth", async () => {
    const normalizedCandidate = "修".repeat(220);
    const rawCandidate = `\uFEFF# 第1章\r\n\r\n${normalizedCandidate}`;
    const settleRevisionCandidate = vi.fn().mockResolvedValue({
      valid: true,
      truthFileOverrides: {
        currentState: "candidate-state",
        ledger: "candidate-ledger",
        hooks: "candidate-hooks",
      },
    });
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({ passed: false, overallScore: 70 }))
      .mockImplementationOnce(async (_dir, content, _chapter, _genre, options) => {
        expect(content).toBe(normalizedCandidate);
        expect(options?.truthFileOverrides).toEqual({
          currentState: "candidate-state",
          ledger: "candidate-ledger",
          hooks: "candidate-hooks",
        });
        return createAuditResult({ passed: true, overallScore: 95 });
      });

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: { content: "原".repeat(200), wordCount: 200, postWriteErrors: [] },
      createReviser: () => ({
        reviseChapter: vi.fn().mockResolvedValue({
          revisedContent: rawCandidate,
          wordCount: 220,
          fixedIssues: ["fixed"],
          tokenUsage: ZERO_USAGE,
        }),
      }),
      auditor: { auditChapter },
      normalizePostWriteSurface: (content) => content === rawCandidate ? normalizedCandidate : content,
      settleRevisionCandidate,
      runPostWriteChecks: (content) => content.startsWith("原") ? [DETERMINISTIC_REPAIR] : [],
    });

    expect(settleRevisionCandidate).toHaveBeenCalledWith(
      normalizedCandidate,
      expect.objectContaining({ revisedContent: rawCandidate }),
    );
    expect(result.finalContent).toBe(normalizedCandidate);
    expect(result.auditResult.provenance?.phase).toBe("post-revision");
  });

  it("routes verified typed hook contradictions from settlement through the shared candidate gate", async () => {
    const original = "原".repeat(200);
    const candidate = "修".repeat(220);
    const contentHash = computeChapterContentHash(candidate);
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({ passed: false, overallScore: 70 }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, overallScore: 95 }));
    const result = await runChapterReviewCycle({
      ...baseParams,
      bookId: "book-1",
      initialOutput: { content: original, wordCount: 200, postWriteErrors: [] },
      createReviser: () => ({
        reviseChapter: vi.fn().mockResolvedValue({
          revisedContent: candidate,
          wordCount: 220,
          fixedIssues: ["hook"],
          tokenUsage: ZERO_USAGE,
        }),
      }),
      auditor: { auditChapter },
      settleRevisionCandidate: async () => ({
        valid: true,
        stateFindings: [{
          severity: "critical",
          category: "hook-runtime-contradiction",
          description: "advance was resolved",
          suggestion: "restore progressing hook state",
          source: "state",
          verification: "verified",
          evidence: { contentHash, stateRef: "runtime:hook:H007" },
          repairTarget: "runtime-state",
        }],
      }),
      runPostWriteChecks: (content) => content.startsWith("原")
        ? [DETERMINISTIC_REPAIR]
        : [],
    });

    expect(result.finalContent).toBe(original);
    expect(result.revised).toBe(false);
    expect(result.auditRuns?.[1]?.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "hook-runtime-contradiction", severity: "critical" }),
    ]));
  });

  it("does not block a candidate for an unverified typed hook evidence warning", async () => {
    const original = "原".repeat(200);
    const candidate = "修".repeat(220);
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({ passed: false, overallScore: 70 }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, overallScore: 95 }));
    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: { content: original, wordCount: 200, postWriteErrors: [] },
      createReviser: () => ({
        reviseChapter: vi.fn().mockResolvedValue({
          revisedContent: candidate,
          wordCount: 220,
          fixedIssues: ["hook"],
          tokenUsage: ZERO_USAGE,
        }),
      }),
      auditor: { auditChapter },
      settleRevisionCandidate: async () => ({
        valid: true,
        stateFindings: [{
          severity: "warning",
          category: "hook-runtime-evidence-missing",
          description: "advance evidence missing",
          suggestion: "review the settled delta",
          source: "deterministic",
          verification: "unverified",
          repairTarget: "runtime-state",
        }],
      }),
      runPostWriteChecks: (content) => content.startsWith("原")
        ? [DETERMINISTIC_REPAIR]
        : [],
    });

    expect(result.finalContent).toBe(candidate);
    expect(result.revised).toBe(true);
  });

  it("rejects an unsettled candidate before post-revision audit", async () => {
    const original = "原".repeat(200);
    const auditChapter = vi.fn().mockResolvedValue(createAuditResult({ passed: false, overallScore: 40 }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent: "修".repeat(220),
      wordCount: 220,
      fixedIssues: ["fixed"],
      tokenUsage: ZERO_USAGE,
    });

    const result = await runChapterReviewCycle({
      ...baseParams,
      bookId: "book-1",
      initialOutput: { content: original, wordCount: 200, postWriteErrors: [] },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      stateSettlementValid: async () => false,
      runPostWriteChecks: (content) => content.startsWith("原") ? [DETERMINISTIC_REPAIR] : [],
    });

    expect(auditChapter).toHaveBeenCalledTimes(1);
    expect(result.finalContent).toBe(original);
    expect(result.revised).toBe(false);
    expect(result.revisionAttempts).toBe(1);
    expect(result.auditRuns?.[0]?.revision).toMatchObject({
      attempted: true,
      candidateProduced: true,
      accepted: false,
      rejectionReason: expect.stringContaining("state settlement"),
    });
  });

  it("runs the configured two repair iterations and rejects non-passing candidates", async () => {
    // Each round carries a verified blocker, so the loop still runs to its
    // configured bound and the last candidate is still refused.
    const continuityIssue: AuditIssue = { severity: "critical", category: "continuity", description: "broken", suggestion: "fix" };
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 70,
        issues: [continuityIssue],
        hostFindings: [continuityIssue],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 80,
        issues: [{ severity: "warning", category: "pacing", description: "slow", suggestion: "trim" }],
        hostFindings: [{ ...continuityIssue, description: "still broken", suggestion: "fix" }],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 76,
        issues: [{ severity: "warning", category: "pacing", description: "still slow", suggestion: "trim more" }],
        hostFindings: [{ ...continuityIssue, description: "still broken again", suggestion: "fix" }],
      }));

    const reviseChapter = vi.fn()
      .mockResolvedValueOnce({
        revisedContent: "a".repeat(200),
        wordCount: 200,
        fixedIssues: ["fixed continuity"],
        updatedState: "", updatedLedger: "", updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        revisedContent: "b".repeat(200),
        wordCount: 200,
        fixedIssues: ["trimmed pacing"],
        updatedState: "", updatedLedger: "", updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      });

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "c".repeat(200),
        wordCount: 200,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      maxReviewIterations: 2,
      runPostWriteChecks: (content) => content.startsWith("c") ? [DETERMINISTIC_REPAIR] : [],
    });

    // A non-passing candidate never replaces the canonical chapter; with a
    // configured budget of 2 it becomes the base for the next repair attempt.
    expect(reviseChapter).toHaveBeenCalledTimes(2);
    expect(reviseChapter.mock.calls[0]?.[4]).toBe("auto");

    expect(auditChapter).toHaveBeenCalledTimes(3);
    expect(result.auditResult.overallScore).toBe(80);
    expect(result.finalContent).toBe("c".repeat(200));
    expect(result.revised).toBe(false);
  });

  it("does not let a higher-scoring hard-range failure displace an in-range draft", async () => {
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 80,
        issues: [{ severity: "warning", category: "pacing", description: "needs work", suggestion: "tighten" }],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        overallScore: 95,
        issues: [],
      }));

    const reviseChapter = vi.fn().mockResolvedValueOnce({
      revisedContent: "x".repeat(80),
      wordCount: 80,
      fixedIssues: ["tightened"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "c".repeat(200),
        wordCount: 200,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      maxReviewIterations: 1,
      runPostWriteChecks: (content) => content.startsWith("c") ? [DETERMINISTIC_REPAIR] : [],
    });

    expect(reviseChapter).toHaveBeenCalledTimes(1);
    expect(result.finalContent).toBe("c".repeat(200));
    expect(result.finalWordCount).toBe(200);
    expect(result.auditResult.overallScore).toBe(80);
  });

  it("defaults to one automatic repair pass", async () => {
    // The revision loop is now entered by a verified blocker, so the critical
    // travels in hostFindings (deterministic) rather than as an LLM issue.
    const continuityIssue: AuditIssue = { severity: "critical", category: "continuity", description: "broken", suggestion: "fix" };
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 70,
        issues: [continuityIssue],
        hostFindings: [continuityIssue],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 80,
        issues: [{ severity: "warning", category: "pacing", description: "slow", suggestion: "trim" }],
        hostFindings: [{ ...continuityIssue, description: "still broken", suggestion: "fix again" }],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        overallScore: 90,
      }));

    const reviseChapter = vi.fn()
      .mockResolvedValueOnce({
        revisedContent: "a".repeat(200),
        wordCount: 200,
        fixedIssues: ["fixed continuity"],
        updatedState: "", updatedLedger: "", updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        revisedContent: "b".repeat(200),
        wordCount: 200,
        fixedIssues: ["trimmed pacing"],
        updatedState: "", updatedLedger: "", updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      });

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "c".repeat(200),
        wordCount: 200,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      runPostWriteChecks: (content) => content.startsWith("c") ? [DETERMINISTIC_REPAIR] : [],
    });

    expect(reviseChapter).toHaveBeenCalledTimes(1);
    expect(result.auditResult.overallScore).toBe(70);
    expect(result.finalContent).toBe("c".repeat(200));
  });

  it("stops immediately when initial score passes threshold", async () => {
    const auditChapter = vi.fn()
      .mockResolvedValue(createAuditResult({ overallScore: 88 }));
    const reviseChapter = vi.fn();
    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "d".repeat(200),
        wordCount: 200,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
    });

    // No revision should have been called
    expect(reviseChapter).not.toHaveBeenCalled();
    expect(result.auditResult.overallScore).toBe(88);
    expect(result.revised).toBe(false);
  });

  it("normalizes deterministic surface blockers before audit and repair", async () => {
    const auditChapter = vi.fn()
      .mockResolvedValue(createAuditResult({ overallScore: 90, passed: true }));
    const reviseChapter = vi.fn();
    const unsafe = `${"雨".repeat(100)}——${"夜".repeat(98)}`;

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: unsafe,
        wordCount: unsafe.length,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizePostWriteSurface: (content) => content.replace(/——+/g, "，"),
      runPostWriteChecks: (content) =>
        content.includes("——")
          ? [{ severity: "critical" as const, category: "禁止破折号", description: "出现了破折号", suggestion: "用逗号断句" }]
          : [],
    });

    expect(auditChapter.mock.calls[0]?.[1]).not.toContain("——");
    expect(result.finalContent).not.toContain("——");
    expect(result.auditResult.passed).toBe(true);
    expect(reviseChapter).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Output-language guard: a reviser candidate that is not Vietnamese must be
  // rejected before settlement and before the post-revision auditor, and it must
  // never become the base for the next repair iteration.
  // -------------------------------------------------------------------------

  it("rejects a non-Vietnamese revision candidate before settle and before the post-revision audit", async () => {
    const auditChapter = vi.fn().mockResolvedValue(createAuditResult({
      decision: "repair-required",
      passed: false,
      overallScore: 70,
      issues: [DETERMINISTIC_REPAIR],
    }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent: ENGLISH_CANDIDATE,
      wordCount: 3000,
      fixedIssues: ["fixed continuity"],
      tokenUsage: ZERO_USAGE,
    });
    const settleRevisionCandidate = vi.fn().mockResolvedValue({ valid: true });
    const retained: Array<{
      readonly reason: string;
      readonly rejectionEvidence: { readonly findings: ReadonlyArray<{ readonly category: string }> };
    }> = [];
    const retainRejectedCandidate = vi.fn((input: {
      readonly reason: string;
      readonly rejectionEvidence: { readonly findings: ReadonlyArray<{ readonly category: string }> };
    }) => {
      retained.push(input);
    });

    const result = await runChapterReviewCycle({
      ...baseParams,
      lengthSpec: VI_LENGTH_SPEC,
      initialOutput: { content: VI_CANONICAL_CHAPTER, wordCount: 1145, postWriteErrors: [] },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      settleRevisionCandidate,
      retainRejectedCandidate,
      runPostWriteChecks: (content) => (content === VI_CANONICAL_CHAPTER ? [DETERMINISTIC_REPAIR] : []),
    });

    // (a) The post-revision auditor never receives the non-Vietnamese draft.
    for (const call of auditChapter.mock.calls) {
      expect(String(call[1])).not.toContain(ENGLISH_CANDIDATE_MARKER);
    }
    expect(auditChapter).toHaveBeenCalledTimes(1);
    expect(settleRevisionCandidate).not.toHaveBeenCalled();

    // (b)/(c) The canonical Vietnamese chapter survives untouched and is not marked revised.
    expect(result.finalContent).toBe(VI_CANONICAL_CHAPTER);
    expect(result.finalContent).not.toContain(ENGLISH_CANDIDATE_MARKER);
    expect(result.revised).toBe(false);

    // (d) index.json keeps the canonical findings, not the candidate language failure.
    expect(result.auditResult.issues.map((issue) => issue.category)).not.toContain("vi-output-language-mismatch");
    expect(result.auditResult.contentHash).toBe(computeChapterContentHash(VI_CANONICAL_CHAPTER));

    // (e) Telemetry stays bound to the canonical chapter.
    expect(result.revisionAttempts).toBe(1);
    const postRevisionRun = result.auditRuns?.find((run) => run.phase === "post-revision");
    expect(postRevisionRun?.contentHash).not.toBe(computeChapterContentHash(ENGLISH_CANDIDATE));

    // The rejection is recorded with language evidence attached to the retained candidate.
    expect(retained).toHaveLength(1);
    expect(retained[0]?.reason).toContain("not Vietnamese");
    expect(retained[0]?.rejectionEvidence.findings.map((finding) => finding.category))
      .toContain("vi-output-language-mismatch");
  });

  it("rolls a language-rejected candidate back to canonical so the next iteration revises the Vietnamese draft", async () => {
    const auditChapter = vi.fn().mockResolvedValue(createAuditResult({
      decision: "repair-required",
      passed: false,
      overallScore: 70,
      issues: [DETERMINISTIC_REPAIR],
    }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent: ENGLISH_CANDIDATE,
      wordCount: 3000,
      fixedIssues: ["fixed continuity"],
      tokenUsage: ZERO_USAGE,
    });
    const retainRejectedCandidate = vi.fn();

    const result = await runChapterReviewCycle({
      ...baseParams,
      lengthSpec: VI_LENGTH_SPEC,
      maxReviewIterations: 2,
      initialOutput: { content: VI_CANONICAL_CHAPTER, wordCount: 1145, postWriteErrors: [] },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      retainRejectedCandidate,
      runPostWriteChecks: (content) => (content === VI_CANONICAL_CHAPTER ? [DETERMINISTIC_REPAIR] : []),
    });

    expect(reviseChapter).toHaveBeenCalledTimes(2);
    // Both attempts were seeded from the canonical Vietnamese chapter, never from the rejected draft.
    for (const call of reviseChapter.mock.calls) {
      expect(String(call[1])).toBe(VI_CANONICAL_CHAPTER);
    }
    expect(retainRejectedCandidate).toHaveBeenCalledTimes(2);
    expect(auditChapter).toHaveBeenCalledTimes(1);
    expect(result.finalContent).toBe(VI_CANONICAL_CHAPTER);
    expect(result.revised).toBe(false);
  });
});

describe("bindVietnameseAuditorProperNounFindings", () => {
  const KNOWN_NAMES = ["Lục Cảnh", "Ngụy Vinh", "Frostwall"];
  const CONTENT = "Phiếu cấp nhiệt ghi nguồn rút từ Lục Giới, kho ký ức nằm dưới Frostwall của Lục Cảnh.";

  const properNounIssue = (overrides: Partial<Record<string, unknown>> = {}): AuditIssue => ({
    severity: "critical",
    category: "Proper Noun Check",
    description:
      "The chapter identifies the memory store as “Lục Giới,” while the established hook and state use “Lục Cảnh.” This changes a protected proper name.",
    suggestion: "Dùng đúng tên chuẩn trong sổ tay.",
    source: "llm",
    verification: "unverified",
    ...overrides,
  } as AuditIssue);

  it("binds a quoted name pair onto verified evidence when the target exists in the chapter", () => {
    const { findings } = bindVietnameseAuditorProperNounFindings(
      CONTENT,
      [properNounIssue()],
      KNOWN_NAMES,
    );
    expect(findings).toHaveLength(1);
    const bound = findings[0]!;
    expect(bound.severity).toBe("critical");
    expect(bound.verification).toBe("verified");
    expect(bound.ruleId).toBe("vi-auditor-proper-name");
    expect(bound.repairHint?.kind).toBe("exact-replacement");
    expect(bound.repairHint?.targetText).toBe("Lục Giới");
    expect(bound.repairHint?.replacementText).toBe("Lục Cảnh");
    expect(bound.evidence?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("skips the binding when both quoted tokens are known names", () => {
    const { findings } = bindVietnameseAuditorProperNounFindings(
      CONTENT,
      [properNounIssue({
        description: "The chapter uses “Lục Cảnh” and “Frostwall” consistently.",
      })],
      KNOWN_NAMES,
    );
    expect(findings).toHaveLength(0);
  });

  it("skips the binding when the claimed wrong name is absent from the chapter", () => {
    const { findings } = bindVietnameseAuditorProperNounFindings(
      CONTENT,
      [properNounIssue({
        description: "The chapter should have said “Lục Cảnh” instead of “Lục Địa.”",
      })],
      KNOWN_NAMES,
    );
    expect(findings).toHaveLength(0);
  });

  it("does not double-bind issues already covered by the spelling signal", () => {
    const { findings } = bindVietnameseAuditorProperNounFindings(
      CONTENT,
      [properNounIssue({
        category: "spelling",
        description: "Lỗi chính tả: “Lục Giới” phải là “Lục Cảnh.”",
        repairHint: { kind: "exact-replacement", targetText: "Lục Giới", replacementText: "Lục Cảnh", occurrenceIndexes: [1], context: "" },
      })],
      KNOWN_NAMES,
    );
    expect(findings).toHaveLength(0);
  });

  it("ignores informational lines without a name claim", () => {
    const { findings } = bindVietnameseAuditorProperNounFindings(
      CONTENT,
      [properNounIssue({ severity: "info" })],
      KNOWN_NAMES,
    );
    expect(findings).toHaveLength(0);
  });
});
