import { afterEach, describe, expect, it } from "vitest";
import { getAppLanguage, setAppLanguage, tr, translateAppString } from "./app-language";

afterEach(() => {
  setAppLanguage("zh");
});

describe("global app language", () => {
  it("supports Vietnamese as a UI locale", () => {
    setAppLanguage("vi");

    expect(getAppLanguage()).toBe("vi");
  });

  it("keeps legacy bilingual copy on English fallback for Vietnamese", () => {
    setAppLanguage("vi");
    expect(tr("中文", "English")).toBe("English");

    setAppLanguage("en");
    expect(tr("中文", "English")).toBe("English");

    setAppLanguage("zh");
    expect(tr("中文", "English")).toBe("中文");
  });

  it("translates stable catalog keys for non-React consumers", () => {
    setAppLanguage("vi");
    expect(translateAppString("nav.books")).toBe("Sách");
    expect(translateAppString("reader.chapterLabel", { n: 4 })).toContain("4");
  });
});
