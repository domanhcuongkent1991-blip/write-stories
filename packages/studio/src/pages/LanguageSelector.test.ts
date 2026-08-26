import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  createWritingLanguageSelectionController,
  LanguageSelector,
} from "./LanguageSelector";

describe("LanguageSelector", () => {
  it("renders direct Vietnamese first-run chrome while keeping two writing choices", () => {
    const html = renderToStaticMarkup(createElement(LanguageSelector, {
      uiLocale: "vi",
      onUiLocaleChange: vi.fn(),
      onSelectWritingLanguage: vi.fn(),
    }));

    expect(html).toContain('aria-label="Ngôn ngữ giao diện"');
    expect(html).toContain("Sáng tác bằng tiếng Trung");
    expect(html).toContain("Sáng tác bằng tiếng Anh");
    expect(html).toContain("Có thể thay đổi trong phần Cài đặt");
    expect(html.match(/data-writing-language=/g)).toHaveLength(2);
    expect(html).toContain('data-writing-language="zh"');
    expect(html).toContain('data-writing-language="en"');
    expect(html).not.toContain('data-writing-language="vi"');
    expect(html).not.toContain("中文创作");
    expect(html).not.toContain("English Writing");
    expect(html).not.toContain("可在设置中更改");
  });

  it.each(["zh", "en", "vi"] as const)("renders localized chrome for %s", (locale) => {
    const html = renderToStaticMarkup(createElement(LanguageSelector, {
      uiLocale: locale,
      onUiLocaleChange: vi.fn(),
      onSelectWritingLanguage: vi.fn(),
    }));
    expect(html).toContain("data-writing-language=\"zh\"");
    expect(html).toContain("data-writing-language=\"en\"");
    expect(html).not.toContain("data-writing-language=\"vi\"");
  });

  it("serializes fast clicks, cleans up the timer, and resets after rejection", async () => {
    vi.useFakeTimers();
    const selected: Array<string | null> = [];
    const pending: boolean[] = [];
    const callbacks: string[] = [];
    const onSelect = vi.fn(async (language: "zh" | "en") => {
      callbacks.push(language);
      throw new Error("request failed");
    });
    const controller = createWritingLanguageSelectionController(
      onSelect,
      (language) => selected.push(language),
      (value) => pending.push(value),
    );

    controller.select("zh");
    controller.select("en");
    vi.advanceTimersByTime(400);
    await Promise.resolve();
    await Promise.resolve();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(callbacks).toEqual(["zh"]);
    expect(pending).toEqual([true, false]);
    expect(selected).toEqual(["zh", null]);

    controller.select("en");
    controller.cancel();
    vi.advanceTimersByTime(400);
    expect(onSelect).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
