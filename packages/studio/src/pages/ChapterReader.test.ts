import { describe, expect, it } from "vitest";

import {
  getChapterReaderActionRowClassName,
  getChapterReaderFooterMetaClassName,
  getChapterReaderManuscriptClassName,
} from "./ChapterReader";

describe("ChapterReader layout helpers", () => {
  it("keeps the action row wrapped on narrow screens", () => {
    const className = getChapterReaderActionRowClassName();

    expect(className).toContain("w-full");
    expect(className).toContain("flex-wrap");
  });

  it("reduces manuscript padding on mobile", () => {
    const className = getChapterReaderManuscriptClassName();

    expect(className).toContain("p-4");
    expect(className).toContain("sm:p-8");
  });

  it("wraps footer metadata", () => {
    const className = getChapterReaderFooterMetaClassName();

    expect(className).toContain("flex-wrap");
    expect(className).toContain("justify-center");
  });
});
