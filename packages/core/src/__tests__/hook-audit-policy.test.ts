import { describe, expect, it } from "vitest";
import type { StoredHook } from "../state/memory-db.js";
import type { AuditIssue } from "../agents/continuity.js";
import {
  HOOK_STALE_CRITICAL_FLOOR_CHAPTERS,
  clampAuditorHookEscalation,
  computeHookSeverityCaps,
  renderHostHookSeverityPolicy,
} from "../utils/hook-audit-policy.js";

function createHook(overrides: Partial<StoredHook> = {}): StoredHook {
  return {
    hookId: overrides.hookId ?? "H004",
    startChapter: overrides.startChapter ?? 0,
    type: overrides.type ?? "world_state",
    status: overrides.status ?? "deferred",
    lastAdvancedChapter: overrides.lastAdvancedChapter ?? 0,
    expectedPayoff: overrides.expectedPayoff ?? "Ecoapi source code patch",
    notes: overrides.notes ?? "",
    ...(overrides.coreHook === undefined ? {} : { coreHook: overrides.coreHook }),
    ...(overrides.promoted === undefined ? {} : { promoted: overrides.promoted }),
    ...(overrides.paysOffInArc === undefined ? {} : { paysOffInArc: overrides.paysOffInArc }),
  };
}

const MEMO_SERVICING_H004 = [
  "## 本章 hook 账",
  "defer:",
  "- H004 carried over to Volume 3 — blocked by H001",
  "advance:",
  "- H005 tiếp tục truy dấu chuỗi khóa",
].join("\n");

function createIssue(overrides: Partial<AuditIssue> = {}): AuditIssue {
  return {
    severity: overrides.severity ?? "critical",
    category: overrides.category ?? "Hook Check",
    description: overrides.description ?? "Hook H004 có promoted=true và core_hook=true nhưng vẫn chưa được xử lý.",
    suggestion: overrides.suggestion ?? "Resolve or defer with a carried-over plan.",
  };
}

describe("computeHookSeverityCaps", () => {
  it("caps a promoted core hook the memo defers inside the staleness window", () => {
    const caps = computeHookSeverityCaps({
      hooks: [createHook({ coreHook: true, promoted: true, lastAdvancedChapter: 0 })],
      chapterNumber: 5,
      memoBody: MEMO_SERVICING_H004,
    });
    expect(caps).toEqual([{ hookId: "H004", dormancy: 4 }]);
  });

  it("caps a hook the memo advances as well as defers", () => {
    const caps = computeHookSeverityCaps({
      hooks: [
        createHook({ hookId: "H005", coreHook: true, promoted: true, lastAdvancedChapter: 2 }),
      ],
      chapterNumber: 5,
      memoBody: MEMO_SERVICING_H004,
    });
    expect(caps).toEqual([{ hookId: "H005", dormancy: 3 }]);
  });

  it("does not cap once dormancy reaches the staleness floor", () => {
    const caps = computeHookSeverityCaps({
      hooks: [createHook({ coreHook: true, promoted: true, lastAdvancedChapter: 0 })],
      chapterNumber: HOOK_STALE_CRITICAL_FLOOR_CHAPTERS + 1,
      memoBody: MEMO_SERVICING_H004,
    });
    expect(caps).toEqual([]);
  });

  it("does not cap hooks the memo never touches", () => {
    const caps = computeHookSeverityCaps({
      hooks: [createHook({ hookId: "H099", coreHook: true, promoted: true })],
      chapterNumber: 5,
      memoBody: MEMO_SERVICING_H004,
    });
    expect(caps).toEqual([]);
  });

  it("does not cap non-promoted or non-core hooks — they stay under auditor judgment", () => {
    const caps = computeHookSeverityCaps({
      hooks: [
        createHook({ coreHook: true, promoted: false }),
        createHook({ hookId: "H006", coreHook: false, promoted: true }),
      ],
      chapterNumber: 5,
      memoBody: MEMO_SERVICING_H004,
    });
    expect(caps).toEqual([]);
  });

  it("does not cap resolved hooks", () => {
    const caps = computeHookSeverityCaps({
      hooks: [createHook({ coreHook: true, promoted: true, status: "resolved" })],
      chapterNumber: 5,
      memoBody: MEMO_SERVICING_H004,
    });
    expect(caps).toEqual([]);
  });

  it("returns no caps without a memo body", () => {
    const caps = computeHookSeverityCaps({
      hooks: [createHook({ coreHook: true, promoted: true })],
      chapterNumber: 5,
    });
    expect(caps).toEqual([]);
  });
});

describe("clampAuditorHookEscalation", () => {
  it("downgrades a critical finding naming a capped hook and keeps the note", () => {
    const capped = clampAuditorHookEscalation(
      [createIssue()],
      [{ hookId: "H004", dormancy: 4 }],
    );
    expect(capped[0]).toMatchObject({ severity: "warning" });
    expect(capped[0]!.description).toContain("H004");
    expect(capped[0]!.description).toContain("host cap");
  });

  it("leaves critical findings about other hooks untouched", () => {
    const capped = clampAuditorHookEscalation(
      [createIssue({ description: "Hook H099 is unresolved at volume end." })],
      [{ hookId: "H004", dormancy: 4 }],
    );
    expect(capped[0]!.severity).toBe("critical");
  });

  it("leaves non-critical severities untouched", () => {
    const capped = clampAuditorHookEscalation(
      [createIssue({ severity: "warning" })],
      [{ hookId: "H004", dormancy: 4 }],
    );
    expect(capped[0]!.severity).toBe("warning");
    expect(capped[0]!.description).not.toContain("host cap");
  });

  it("does not treat a longer hook ID sharing a prefix as capped", () => {
    const capped = clampAuditorHookEscalation(
      [createIssue({ description: "Hook H0041 drifted far past its window." })],
      [{ hookId: "H004", dormancy: 4 }],
    );
    expect(capped[0]!.severity).toBe("critical");
  });

  it("is a no-op without caps", () => {
    const issues = [createIssue()];
    expect(clampAuditorHookEscalation(issues, [])).toBe(issues);
  });
});

describe("renderHostHookSeverityPolicy", () => {
  it("renders nothing when no hook is capped", () => {
    expect(renderHostHookSeverityPolicy([], "en")).toBe("");
  });

  it("names capped hooks and forbids critical escalation in English prompts", () => {
    const block = renderHostHookSeverityPolicy([{ hookId: "H004", dormancy: 4 }], "en");
    expect(block).toContain("H004");
    expect(block).toContain("Do NOT report them as critical");
    expect(block).toContain("overall_score");
  });

  it("names capped hooks and forbids critical escalation in Chinese prompts", () => {
    const block = renderHostHookSeverityPolicy([{ hookId: "H004", dormancy: 4 }], "zh");
    expect(block).toContain("H004");
    expect(block).toContain("不得将它们判为 critical");
    expect(block).toContain("overall_score");
  });
});
