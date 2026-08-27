import { describe, expect, it } from "vitest";

import {
  getFlowCanvasClassName,
  getFlowLegendClassName,
  getFlowStatsClassName,
  getFlowTitleClassName,
  getFlowToolbarClassName,
} from "./FlowView";

describe("FlowView mobile layout", () => {
  it("wraps toolbar controls without forcing horizontal overflow", () => {
    const className = getFlowToolbarClassName();

    expect(className).toContain("min-w-0");
    expect(className).toContain("flex-wrap");
  });

  it("allows a long graph title to wrap inside the toolbar", () => {
    expect(getFlowTitleClassName()).toContain("min-w-0");
    expect(getFlowTitleClassName()).toContain("break-words");
  });

  it("wraps stats and legend independently", () => {
    expect(getFlowStatsClassName()).toContain("flex-wrap");
    expect(getFlowLegendClassName()).toContain("flex-wrap");
    expect(getFlowLegendClassName()).toContain("w-full");
  });

  it("keeps the graph canvas usable on short mobile layouts", () => {
    expect(getFlowCanvasClassName()).toContain("min-h-[20rem]");
  });
});
