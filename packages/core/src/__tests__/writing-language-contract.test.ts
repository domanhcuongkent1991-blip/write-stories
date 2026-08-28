import { describe, expect, it } from "vitest";
import {
  ProjectConfigSchema,
  WritingLanguageSchema,
  resolveWritingLanguageProfile,
  inferLanguage,
} from "../index.js";

describe("writing language contract", () => {
  it("parses zh, en and explicit vi", () => {
    expect(WritingLanguageSchema.parse("zh")).toBe("zh");
    expect(WritingLanguageSchema.parse("en")).toBe("en");
    expect(WritingLanguageSchema.parse("vi")).toBe("vi");
    expect(() => WritingLanguageSchema.parse("fr")).toThrow();
  });

  it("keeps VI explicit instead of inferring it from Latin text", () => {
    expect(inferLanguage("Một người trở lại Sài Gòn để tìm cuốn sổ cũ.")).toBe("en");
    expect(inferLanguage("")).toBe("zh");
  });

  it("does not widen project language to VI", () => {
    expect(() => ProjectConfigSchema.shape.language.parse("vi")).toThrow();
  });

  it("resolves VI to an explicit English-scaffold strategy", () => {
    expect(resolveWritingLanguageProfile("vi")).toEqual({
      language: "vi",
      promptStrategy: "en-scaffold-vi-contract",
      scaffoldLanguage: "en",
      countingMode: "vi_wordlike_tokens_v1",
      defaultChapterLength: 2000,
      supportsLongFiction: true,
    });
  });
});
