import { describe, expect, it } from "vitest";

import {
  getAnalysisIssueMessageClassName,
  getAnalysisIssueRowClassName,
} from "./AnalysisPanel";

describe("AnalysisPanel mobile issue layout", () => {
  it("wraps issue rows on narrow screens", () => {
    const className = getAnalysisIssueRowClassName();

    expect(className).toContain("min-w-0");
    expect(className).toContain("flex-wrap");
    expect(className).toContain("sm:flex-nowrap");
  });

  it("breaks long issue messages inside the panel", () => {
    const className = getAnalysisIssueMessageClassName();

    expect(className).toContain("min-w-0");
    expect(className).toContain("break-words");
  });
});
