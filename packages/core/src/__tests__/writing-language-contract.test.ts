import { describe, expect, it } from "vitest";
import {
  ProjectConfigSchema,
  WritingLanguageSchema,
  resolveWritingLanguageProfile,
  inferLanguage,
} from "../index.js";
import { BookConfigSchema } from "../models/book.js";
import { GenreProfileSchema } from "../models/genre-profile.js";
import { RuntimeStateLanguageSchema, StateManifestSchema } from "../models/runtime-state.js";

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

  it("accepts VI in persisted book and runtime state contracts", () => {
    expect(BookConfigSchema.parse({
      id: "vi-book",
      title: "Vietnamese Book",
      platform: "other",
      genre: "other",
      status: "outlining",
      language: "vi",
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    }).language).toBe("vi");
    expect(RuntimeStateLanguageSchema.parse("vi")).toBe("vi");
    expect(StateManifestSchema.parse({
      schemaVersion: 2,
      language: "vi",
      lastAppliedChapter: 0,
      projectionVersion: 1,
      migrationWarnings: [],
    }).language).toBe("vi");
  });

  it("does not widen project or genre-profile language to VI", () => {
    expect(() => ProjectConfigSchema.shape.language.parse("vi")).toThrow();
    expect(() => GenreProfileSchema.shape.language.parse("vi")).toThrow();
  });

  it("resolves VI to an explicit English-scaffold strategy", () => {
    expect(resolveWritingLanguageProfile("vi")).toEqual({
      language: "vi",
      promptStrategy: "en-scaffold-vi-contract",
      scaffoldLanguage: "en",
      countingMode: "vi_wordlike_tokens_v1",
      defaultChapterLength: 1150,
      supportsLongFiction: true,
    });
  });
});
