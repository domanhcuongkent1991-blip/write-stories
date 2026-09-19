import { describe, expect, it } from "vitest";
import {
  assessOutlineCoverage,
  extractPromisedPayoffChapter,
  parseVolumeBoundaries,
  selectDuePayoffHooks,
  selectOverduePayoffHooks,
} from "../utils/outline-coverage.js";
import type { StoredHook } from "../state/memory-db.js";

const FIVE_CHAPTER_VOLUME_MAP = [
  "## 01_Volume_Themes_and_Emotional_Curves",
  'Volume 1 (Chapters 1-3): "The 14cm Discrepancy" — theme text.',
  'Volume 2 (Chapters 4-5): "The Drainage Breach" — theme text.',
  "",
  "## 05_Rhythm_Principles",
  "1. Climax Spacing: every 2 chapters.",
].join("\n");

const FIFTEEN_CHAPTER_VOLUME_MAP = [
  'Volume 1 (Chapters 1-3): "Setup".',
  'Volume 2 (Chapters 4-6): "Escalation".',
  'Volume 3 (Chapters 7-10): "Reversal".',
  'Volume 4 (Chapters 11-15): "Climax and aftermath".',
].join("\n");

function createHook(overrides: Partial<StoredHook> = {}): StoredHook {
  return {
    hookId: overrides.hookId ?? "H004",
    startChapter: overrides.startChapter ?? 0,
    type: overrides.type ?? "world_state",
    status: overrides.status ?? "deferred",
    lastAdvancedChapter: overrides.lastAdvancedChapter ?? 0,
    expectedPayoff: overrides.expectedPayoff ?? "payoff",
    notes: overrides.notes ?? "",
    ...(overrides.paysOffInArc === undefined ? {} : { paysOffInArc: overrides.paysOffInArc }),
  };
}

describe("parseVolumeBoundaries", () => {
  it("parses English volume ranges from the qualification baseline shape", () => {
    expect(parseVolumeBoundaries(FIVE_CHAPTER_VOLUME_MAP)).toEqual([
      { name: "Volume 1", startCh: 1, endCh: 3 },
      { name: "Volume 2", startCh: 4, endCh: 5 },
    ]);
  });

  it("parses markdown-bolded ranges and single-chapter volumes", () => {
    const volumes = parseVolumeBoundaries(
      [
        "**Volume 1 (Chapters 1-3)**: setup",
        "Volume 2 (Chapter 4): short volume",
        "### Volume 3 (Chapters 5–9) — en-dash separator",
      ].join("\n"),
    );
    expect(volumes).toEqual([
      { name: "Volume 1", startCh: 1, endCh: 3 },
      { name: "Volume 2", startCh: 4, endCh: 4 },
      { name: "Volume 3", startCh: 5, endCh: 9 },
    ]);
  });

  it("returns nothing for prose without volume ranges", () => {
    expect(parseVolumeBoundaries("The story unfolds over many chapters.")).toEqual([]);
  });
});

describe("extractPromisedPayoffChapter", () => {
  it("reads the absolute chapter token from volume-qualified promises", () => {
    expect(extractPromisedPayoffChapter("Volume 2 Chapter 5")).toBe(5);
    expect(extractPromisedPayoffChapter("volume 3 chapter 12")).toBe(12);
  });

  it("reads bare chapter promises", () => {
    expect(extractPromisedPayoffChapter("Chapter 8")).toBe(8);
  });

  it("returns null for prose-only promises and empty input", () => {
    expect(extractPromisedPayoffChapter("the final chapter of Volume 2")).toBeNull();
    expect(extractPromisedPayoffChapter("")).toBeNull();
    expect(extractPromisedPayoffChapter(undefined)).toBeNull();
  });
});

describe("assessOutlineCoverage", () => {
  it("flags the luna-27 mismatch: outline plans 5 chapters, target is 15", () => {
    const report = assessOutlineCoverage({
      volumeMapMarkdown: FIVE_CHAPTER_VOLUME_MAP,
      targetChapters: 15,
    });
    expect(report.coversTarget).toBe(false);
    expect(report.maxOutlinedChapter).toBe(5);
    expect(report.unplannedChapters).toBe(10);
    expect(report.issues[0]).toContain("Chapters 6-15 would be written with no planned arc");
  });

  it("accepts an outline that covers the target", () => {
    const report = assessOutlineCoverage({
      volumeMapMarkdown: FIFTEEN_CHAPTER_VOLUME_MAP,
      targetChapters: 15,
    });
    expect(report.coversTarget).toBe(true);
    expect(report.maxOutlinedChapter).toBe(15);
    expect(report.unplannedChapters).toBe(0);
    expect(report.issues).toEqual([]);
  });

  it("reports hook payoff promises beyond the target as issues", () => {
    const report = assessOutlineCoverage({
      volumeMapMarkdown: FIFTEEN_CHAPTER_VOLUME_MAP,
      targetChapters: 15,
      hooks: [createHook({ paysOffInArc: "Volume 4 Chapter 18" })],
    });
    expect(report.coversTarget).toBe(true);
    expect(report.issues.some((issue) => issue.includes("H004") && issue.includes("chapter 18"))).toBe(true);
  });

  it("does not flag hooks promised inside the target", () => {
    const report = assessOutlineCoverage({
      volumeMapMarkdown: FIFTEEN_CHAPTER_VOLUME_MAP,
      targetChapters: 15,
      hooks: [createHook({ paysOffInArc: "Volume 2 Chapter 5" })],
    });
    expect(report.issues).toEqual([]);
  });

  it("treats an unparseable outline as not covering, without a target to compare", () => {
    const report = assessOutlineCoverage({ volumeMapMarkdown: "no volumes here" });
    expect(report.coversTarget).toBe(false);
    expect(report.maxOutlinedChapter).toBeNull();
    expect(report.issues[0]).toContain("No parseable");
  });
});

describe("selectDuePayoffHooks", () => {
  it("selects hooks whose payoff promise names this chapter, including deferred ones", () => {
    // luna-30b ch8: H002/H005 were due at Chapter 8 and omitted from the memo
    // ledger entirely. Deferred hooks must be included — a deferred hook whose
    // promise names this chapter is exactly the case needing a decision.
    const hooks = [
      createHook({ hookId: "H002", status: "deferred", paysOffInArc: "Chapter 8" }),
      createHook({ hookId: "H005", status: "progressing", paysOffInArc: "Volume 2 Chapter 8" }),
      createHook({ hookId: "H007", status: "open", paysOffInArc: "Chapter 12" }),
    ];
    expect(selectDuePayoffHooks(hooks, 8).map((h) => h.hookId)).toEqual(["H002", "H005"]);
  });

  it("excludes resolved hooks and hooks without a parseable promise", () => {
    const hooks = [
      createHook({ hookId: "H001", status: "resolved", paysOffInArc: "Chapter 8" }),
      createHook({ hookId: "H003", status: "open", paysOffInArc: "the end of Volume 2" }),
      createHook({ hookId: "H004", status: "open" }),
    ];
    expect(selectDuePayoffHooks(hooks, 8)).toEqual([]);
  });

  it("treats decorated statuses like 'progressing (blocked=[...])' as non-terminal", () => {
    // Real ledgers render diagnostics into the status cell; only resolved is
    // terminal for due-hook purposes.
    const hooks = [
      createHook({ hookId: "H005", status: "progressing (blocked=[H002],distance=8)", paysOffInArc: "Chapter 8" }),
    ];
    expect(selectDuePayoffHooks(hooks, 8).map((h) => h.hookId)).toEqual(["H005"]);
  });
});

describe("selectOverduePayoffHooks", () => {
  it("includes promises at or before the current chapter and excludes later ones", () => {
    const hooks = [
      createHook({ hookId: "H003", status: "open", paysOffInArc: "Chapter 6" }),
      createHook({ hookId: "H005", status: "deferred", paysOffInArc: "Chapter 8" }),
      createHook({ hookId: "H007", status: "open", paysOffInArc: "Chapter 12" }),
      createHook({ hookId: "H001", status: "resolved", paysOffInArc: "Chapter 4" }),
    ];
    expect(selectOverduePayoffHooks(hooks, 8).map((h) => h.hookId)).toEqual(["H003", "H005"]);
  });
});
