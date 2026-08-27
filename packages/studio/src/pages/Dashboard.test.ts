import { describe, expect, it } from "vitest";

import {
  getDashboardBookActionRowClassName,
  getDashboardBookCardLayoutClassName,
  getDashboardHeaderLayoutClassName,
} from "./Dashboard";

describe("Dashboard layout helpers", () => {
  it("stacks the library header on narrow screens", () => {
    const className = getDashboardHeaderLayoutClassName();

    expect(className).toContain("flex-col");
    expect(className).toContain("sm:flex-row");
  });

  it("stacks book cards on narrow screens", () => {
    const className = getDashboardBookCardLayoutClassName();

    expect(className).toContain("flex-col");
    expect(className).toContain("sm:flex-row");
  });

  it("wraps book actions without forcing horizontal overflow", () => {
    const className = getDashboardBookActionRowClassName();

    expect(className).toContain("w-full");
    expect(className).toContain("flex-wrap");
    expect(className).toContain("sm:w-auto");
  });
});
