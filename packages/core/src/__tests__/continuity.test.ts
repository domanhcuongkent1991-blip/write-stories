import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContinuityAuditor } from "../agents/continuity.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

describe("ContinuityAuditor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a critical audit issue instead of throwing when audit output is not JSON", () => {
    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-auditor-bad-json-test",
    });

    const result = (auditor as any).parseAuditResult("模型只返回了一段散文，没有 JSON。", "zh");

    expect(result.passed).toBe(false);
    expect(result.summary).toContain("审稿输出解析失败");
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: "critical",
        category: "系统错误",
      }),
    ]);
  });

  it("parses typed repair_scope from audit JSON", () => {
    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-auditor-repair-scope-test",
    });

    const result = (auditor as any).parseAuditResult(JSON.stringify({
      passed: false,
      issues: [{
        severity: "critical",
        repair_scope: "structural",
        category: "模型审稿判断",
        description: "核心场面缺失",
        suggestion: "重写场面",
      }],
      summary: "needs rewrite",
    }), "zh");

    expect(result.issues[0]).toMatchObject({
      repairScope: "structural",
      category: "模型审稿判断",
    });
  });

  it("preserves optional finding contract fields while accepting legacy findings", () => {
    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-auditor-contract-test",
    });
    const result = (auditor as any).parseAuditResult(JSON.stringify({
      passed: false,
      issues: [{
        severity: "critical",
        category: "state",
        description: "fact drift",
        suggestion: "repair state",
        ruleId: "state.fact",
        findingId: "finding-1",
        fingerprint: "a".repeat(64),
        source: "state",
        verification: "verified",
        evidence: { contentHash: "b".repeat(64), stateRef: "story/current_state.md#gold" },
        acceptanceCriteria: ["state settlement valid"],
        repairTarget: "runtime-state",
        lifecycle: "open",
        confidence: 0.9,
      }, {
        severity: "warning",
        category: "legacy",
        description: "old",
        suggestion: "keep",
      }],
      summary: "needs repair",
    }), "zh");

    expect(result.issues[0]).toMatchObject({ ruleId: "state.fact", findingId: "finding-1", repairTarget: "runtime-state", confidence: 0.9 });
    expect(result.issues[1]).toMatchObject({ category: "legacy" });
    expect(result.issues[1]).not.toHaveProperty("transitionEvidence");
  });

  it("parses a structured exact-replacement hint from auditor JSON", () => {
    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-auditor-spelling-hint-test",
    });
    const result = (auditor as any).parseAuditResult(JSON.stringify({
      passed: false,
      overall_score: 94,
      issues: [{
        severity: "critical",
        repair_scope: "local",
        category: "Vietnamese Spelling",
        description: "Lỗi đánh máy có vị trí xác định.",
        suggestion: "Sửa đúng cụm từ.",
        repair_hint: {
          kind: "exact-replacement",
          target_text: "cụm từ sai",
          replacement_text: "cụm từ đúng",
          occurrence_indexes: [1],
          context: "... cụm từ sai ...",
        },
      }],
      summary: "needs local repair",
    }), "en");

    expect(result.issues[0]).toMatchObject({
      repairScope: "local",
      repairHint: {
        kind: "exact-replacement",
        targetText: "cụm từ sai",
        replacementText: "cụm từ đúng",
        occurrenceIndexes: [1],
        context: "... cụm từ sai ...",
      },
    });
  });

  it("parses the Vietnamese transition checklist and exact cross-chapter evidence", () => {
    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-auditor-transition-parser-test",
    });
    const result = (auditor as any).parseAuditResult(JSON.stringify({
      passed: false,
      overall_score: 92,
      transition_check: {
        status: "contradiction",
        dimensions_checked: ["time", "location", "physical-state", "device-state", "possession"],
      },
      issues: [{
        severity: "critical",
        repair_scope: "structural",
        category: "Transition Continuity",
        description: "The water level reverses without a causal event.",
        suggestion: "Keep the accepted level or depict the rise.",
        transition_evidence: {
          dimension: "physical-state",
          previous_text: "Vạch mực nước chạm đúng mốc 1,22m",
          current_text: "mặt nước thực tế cuồn cuộn ở mốc 1,34m",
        },
      }],
      summary: "transition contradiction",
    }), "en");

    expect((result as any).transitionCheck).toEqual({
      status: "contradiction",
      dimensionsChecked: ["time", "location", "physical-state", "device-state", "possession"],
    });
    expect((result.issues[0] as any).transitionEvidence).toEqual({
      dimension: "physical-state",
      previousText: "Vạch mực nước chạm đúng mốc 1,22m",
      currentText: "mặt nước thực tế cuồn cuộn ở mốc 1,34m",
    });
  });

  it("host-binds exact Vietnamese transition evidence into a verified blocker", async () => {
    const { root, bookDir } = await createVietnameseTransitionFixture();
    const currentBody = "Trong đêm, mặt nước thực tế cuồn cuộn ở mốc 1,34m mà không có trận mưa mới.";
    const auditor = createTestAuditor(root);
    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({
        passed: false,
        overall_score: 92,
        transition_check: {
          status: "contradiction",
          dimensions_checked: ["time", "location", "physical-state", "device-state", "possession"],
        },
        issues: [{
          severity: "critical",
          repair_scope: "structural",
          category: "Transition Continuity",
          description: "Mực nước đảo ngược mà không có nguyên nhân.",
          suggestion: "Giữ mốc 1,22m hoặc mô tả nguyên nhân nước dâng.",
          transition_evidence: {
            dimension: "physical-state",
            previous_text: "Vạch mực nước chạm đúng mốc 1,22m lúc 08:40.",
            current_text: "mặt nước thực tế cuồn cuộn ở mốc 1,34m",
          },
        }],
        summary: "transition contradiction",
      }),
      usage: ZERO_USAGE,
    });

    try {
      const result = await auditor.auditChapter(bookDir, currentBody, 2, "other");
      const messages = chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }> | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";

      expect(systemPrompt).toContain("Vietnamese cross-chapter transition contract");
      expect(systemPrompt).toContain('"dimensions_checked": ["time", "location", "physical-state", "device-state", "possession"]');
      expect(systemPrompt).toContain('"transition_evidence"');
      expect(systemPrompt.match(/"transition_check"/gu)).toHaveLength(2);
      expect((result as any).hostFindings).toEqual([
        expect.objectContaining({
          severity: "critical",
          ruleId: "continuity.transition",
          verification: "verified",
          repairScope: "structural",
          repairTarget: "prose",
          evidence: expect.objectContaining({
            excerpt: expect.stringContaining("1,22m"),
          }),
        }),
      ]);
      expect(result.issues).toEqual([]);
      expect(result.parseFailed).not.toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks a Vietnamese transition audit inconclusive when exact evidence does not bind", async () => {
    const { root, bookDir } = await createVietnameseTransitionFixture();
    const auditor = createTestAuditor(root);
    vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({
        passed: false,
        overall_score: 92,
        transition_check: {
          status: "contradiction",
          dimensions_checked: ["time", "location", "physical-state", "device-state", "possession"],
        },
        issues: [{
          severity: "critical",
          repair_scope: "structural",
          category: "Transition Continuity",
          description: "Mực nước đảo ngược.",
          suggestion: "Sửa mốc nước.",
          transition_evidence: {
            dimension: "physical-state",
            previous_text: "Mốc không tồn tại trong chương trước.",
            current_text: "mặt nước trở lại 1,34m",
          },
        }],
        summary: "transition contradiction",
      }),
      usage: ZERO_USAGE,
    });

    try {
      const result = await auditor.auditChapter(bookDir, "Trong đêm, mặt nước trở lại 1,34m.", 2, "other");

      expect(result.parseFailed).toBe(true);
      expect((result as any).parseFailedReason).toBe("evidence-not-bound");
      expect((result as any).hostFindings).toEqual([]);
      expect(result.issues.some((issue) => Object.prototype.hasOwnProperty.call(issue, "transitionEvidence"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds Vietnamese transition evidence after whitespace and dash-glyph normalization", async () => {
    const { root, bookDir } = await createVietnameseTransitionFixture();
    const currentBody = "Trong đêm, mặt nước thực tế cuồn cuộn ở mốc 1,34m \u2014 mà không có trận mưa mới.";
    const auditor = createTestAuditor(root);
    vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({
        passed: false,
        overall_score: 92,
        transition_check: {
          status: "contradiction",
          dimensions_checked: ["time", "location", "physical-state", "device-state", "possession"],
        },
        issues: [{
          severity: "critical",
          repair_scope: "structural",
          category: "Transition Continuity",
          description: "Mực nước đảo ngược mà không có nguyên nhân.",
          suggestion: "Giữ mốc 1,22m hoặc mô tả nguyên nhân nước dâng.",
          transition_evidence: {
            dimension: "physical-state",
            previous_text: "Vạch mực  nước chạm đúng mốc  1,22m lúc 08:40.",
            current_text: "mặt nước thực tế cuồn cuộn ở mốc 1,34m - mà",
          },
        }],
        summary: "transition contradiction",
      }),
      usage: ZERO_USAGE,
    });

    try {
      const result = await auditor.auditChapter(bookDir, currentBody, 2, "other");

      expect(result.parseFailed).not.toBe(true);
      expect((result as any).hostFindings).toEqual([
        expect.objectContaining({
          severity: "critical",
          ruleId: "continuity.transition",
          verification: "verified",
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks a Vietnamese chapter-2 audit inconclusive when transition_check is missing", async () => {
    const { root, bookDir } = await createVietnameseTransitionFixture();
    const auditor = createTestAuditor(root);
    vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({ passed: true, overall_score: 95, issues: [], summary: "ok" }),
      usage: ZERO_USAGE,
    });

    try {
      const result = await auditor.auditChapter(bookDir, "Mực nước giữ ở 1,22m.", 2, "other");

      expect(result.parseFailed).toBe(true);
      expect((result as any).parseFailedReason).toBe("transition-check-missing");
      expect((result as any).hostFindings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks a Vietnamese transition audit inconclusive when a consistent check still carries evidence", async () => {
    const { root, bookDir } = await createVietnameseTransitionFixture();
    const auditor = createTestAuditor(root);
    vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({
        passed: false,
        overall_score: 91,
        transition_check: {
          status: "consistent",
          dimensions_checked: ["time", "location", "physical-state", "device-state", "possession"],
        },
        issues: [{
          severity: "critical",
          repair_scope: "structural",
          category: "Transition Continuity",
          description: "Kết luận nhất quán nhưng vẫn nêu bằng chứng bất nhất.",
          suggestion: "Loại bỏ bằng chứng hoặc đổi trạng thái sang contradiction.",
          transition_evidence: {
            dimension: "physical-state",
            previous_text: "Vạch mực nước chạm đúng mốc 1,22m lúc 08:40.",
            current_text: "mặt nước thực tế cuồn cuộn ở mốc 1,34m",
          },
        }],
        summary: "transition consistent",
      }),
      usage: ZERO_USAGE,
    });

    try {
      const result = await auditor.auditChapter(bookDir, "Trong đêm, mặt nước thực tế cuồn cuộn ở mốc 1,34m.", 2, "other");

      expect(result.parseFailed).toBe(true);
      expect((result as any).parseFailedReason).toBe("consistent-with-evidence");
      expect((result as any).hostFindings).toEqual([]);
      expect(result.issues.some((issue) => Object.prototype.hasOwnProperty.call(issue, "transitionEvidence"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks a Vietnamese transition audit inconclusive when a contradiction has no evidence", async () => {
    const { root, bookDir } = await createVietnameseTransitionFixture();
    const auditor = createTestAuditor(root);
    vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({
        passed: false,
        overall_score: 78,
        transition_check: {
          status: "contradiction",
          dimensions_checked: ["time", "location", "physical-state", "device-state", "possession"],
        },
        issues: [],
        summary: "transition contradiction without evidence",
      }),
      usage: ZERO_USAGE,
    });

    try {
      const result = await auditor.auditChapter(bookDir, "Mực nước giữ ở 1,22m.", 2, "other");

      expect(result.parseFailed).toBe(true);
      expect((result as any).parseFailedReason).toBe("inconsistent-without-evidence");
      expect((result as any).hostFindings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the English scaffold plus exact spelling contract for Vietnamese audit prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-lang-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    await mkdir(join(root, "prompt", "longform"), { recursive: true });

    await Promise.all([
      writeFile(join(root, "prompt", "longform", "auditor.md"), "PROJECT AUDITOR OVERRIDE", "utf-8"),
      writeFile(
        join(bookDir, "book.json"),
        JSON.stringify({
          id: "vietnamese-book",
          title: "Vietnamese Book",
          genre: "xuanhuan",
          platform: "royalroad",
          chapterWordCount: 800,
          targetChapters: 60,
          status: "active",
          language: "vi",
          createdAt: "2026-03-23T00:00:00.000Z",
          updatedAt: "2026-03-23T00:00:00.000Z",
        }, null, 2),
        "utf-8",
      ),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Lin Yue keeps the oath token hidden.\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), "# Subplot Board\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# Emotional Arcs\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# Character Matrix\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nReturn to the mentor debt.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose restrained.\n", "utf-8"),
    ]);

    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({
        passed: true,
        issues: [],
        summary: "ok",
      }),
      usage: ZERO_USAGE,
    });

    try {
      await auditor.auditChapter(bookDir, "Chapter body.", 1, "xuanhuan");

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";

      expect(systemPrompt).toContain("ALL OUTPUT MUST BE IN ENGLISH");
      expect(systemPrompt).toContain("PROJECT AUDITOR OVERRIDE");
      expect(systemPrompt).toContain("Vietnamese spelling or typing error");
      expect(systemPrompt).toContain('"repair_hint"');
      expect(systemPrompt).toContain('"target_text"');
      expect(systemPrompt).toContain('"replacement_text"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("localizes English audit prompts instead of mixing Chinese control text", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-en-prompt-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(bookDir, "book.json"),
        JSON.stringify({
          id: "english-book",
          title: "English Book",
          genre: "other",
          platform: "royalroad",
          chapterWordCount: 800,
          targetChapters: 60,
          status: "active",
          language: "en",
          createdAt: "2026-03-23T00:00:00.000Z",
          updatedAt: "2026-03-23T00:00:00.000Z",
        }, null, 2),
        "utf-8",
      ),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Mara keeps the warehouse key hidden.\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), "# Subplot Board\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# Emotional Arcs\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# Character Matrix\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nCheck Warehouse 9.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose restrained.\n", "utf-8"),
    ]);

    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({
        passed: true,
        issues: [],
        summary: "ok",
      }),
      usage: ZERO_USAGE,
    });

    try {
      await auditor.auditChapter(bookDir, "Chapter body.", 1, "other");

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";
      const userPrompt = messages?.[1]?.content ?? "";

      expect(systemPrompt).toContain("Hook Check");
      expect(systemPrompt).toContain("Chapter Memo Drift Check");
      expect(systemPrompt).not.toContain("Outline Drift Check");
      expect(systemPrompt).toContain("stays dormant long enough to feel abandoned");
      expect(systemPrompt).toContain("3-question test");
      expect(systemPrompt).toContain("same mode long enough to flatten rhythm");
      expect(systemPrompt).not.toContain("more than 5 chapters");
      expect(systemPrompt).not.toContain("3 straight chapters");
      expect(systemPrompt).not.toContain("3+ consecutive chapters");
      expect(systemPrompt).not.toContain("伏笔检查");
      expect(systemPrompt).not.toContain("大纲偏离检测");

      expect(userPrompt).toContain("Review chapter 1.");
      expect(userPrompt).toContain("## Current State Card");
      expect(userPrompt).toContain("## Pending Hooks");
      expect(userPrompt).not.toContain("请审查第1章");
      expect(userPrompt).not.toContain("## 当前状态卡");
      expect(userPrompt).not.toContain("## 伏笔池");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses selected summary and hook evidence instead of full long-history markdown in governed mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        [
          "# Pending Hooks",
          "",
          "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| guild-route | 1 | mystery | open | 2 | 6 | Merchant guild trail |",
          "| mentor-oath | 8 | relationship | open | 99 | 101 | Mentor oath debt with Lin Yue |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "chapter_summaries.md"),
        [
          "# Chapter Summaries",
          "",
          "| 1 | Guild Trail | Merchant guild flees west | Route clues only | None | guild-route seeded | tense | action |",
          "| 99 | Trial Echo | Lin Yue | Mentor left without explanation | Oath token matters again | mentor-oath advanced | aching | fallout |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(join(storyDir, "subplot_board.md"), "# 支线进度板\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# 情感弧线\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# 角色交互矩阵\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Chapter 100\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose restrained.\n", "utf-8"),
    ]);

    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({
        passed: true,
        issues: [],
        summary: "ok",
      }),
      usage: ZERO_USAGE,
    });

    try {
      await auditor.auditChapter(
        bookDir,
        "Chapter body.",
        100,
        "xuanhuan",
        {
          chapterIntent: "# Chapter Intent\n\n## Goal\nBring the focus back to the mentor oath conflict.\n",
          contextPackage: {
            chapter: 100,
            selectedContext: [
              {
                source: "story/chapter_summaries.md#99",
                reason: "Relevant episodic memory.",
                excerpt: "Trial Echo | Mentor left without explanation | mentor-oath advanced",
              },
              {
                source: "story/pending_hooks.md#mentor-oath",
                reason: "Carry forward unresolved hook.",
                excerpt: "relationship | open | 101 | Mentor oath debt with Lin Yue",
              },
            ],
          },
          ruleStack: {
            layers: [{ id: "L4", name: "current_task", precedence: 70, scope: "local" }],
            sections: {
              hard: ["current_state"],
              soft: ["current_focus"],
              diagnostic: ["continuity_audit"],
            },
            overrideEdges: [],
            activeOverrides: [],
          },
        },
      );

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const userPrompt = messages?.[1]?.content ?? "";

      expect(userPrompt).toContain("story/chapter_summaries.md#99");
      expect(userPrompt).toContain("story/pending_hooks.md#mentor-oath");
      expect(userPrompt).not.toContain("| 1 | Guild Trail |");
      expect(userPrompt).not.toContain("guild-route | 1 | mystery");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("injects the chapter memo into the audit prompt for memo-drift checking", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-memo-drift-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "# Current State\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), "# 支线\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# 情感\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# 矩阵\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style\n", "utf-8"),
    ]);

    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0, maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({ passed: true, issues: [], summary: "ok" }),
      usage: ZERO_USAGE,
    });

    const memoBody = [
      "## 当前任务",
      "陆焚在小巷抢回残刃并离开。",
      "",
      "## 读者此刻在等什么",
      "读者想看他怎么脱身。",
      "",
      "## 该兑现的 / 暂不掀的",
      "兑现：残刃归手；暂不掀：身世。",
      "",
      "## 日常/过渡承担什么任务",
      "开篇小巷场景 → 情绪代入 + 信息植入。",
      "",
      "## 关键抉择过三连问",
      "陆焚选择独自动手的理由是什么？",
      "",
      "## 章尾必须发生的改变",
      "陆焚拿回残刃，被人目击。",
      "",
      "## 本章 hook 账",
      "resolve: H11 残刃下落 → 本章找回。defer: H04 幕后主使 → 留到第 50 章。",
      "",
      "## 不要做",
      "不要写成大段打斗。",
    ].join("\n");

    try {
      await auditor.auditChapter(bookDir, "Chapter body.", 42, "xuanhuan", {
        chapterMemo: {
          chapter: 42,
          goal: "陆焚抢回残刃并离开",
          isGoldenOpening: false,
          body: memoBody,
          threadRefs: [],
        },
      });

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";
      const userPrompt = messages?.[1]?.content ?? "";

      // Prompt declares structure-only scope and sparse-memo legality.
      expect(systemPrompt).toContain("审稿边界");
      expect(systemPrompt).toContain("你不审文笔");
      expect(systemPrompt).toContain("稀疏 memo 是合法状态");
      expect(systemPrompt).toContain("章节备忘偏离");
      expect(systemPrompt).not.toContain("大纲偏离检测");

      // User prompt injects the memo for drift-checking.
      expect(userPrompt).toContain("## 章节备忘（用于 memo 偏离检测）");
      expect(userPrompt).toContain("goal：陆焚抢回残刃并离开");
      expect(userPrompt).toContain("## 章尾必须发生的改变");
      // Legacy volume-outline block is gone.
      expect(userPrompt).not.toContain("## 卷纲");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createTestAuditor(projectRoot: string): ContinuityAuditor {
  return new ContinuityAuditor({
    client: {
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
    },
    model: "test-model",
    projectRoot,
  });
}

async function createVietnameseTransitionFixture(): Promise<{ root: string; bookDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "inkos-auditor-transition-test-"));
  const bookDir = join(root, "book");
  const storyDir = join(bookDir, "story");
  const chaptersDir = join(bookDir, "chapters");
  await Promise.all([
    mkdir(storyDir, { recursive: true }),
    mkdir(chaptersDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(bookDir, "book.json"), JSON.stringify({
      id: "vietnamese-transition-book",
      title: "Vietnamese Transition Book",
      genre: "other",
      platform: "other",
      chapterWordCount: 1150,
      targetChapters: 10,
      status: "active",
      language: "vi",
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    }, null, 2), "utf-8"),
    writeFile(join(chaptersDir, "0001_Moc_Nuoc.md"), [
      "# Chương 1: Mốc Nước",
      "",
      "Vạch mực nước chạm đúng mốc 1,22m lúc 08:40.",
    ].join("\n"), "utf-8"),
    writeFile(join(storyDir, "current_state.md"), "# Trạng thái hiện tại\n", "utf-8"),
    writeFile(join(storyDir, "pending_hooks.md"), "# Tình tiết cài cắm\n", "utf-8"),
    writeFile(join(storyDir, "chapter_summaries.md"), "# Tóm tắt chương\n", "utf-8"),
    writeFile(join(storyDir, "subplot_board.md"), "# Tuyến phụ\n", "utf-8"),
    writeFile(join(storyDir, "emotional_arcs.md"), "# Cung cảm xúc\n", "utf-8"),
    writeFile(join(storyDir, "character_matrix.md"), "# Nhân vật\n", "utf-8"),
    writeFile(join(storyDir, "volume_outline.md"), "# Dàn ý\n", "utf-8"),
    writeFile(join(storyDir, "style_guide.md"), "# Phong cách\n", "utf-8"),
  ]);
  return { root, bookDir };
}

describe("Vietnamese audit verdict repair", () => {
  function badEvidenceVerdict(): string {
    return JSON.stringify({
      passed: false,
      overall_score: 72,
      transition_check: {
        status: "contradiction",
        dimensions_checked: ["time", "location", "physical-state", "device-state", "possession"],
      },
      issues: [{
        severity: "critical",
        category: "Transition Continuity",
        description: "Mốc nước đảo ngược.",
        transition_evidence: {
          dimension: "physical-state",
          previous_text: "Câu không tồn tại ở chương trước.",
          current_text: "câu không tồn tại ở chương này",
        },
      }],
      summary: "transition contradiction",
    });
  }

  function bindingVerdict(): string {
    return JSON.stringify({
      passed: false,
      overall_score: 88,
      transition_check: {
        status: "contradiction",
        dimensions_checked: ["time", "location", "physical-state", "device-state", "possession"],
      },
      issues: [{
        severity: "critical",
        category: "Transition Continuity",
        description: "Mực nước đảo ngược mà không có nguyên nhân.",
        transition_evidence: {
          dimension: "physical-state",
          previous_text: "Vạch mực nước chạm đúng mốc 1,22m lúc 08:40.",
          current_text: "mặt nước thực tế cuồn cuộn ở mốc 1,34m",
        },
      }],
      summary: "transition contradiction",
    });
  }

  it("unwraps a transport envelope before audit parsing", () => {
    const auditor = createTestAuditor("/tmp/inkos-envelope-test");
    const result = (auditor as any).parseAuditResult(
      JSON.stringify({ status: "ok", processed: 1, passed: true, overall_score: 82, issues: [], summary: "ok" }),
      "en",
    );
    expect(result.passed).toBe(true);
    expect(result.overallScore).toBe(82);
    expect(result.parseFailed).not.toBe(true);
  });

  it("runs exactly one bounded verdict repair when the first audit cannot bind", async () => {
    const { root, bookDir } = await createVietnameseTransitionFixture();
    const auditor = createTestAuditor(root);
    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never)
      .mockImplementationOnce((async () => ({
        content: badEvidenceVerdict(),
        usage: ZERO_USAGE,
      })) as never)
      .mockImplementationOnce((async () => ({
        content: bindingVerdict(),
        usage: ZERO_USAGE,
      })) as never);

    try {
      const result = await auditor.auditChapter(
        bookDir,
        "Trong đêm, mặt nước thực tế cuồn cuộn ở mốc 1,34m mà không có trận mưa mới.",
        2,
        "other",
      );

      expect(chatSpy).toHaveBeenCalledTimes(2);
      const repairOptions = chatSpy.mock.calls[1]?.[1] as { temperature?: number } | undefined;
      expect(repairOptions?.temperature).toBe(0);
      const repairMessages = chatSpy.mock.calls[1]?.[0] as ReadonlyArray<{ role: string; content: string }>;
      const repairUser = repairMessages?.[1]?.content ?? "";
      expect(repairUser).toContain("<BEGIN_UNTRUSTED_AUDITOR_OUTPUT>");
      expect(repairUser).toContain("Câu không tồn tại ở chương trước.");
      expect(result.parseFailed).not.toBe(true);
      expect(result.overallScore).toBe(88);
      expect((result as any).hostFindings?.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the fail-closed result when the repair declines with the sentinel", async () => {
    const { root, bookDir } = await createVietnameseTransitionFixture();
    const auditor = createTestAuditor(root);
    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never)
      .mockImplementationOnce((async () => ({
        content: badEvidenceVerdict(),
        usage: ZERO_USAGE,
      })) as never)
      .mockImplementationOnce((async () => ({
        content: "AUDIT_REPAIR_REJECTED",
        usage: ZERO_USAGE,
      })) as never);

    try {
      const result = await auditor.auditChapter(bookDir, "Trong đêm, mặt nước trở lại 1,34m.", 2, "other");

      expect(chatSpy).toHaveBeenCalledTimes(2);
      expect(result.parseFailed).toBe(true);
      expect(result.overallScore).toBe(72);
      expect((result as any).hostFindings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the fail-closed result when the repair call itself fails", async () => {
    const { root, bookDir } = await createVietnameseTransitionFixture();
    const auditor = createTestAuditor(root);
    vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never)
      .mockImplementationOnce((async () => ({
        content: badEvidenceVerdict(),
        usage: ZERO_USAGE,
      })) as never)
      .mockImplementationOnce((async () => {
        throw new Error("provider unavailable");
      }) as never);

    try {
      const result = await auditor.auditChapter(bookDir, "Trong đêm, mặt nước trở lại 1,34m.", 2, "other");

      expect(result.parseFailed).toBe(true);
      expect(result.overallScore).toBe(72);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair parse failures for non-Vietnamese chapters", () => {
    const auditor = createTestAuditor("/tmp/inkos-zh-repair-test");
    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never);

    const result = (auditor as any).parseAuditResult("模型只返回了一段散文，没有 JSON。", "zh");
    expect(result.parseFailed).toBe(true);
    expect(result.parseFailedReason).toBe("unparseable-output");
    expect(chatSpy).not.toHaveBeenCalled();
  });
});
