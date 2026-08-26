import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LanguageSelector } from "./LanguageSelector";

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
});
