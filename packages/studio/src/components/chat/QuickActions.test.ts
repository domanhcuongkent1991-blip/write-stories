import { describe, expect, it } from "vitest";

import { getQuickActionsClassName } from "./QuickActions";

describe("QuickActions mobile layout", () => {
  it("wraps all actions without a horizontal scrolling row", () => {
    const className = getQuickActionsClassName();

    expect(className).toContain("min-w-0");
    expect(className).toContain("flex-wrap");
    expect(className).toContain("overflow-x-hidden");
    expect(className).not.toContain("overflow-x-auto");
  });
});
