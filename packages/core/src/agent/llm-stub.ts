import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  Api,
} from "@mariozechner/pi-ai";
import type { LLMMessage, LLMResponse } from "../llm/provider.js";

export function isLlmStubEnabled(): boolean {
  return Boolean(process.env.INKOS_AGENT_LLM_STUB);
}

// Mirrors EMPTY_USAGE in agent-session.ts exactly.
const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
          return block.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content);
}

function lastUserText(context: { messages?: Array<{ role: string; content: unknown }> }): string {
  const msgs = context.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === "user") {
      return messageContentText(m.content);
    }
  }
  return "";
}

function systemText(context: { systemPrompt?: unknown; messages?: Array<{ role: string; content: unknown }> }): string {
  const separatePrompt = typeof context.systemPrompt === "string" ? context.systemPrompt : "";
  const messagePrompts = (context.messages ?? [])
    .filter((message) => message.role === "system")
    .map((message) => messageContentText(message.content));
  return [separatePrompt, ...messagePrompts].filter(Boolean).join("\n");
}

function isUnconfirmedBookCreationPrompt(context: { systemPrompt?: unknown; messages?: Array<{ role: string; content: unknown }> }): boolean {
  const prompt = systemText(context);
  return /book creation assistant|建书助手/i.test(prompt)
    && /action\s*=\s*create_book|action=create_book/i.test(prompt)
    && /do not create directly yet|还不能直接建书/i.test(prompt)
    && !/confirmed long-form|用户已经确认创建/i.test(prompt);
}

function creationTitle(text: string): string | undefined {
  const vietnamese = text.match(/\bvề\s+([^,\n.!?]+?)(?:\s*,|[.!?]|$)/i)?.[1]?.trim();
  if (vietnamese) return vietnamese;
  return text.match(/(?:tựa đề|tên sách|title)\s*(?:là|is|:)\s*["“]?([^"”\n,.!?]+?)["”]?(?:\s*[,\n.!?]|$)/i)?.[1]?.trim();
}

function alreadyProposed(
  context: { messages?: Array<{ role: string; content: unknown; toolName?: string }> },
): boolean {
  return (context.messages ?? []).some((m) => {
    // Agent format (non-openai-completions): role="toolResult" with toolName
    if (m.role === "toolResult" && (m as { toolName?: string }).toolName === "propose_action") {
      return true;
    }
    // LLM format (openai-completions): assistant message with toolCall content
    if (m.role === "assistant" && Array.isArray(m.content)) {
      if (
        (m.content as Array<{ type: string; name?: string }>).some(
          (c) => c.type === "toolCall" && c.name === "propose_action",
        )
      ) {
        return true;
      }
    }
    // LLM format (openai-completions folded): tool result folded into user message string
    if (m.role === "user" && typeof m.content === "string") {
      if (/- propose_action \(/.test(m.content as string)) {
        return true;
      }
    }
    return false;
  });
}

/**
 * Returns a deterministic AssistantMessageEventStream that either emits a
 * propose_action toolCall (when the latest user text mentions "结构/骨架/structure"
 * and propose_action hasn't run yet) or a plain "好的。" text reply.
 *
 * Mirrors localAssistantStopStream in agent-session.ts exactly — same
 * createAssistantMessageEventStream() + queueMicrotask pattern.
 */
export function stubAgentStream(model: Model<Api>, context: unknown): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const text = lastUserText(context as { messages?: Array<{ role: string; content: unknown }> });
  const proposed = alreadyProposed(
    context as { messages?: Array<{ role: string; content: unknown; toolName?: string }> },
  );
  const title = !proposed && isUnconfirmedBookCreationPrompt(
    context as { systemPrompt?: unknown; messages?: Array<{ role: string; content: unknown }> },
  ) ? creationTitle(text) : undefined;
  const wantCreateBook = Boolean(title);
  const wantStructure = !proposed && !wantCreateBook && /结构|骨架|structure/i.test(text);

  const content = wantCreateBook
    ? [
        {
          type: "toolCall" as const,
          id: "stub-create-book",
          name: "propose_action",
          arguments: {
            action: "create_book",
            title,
            summary: `Create the long-form book "${title}" after confirmation.`,
            instruction: `Create a long-form book titled "${title}". Genre: urban fiction. Platform: other. Length: 200 chapters at 3000 words each. World: contemporary city. Protagonist: an ordinary person facing a growing conflict. Core conflict: personal truth versus social pressure.`,
            createBook: {
              title,
              genre: "urban fiction",
              platform: "other",
              targetChapters: 200,
              chapterWordCount: 3000,
            },
          },
        },
      ]
    : wantStructure
    ? [
        {
          type: "toolCall" as const,
          id: "stub-draft",
          name: "propose_action",
          arguments: {
            action: "draft_structure",
            title: "搭建结构",
            summary: "确认后生成三幕骨架",
            instruction: "搭建一个三幕分支结构",
            draftStructure: { instruction: "三幕分支结构" },
          },
        },
      ]
    : [{ type: "text" as const, text: "好的。" }];

  const stopReason = wantCreateBook || wantStructure ? ("toolUse" as const) : ("stop" as const);

  const message: AssistantMessage = {
    role: "assistant",
    content: content as AssistantMessage["content"],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE as AssistantMessage["usage"],
    stopReason,
    timestamp: Date.now(),
  };

  queueMicrotask(() => {
    stream.push({ type: "done", reason: stopReason, message });
    stream.end(message);
  });

  return stream;
}

const STRUCTURE_JSON = JSON.stringify({
  nodes: [
    {
      id: "s",
      type: "start",
      title: "开场",
      sceneDesc: "宫门前",
      choices: [{ id: "c1", text: "查账", targetNodeId: "b" }],
    },
    {
      id: "b",
      type: "branch",
      title: "抉择",
      sceneDesc: "账房",
      choices: [
        { id: "c2", text: "公开", targetNodeId: "e1" },
        { id: "c3", text: "隐瞒", targetNodeId: "e2" },
      ],
    },
    { id: "e1", type: "ending", title: "真相", choices: [] },
    { id: "e2", type: "ending", title: "沉沦", choices: [] },
  ],
});

const NODE_JSON = JSON.stringify({
  type: "branch",
  title: "新场景",
  sceneDesc: "夜色",
  dialogue: [{ speaker: "阿梅", text: "账不能错", emotion: "坚定" }],
  choices: [],
});

const ARCHITECT_FOUNDATION = `=== SECTION: story_frame ===
{{TITLE}} follows a protagonist who chooses to record the truth while a changing city rewards convenient lies. The tone is intimate, tense, and hopeful.

The central conflict pits the protagonist's evidence against a network that protects its influence through silence. Personal stakes and public consequences remain linked throughout the story.

The world is contemporary and grounded: promises have costs, records can be altered, and trust must be earned through observable choices. These rules shape every major turn.

The ending shows the protagonist publishing the complete record and accepting the relationships that survive the truth. Objective: expose the network and establish a trusted public archive.
=== SECTION: volume_map ===
The opening volume follows the first discovery, the pressure to stay silent, and the choice to investigate. Its emotional curve moves from curiosity through isolation to a small, irreversible act of courage.

The middle volumes widen the investigation from one neighborhood to the institutions that enabled it. Each volume resolves one visible question while leaving a deeper promise active for the next stage.

The final volumes force public accountability and a personal sacrifice. The protagonist's private evidence becomes a shared record, and the final turn pays off the first hidden clue.
=== SECTION: roles ===
---ROLE---
tier: major
name: Protagonist
---CONTENT---
An observant archivist who begins by protecting a small circle and ends by making the truth available to everyone. Their arc is measured by the risks they accept.
=== SECTION: book_rules ===
# Writing Rules

Keep cause and effect visible. Do not erase established evidence or resolve a conflict without a concrete choice and consequence.
=== SECTION: pending_hooks ===
| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | payoff_timing | notes |
| first-record | 0 | mystery | open | 0 | The altered record reveals who benefits. | final volume | Seed clue for the central investigation. |
`;

const FOUNDATION_REVIEW = `=== DIMENSION: 1 ===
Score: 90
分数：90
Feedback: The central conflict is clear and sustainable.
意见：核心冲突清晰且可持续。

=== DIMENSION: 2 ===
Score: 90
分数：90
Feedback: The opening has a concrete hook and forward motion.
意见：开篇有具体钩子并保持推进。

=== DIMENSION: 3 ===
Score: 90
分数：90
Feedback: The world rules are coherent and specific.
意见：世界规则内洽且具体。

=== DIMENSION: 4 ===
Score: 90
分数：90
Feedback: The main characters have distinct voices and motives.
意见：主要角色的声音与动机有区分度。

=== DIMENSION: 5 ===
Score: 90
分数：90
Feedback: The requested length and pacing are feasible.
意见：目标篇幅与节奏可行。

=== OVERALL ===
Total: 90
Passed: yes
Summary: The foundation is ready for the writing phase.
总评：基础设定已具备进入写作阶段的条件。`;

const PLANNER_MEMO = `# Chapter 1 memo

## Chapter goal
Reveal the first altered record

## Thread refs
- first-record

## Scene and length budget
The opening scene establishes the archive room and the concrete evidence that starts the investigation.

## Current task
The protagonist compares the original record with its altered copy and keeps both versions safe.

## What the reader is waiting for right now
The reader expects the first clue to prove that the discrepancy is deliberate rather than accidental.
This chapter confirms the pattern while opening a more dangerous question about who changed it.

## To pay off / to keep buried
Pay off the visible discrepancy with a physical comparison and a witness.
Keep the identity of the person behind the alteration buried until the next volume.

## What the slow / transitional beats carry
The quiet archive routine shows the protagonist's method and makes the later intrusion feel disruptive.

## Three-question check on the key choice
The protagonist chooses evidence over personal safety because the record protects someone vulnerable.
The choice serves the immediate goal and follows their established habit of careful observation.

## Required end-of-chapter change
The protagonist leaves with a verified copy, while an unknown watcher learns that the discrepancy was found.

## Hook ledger for this chapter
open: the watcher leaves a second altered record for the protagonist to find later.
advance: first-record moves from a suspicion to documented evidence.
resolve: none, because the network behind the change remains unknown.
defer: the archivist's missing mentor is held for a later chapter with a concrete lead.

## Do not
Do not invent a new institution, erase the original record, or resolve the hidden network in this opening chapter.`;

const WRITER_OUTPUT_VI = `=== PRE_WRITE_CHECK ===
| Check | This chapter | Note |
|---|---|---|
| Current task | Verify the altered record | Evidence stays concrete. |

=== CHAPTER_TITLE ===
Dấu Vết Đầu Tiên

=== CHAPTER_CONTENT ===
Buổi sáng, Mai mở cánh cửa phòng lưu trữ và đặt bản hồ sơ cũ bên cạnh bản sao mới nhận. Những con số tưởng như vô hại lại lệch nhau ở đúng một dòng, nơi tên người gửi đã bị thay bằng một khoảng trắng. Cô chụp lại từng trang, ghi thời gian vào sổ tay rồi cất bản gốc vào ngăn khóa riêng. Khi tiếng bước chân dừng ngoài hành lang, Mai hiểu rằng có người đã biết cô nhìn thấy điều không nên thấy. Cô không tắt đèn; cô mở cửa, mang theo bằng chứng và bước ra đối diện với người đang chờ.`;

const OBSERVER_OUTPUT = `=== OBSERVATIONS ===
[CHARACTERS]
- Mai: đối chiếu hồ sơ gốc và bản sao, giữ lại bằng chứng (scene: phòng lưu trữ)
[LOCATIONS]
- Mai moved from phòng lưu trữ to hành lang
[RESOURCES]
- Mai giữ hồ sơ gốc và một bản sao chụp
[RELATIONSHIPS]
- none
[EMOTIONS]
- Mai: tập trung → cảnh giác (trigger: tiếng bước chân ngoài hành lang)
[INFORMATION]
- Mai learned: hồ sơ đã bị sửa có chủ ý (source: đối chiếu hai bản)
[PLOT_THREADS]
- ADVANCED: first-record — sai lệch đã thành bằng chứng được ghi nhận
[TIME]
- buổi sáng
[PHYSICAL_STATE]
- Mai: không bị thương`;

function settlerDeltaResponse(joined: string): string {
  const chapterMatch = joined.match(/第\s*(\d+)\s*章/) ?? joined.match(/Chapter\s+(\d+)/i);
  const chapter = Number(chapterMatch?.[1] ?? 1);
  const title = joined.match(/第\s*\d+\s*章「([^」]+)」/)?.[1]
    ?? joined.match(/Chapter\s+\d+\s+["“]([^"”]+)["”]/i)?.[1]
    ?? "Dấu Vết Đầu Tiên";
  const delta = {
    chapter,
    currentStatePatch: {
      currentLocation: "Hành lang ngoài phòng lưu trữ",
      protagonistState: "Mai giữ bản gốc và bản sao an toàn",
      currentGoal: "Xác minh nguồn gốc hồ sơ bị sửa",
      currentConflict: "Bằng chứng đối đầu với sức ép phải im lặng",
    },
    hookOps: { upsert: [], mention: [], resolve: [], defer: [] },
    newHookCandidates: [],
    chapterSummary: {
      chapter,
      title,
      characters: "Mai",
      events: "Mai phát hiện sai lệch có chủ ý trong hồ sơ.",
      stateChanges: "Sai lệch được ghi nhận thành bằng chứng.",
      hookActivity: "first-record advanced",
      mood: "căng thẳng",
      chapterType: "mở đầu",
    },
    subplotOps: [],
    emotionalArcOps: [],
    characterMatrixOps: [],
    notes: [],
  };
  return `=== POST_SETTLEMENT ===
Settlement recorded from the chapter evidence.

=== RUNTIME_STATE_DELTA ===
${JSON.stringify(delta, null, 2)}`;
}

function architectFoundationResponse(joined: string): string {
  const title = joined.match(/titled\s+["“]([^"”]+)["”]/i)?.[1]?.trim() || "InkOS Story";
  return ARCHITECT_FOUNDATION.replaceAll("{{TITLE}}", title);
}

/**
 * Deterministic replacement for the chatCompletion network call.
 * Returns STRUCTURE_JSON when the prompt mentions structure/骨架/nodes,
 * otherwise a single node JSON.
 */
export function stubChatCompletion(
  messages: ReadonlyArray<LLMMessage>,
  _model: string,
): LLMResponse {
  const joined = messages.map((m) => m.content).join("\n");
  const isArchitectFoundation = /architect|架构师/i.test(joined)
    && /generate the complete foundation for|生成完整基础设定/i.test(joined)
    && /story_frame|volume_map|pending_hooks/i.test(joined);
  const isFoundationReview = /senior fiction editor reviewing.*foundation|资深小说编辑.*基础设定/i.test(joined)
    && /=== DIMENSION|逐项打分/i.test(joined);
  const isPlannerMemo = /chapter_memo|editor-in-chief|创作总编/i.test(joined)
    && /## Chapter goal|## 本章目标/i.test(joined);
  const isWriterOutput = /=== PRE_WRITE_CHECK ===/.test(joined)
    && /=== CHAPTER_TITLE ===/.test(joined)
    && /=== CHAPTER_CONTENT ===/.test(joined);
  const isObserverOutput = /fact extraction specialist|事实提取专家/i.test(joined)
    && /=== OBSERVATIONS ===/.test(joined);
  const isSettlerDelta = /状态追踪分析师|state tracking analyst/i.test(joined)
    && /=== RUNTIME_STATE_DELTA ===/.test(joined);
  const isStateValidator = /continuity validator for a novel writing system/i.test(joined)
    && /PASS, REPAIR, or FAIL/i.test(joined);
  const content = isArchitectFoundation
    ? architectFoundationResponse(joined)
    : isFoundationReview
      ? FOUNDATION_REVIEW
      : isPlannerMemo
        ? PLANNER_MEMO
        : isWriterOutput
          ? WRITER_OUTPUT_VI
          : isObserverOutput
            ? OBSERVER_OUTPUT
            : isSettlerDelta
              ? settlerDeltaResponse(joined)
              : isStateValidator
                ? "PASS"
                : /骨架|nodes|结构/i.test(joined)
                  ? STRUCTURE_JSON
                  : NODE_JSON;
  return {
    content,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}
