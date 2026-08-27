import { describe, expect, it } from "vitest";
import {
  buildProjectExportDownloadUrl,
  getStoryGraphNodeActionRowClassName,
  getStoryGraphNodeClassName,
  getStoryGraphTitleClassName,
  getStoryGraphTopActionRowClassName,
  getStoryGraphTopNavClassName,
} from "./StoryGraphTree";

describe("buildProjectExportDownloadUrl", () => {
  it("points to the interactive-film package export endpoint", () => {
    expect(buildProjectExportDownloadUrl("demo")).toBe("/api/v1/projects/demo/export");
  });
});

describe("StoryGraphTree mobile layout", () => {
  it("wraps top navigation and its action group", () => {
    expect(getStoryGraphTopNavClassName()).toContain("flex-wrap");
    expect(getStoryGraphTopActionRowClassName()).toContain("w-full");
    expect(getStoryGraphTopActionRowClassName()).toContain("flex-wrap");
    expect(getStoryGraphTopActionRowClassName()).toContain("sm:w-auto");
  });

  it("allows long graph and node content to break within the viewport", () => {
    expect(getStoryGraphTitleClassName()).toContain("min-w-0");
    expect(getStoryGraphTitleClassName()).toContain("break-words");
    expect(getStoryGraphNodeClassName()).toContain("break-words");
  });

  it("wraps node actions on narrow screens", () => {
    expect(getStoryGraphNodeActionRowClassName()).toContain("flex-wrap");
  });
});
