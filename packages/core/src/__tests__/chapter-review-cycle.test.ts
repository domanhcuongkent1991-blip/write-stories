import { describe, expect, it, vi } from "vitest";
import { runChapterReviewCycle } from "../pipeline/chapter-review-cycle.js";
import { computeChapterContentHash } from "../audit/chapter-audit-evaluator.js";
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

  it("runs at most one repair and rejects a candidate that does not pass acceptance", async () => {
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 70,
        issues: [{ severity: "critical", category: "continuity", description: "broken", suggestion: "fix" }],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 80,
        issues: [{ severity: "warning", category: "pacing", description: "slow", suggestion: "trim" }],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 76,
        issues: [{ severity: "warning", category: "pacing", description: "still slow", suggestion: "trim more" }],
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

    // Quality revisions are bounded to one and a non-passing candidate is rejected.
    expect(reviseChapter).toHaveBeenCalledTimes(1);
    expect(reviseChapter.mock.calls[0]?.[4]).toBe("auto");

    expect(result.auditResult.overallScore).toBe(70);
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
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 70,
        issues: [{ severity: "critical", category: "continuity", description: "broken", suggestion: "fix" }],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 80,
        issues: [{ severity: "warning", category: "pacing", description: "slow", suggestion: "trim" }],
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
});
