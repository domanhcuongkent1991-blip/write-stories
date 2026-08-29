import { describe, expect, it } from "vitest";

import { getBookDetailExportControlsClassName } from "./BookDetail";

describe("BookDetail mobile export controls", () => {
  it("wraps export controls so the full Vietnamese action remains reachable", () => {
    const className = getBookDetailExportControlsClassName();

    expect(className).toContain("min-w-0");
    expect(className).toContain("flex-wrap");
  });
});
