import { describe, expect, expectTypeOf, it } from "vitest";
import type { WritingLanguage } from "@actalk/inkos-core";
import {
  resolveBookLanguageUpdate,
  resolveCliLocale,
  resolveGlobalWritingLanguage,
  resolveWritingLanguage,
} from "../locale.js";
import { formatWriteNextResultLines } from "../localization.js";

const WRITE_RESULT = {
  chapterNumber: 1,
  title: "Boundary",
  wordCount: 1200,
  status: "ready-for-review",
  revised: false,
  issues: [],
  auditPassed: true,
} as const;

describe("CLI locale and writing-language boundaries", () => {
  it("resolves the UI locale independently from writing language", () => {
    expect(resolveCliLocale({ INKOS_LOCALE: "vi_VN.UTF-8" })).toBe("vi");
    expect(resolveCliLocale({ INKOS_LOCALE: "auto", LANG: "en_US.UTF-8" })).toBe("en");
    expect(resolveCliLocale({ LC_ALL: "vi_VN.UTF-8", LANG: "en_US.UTF-8" })).toBe("vi");
    expect(resolveCliLocale({ LANG: "C" })).toBe("zh");

    expect(resolveWritingLanguage("en", {})).toBe("en");
    expect(resolveWritingLanguage(undefined, { INKOS_DEFAULT_LANGUAGE: "en" })).toBe("en");
    expect(resolveWritingLanguage(undefined, { INKOS_LOCALE: "vi" })).toBe("zh");
    expect(resolveWritingLanguage(undefined, { INKOS_DEFAULT_LANGUAGE: "vi" })).toBe("vi");
    expect(resolveWritingLanguage("vi", {})).toBe("vi");
  });

  it("uses the book language for length units under a Vietnamese UI", () => {
    expect(formatWriteNextResultLines("vi", "zh", WRITE_RESULT)).toContain("  Độ dài: 1200字");
    expect(formatWriteNextResultLines("vi", "en", WRITE_RESULT)).toContain("  Độ dài: 1200 words");
  });

  it("keeps Vietnamese in the writing-language type while UI locale stays independent", () => {
    expectTypeOf<"vi">().toMatchTypeOf<WritingLanguage>();
    expectTypeOf<WritingLanguage>().toEqualTypeOf<"zh" | "en" | "vi">();
  });

  it("keeps global defaults legacy-safe and blocks Vietnamese book migration", () => {
    expect(resolveGlobalWritingLanguage("zh")).toBe("zh");
    expect(resolveGlobalWritingLanguage("en")).toBe("en");
    expect(() => resolveGlobalWritingLanguage("vi")).toThrow(
      "Global default writing language must be zh or en.",
    );

    expect(resolveBookLanguageUpdate("vi", "vi")).toBe("vi");
    expect(resolveBookLanguageUpdate("en", undefined)).toBe("en");
    expect(() => resolveBookLanguageUpdate("en", "vi")).toThrow(
      "Vietnamese writing language cannot be enabled or disabled through book update.",
    );
    expect(() => resolveBookLanguageUpdate("vi", "en")).toThrow(
      "Vietnamese writing language cannot be enabled or disabled through book update.",
    );
  });
});
