import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BookWritingLanguageSelector } from "./BookWritingLanguageSelector";

const labels = { zh: "中文", en: "English", vi: "Tiếng Việt" } as const;

describe("BookWritingLanguageSelector", () => {
  it("hides Vietnamese when the capability does not advertise it", () => {
    const html = renderToStaticMarkup(React.createElement(BookWritingLanguageSelector, {
      value: "zh", available: ["zh", "en"], disabled: false, onChange: vi.fn(), labels,
    }));
    expect(html).toContain('value="zh"');
    expect(html).toContain('value="en"');
    expect(html).not.toContain('value="vi"');
  });

  it("renders Vietnamese from the advertised writing-language capability", () => {
    const html = renderToStaticMarkup(React.createElement(BookWritingLanguageSelector, {
      value: "vi", available: ["zh", "en", "vi"], disabled: false, onChange: vi.fn(), labels,
    }));
    expect(html).toContain('value="vi"');
    expect(html).toContain("Tiếng Việt");
    expect(html).toContain("中文");
    expect(html).toContain("English");
  });
});
