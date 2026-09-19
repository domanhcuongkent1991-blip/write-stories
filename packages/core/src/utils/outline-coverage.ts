import type { StoredHook } from "../state/memory-db.js";
import type { VolumeBoundary } from "./hook-promotion.js";
import { normalizeStoredHookStatus } from "./hook-lifecycle.js";

/**
 * Deterministic outline-depth assessment shared by the doctor check, the
 * qualification runner guard, and the baseline validator.
 *
 * Root cause it detects (luna-27 campaign): a book whose volume_map was
 * generated for N chapters but whose targetChapters was later raised to M > N
 * writes chapters N+1..M with no planned arc. Every hook payoff promised in
 * the outline stays permanently overdue, the planner defers forever, and deep
 * chapters fail hook-debt audits by construction. Detecting this is cheap and
 * purely lexical; fixing it belongs to the architect/author, not to this
 * module.
 */

const VOLUME_RANGE_PATTERNS: ReadonlyArray<RegExp> = [
  /Volume\s+(\d+)\s*\(\s*Chapters?\s*(\d+)\s*[-~–—]\s*(\d+)\s*\)/i,
  /Volume\s+(\d+)\s*\(\s*Chapter\s*(\d+)\s*\)/i,
  /第\s*(\d+)\s*卷\s*[（(]\s*第?\s*(\d+)\s*[-~–—至]\s*(\d+)\s*章\s*[)）]/u,
];

export function parseVolumeBoundaries(volumeMapMarkdown: string): VolumeBoundary[] {
  const volumes: VolumeBoundary[] = [];
  for (const rawLine of volumeMapMarkdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    for (const pattern of VOLUME_RANGE_PATTERNS) {
      const match = line.match(pattern);
      if (!match) continue;
      const name = match[1]!;
      const startCh = parseInt(match[2] ?? "", 10);
      const endCh = parseInt(match[3] ?? match[2] ?? "", 10);
      if (!Number.isFinite(startCh) || !Number.isFinite(endCh)) continue;
      if (startCh <= 0 || endCh < startCh) continue;
      volumes.push({ name: `Volume ${name}`, startCh, endCh });
      break;
    }
  }
  return volumes;
}

export interface OutlineCoverageReport {
  /** Highest chapter number the outline plans for; null when unparseable. */
  readonly maxOutlinedChapter: number | null;
  readonly volumeCount: number;
  readonly targetChapters: number | null;
  /** True when the outline plans at least through targetChapters. */
  readonly coversTarget: boolean;
  /** Chapters the book will write beyond the outline; 0 when covered. */
  readonly unplannedChapters: number;
  /** Actionable, human-readable problems. Empty when healthy. */
  readonly issues: ReadonlyArray<string>;
}

/**
 * Assess whether the outline plans deeply enough for the book's target.
 * Unparseable outlines report `coversTarget: false` with an explanatory issue
 * but no `maxOutlinedChapter` — callers decide whether that is fatal (the
 * qualification runner treats it as such; the doctor only warns).
 */
export function assessOutlineCoverage(params: {
  readonly volumeMapMarkdown: string;
  readonly targetChapters?: number | null;
  readonly hooks?: ReadonlyArray<StoredHook>;
}): OutlineCoverageReport {
  const volumes = parseVolumeBoundaries(params.volumeMapMarkdown);
  const target = params.targetChapters ?? null;
  const maxOutlined = volumes.length > 0
    ? Math.max(...volumes.map((volume) => volume.endCh))
    : null;
  const issues: string[] = [];

  if (volumes.length === 0) {
    issues.push("No parseable 'Volume N (Chapters A-B)' ranges found in outline/volume_map.md.");
  } else if (target !== null && maxOutlined !== null && maxOutlined < target) {
    issues.push(
      `Outline plans ${maxOutlined} chapter(s) across ${volumes.length} volume(s) but targetChapters is ${target}. `
      + `Chapters ${maxOutlined + 1}-${target} would be written with no planned arc: hook payoffs promised in the outline stay permanently overdue and deep chapters fail hook-debt audits by construction. `
      + `Regenerate the foundation for the new depth or lower targetChapters to ${maxOutlined}.`,
    );
  }

  // Hook payoff promises that fall outside the planned arc are the concrete
  // symptom that bites first (the luna-27 ch11 H004 case), so report them
  // explicitly even when the volume range itself is fine.
  if (params.hooks && target !== null) {
    for (const hook of params.hooks) {
      const chapter = extractPromisedPayoffChapter(hook.paysOffInArc);
      if (chapter === null || chapter <= target) continue;
      issues.push(
        `Hook ${hook.hookId} promises payoff at chapter ${chapter}, beyond targetChapters ${target}; it can never be paid off in this book.`,
      );
    }
  }

  const unplanned = maxOutlined !== null && target !== null && target > maxOutlined
    ? target - maxOutlined
    : 0;
  return {
    maxOutlinedChapter: maxOutlined,
    volumeCount: volumes.length,
    targetChapters: target,
    // Strictly about volume-range depth versus the target; hook-payoff issues
    // live in `issues` so callers can warn without failing coverage.
    coversTarget: volumes.length > 0 && (target === null || (maxOutlined ?? 0) >= target),
    unplannedChapters: unplanned,
    issues,
  };
}

const VOLUME_CHAPTER_PATTERN = /volume\s*(\d+)\s*chapter\s*(\d+)/i;
const BARE_CHAPTER_PATTERN = /chapter\s*(\d+)/i;
const ZH_VOLUME_CHAPTER_PATTERN = /第\s*(\d+)\s*卷[^第]*?第\s*(\d+)\s*章/u;

/**
 * Resolve a prose payoff promise ("Volume 2 Chapter 5") to an absolute chapter
 * number. The chapter token is taken as absolute — the qualification baseline
 * and the planner ledger both use absolute chapter numbers in this field
 * ("Volume 2 Chapter 5" with Volume 2 = Chapters 4-5). Returns null when no
 * concrete chapter number appears (prose-only promises like "the final
 * volume") — callers treat unparseable promises as out of scope, never as
 * violations.
 */
export function extractPromisedPayoffChapter(paysOffInArc: string | undefined): number | null {
  const text = (paysOffInArc ?? "").trim();
  if (!text) return null;

  const zhMatch = text.match(ZH_VOLUME_CHAPTER_PATTERN);
  const enMatch = text.match(VOLUME_CHAPTER_PATTERN);
  const chapterToken = enMatch?.[2] ?? zhMatch?.[2] ?? text.match(BARE_CHAPTER_PATTERN)?.[1];
  if (chapterToken === undefined) return null;

  const chapter = parseInt(chapterToken, 10);
  if (!Number.isFinite(chapter) || chapter <= 0) return null;
  return chapter;
}

/**
 * Hooks whose concrete payoff promise lands on `chapterNumber` and that are not
 * resolved yet. Silence-based recyclable selection cannot surface these: a due
 * hook touched recently has low silence and never appears as debt, which is how
 * luna-30b ch8 silently lost its volume-climax hooks. `deferred`/`paused` hooks
 * ARE included on purpose — a deferred hook whose promise names this chapter is
 * exactly the case that needs an explicit decision.
 *
 * Shared by the planner due-hook guard, the planner prompt "due this chapter"
 * block, and the doctor overdue-payoff check so all three cannot drift apart.
 */
export function selectDuePayoffHooks(
  hooks: ReadonlyArray<StoredHook>,
  chapterNumber: number,
): StoredHook[] {
  return hooks.filter((hook) => {
    if (normalizeStoredHookStatus(hook.status) === "resolved") return false;
    return extractPromisedPayoffChapter(hook.paysOffInArc) === chapterNumber;
  });
}

/**
 * Same predicate as `selectDuePayoffHooks` but keeps every due hook whose
 * promise chapter is at or before `chapterNumber`, for post-hoc drift checks
 * (doctor) where a promise silently slipped past its deadline.
 */
export function selectOverduePayoffHooks(
  hooks: ReadonlyArray<StoredHook>,
  chapterNumber: number,
): StoredHook[] {
  return hooks.filter((hook) => {
    if (normalizeStoredHookStatus(hook.status) === "resolved") return false;
    const promised = extractPromisedPayoffChapter(hook.paysOffInArc);
    return promised !== null && promised <= chapterNumber;
  });
}


