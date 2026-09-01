import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviserAgent } from "../agents/reviser.js";
import { buildLengthSpec } from "../utils/length-metrics.js";
import type { AuditIssue } from "../agents/continuity.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

const CRITICAL_ISSUE: AuditIssue = {
  severity: "critical",
  category: "continuity",
  description: "Fix the broken continuity",
  suggestion: "Repair the contradiction",
};

describe("ReviserAgent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses counting-mode units and hard structural range in auto revision prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-length-prompt-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });
    await writeFile(join(bookDir, "book.json"), JSON.stringify({
      id: "english-book",
      title: "English Book",
      genre: "xuanhuan",
      platform: "royalroad",
      chapterWordCount: 100,
      targetChapters: 10,
      status: "active",
      language: "en",
      createdAt: "2026-03-23T00:00:00.000Z",
      updatedAt: "2026-03-23T00:00:00.000Z",
    }), "utf-8");
    const agent = new ReviserAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: root,
    });
    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: "=== FIXED_ISSUES ===\n\n=== REVISED_CONTENT ===\nRevised content.",
      usage: ZERO_USAGE,
    });

    try {
      await agent.reviseChapter(
        bookDir,
        "Original content.",
        1,
        [CRITICAL_ISSUE],
        "auto",
        "xuanhuan",
        { lengthSpec: buildLengthSpec(100, "en") },
      );
      const systemPrompt = ((chatSpy.mock.calls[0]?.[0] ?? []) as ReadonlyArray<{ content: string }>)[0]?.content ?? "";
      expect(systemPrompt).toContain("hard range");
      expect(systemPrompt).toContain("en_words");
      expect(systemPrompt).toContain("words");
      expect(systemPrompt).toContain("STRUCTURAL REPAIR");
      expect(systemPrompt).not.toContain("softMin");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gives Vietnamese auto revision the 1100-1300 writer target without narrowing the audit gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-vi-target-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });
    await writeFile(join(bookDir, "book.json"), JSON.stringify({
      id: "vietnamese-book",
      title: "Vietnamese Book",
      genre: "xuanhuan",
      platform: "other",
      chapterWordCount: 1150,
      targetChapters: 10,
      status: "active",
      language: "vi",
      createdAt: "2026-03-23T00:00:00.000Z",
      updatedAt: "2026-03-23T00:00:00.000Z",
    }), "utf-8");
    const agent = new ReviserAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: root,
    });
    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: "=== FIXED_ISSUES ===\n\n=== REVISED_CONTENT ===\nBản đã sửa.",
      usage: ZERO_USAGE,
    });

    try {
      await agent.reviseChapter(
        bookDir,
        "Bản thảo ban đầu.",
        1,
        [CRITICAL_ISSUE],
        "auto",
        "xuanhuan",
        { lengthSpec: buildLengthSpec(1150, "vi") },
      );
      const messages = (chatSpy.mock.calls[0]?.[0] ?? []) as ReadonlyArray<{ content: string }>;
      const combinedPrompt = messages.map((message) => message.content).join("\n");
      expect(combinedPrompt).toContain("1100-1300");
      expect(combinedPrompt).toContain("vi_wordlike_tokens_v1");
      expect(combinedPrompt).toContain("1000-1800");
      expect(combinedPrompt).not.toContain("1000-1500");
      expect(combinedPrompt).toContain("chapter memo/context");
      expect(combinedPrompt).toContain("preserve causal beats and compress redundant transitions");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("strips a repeated writer envelope from Vietnamese revised prose", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-vi-envelope-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });
    await writeFile(join(bookDir, "book.json"), JSON.stringify({
      id: "vietnamese-book",
      title: "Vietnamese Book",
      genre: "xuanhuan",
      platform: "other",
      chapterWordCount: 1150,
      targetChapters: 10,
      status: "active",
      language: "vi",
      createdAt: "2026-03-23T00:00:00.000Z",
      updatedAt: "2026-03-23T00:00:00.000Z",
    }), "utf-8");
    const agent = new ReviserAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: root,
    });
    vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "- compressed",
        "",
        "=== REVISED_CONTENT ===",
        "CHAPTER_TITLE: Đối chất",
        "CHAPTER_CONTENT:",
        "Minh đặt thẻ nhớ lên bàn.",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      const out = await agent.reviseChapter(
        bookDir,
        "Bản gốc.",
        5,
        [{
          severity: "critical",
          category: "length",
          description: "Vượt hard range",
          suggestion: "Cắt gọn",
          repairScope: "structural",
          repairTarget: "prose",
        }],
        "auto",
        "xuanhuan",
        { lengthSpec: buildLengthSpec(1150, "vi") },
      );

      expect(out.revisedContent).toBe("Minh đặt thẻ nhớ lên bàn.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { language: "zh", mode: "zh_chars", unit: "字", source: "原始正文。" },
    { language: "en", mode: "en_words", unit: "words", source: "Original draft." },
    { language: "vi", mode: "vi_wordlike_tokens_v1", unit: "từ", source: "Bản thảo ban đầu." },
  ] as const)("includes exact $mode and $unit in manual hard-range prompts", async ({ language, mode, unit, source }) => {
    const root = await mkdtemp(join(tmpdir(), `inkos-reviser-${language}-mode-`));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });
    await writeFile(join(bookDir, "book.json"), JSON.stringify({
      id: `${language}-book`,
      title: "Book",
      genre: "xuanhuan",
      platform: "other",
      chapterWordCount: 100,
      targetChapters: 10,
      status: "active",
      language,
      createdAt: "2026-03-23T00:00:00.000Z",
      updatedAt: "2026-03-23T00:00:00.000Z",
    }), "utf-8");
    const agent = new ReviserAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: root,
    });
    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: "=== FIXED_ISSUES ===\n\n=== REVISED_CONTENT ===\nRevised.",
      usage: ZERO_USAGE,
    });

    try {
      await agent.reviseChapter(
        bookDir,
        source,
        1,
        [CRITICAL_ISSUE],
        "rewrite",
        "xuanhuan",
        { lengthSpec: buildLengthSpec(100, language) },
      );
      const messages = (chatSpy.mock.calls[0]?.[0] ?? []) as ReadonlyArray<{ content: string }>;
      const combinedPrompt = messages.map((message) => message.content).join("\n");
      expect(combinedPrompt).toContain(mode);
      expect(combinedPrompt).toContain(unit);
      expect(combinedPrompt).toMatch(/硬性区间|Hard range/u);
      expect(combinedPrompt).not.toContain("轻微偏离");
      expect(combinedPrompt).not.toContain("minor deviation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers book language override when building revision prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-lang-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });
    await mkdir(join(root, "prompt", "longform"), { recursive: true });

    await writeFile(
      join(bookDir, "book.json"),
      JSON.stringify({
        id: "english-book",
        title: "English Book",
        genre: "xuanhuan",
        platform: "royalroad",
        chapterWordCount: 800,
        targetChapters: 60,
        status: "active",
        language: "en",
        createdAt: "2026-03-23T00:00:00.000Z",
        updatedAt: "2026-03-23T00:00:00.000Z",
      }, null, 2),
      "utf-8",
    );
    await writeFile(join(root, "prompt", "longform", "reviser.md"), "PROJECT REVISER OVERRIDE", "utf-8");

    const agent = new ReviserAgent({
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

    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "- repaired",
        "",
        "=== REVISED_CONTENT ===",
        "Revised chapter content.",
        "",
        "=== UPDATED_STATE ===",
        "State card",
        "",
        "=== UPDATED_HOOKS ===",
        "Hooks board",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      const output = await agent.reviseChapter(bookDir, "Original chapter content.", 1, [CRITICAL_ISSUE], "rewrite", "xuanhuan");

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";

      expect(systemPrompt).toContain("MUST be in English");
      expect(systemPrompt).toContain("PROJECT REVISER OVERRIDE");
      expect(systemPrompt).not.toContain("=== UPDATED_STATE ===");
      expect(systemPrompt).not.toContain("=== UPDATED_HOOKS ===");
      expect("updatedState" in output).toBe(false);
      expect("updatedHooks" in output).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps rewrite mode local-first instead of encouraging full-chapter replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-rewrite-guardrail-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    const agent = new ReviserAgent({
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

    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "- repaired",
        "",
        "=== PATCHES ===",
        "--- PATCH 1 ---",
        "TARGET_TEXT:",
        "原始正文。",
        "REPLACEMENT_TEXT:",
        "修订后的正文。",
        "--- END PATCH ---",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      await agent.reviseChapter(bookDir, "原始正文。", 1, [CRITICAL_ISSUE], "rewrite", "xuanhuan");

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";

      expect(systemPrompt).toContain("优先保留原文的绝大部分句段");
      expect(systemPrompt).toContain("除非问题跨越整章");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tells the model to preserve the target range when a length spec is provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    const agent = new ReviserAgent({
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

    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "- repaired",
        "",
        "=== PATCHES ===",
        "--- PATCH 1 ---",
        "TARGET_TEXT:",
        "原始正文。",
        "REPLACEMENT_TEXT:",
        "修订后的正文。",
        "--- END PATCH ---",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      await agent.reviseChapter(
        bookDir,
        "原始正文。",
        1,
        [CRITICAL_ISSUE],
        "spot-fix",
        "xuanhuan",
        {
          lengthSpec: buildLengthSpec(220, "zh"),
        },
      );

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";
      const userPrompt = messages?.[1]?.content ?? "";

      expect(systemPrompt).toContain("章节长度必须按指定计数模式落入硬性区间");
      expect(systemPrompt).toContain("=== PATCHES ===");
      expect(systemPrompt).not.toContain("=== REVISED_CONTENT ===");
      expect(userPrompt).toContain("目标：220");
      expect(userPrompt).toContain("硬性区间：160-280");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconstructs revised content from spot-fix patches and preserves untouched text", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-spotfix-patch-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    const agent = new ReviserAgent({
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

    vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "- 收紧了开头动作句。",
        "",
        "=== PATCHES ===",
        "--- PATCH 1 ---",
        "TARGET_TEXT:",
        "林越没有立刻进去。",
        "REPLACEMENT_TEXT:",
        "林越先停在门槛外，侧耳听了一息。",
        "--- END PATCH ---",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    const original = [
      "门轴轻轻响了一下。",
      "林越没有立刻进去。",
      "",
      "巷子尽头的风还在吹。",
      "他把手按在潮冷的门框上，没有出声。",
      "更远处传来极轻的脚步回响，又很快断掉。",
    ].join("\n");

    try {
      const result = await agent.reviseChapter(
        bookDir,
        original,
        1,
        [CRITICAL_ISSUE],
        "spot-fix",
        "xuanhuan",
      );

      expect(result.revisedContent).toBe([
        "门轴轻轻响了一下。",
        "林越先停在门槛外，侧耳听了一息。",
        "",
        "巷子尽头的风还在吹。",
        "他把手按在潮冷的门框上，没有出声。",
        "更远处传来极轻的脚步回响，又很快断掉。",
      ].join("\n"));
      expect(result.fixedIssues).toEqual(["- 收紧了开头动作句。"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores REVISED_CONTENT for auto mode when issues are local-only and PATCHES are available", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-auto-local-only-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    const agent = new ReviserAgent({
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

    vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "- removed the AI tell",
        "",
        "=== PATCHES ===",
        "--- PATCH 1 ---",
        "TARGET_TEXT:",
        "他仿佛听见门外有响动。",
        "REPLACEMENT_TEXT:",
        "他听见门外像有一点轻响。",
        "--- END PATCH ---",
        "",
        "=== REVISED_CONTENT ===",
        "整章重写后的版本，不应该被局部问题采用。",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      const result = await agent.reviseChapter(
        bookDir,
        "他仿佛听见门外有响动。\n\n他没有回头。",
        1,
        [{
          severity: "warning",
          category: "套话密度",
          description: "仿佛用得太直接",
          suggestion: "改成更具体的感官描写",
          repairScope: "local",
        }],
        "auto",
        "xuanhuan",
      );

      expect(result.revisedContent).toContain("他听见门外像有一点轻响。");
      expect(result.revisedContent).not.toContain("整章重写后的版本");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps REVISED_CONTENT available for auto mode when issues are whole-chapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-auto-whole-chapter-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    const agent = new ReviserAgent({
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

    vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "- restructured chapter pacing",
        "",
        "=== PATCHES ===",
        "--- PATCH 1 ---",
        "TARGET_TEXT:",
        "第一段。",
        "REPLACEMENT_TEXT:",
        "第一段（局部修补）。",
        "--- END PATCH ---",
        "",
        "=== REVISED_CONTENT ===",
        "整章重写后的版本，处理了整体节奏与结构。",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      const result = await agent.reviseChapter(
        bookDir,
        "第一段。\n\n第二段。\n\n第三段。",
        1,
        [{
          severity: "critical",
          category: "Outline Drift Check",
          description: "整章结构已经偏离",
          suggestion: "重建当前章节奏与组织",
        }],
        "auto",
        "xuanhuan",
      );

      expect(result.revisedContent).toContain("整章重写后的版本");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sanitizes reduced governed control input so raw hook ids and source labels do not enter reviser prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-governed-sanitize-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    const agent = new ReviserAgent({
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

    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "- fixed",
        "",
        "=== PATCHES ===",
        "--- PATCH 1 ---",
        "TARGET_TEXT:",
        "原始正文。",
        "REPLACEMENT_TEXT:",
        "修订后的正文。",
        "--- END PATCH ---",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      await agent.reviseChapter(
        bookDir,
        "原始正文。",
        1,
        [CRITICAL_ISSUE],
        "auto",
        "xuanhuan",
        {
          chapterIntent: [
            "# Chapter Intent",
            "",
            "## Goal",
            "Bring the focus back to the mentor oath conflict.",
            "",
            "## Must Avoid",
            "- 前几章回顾式总结",
            "- 本章要做的是把 H001/H002 推下去",
            "",
            "## Hook Agenda",
            "### Resolve",
            "- H001",
            "",
            "### Advance",
            "- H002",
          ].join("\n"),
          contextPackage: {
            chapter: 1,
            selectedContext: [
              {
                source: "runtime/hook_debt#H001",
                reason: "Narrative debt brief with original seed text for this hook agenda target.",
                excerpt: "H001 | original seed (ch1): the oath debt first surfaced",
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

      const userPrompt = (chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }> | undefined)?.[1]?.content ?? "";
      expect(userPrompt).not.toContain("runtime/hook_debt#H001");
      expect(userPrompt).not.toContain("## Hook Agenda");
      expect(userPrompt).not.toContain("H001");
      expect(userPrompt).not.toContain("H002");
      expect(userPrompt).not.toContain("前几章");
      expect(userPrompt).not.toContain("本章要做的");
      expect(userPrompt).toContain("Bring the focus back to the mentor oath conflict.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses selected summary and hook evidence instead of full long-history markdown in governed mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-governed-test-"));
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
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Chapter 100\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(
        join(storyDir, "story_bible.md"),
        [
          "# Story Bible",
          "",
          "- The jade seal cannot be destroyed.",
          "- Guildmaster Ren secretly forged the harbor roster in chapter 140.",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "character_matrix.md"),
        [
          "# 角色交互矩阵",
          "",
          "### 角色档案",
          "| 角色 | 核心标签 | 反差细节 | 说话风格 | 性格底色 | 与主角关系 | 核心动机 | 当前目标 |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          "| Lin Yue | oath | restraint | clipped | stubborn | self | repay debt | find mentor |",
          "| Guildmaster Ren | guild | swagger | loud | opportunistic | rival | stall Mara | seize seal |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose restrained.\n", "utf-8"),
    ]);

    const agent = new ReviserAgent({
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

    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "- repaired",
        "",
        "=== PATCHES ===",
        "--- PATCH 1 ---",
        "TARGET_TEXT:",
        "原始正文。",
        "REPLACEMENT_TEXT:",
        "修订后的正文。",
        "--- END PATCH ---",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      await agent.reviseChapter(
        bookDir,
        "原始正文。",
        100,
        [CRITICAL_ISSUE],
        "spot-fix",
        "xuanhuan",
        {
          chapterIntent: "# Chapter Intent\n\n## Goal\nBring the focus back to the mentor oath conflict.\n",
          contextPackage: {
            chapter: 100,
            selectedContext: [
              {
                source: "story/story_bible.md",
                reason: "Preserve canon constraints referenced by mustKeep.",
                excerpt: "The jade seal cannot be destroyed.",
              },
              {
                source: "story/volume_outline.md",
                reason: "Anchor the default planning node for this chapter.",
                excerpt: "Track the mentor oath fallout.",
              },
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
          lengthSpec: buildLengthSpec(220, "zh"),
        },
      );

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const userPrompt = messages?.[1]?.content ?? "";

      expect(userPrompt).not.toContain("story/chapter_summaries.md#99");
      expect(userPrompt).not.toContain("story/pending_hooks.md#mentor-oath");
      expect(userPrompt).not.toContain("story/story_bible.md");
      expect(userPrompt).not.toContain("story/volume_outline.md");
      expect(userPrompt).toContain("The jade seal cannot be destroyed.");
      expect(userPrompt).toContain("Track the mentor oath fallout.");
      expect(userPrompt).not.toContain("| 1 | Guild Trail |");
      expect(userPrompt).not.toContain("guild-route | 1 | mystery");
      expect(userPrompt).not.toContain("Guildmaster Ren secretly forged the harbor roster in chapter 140.");
      expect(userPrompt).not.toContain("| Guildmaster Ren | guild | swagger | loud | opportunistic | rival | stall Mara | seize seal |");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes structural issues to REVISED_CONTENT (rewrite-only) and rejects stray PATCHES", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-route-structural-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    const agent = new ReviserAgent({
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

    // Model returns PATCHES when reviewer asked for REVISED_CONTENT — parser
    // must reject the patches and leave the chapter unchanged.
    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "- tried to patch but problem is structural",
        "",
        "=== PATCHES ===",
        "--- PATCH 1 ---",
        "TARGET_TEXT:",
        "原文。",
        "REPLACEMENT_TEXT:",
        "局部替换。",
        "--- END PATCH ---",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      const out = await agent.reviseChapter(
        bookDir,
        "原文。",
        1,
        [
	          {
	            severity: "critical",
	            category: "模型审稿判断",
	            description: "未兑现 memo 的 goal",
	            suggestion: "重写全章",
	            repairScope: "structural",
	          },
        ],
        "auto",
        "xuanhuan",
      );

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";

      // System prompt directs model to REVISED_CONTENT for structural issues.
      expect(systemPrompt).toContain("分流指令");
      expect(systemPrompt).toContain("必须输出 REVISED_CONTENT");
      // Parser rejects stray PATCHES in rewrite-only mode.
      expect(out.revisedContent).toBe("原文。");
      expect(out.fixedIssues).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes local issues to PATCHES (patch-only) and rejects stray REVISED_CONTENT", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-route-local-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });

    const agent = new ReviserAgent({
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

    // Model returns REVISED_CONTENT when reviewer asked for PATCHES — parser
    // must reject the rewrite (patch-only mode) and leave the chapter unchanged.
    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "- rewrote whole chapter",
        "",
        "=== REVISED_CONTENT ===",
        "整章重写的正文。",
        "",
        "=== UPDATED_STATE ===",
        "状态卡",
        "",
        "=== UPDATED_HOOKS ===",
        "伏笔池",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      const out = await agent.reviseChapter(
        bookDir,
        "原文。",
        1,
        [
	          {
	            severity: "warning",
	            category: "模型审稿判断",
	            description: "'不禁' 密度过高",
	            suggestion: "替换成具体动作",
	            repairScope: "local",
	          },
        ],
        "auto",
        "xuanhuan",
      );

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";

      expect(systemPrompt).toContain("分流指令");
      expect(systemPrompt).toContain("必须只输出 PATCHES");
      // Parser rejects REVISED_CONTENT in patch-only mode.
      expect(out.revisedContent).toBe("原文。");
      expect(out.fixedIssues).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps provider-backed revision explicit after local spelling repair moves to orchestration", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-vi-spelling-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });
    const agent = new ReviserAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: root,
    });
    const original = "Âm thanh vang lên; mười mốn bước chân rồi mười mốn nhịp thở.";
    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never)
      .mockResolvedValue({
        content: [
          "=== FIXED_ISSUES ===",
          "- Phát hiện lỗi chính tả mười mốn",
          "",
          "=== PATCHES ===",
          "--- PATCH 1 ---",
          "TARGET_TEXT:",
          "mười mốn",
          "REPLACEMENT_TEXT:",
          "mười bốn",
          "OCCURRENCE_INDEX: 1",
          "--- END PATCH ---",
          "--- PATCH 2 ---",
          "TARGET_TEXT:",
          "mười mốn",
          "REPLACEMENT_TEXT:",
          "mười bốn",
          "OCCURRENCE_INDEX: 2",
          "--- END PATCH ---",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    try {
      const out = await agent.reviseChapter(
        bookDir,
        original,
        1,
        [
          {
            severity: "critical",
            category: "vi-known-spelling",
            description: "Phát hiện lỗi chính tả mười mốn",
            suggestion: "Thay bằng mười bốn",
            repairScope: "local",
            repairTarget: "prose",
            verification: "verified",
            repairHint: {
              kind: "exact-replacement",
              targetText: "mười mốn",
              replacementText: "mười bốn",
              occurrenceIndexes: [1],
              context: "... mười mốn bước chân ...",
            },
          },
          {
            severity: "critical",
            category: "vi-known-spelling",
            description: "Phát hiện lỗi chính tả mười mốn",
            suggestion: "Thay bằng mười bốn",
            repairScope: "local",
            repairTarget: "prose",
            verification: "verified",
            repairHint: {
              kind: "exact-replacement",
              targetText: "mười mốn",
              replacementText: "mười bốn",
              occurrenceIndexes: [2],
              context: "... mười mốn nhịp thở ...",
            },
          },
          {
            severity: "warning",
            category: "Chronicle Drift Check",
            description: "Cảnh báo chưa được xác minh.",
            suggestion: "Chỉ dùng làm dữ liệu tham khảo.",
            repairScope: "local",
            verification: "unverified",
          },
        ],
        "auto",
        "other",
      );

      expect(chatSpy).toHaveBeenCalledTimes(1);
      expect(out.revisedContent).toBe("Âm thanh vang lên; mười bốn bước chân rồi mười bốn nhịp thở.");
      expect(out.fixedIssues).toEqual(["- Phát hiện lỗi chính tả mười mốn"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
