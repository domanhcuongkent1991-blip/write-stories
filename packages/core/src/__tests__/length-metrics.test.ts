import { describe, it, expect } from "vitest";
import {
  buildLengthSpec,
  countChapterLength,
  defaultChapterLength,
  formatLengthCount,
  formatWriterPromptLengthGuidance,
  isOutsideHardRange,
  isOutsideSoftRange,
  resolveLengthCountingMode,
} from "../utils/length-metrics.js";

describe("length metrics", () => {
  it("counts Chinese chapter length using zh_chars", () => {
    expect(countChapterLength("他抬头看天。", "zh_chars")).toBe(6);
  });

  it("counts English chapter length using en_words", () => {
    expect(countChapterLength("He looked at the sky.", "en_words")).toBe(5);
  });

  it("defaults chapter length to the language-native unit", () => {
    expect(defaultChapterLength("zh")).toBe(3000);
    expect(defaultChapterLength("en")).toBe(2000);
    expect(defaultChapterLength()).toBe(3000);
  });

  it("counts prose only for markdown-shaped Chinese chapters", () => {
    const markdownChapter = [
      "---",
      "title: 第1章 归来",
      "---",
      "",
      "# 第1章 归来",
      "",
      "陈风抬头看天。",
    ].join("\n");

    expect(countChapterLength(markdownChapter, "zh_chars")).toBe("陈风抬头看天。".length);
  });

  it("builds a conservative length spec for Chinese chapters", () => {
    const spec = buildLengthSpec(2200, "zh");

    expect(spec).toEqual({
      target: 2200,
      softMin: 1900,
      softMax: 2500,
      hardMin: 1600,
      hardMax: 2800,
      countingMode: "zh_chars",
    });
  });

  it("builds a conservative length spec for English chapters", () => {
    const spec = buildLengthSpec(2200, "en");

    expect(spec.countingMode).toBe("en_words");
    expect(spec.softMin).toBe(1900);
    expect(spec.softMax).toBe(2500);
    expect(spec.hardMin).toBe(1600);
    expect(spec.hardMax).toBe(2800);
  });

  it("scales the conservative bands for smaller targets", () => {
    const spec = buildLengthSpec(220, "zh");

    expect(spec.softMin).toBe(190);
    expect(spec.softMax).toBe(250);
    expect(spec.hardMin).toBe(160);
    expect(spec.hardMax).toBe(280);
  });

  it("detects soft and hard range drift", () => {
    const spec = buildLengthSpec(2200, "zh");

    expect(isOutsideSoftRange(1800, spec)).toBe(true);
    expect(isOutsideSoftRange(2200, spec)).toBe(false);
    expect(isOutsideHardRange(1500, spec)).toBe(true);
    expect(isOutsideHardRange(2200, spec)).toBe(false);
  });

  it("counts Vietnamese Unicode word-like tokens deterministically", () => {
    expect(countChapterLength("Một đêm, thành-phố thức giấc năm 2026.", "vi_wordlike_tokens_v1")).toBe(7);
    expect(countChapterLength("người’s lời", "vi_wordlike_tokens_v1")).toBe(2);
  });

  it("normalizes NFC only for Vietnamese measurement", () => {
    const nfc = "Tiếng Việt rất đẹp";
    const nfd = nfc.normalize("NFD");
    expect(countChapterLength(nfc, "vi_wordlike_tokens_v1"))
      .toBe(countChapterLength(nfd, "vi_wordlike_tokens_v1"));
  });

  it("keeps markdown metadata outside Vietnamese prose counts", () => {
    const markdown = "---\ntitle: Thử\n---\n# Chương 1\n\nMột ngày bình yên.";
    expect(countChapterLength(markdown, "vi_wordlike_tokens_v1")).toBe(4);
  });

  it("builds VI defaults without changing zh/en", () => {
    expect(defaultChapterLength("vi")).toBe(1150);
    expect(resolveLengthCountingMode("vi")).toBe("vi_wordlike_tokens_v1");
    expect(buildLengthSpec(2200, "vi").countingMode).toBe("vi_wordlike_tokens_v1");
    expect(defaultChapterLength("zh")).toBe(3000);
    expect(defaultChapterLength("en")).toBe(2000);
  });

  it("builds the approved Vietnamese short-chapter policy", () => {
    expect(buildLengthSpec(1150, "vi")).toEqual({
      target: 1150,
      softMin: 1100,
      softMax: 1300,
      hardMin: 1000,
      hardMax: 1800,
      countingMode: "vi_wordlike_tokens_v1",
    });
  });

  it("builds the Vietnamese long-form spec for a 2600-word book target", () => {
    expect(buildLengthSpec(2600, "vi")).toEqual({
      target: 2600,
      softMin: 2246,
      softMax: 2954,
      hardMin: 1891,
      hardMax: 3309,
      countingMode: "vi_wordlike_tokens_v1",
    });
  });

  it("formats the Vietnamese writer guidance for long-form targets", () => {
    const guidance = formatWriterPromptLengthGuidance(buildLengthSpec(2600, "vi"), "vi");
    expect(guidance).toBeDefined();
    expect(guidance).toContain("2246-2954");
    expect(guidance).toContain("2600");
    expect(guidance).toContain("1891-3309");
    expect(guidance).toContain("vi_wordlike_tokens_v1");
  });

  it("formats Vietnamese length counts in words", () => {
    expect(formatLengthCount(7, "vi_wordlike_tokens_v1")).toBe("7 từ");
  });

  it("formats the Vietnamese writer target separately from the audit safety range", () => {
    const guidance = formatWriterPromptLengthGuidance(buildLengthSpec(1150, "vi"), "vi");
    expect(guidance).toContain("1100-1300");
    expect(guidance).toContain("vi_wordlike_tokens_v1");
    expect(guidance).toContain("1000-1800");
    expect(guidance).not.toContain("1000-1500");
    expect(guidance).toContain("chapter memo/context");
  });

  it("does not override non-Vietnamese prompt formatting", () => {
    expect(formatWriterPromptLengthGuidance(buildLengthSpec(2200, "zh"), "zh")).toBeUndefined();
  });

});
