import { describe, expect, it } from "vitest";
import { getArtifactDrawerHeaderLayoutClassName } from "./ProjectArtifactDrawer";

describe("ProjectArtifactDrawer responsive header layout", () => {
  it("wraps action buttons below the title on narrow viewports", () => {
    const className = getArtifactDrawerHeaderLayoutClassName();

    expect(className).toContain("flex-wrap");
    expect(className).toContain("sm:flex-nowrap");
  });
});
