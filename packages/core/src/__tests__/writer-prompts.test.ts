import { describe, expect, it } from "vitest";
import type { BookConfig } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import { LengthSpecSchema } from "../models/length-governance.js";
import { buildWriterSystemPrompt, buildGoldenOpeningDiscipline } from "../agents/writer-prompts.js";
import { BookRulesSchema } from "../models/book-rules.js";
import { buildLengthSpec } from "../utils/length-metrics.js";

const BOOK: BookConfig = {
  id: "prompt-book",
  title: "Prompt Book",
  platform: "tomato",
  genre: "other",
  status: "active",
  targetChapters: 20,
  chapterWordCount: 3000,
  createdAt: "2026-03-22T00:00:00.000Z",
  updatedAt: "2026-03-22T00:00:00.000Z",
};

const GENRE: GenreProfile = {
  id: "other",
  name: "综合",
  language: "zh",
  chapterTypes: ["setup", "conflict"],
  fatigueWords: [],
  numericalSystem: false,
  powerScaling: false,
  eraResearch: false,
  pacingRule: "",
  satisfactionTypes: [],
  auditDimensions: [],
};

describe("buildWriterSystemPrompt", () => {
  it("keeps governed inputs and leaves reusable craft to the activated Skill", () => {
    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      undefined,
      "zh",
      "governed",
    );

    expect(prompt).toContain("## 输入治理契约");
    expect(prompt).toContain("卷纲是默认规划");
    expect(prompt).not.toContain("## 核心规则");
    expect(prompt).not.toContain("## 创作宪法");
    expect(prompt).not.toContain("## 代入感六支柱");
  });

  it("enforces narrative person only when the user explicitly set one (#290)", () => {
    const firstPerson = BookRulesSchema.parse({ narrativePerson: "first" });
    const promptFirst = buildWriterSystemPrompt(
      BOOK, GENRE, firstPerson, "# Book Rules", "# Genre Body", "# Style Guide",
      undefined, 3, "creative", undefined, "zh", "governed",
    );
    expect(promptFirst).toContain("叙事人称（硬约束）");
    expect(promptFirst).toContain("第一人称");

    // Unset → no narrative-person section is imposed (the genre default applies).
    const noPerson = BookRulesSchema.parse({});
    const promptNone = buildWriterSystemPrompt(
      BOOK, GENRE, noPerson, "# Book Rules", "# Genre Body", "# Style Guide",
      undefined, 3, "creative", undefined, "zh", "governed",
    );
    expect(promptNone).not.toContain("叙事人称（硬约束）");
  });

  it("tolerates a stray narrativePerson value (degrades to no constraint, fail-open)", () => {
    const rules = BookRulesSchema.parse({ narrativePerson: "(仅当用户指定)" });
    expect(rules.narrativePerson).toBeUndefined();
  });

  it("uses target-range wording when a length spec is provided", () => {
    const lengthSpec = LengthSpecSchema.parse({
      target: 2200,
      softMin: 1900,
      softMax: 2500,
      hardMin: 1600,
      hardMax: 2800,
      countingMode: "zh_chars",
    });

    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      undefined,
      "zh",
      "governed",
      lengthSpec,
    );

    expect(prompt).toContain("目标字数：2200");
    expect(prompt).toContain("允许区间：1900-2500");
    expect(prompt).not.toContain("正文不少于2200字");
  });

  it("gives Vietnamese writers a 1100-1300 generation target while preserving audit safety", () => {
    const prompt = buildWriterSystemPrompt(
      { ...BOOK, language: "vi" },
      { ...GENRE, name: "综合" },
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide",
      undefined,
      1,
      "creative",
      undefined,
      "vi",
      "governed",
      buildLengthSpec(1150, "vi"),
    );

    expect(prompt).toContain("1100-1300");
    expect(prompt).toContain("vi_wordlike_tokens_v1");
    expect(prompt).toContain("1000-1800");
    expect(prompt).not.toContain("1000-1500");
    expect(prompt).toContain("chapter memo/context");
    expect(prompt).toContain("CHAPTER_CONTENT");
    expect(prompt).toContain("mục tiêu viết");
    expect(prompt).toContain("Độ dài khi viết tiếng Việt");
    expect(prompt).not.toContain("## 字数治理");
  });

  it("keeps hard guardrails and book/style constraints in governed mode", () => {
    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules\n\n- Do not reveal the mastermind.",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      undefined,
      "zh",
      "governed",
    );

    expect(prompt).toContain("Do not reveal the mastermind");
    expect(prompt).toContain("Keep the prose restrained");
  });

  it("injects golden opening discipline into zh writer system prompt for ch<=3", () => {
    for (const ch of [1, 2, 3]) {
      const prompt = buildWriterSystemPrompt(
        BOOK,
        GENRE,
        null,
        "# Book Rules",
        "# Genre Body",
        "# Style Guide",
        undefined,
        ch,
        "creative",
        undefined,
        "zh",
        "governed",
      );
      expect(prompt).toContain("黄金三章写作纪律");
      expect(prompt).toContain(`第 ${ch} 章`);
    }
  });

  it("injects golden opening discipline into en writer system prompt for ch<=3", () => {
    for (const ch of [1, 2, 3]) {
      const prompt = buildWriterSystemPrompt(
        BOOK,
        { ...GENRE, language: "en", name: "General" },
        null,
        "# Book Rules",
        "# Genre Body",
        "# Style Guide",
        undefined,
        ch,
        "creative",
        undefined,
        "en",
        "governed",
      );
      expect(prompt).toContain("Golden Opening Discipline");
      expect(prompt).toContain(`Chapter ${ch}`);
    }
  });

  it("omits golden opening discipline for ch>=4 in both languages", () => {
    const zh = buildWriterSystemPrompt(
      BOOK, GENRE, null, "# Book Rules", "# Genre Body", "# Style Guide",
      undefined, 4, "creative", undefined, "zh", "governed",
    );
    expect(zh).not.toContain("黄金三章写作纪律");

    const en = buildWriterSystemPrompt(
      BOOK, { ...GENRE, language: "en", name: "General" }, null,
      "# Book Rules", "# Genre Body", "# Style Guide",
      undefined, 4, "creative", undefined, "en", "governed",
    );
    expect(en).not.toContain("Golden Opening Discipline");
  });

  it("renders golden opening discipline as cohesive prose, not a checklist", () => {
    const out = buildGoldenOpeningDiscipline(1, "zh");
    // Header line is allowed; body must not contain enumerated/bulleted lines.
    expect(out).not.toMatch(/^\s*1\.\s/m);
    expect(out).not.toMatch(/^\s*-\s/m);
    expect(out).not.toMatch(/^\s*\*\s/m);
    // Carries the load-bearing slot constraints.
    expect(out).toContain("800 字");
    expect(out).toContain("做出来");
    expect(out).toContain("说出来");
    expect(out).toContain("小钩子");
  });

  it("buildGoldenOpeningDiscipline returns empty string for ch>=4 / undefined", () => {
    expect(buildGoldenOpeningDiscipline(4, "zh")).toBe("");
    expect(buildGoldenOpeningDiscipline(99, "en")).toBe("");
    expect(buildGoldenOpeningDiscipline(undefined, "zh")).toBe("");
  });

  it("tells governed English prompts to obey variance briefs and include resistance-bearing exchanges", () => {
    const prompt = buildWriterSystemPrompt(
      {
        ...BOOK,
        language: "en",
      },
      {
        ...GENRE,
        language: "en",
        name: "General",
      },
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      undefined,
      "en",
      "governed",
    );

    expect(prompt).toContain("English Variance Brief");
    expect(prompt).toContain("resistance-bearing exchange");
  });
});

describe("buildWriterSystemPrompt style-guide header", () => {
  const STYLE_BODY = "# Style guide body\n\nKeep the prose restrained.";

  it("labels the style guide section in the book language", () => {
    const viPrompt = buildWriterSystemPrompt(
      { ...BOOK, language: "vi" },
      GENRE,
      null,
      "",
      "",
      STYLE_BODY,
      undefined,
      1,
      "full",
      undefined,
      "vi",
    );
    expect(viPrompt).toContain("## Phong cách viết");
    expect(viPrompt).not.toContain("## 文风指南");

    const zhPrompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "",
      "",
      STYLE_BODY,
      undefined,
      1,
      "full",
      undefined,
      "zh",
    );
    expect(zhPrompt).toContain("## 文风指南");
    expect(zhPrompt).not.toContain("## Phong cách viết");
  });
});
