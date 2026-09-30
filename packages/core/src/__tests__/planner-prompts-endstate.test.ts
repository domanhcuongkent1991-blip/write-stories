import { describe, expect, it } from "vitest";
import { PLANNER_MEMO_SYSTEM_PROMPT, PLANNER_MEMO_SYSTEM_PROMPT_EN } from "../agents/planner-prompts.js";

describe("planner memo end-state continuity", () => {
  it("requires a previous-chapter end-state continuity constraint in the do-not section (zh)", () => {
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("物证与状态连续性");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("上一章结束时关键物证的位置/状态");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("转移动作");
  });

  it("requires a previous-chapter end-state continuity constraint in the do-not section (en)", () => {
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("evidence and state continuity");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("close of the previous chapter");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("the object being moved");
  });
});
