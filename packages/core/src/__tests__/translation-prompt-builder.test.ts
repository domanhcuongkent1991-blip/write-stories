import { describe, expect, it } from "vitest";
import {
  buildRefineSystemPrompt,
  buildRefineUserPayload,
  buildTranslationSystemPrompt,
  buildTranslationUserPayload,
} from "../translation/prompt-builder.js";
import type { TranslationGlossaryTerm, TranslationSegment } from "../translation/types.js";

const glossary: ReadonlyArray<TranslationGlossaryTerm> = [
  { source: "李明", target: "Lý Minh", category: "person", aliases: ["小明"], note: "protagonist" },
  { source: "青云门", target: "Thanh Vân Môn", category: "sect" },
];
const styleContract = resolveZhViStyleContractForTest();
const context = {
  contextBefore: "đoạn trước đó",
  contextAfter: "đoạn sau đó",
  previousTargetTail: "bản dịch trước đó",
};

function resolveZhViStyleContractForTest(): string {
  return "Giữ xưng hô nhất quán. Tên riêng Hán-Việt có chọn lọc. Dịch sát nghĩa nhưng không dịch từng chữ.";
}

describe("buildTranslationSystemPrompt", () => {
  it("orders blocks ROLE -> GLOSSARY -> CAST -> STYLE", () => {
    const prompt = buildTranslationSystemPrompt({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      glossary,
      styleContract,
    });
    const labels = [
      "# GLOSSARY - REQUIRED TRANSLATIONS",
      "# CAST",
      "# STYLE INSTRUCTIONS",
    ];
    expect(prompt).toContain("You are InkOS Translation Agent");
    let position = -1;
    for (const label of labels) {
      const found = prompt.indexOf(label);
      expect(found).toBeGreaterThan(position);
      position = found;
    }
    expect(prompt).toMatchSnapshot();
  });

  it("lists only the supplied glossary terms and their aliases", () => {
    const prompt = buildTranslationSystemPrompt({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      glossary,
      styleContract,
    });
    expect(prompt).toContain("李明");
    expect(prompt).toContain("Lý Minh");
    expect(prompt).toContain("小明");
    expect(prompt).toContain("青云门");
    expect(prompt).not.toContain("落霞城");
  });

  it("omits glossary and style blocks when empty", () => {
    const prompt = buildTranslationSystemPrompt({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      glossary: [],
      styleContract: undefined,
    });
    expect(prompt).not.toContain("# GLOSSARY - REQUIRED TRANSLATIONS");
    expect(prompt).not.toContain("# CAST");
    expect(prompt).not.toContain("# STYLE INSTRUCTIONS");
  });
});

describe("buildTranslationUserPayload", () => {
  const segments: ReadonlyArray<TranslationSegment> = [
    { index: 1, source: "李明走进落霞城。" },
    { index: 2, source: "他说要买灵石。" },
  ];

  it("places CHAPTER SUMMARY before CONTEXT before PREVIOUS TAIL before TASK", () => {
    const payload = buildTranslationUserPayload({
      chapterTitle: "入门",
      segments,
      context: { ...context, chapterSummary: "Trước đó Lý Minh nhập môn." },
      glossaryFiltered: glossary,
    });
    const labels = [
      "# CHAPTER SUMMARY (do NOT translate)",
      "# CONTEXT (do NOT translate)",
      "# PREVIOUS TRANSLATION TAIL (do NOT translate)",
      "# TASK",
    ];
    let position = -1;
    for (const label of labels) {
      const found = payload.indexOf(label);
      expect(found).toBeGreaterThan(position);
      position = found;
    }
    expect(payload).toContain("Trước đó Lý Minh nhập môn.");
    expect(payload).toContain("đoạn trước đó");
    expect(payload).toContain("đoạn sau đó");
    expect(payload).toContain("bản dịch trước đó");
    expect(payload).toContain("李明走进落霞城。");
    expect(payload).toMatchSnapshot();
  });

  it("renders a CONTINUITY block with previous third-person forms when provided", () => {
    const payload = buildTranslationUserPayload({
      chapterTitle: "入门",
      segments,
      context: { previousAddressForms: ["hắn", "nàng"] },
      glossaryFiltered: glossary,
    });
    const blockPosition = payload.indexOf("# CONTINUITY (do NOT translate)");
    expect(blockPosition).toBeGreaterThanOrEqual(0);
    expect(payload).toContain("hắn, nàng");
    expect(payload).toContain("Keep the same forms");
    // Continuity sits after the context blocks, before TASK.
    const taskPosition = payload.indexOf("# TASK");
    expect(blockPosition < taskPosition).toBe(true);
  });

  it("omits the CONTINUITY block when no previous address forms are known", () => {
    const payload = buildTranslationUserPayload({
      chapterTitle: "入门",
      segments,
      context: {},
      glossaryFiltered: [],
    });
    expect(payload).not.toContain("# CONTINUITY");
  });

  it("omits context blocks when the context is empty", () => {
    const payload = buildTranslationUserPayload({
      chapterTitle: "入门",
      segments,
      context: {},
      glossaryFiltered: glossary,
    });
    expect(payload).not.toContain("# CHAPTER SUMMARY");
    expect(payload).not.toContain("# CONTEXT");
    expect(payload).not.toContain("# PREVIOUS TRANSLATION TAIL");
    expect(payload).toContain("# TASK");
  });

  it("never contains the string 'undefined'", () => {
    const payload = buildTranslationUserPayload({
      chapterTitle: "入门",
      segments,
      context: {},
      glossaryFiltered: [],
    });
    const prompt = buildTranslationSystemPrompt({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      glossary,
      styleContract,
    });
    expect(prompt + payload).not.toContain("undefined");
  });
});

describe("refine prompts", () => {
  it("builds a refine system prompt with its own style instructions", () => {
    const prompt = buildRefineSystemPrompt({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      glossary,
      styleContract,
    });
    expect(prompt).toContain("refine");
    expect(prompt).toContain("# GLOSSARY - REQUIRED TRANSLATIONS");
    expect(prompt).toContain("# STYLE INSTRUCTIONS");
  });

  it("builds a refine user payload with DRAFT and previous refined tail blocks", () => {
    const payload = buildRefineUserPayload({
      chapterTitle: "入门",
      segments: [
        { index: 1, source: "李明走进落霞城。", target: "Lý Minh bước vào thành Lạc Hà." },
      ],
      context: { previousTargetTail: "bản refine trước đó" },
      glossaryFiltered: glossary,
    });
    const tailPosition = payload.indexOf("# PREVIOUS REFINED TAIL (do NOT translate)");
    const draftPosition = payload.indexOf("# DRAFT");
    expect(tailPosition).toBeGreaterThanOrEqual(0);
    expect(draftPosition).toBeGreaterThan(tailPosition);
    expect(payload).toContain("Lý Minh bước vào thành Lạc Hà.");
    expect(payload).toContain("bản refine trước đó");
  });
});
