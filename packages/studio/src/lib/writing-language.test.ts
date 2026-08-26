import { afterEach, describe, expect, it } from "vitest";
import {
  getWritingLanguage,
  resolveProjectWritingLanguage,
  selectWritingText,
  setWritingLanguage,
} from "./writing-language";

afterEach(() => {
  setWritingLanguage("zh");
});

describe("writing language boundary", () => {
  it("accepts only project writing languages and never exposes Vietnamese", () => {
    expect(resolveProjectWritingLanguage("zh")).toBe("zh");
    expect(resolveProjectWritingLanguage("en")).toBe("en");
    expect(resolveProjectWritingLanguage("vi")).toBe("zh");
    expect(resolveProjectWritingLanguage(undefined)).toBe("zh");
  });

  it("selects writing content independently from UI locale state", () => {
    setWritingLanguage("en");

    expect(getWritingLanguage()).toBe("en");
    expect(selectWritingText("中文", "English")).toBe("English");
    expect(selectWritingText("中文", "English", "zh")).toBe("中文");
  });
});
