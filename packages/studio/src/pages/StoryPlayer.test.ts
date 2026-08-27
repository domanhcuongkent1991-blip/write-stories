import { describe, expect, it } from "vitest";

import {
  getStoryPlayerChoiceClassName,
  getStoryPlayerHudClassName,
  getStoryPlayerHudRowClassName,
} from "./StoryPlayer";

describe("StoryPlayer mobile layout", () => {
  it("keeps the HUD in document flow on mobile and fixed on wider screens", () => {
    const className = getStoryPlayerHudClassName();

    expect(className).toContain("w-full");
    expect(className).toContain("max-w-full");
    expect(className).toContain("overflow-y-auto");
    expect(className).toContain("lg:fixed");
    expect(className).toContain("lg:max-w-[calc(100vw-3rem)]");
    expect(className).not.toContain("sm:fixed");
    expect(className.split(/\s+/)).not.toContain("fixed");
  });

  it("allows long HUD labels and choices to wrap", () => {
    expect(getStoryPlayerHudRowClassName()).toContain("min-w-0");
    expect(getStoryPlayerChoiceClassName()).toContain("break-words");
  });
});
