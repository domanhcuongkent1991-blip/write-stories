import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  createWritingLanguageButtonProps,
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
    const expected = {
      zh: ["界面语言", "中文创作", "英文创作", "可在设置中更改"],
      en: ["Interface language", "Chinese Writing", "English Writing", "Can be changed in Settings"],
      vi: ["Ngôn ngữ giao diện", "Sáng tác bằng tiếng Trung", "Sáng tác bằng tiếng Anh", "Có thể thay đổi trong phần Cài đặt"],
    }[locale];
    for (const copy of expected) expect(html).toContain(copy);
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
    await vi.advanceTimersByTimeAsync(400);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(callbacks).toEqual(["zh"]);
    expect(pending).toEqual([true, false]);
    expect(selected).toEqual(["zh", null]);

    controller.deactivate();
    controller.activate();
    const updatedOnSelect = vi.fn();
    controller.updateOnSelect(updatedOnSelect);
    controller.select("en");
    controller.deactivate();
    vi.advanceTimersByTime(400);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(updatedOnSelect).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("wires rendered writing buttons through the production click props", () => {
    const controller = {
      select: vi.fn(),
      updateOnSelect: vi.fn(),
      activate: vi.fn(),
      deactivate: vi.fn(),
    };
    const zhButton = createWritingLanguageButtonProps(controller, "zh");
    const enButton = createWritingLanguageButtonProps(controller, "en");
    zhButton.onClick();
    enButton.onClick();
    expect(controller.select).toHaveBeenNthCalledWith(1, "zh");
    expect(controller.select).toHaveBeenNthCalledWith(2, "en");
  });
});
