import { describe, expect, it } from "vitest";

import { getImportTabItemClassName, getImportTabListClassName } from "./ImportManager";

describe("ImportManager mobile layout", () => {
  it("keeps the multi-tab navigation inside the viewport with intentional local scrolling", () => {
    expect(getImportTabListClassName()).toContain("max-w-full");
    expect(getImportTabListClassName()).toContain("overflow-x-auto");
    expect(getImportTabItemClassName()).toContain("shrink-0");
  });
});
