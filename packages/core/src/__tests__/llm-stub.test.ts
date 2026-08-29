import { describe, expect, it, afterEach } from "vitest";
import { isLlmStubEnabled, stubAgentStream, stubChatCompletion } from "../agent/llm-stub.js";
import { buildAgentSystemPrompt } from "../agent/agent-system-prompt.js";
import { parseMemo } from "../utils/chapter-memo-parser.js";
import { parseCreativeOutput } from "../agents/writer-parser.js";
import { parseSettlerDeltaOutput } from "../agents/settler-delta-parser.js";
import { buildRuntimeStateArtifactsFromSnapshot } from "../state/runtime-state-store.js";
import { StateManifestSchema } from "../models/runtime-state.js";

describe("llm-stub", () => {
  const prev = process.env.INKOS_AGENT_LLM_STUB;
  afterEach(() => {
    if (prev === undefined) delete process.env.INKOS_AGENT_LLM_STUB;
    else process.env.INKOS_AGENT_LLM_STUB = prev;
  });

  it("isLlmStubEnabled reflects the env var", () => {
    process.env.INKOS_AGENT_LLM_STUB = "1";
    expect(isLlmStubEnabled()).toBe(true);
    delete process.env.INKOS_AGENT_LLM_STUB;
    expect(isLlmStubEnabled()).toBe(false);
  });

  it("stubChatCompletion returns a valid structure JSON for a structure prompt", () => {
    const res = stubChatCompletion(
      [
        { role: "system", content: "生成分支骨架 JSON：{nodes:[...]}" },
        { role: "user", content: "三幕" },
      ],
      "stub-model",
    );
    const parsed = JSON.parse(res.content) as { nodes: unknown[] };
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(parsed.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it("proposes create_book for an unconfirmed Vietnamese creation brief", async () => {
    const stream = stubAgentStream({} as never, {
      messages: [
        {
          role: "system",
          content:
            "You are the InkOS book creation assistant. Do not create directly yet. Call propose_action with action=create_book.",
        },
        { role: "user", content: "Hãy tạo một cuốn tiểu thuyết về Những Ngày Mưa, thể loại đô thị." },
      ],
    });

    const events: unknown[] = [];
    for await (const event of stream) events.push(event);
    const done = events.find((event) => (event as { type?: string }).type === "done") as {
      message?: { content?: Array<{ type?: string; name?: string; arguments?: Record<string, unknown> }> };
    } | undefined;
    const toolCall = done?.message?.content?.find((content) => content.type === "toolCall");

    expect(toolCall?.name).toBe("propose_action");
    expect(toolCall?.arguments).toMatchObject({
      action: "create_book",
      title: "Những Ngày Mưa",
      instruction: expect.stringContaining("Những Ngày Mưa"),
      createBook: { title: "Những Ngày Mưa" },
    });
  });

  it("handles the Pi runtime shape with systemPrompt separate and text blocks", async () => {
    const stream = stubAgentStream({} as never, {
      systemPrompt: buildAgentSystemPrompt(null, "vi", "book-create"),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hãy tạo một cuốn tiểu thuyết về Thành Phố Không Ngủ, thể loại đô thị." }],
        },
      ],
    });

    const events: unknown[] = [];
    for await (const event of stream) events.push(event);
    const done = events.find((event) => (event as { type?: string }).type === "done") as {
      message?: { content?: Array<{ type?: string; name?: string; arguments?: Record<string, unknown> }> };
    } | undefined;
    const toolCall = done?.message?.content?.find((content) => content.type === "toolCall");

    expect(toolCall?.name).toBe("propose_action");
    expect(toolCall?.arguments).toMatchObject({
      action: "create_book",
      instruction: expect.stringContaining("Thành Phố Không Ngủ"),
      createBook: { title: "Thành Phố Không Ngủ" },
    });
  });

  it("returns all required sections for an architect foundation prompt", () => {
    const res = stubChatCompletion(
      [
        {
          role: "system",
          content: "You are the InkOS architect. Output exactly five SECTION blocks: story_frame, volume_map, roles, book_rules, pending_hooks.",
        },
        { role: "user", content: 'Generate the complete foundation for a novel titled "Thành Phố Không Ngủ".' },
      ],
      "stub-model",
    );

    expect(res.content).toContain("=== SECTION: story_frame ===");
    expect(res.content).toContain("=== SECTION: volume_map ===");
    expect(res.content).toContain("=== SECTION: roles ===");
    expect(res.content).toContain("=== SECTION: book_rules ===");
    expect(res.content).toContain("=== SECTION: pending_hooks ===");
    expect(res.content).not.toContain('"type":"branch"');
  });

  it("returns all five dimensions for a foundation-review prompt", () => {
    const res = stubChatCompletion(
      [
        {
          role: "system",
          content: "You are a senior fiction editor reviewing a new book's foundation. Score each dimension using the strict === DIMENSION: N === format.",
        },
        { role: "user", content: "## Story Bible\nA complete foundation excerpt." },
      ],
      "stub-model",
    );

    for (let dimension = 1; dimension <= 5; dimension += 1) {
      expect(res.content).toContain(`=== DIMENSION: ${dimension} ===`);
    }
    expect(res.content).toContain("=== OVERALL ===");
    expect(res.content).not.toContain('"type":"branch"');
  });

  it("returns a parseable memo for an English planner prompt", () => {
    const res = stubChatCompletion(
      [
        {
          role: "system",
          content: "You are the novel's editor-in-chief. Produce a chapter_memo with ## Chapter goal and all required sections.",
        },
        { role: "user", content: "# Chapter 1 memo request\nPlan the next chapter." },
      ],
      "stub-model",
    );

    expect(res.content).toContain("## Chapter goal");
    expect(res.content).toContain("## Current task");
    expect(res.content).toContain("## Do not");
    expect(res.content).not.toContain('"type":"branch"');
    expect(parseMemo(res.content, 1, false).goal).toContain("Reveal the first altered record");
  });

  it("returns Vietnamese chapter markers for a writer prompt", () => {
    const res = stubChatCompletion(
      [
        {
          role: "system",
          content: "You are the InkOS writing assistant. Output === PRE_WRITE_CHECK ===, === CHAPTER_TITLE ===, and === CHAPTER_CONTENT === blocks.",
        },
        { role: "user", content: "Write chapter 1 in Vietnamese." },
      ],
      "stub-model",
    );

    expect(res.content).toContain("=== PRE_WRITE_CHECK ===");
    expect(res.content).toContain("=== CHAPTER_TITLE ===");
    expect(res.content).toContain("=== CHAPTER_CONTENT ===");
    expect(res.content).not.toContain('"type":"branch"');
    expect(parseCreativeOutput(1, res.content, "vi", "vi_wordlike_tokens_v1").content).toContain("Buổi sáng");
  });

  it("returns parseable observer facts instead of a generic node for observer prompts", () => {
    const res = stubChatCompletion(
      [
        { role: "system", content: "你是一个事实提取专家。输出格式：=== OBSERVATIONS ===" },
        { role: "user", content: "请提取第1章中的所有事实：Mai走出档案室。" },
      ],
      "stub-model",
    );

    expect(res.content).toContain("=== OBSERVATIONS ===");
    expect(res.content).toContain("[CHARACTERS]");
    expect(res.content).not.toContain('"type":"branch"');
  });

  it("returns a schema-valid runtime delta for settler prompts", () => {
    const res = stubChatCompletion(
      [
        { role: "system", content: "你是状态追踪分析师。必须输出 === RUNTIME_STATE_DELTA === 和 === POST_SETTLEMENT ===。" },
        { role: "user", content: "请分析第1章「Dấu Vết Đầu Tiên」的正文，更新所有追踪文件。" },
      ],
      "stub-model",
    );

    const parsed = parseSettlerDeltaOutput(res.content);
    expect(parsed.runtimeStateDelta.chapter).toBe(1);
    expect(parsed.runtimeStateDelta.chapterSummary?.title).toBe("Dấu Vết Đầu Tiên");
    expect(parsed.runtimeStateDelta.hookOps).toEqual({ upsert: [], mention: [], resolve: [], defer: [] });
    expect(parsed.postSettlement).toMatch(/settlement/i);
  });

  it("returns PASS for the state-validator protocol", () => {
    const res = stubChatCompletion(
      [
        { role: "system", content: "You are a continuity validator for a novel writing system. First line: exactly PASS, REPAIR, or FAIL." },
        { role: "user", content: "Chapter 1 validation" },
      ],
      "stub-model",
    );

    expect(res.content.trim()).toBe("PASS");
  });

  it("feeds the parsed VI delta through the runtime artifact API", () => {
    const response = stubChatCompletion(
      [
        { role: "system", content: "你是状态追踪分析师。必须输出 === RUNTIME_STATE_DELTA ===。" },
        { role: "user", content: "请分析第1章「Dấu Vết Đầu Tiên」的正文。" },
      ],
      "stub-model",
    );
    const delta = parseSettlerDeltaOutput(response.content).runtimeStateDelta;
    const snapshot = {
      manifest: StateManifestSchema.parse({
        schemaVersion: 2,
        language: "vi",
        lastAppliedChapter: 0,
        projectionVersion: 1,
        migrationWarnings: [],
      }),
      currentState: { chapter: 0, facts: [] },
      hooks: { hooks: [] },
      chapterSummaries: { rows: [] },
    };

    const artifacts = buildRuntimeStateArtifactsFromSnapshot({ snapshot, delta, language: "vi" });
    expect(artifacts.snapshot.manifest.language).toBe("vi");
    expect(artifacts.snapshot.currentState.chapter).toBe(1);
    expect(artifacts.currentStateMarkdown).toContain("# Trạng thái hiện tại");
  });
});
