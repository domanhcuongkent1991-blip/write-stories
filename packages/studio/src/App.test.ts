import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHeaderLocaleSelection,
  deriveActiveBookId,
  deriveStartupGate,
  isBookCreateChatRoute,
  syncProjectWritingLanguage,
} from "./App";
import { setAppLanguage } from "./lib/app-language";
import { getWritingLanguage, setWritingLanguage } from "./lib/writing-language";

afterEach(() => {
  setAppLanguage("zh");
  setWritingLanguage("zh");
});

describe("createHeaderLocaleSelection", () => {
  it("changes only the UI locale", () => {
    const setLocale = vi.fn();
    const selectLocale = createHeaderLocaleSelection(setLocale);

    selectLocale("vi");

    expect(setLocale).toHaveBeenCalledOnce();
    expect(setLocale).toHaveBeenCalledWith("vi");
  });

  it("does not let a Vietnamese UI selection mutate project writing language", () => {
    setWritingLanguage("en");
    const selectLocale = createHeaderLocaleSelection(setAppLanguage);

    selectLocale("vi");

    expect(getWritingLanguage()).toBe("en");
  });
});

describe("syncProjectWritingLanguage", () => {
  it("syncs zh/en from the project and never stores vi", () => {
    expect(syncProjectWritingLanguage("en")).toBe("en");
    expect(getWritingLanguage()).toBe("en");

    expect(syncProjectWritingLanguage("vi")).toBe("zh");
    expect(getWritingLanguage()).toBe("zh");
  });
});

describe("deriveActiveBookId", () => {
  it("returns the current book across book-centered routes", () => {
    expect(deriveActiveBookId({ page: "book", bookId: "alpha" })).toBe("alpha");
    expect(deriveActiveBookId({ page: "chapter", bookId: "beta", chapterNumber: 3 })).toBe("beta");
    expect(deriveActiveBookId({ page: "truth", bookId: "gamma" })).toBe("gamma");
    expect(deriveActiveBookId({ page: "analytics", bookId: "delta" })).toBe("delta");
    expect(deriveActiveBookId({ page: "book-settings", bookId: "epsilon" })).toBe("epsilon");
  });

  it("returns undefined for non-book routes", () => {
    expect(deriveActiveBookId({ page: "dashboard" })).toBeUndefined();
    expect(deriveActiveBookId({ page: "services" })).toBeUndefined();
    expect(deriveActiveBookId({ page: "style" })).toBeUndefined();
  });
});

describe("isBookCreateChatRoute", () => {
  it("routes new-book creation through chat instead of the standalone form page", () => {
    expect(isBookCreateChatRoute({ page: "book-create" })).toBe(true);
    expect(isBookCreateChatRoute({ page: "book", bookId: "alpha" })).toBe(false);
  });
});

describe("deriveStartupGate", () => {
  it("shows startup errors instead of spinning forever before the project is ready", () => {
    expect(deriveStartupGate({ ready: false, projectError: null })).toBe("loading");
    expect(deriveStartupGate({ ready: false, projectError: "bad inkos.json" })).toBe("error");
    expect(deriveStartupGate({ ready: true, projectError: "later refetch failed" })).toBe("ready");
  });
});
