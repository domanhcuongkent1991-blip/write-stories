import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BASE_STRINGS,
  formatLocalizedString,
  getPlaceholderNames,
  translateString,
  type StringKey,
} from "./catalog";
import { VI_CATALOG } from "./vi-catalog";

afterEach(() => {
  vi.doUnmock("./vi-catalog");
  vi.resetModules();
});

describe("Studio localization catalog", () => {
  it("translates stable keys without changing the base catalog", () => {
    expect(translateString("nav.books", "vi")).toBe("Sách");
    expect(translateString("nav.books", "en")).toBe("Books");
  });

  it("formats named values and preserves missing placeholders", () => {
    expect(formatLocalizedString("reader.chapterLabel", "vi", { n: 3 })).toContain("3");
    expect(formatLocalizedString("reader.chapterLabel", "en")).toContain("{n}");
  });

  it("returns sorted, unique placeholder names", () => {
    expect(getPlaceholderNames("X {path} {count} {path}")).toEqual(["count", "path"]);
  });

  it("falls back to English when a local VI fixture omits a key", async () => {
    vi.resetModules();
    vi.doMock("./vi-catalog", () => ({
      VI_CATALOG: { "nav.books": "Sách" },
    }));

    const fixtureCatalog = await import("./catalog");
    expect(fixtureCatalog.translateString("nav.newBook", "vi")).toBe("New Book");
  });

  it("provides direct Vietnamese copy for every 1.8.0 baseline key", () => {
    const missingKeys = (Object.keys(BASE_STRINGS) as StringKey[])
      .filter((key) => !(key in VI_CATALOG));

    expect(missingKeys).toEqual([]);
  });

  it("preserves every named placeholder in Vietnamese copy", () => {
    const mismatches = (Object.keys(BASE_STRINGS) as StringKey[])
      .filter((key) => {
        const expected = getPlaceholderNames(BASE_STRINGS[key].en);
        const actual = getPlaceholderNames(VI_CATALOG[key] ?? "");
        return JSON.stringify(actual) !== JSON.stringify(expected);
      });

    expect(mismatches).toEqual([]);
  });
});
