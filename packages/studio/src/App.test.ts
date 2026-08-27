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
import { formatLocalizedString, type StringKey } from "./i18n/catalog";
import * as appModule from "./App";
import * as sidebarModule from "./components/Sidebar";

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

describe("mobile navigation", () => {
  it("provides localized labels for opening and closing navigation", () => {
    expect(formatLocalizedString("common.openNavigation" as StringKey, "en")).toBe("Open navigation");
    expect(formatLocalizedString("common.closeNavigation" as StringKey, "vi")).toBe("Đóng điều hướng");
  });

  it("closes for Escape unless a nested dialog owns the event", () => {
    const shouldClose = (appModule as typeof appModule & {
      shouldCloseMobileNavigation?: (input: {
        key: string;
        defaultPrevented?: boolean;
        nestedDialogOpen?: boolean;
      }) => boolean;
    }).shouldCloseMobileNavigation;

    expect(shouldClose).toBeTypeOf("function");
    expect(shouldClose?.({ key: "Escape" })).toBe(true);
    expect(shouldClose?.({ key: "Enter" })).toBe(false);
    expect(shouldClose?.({ key: "Escape", defaultPrevented: true })).toBe(false);
    expect(shouldClose?.({ key: "Escape", nestedDialogOpen: true })).toBe(false);
  });

  it("hides the sidebar from accessibility only when closed on mobile", () => {
    const shouldHide = (sidebarModule as typeof sidebarModule & {
      shouldHideClosedMobileSidebar?: (input: {
        isDesktop: boolean;
        mobileOpen: boolean;
      }) => boolean;
    }).shouldHideClosedMobileSidebar;

    expect(shouldHide).toBeTypeOf("function");
    expect(shouldHide?.({ isDesktop: false, mobileOpen: false })).toBe(true);
    expect(shouldHide?.({ isDesktop: false, mobileOpen: true })).toBe(false);
    expect(shouldHide?.({ isDesktop: true, mobileOpen: false })).toBe(false);
  });
});
