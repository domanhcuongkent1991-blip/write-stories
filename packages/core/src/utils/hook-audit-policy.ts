import { parseHookLedger } from "./hook-ledger-validator.js";
import { normalizeStoredHookStatus } from "./hook-lifecycle.js";
import type { StoredHook } from "../state/memory-db.js";
import type { AuditIssue } from "../agents/continuity.js";

/**
 * Chapters this many without a real touch let a promoted core hook escalate
 * to critical on the auditor's own authority. Below the floor, a hook the
 * memo already services is host-capped to warning. This mirrors the staleness
 * threshold the reviewer prompt already documents so host and prompt agree.
 */
export const HOOK_STALE_CRITICAL_FLOOR_CHAPTERS = 10;

export interface HostHookSeverityCap {
  readonly hookId: string;
  readonly dormancy: number;
}

/**
 * Deterministic host-side severity cap for the auditor's Hook Check.
 *
 * The qualification campaign graded identical ledger states differently across
 * runs (H004 at dormancy 4: luna-20 recorded info and passed, luna-26 recorded
 * critical and failed ×3). Two prompt rules — "overdue past 10 chapters" and
 * "volume-end without carried-over planning" — fire inconsistently for the same
 * hook. The host resolves that by policy: a promoted core hook that THIS
 * chapter's memo already services (advance/defer/resolve/re-open, i.e. an
 * explicit planning action recorded in the ledger) and that is still inside the
 * staleness window must not be rated critical. Genuinely overdue untouched core
 * hooks and non-promoted noise stay under the auditor's judgment.
 */
export function computeHookSeverityCaps(params: {
  readonly hooks: ReadonlyArray<StoredHook>;
  readonly chapterNumber: number;
  readonly memoBody?: string;
}): ReadonlyArray<HostHookSeverityCap> {
  if (!params.memoBody) return [];
  let serviced: Set<string>;
  try {
    const ledger = parseHookLedger(params.memoBody);
    serviced = new Set<string>([
      ...ledger.open.map((entry) => entry.id),
      ...ledger.advance.map((entry) => entry.id),
      ...ledger.resolve.map((entry) => entry.id),
      ...ledger.defer.map((entry) => entry.id),
    ]);
  } catch {
    return [];
  }
  const caps: HostHookSeverityCap[] = [];
  for (const hook of params.hooks) {
    if (hook.promoted !== true || hook.coreHook !== true) continue;
    if (normalizeStoredHookStatus(hook.status) === "resolved") continue;
    if (!serviced.has(hook.hookId)) continue;
    const lastTouch = Math.max(1, hook.startChapter, hook.lastAdvancedChapter);
    const dormancy = Math.max(0, params.chapterNumber - lastTouch);
    if (dormancy >= HOOK_STALE_CRITICAL_FLOOR_CHAPTERS) continue;
    caps.push({ hookId: hook.hookId, dormancy });
  }
  return caps;
}

function matchesCappedHook(description: string, hookIds: ReadonlyArray<string>): boolean {
  return hookIds.some((hookId) => {
    const escaped = hookId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`, "u").test(description);
  });
}

/**
 * Downgrade auditor Hook Check findings that violate the host cap. Only
 * severity is reduced; description/suggestion are preserved so the planner and
 * reader still see the pressure note. Applied to raw parsed issues before
 * evidence binding and re-audit, so it also keeps the minor-acceptance and
 * repair paths from treating a capped hook as a hard blocker.
 */
export function clampAuditorHookEscalation(
  issues: ReadonlyArray<AuditIssue>,
  caps: ReadonlyArray<HostHookSeverityCap>,
): ReadonlyArray<AuditIssue> {
  if (caps.length === 0) return issues;
  const cappedIds = caps.map((cap) => cap.hookId);
  return issues.map((issue) => {
    if (issue.severity !== "critical") return issue;
    if (!matchesCappedHook(issue.description, cappedIds)) return issue;
    return {
      ...issue,
      severity: "warning",
      description: `${issue.description} [host cap: promoted core hook serviced this chapter within the staleness window]`,
    };
  });
}

export function renderHostHookSeverityPolicy(
  caps: ReadonlyArray<HostHookSeverityCap>,
  language: "en" | "zh",
): string {
  if (caps.length === 0) return "";
  const listed = caps.map((cap) => `${cap.hookId} (dormancy ${cap.dormancy})`).join(", ");
  return language === "en"
    ? `\n\n## Host hook severity policy (deterministic)\nThe following promoted core hooks are already serviced by THIS chapter's plan and are within the ${HOOK_STALE_CRITICAL_FLOOR_CHAPTERS}-chapter staleness window: ${listed}. Do NOT report them as critical and do NOT reduce overall_score for their status — the host downgrades such findings. Every other hook, and any core hook overdue past the window, stays under your judgment.\n`
    : `\n\n## 主站伏笔严重度策略（确定性）\n以下 promoted core hook 已被本章计划处理且处于 ${HOOK_STALE_CRITICAL_FLOOR_CHAPTERS} 章陈旧窗口内：${listed}。不得将它们判为 critical，也不得因它们的状态拉低 overall_score——主站会下调此类发现。其余伏笔，以及超出窗口的 core hook，仍由你判断。\n`;
}
