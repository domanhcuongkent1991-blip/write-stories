import { describe, expect, it } from "vitest";
import { buildBatchContext } from "../translation/context.js";

describe("buildBatchContext", () => {
  const sourceSegments = [
    { index: 1, source: "A".repeat(650) },
    { index: 2, source: "B".repeat(650) },
    { index: 3, source: "C".repeat(10) },
    { index: 4, source: "D".repeat(450) },
    { index: 5, source: "E".repeat(5) },
  ];

  it("builds before/after context from the adjacent source segments for a mid-chapter batch", () => {
    const context = buildBatchContext(
      sourceSegments,
      new Map(),
      [{ index: 3, source: "C".repeat(10) }],
    );
    expect(context.contextBefore).toBe("B".repeat(600));
    expect(context.contextAfter).toBe("D".repeat(400));
    expect(context.previousTargetTail).toBe("");
  });

  it("caps the previous translated tail at 120 characters", () => {
    const context = buildBatchContext(
      sourceSegments,
      new Map([[2, "x".repeat(130)]]),
      [{ index: 3, source: "C".repeat(10) }],
    );
    expect(context.previousTargetTail).toBe("x".repeat(120));
  });

  it("returns empty context before for the first batch of a chapter", () => {
    const context = buildBatchContext(
      sourceSegments,
      new Map(),
      [{ index: 1, source: "A".repeat(650) }],
    );
    expect(context.contextBefore).toBe("");
    expect(context.contextAfter).toBe("B".repeat(400));
    expect(context.previousTargetTail).toBe("");
  });

  it("returns empty context after for the last batch of a chapter", () => {
    const context = buildBatchContext(
      sourceSegments,
      new Map([[4, "y".repeat(20)]]),
      [{ index: 5, source: "E".repeat(5) }],
    );
    expect(context.contextAfter).toBe("");
    expect(context.previousTargetTail).toBe("y".repeat(20));
  });

  it("keeps source context but an empty target tail when the adjacent segment is untranslated", () => {
    const context = buildBatchContext(
      sourceSegments,
      new Map([[1, "translated one"]]),
      [{ index: 3, source: "C".repeat(10) }],
    );
    expect(context.contextBefore).toBe("B".repeat(600));
    expect(context.previousTargetTail).toBe("");
  });

  it("honors custom context length options", () => {
    const context = buildBatchContext(
      sourceSegments,
      new Map(),
      [{ index: 3, source: "C".repeat(10) }],
      { beforeChars: 10, afterChars: 5, tailChars: 4 },
    );
    expect(context.contextBefore).toBe("B".repeat(10));
    expect(context.contextAfter).toBe("D".repeat(5));
  });
});
