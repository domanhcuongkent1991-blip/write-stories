import type { AuditIssue } from "../agents/continuity.js";
import { HookRecordSchema, type HookOps, type HookRecord } from "../models/runtime-state.js";
import type { StoredHook } from "../state/memory-db.js";
import {
  HookOperationContractError,
  HookOperationIntentV2Schema,
  assertHookContractCurrent,
  hashCanonicalHookPayoff,
  type ExpectedHookOperationAction,
  type HookOperationIntentV2,
} from "../models/hook-operation-intent.js";
import { normalizeHookPayoffTiming } from "./hook-lifecycle.js";

/**
 * Legacy prose heuristic for the memo's "## 本章 hook 账" / "## Hook ledger
 * for this chapter" section. Stable-ID runtime hook operations are the
 * authoritative validator; these keyword checks can only request review.
 *
 * The planner commits, per chapter, to:
 *   - advance: <hook_id> "name" → state-change
 *   - resolve: <hook_id> "name" → action
 *
 * The validator parses those two lists and checks that every committed hook
 * has observable evidence in the draft. "Evidence" means the draft mentions
 * at least one keyword from the ledger line's descriptor (hook name, key
 * noun, etc.). We deliberately do NOT require the draft to repeat the raw
 * hook_id like "H007" — writers don't embed IDs in prose.
 */

export type HookLedgerViolation = AuditIssue;

export interface HookLedgerEntry {
  readonly id: string;
  /** Raw text of the ledger line after the hook_id. */
  readonly descriptor: string;
  /** 2+ char CJK sequences and 3+ letter ASCII words extracted from descriptor. */
  readonly keywords: ReadonlyArray<string>;
}

export interface HookLedger {
  readonly open: ReadonlyArray<HookLedgerEntry>;
  readonly advance: ReadonlyArray<HookLedgerEntry>;
  readonly resolve: ReadonlyArray<HookLedgerEntry>;
  readonly defer: ReadonlyArray<HookLedgerEntry>;
  /**
   * Count of `[new] ...` placeholder lines in the `open:` subsection. These
   * are brand-new hooks declared by the planner that have no pre-existing
   * hook_id (extractLedgerEntry rejects them because they carry no id to
   * match downstream), but they still count as "a new hook opened" for the
   * 揭 1 埋 1 floor check.
   */
  readonly newOpenCount: number;
}

const LEDGER_HEADING_PATTERNS = [
  /^#{2,3}\s*本章\s*hook\s*账\s*$/im,
  /^#{2,3}\s*Hook\s+ledger\s+for\s+this\s+chapter\s*$/im,
];

const SUBSECTION_KEYS: ReadonlyArray<keyof HookLedger> = ["open", "advance", "resolve", "defer"];

/**
 * Tokens that look like hook_ids but are placeholders meaning "no hooks in
 * this slot". Writers sometimes emit "- 无" or "- none" under an empty slot
 * instead of leaving it blank.
 */
const PLACEHOLDER_TOKENS = /^(无|空|none|nil|null|暂无|n\/a|na|n-a|tbd|todo|待定)$/i;

/** Subsection heading words that must not be parsed as hook_ids. */
const SUBSECTION_WORDS = /^(open|advance|resolve|defer|new)$/i;

export function parseHookLedger(memoBody: string): HookLedger {
  const section = extractLedgerSection(memoBody);
  if (!section) {
    return { open: [], advance: [], resolve: [], defer: [], newOpenCount: 0 };
  }

  type Subsection = "open" | "advance" | "resolve" | "defer";
  const result: Record<Subsection, HookLedgerEntry[]> = {
    open: [],
    advance: [],
    resolve: [],
    defer: [],
  };
  let newOpenCount = 0;

  let current: Subsection | null = null;
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const subHeadingMatch = line.match(/^(open|advance|resolve|defer)\s*[:：]?\s*$/i);
    if (subHeadingMatch) {
      current = subHeadingMatch[1]!.toLowerCase() as Subsection;
      continue;
    }

    if (!current) continue;
    if (!line.startsWith("-")) continue;

    // `[new]` placeholder lines have no hook_id but still count as a new hook
    // opened (揭 1 埋 1 floor check). extractLedgerEntry filters them out for
    // advance/resolve evidence matching; we tally them separately here.
    const cleaned = line.replace(/^-+\s*/, "").trim();
    if (current === "open" && /^\[new\]/i.test(cleaned)) {
      newOpenCount += 1;
      continue;
    }

    const entry = extractLedgerEntry(line);
    if (entry) result[current].push(entry);
  }

  return { ...result, newOpenCount };
}

/**
 * Remove only resolve operations that failed semantic payoff preflight.
 * The hook remains active in canonical state because no defer/resolve operation
 * is synthesized. All prose planning and unrelated hook operations are kept.
 */
export function removeHookResolveCommitments(
  memoBody: string,
  hookIds: ReadonlyArray<string>,
): string {
  const targets = new Set(hookIds.map((hookId) => hookId.trim()).filter(Boolean));
  if (targets.size === 0) return memoBody;

  const newline = memoBody.includes("\r\n") ? "\r\n" : "\n";
  const retained: string[] = [];
  let inLedger = false;
  let subsection: keyof HookLedger | null = null;

  for (const line of memoBody.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (LEDGER_HEADING_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      inLedger = true;
      subsection = null;
      retained.push(line);
      continue;
    }
    if (inLedger && /^#{1,6}\s+/u.test(trimmed)) {
      inLedger = false;
      subsection = null;
    }
    if (inLedger) {
      const subsectionMatch = trimmed.match(/^(open|advance|resolve|defer)\s*[:：]?\s*$/iu);
      if (subsectionMatch) {
        subsection = subsectionMatch[1]!.toLowerCase() as keyof HookLedger;
      } else if (subsection === "resolve" && trimmed.startsWith("-")) {
        const entry = extractLedgerEntry(line);
        if (entry && targets.has(entry.id)) continue;
      }
    }
    retained.push(line);
  }

  return retained.join(newline);
}

/**
 * Enforce: every hook declared under advance / resolve must have observable
 * evidence in the draft text. We do NOT validate `open` (new hooks don't have
 * a pre-existing id/descriptor to echo) or `defer` (deferred = deliberately
 * not touched).
 *
 * Additionally enforces the "揭 1 埋 1" hard floor (Xu Er Jia De Mao, 番茄文章
 * 10): whenever a chapter resolves one or more hooks, it must open at least
 * as many new hooks in the same memo. "Resolve without opening" leaves the
 * reader feeling "解完即索然无味" — the story loses forward pull. The softer
 * "揭 1 埋 2" rule is a planner-prompt recommendation, not a hard gate here,
 * because enforcing ×2 would conflict with the "≤ 2 new hooks per chapter"
 * cap on the planner side when resolve=2.
 */
export function validateHookLedger(
  memoBody: string,
  draftContent: string,
): ReadonlyArray<HookLedgerViolation> {
  const ledger = parseHookLedger(memoBody);
  const violations: HookLedgerViolation[] = [];

  // Evidence check for everything the memo committed to land in prose.
  const committed = dedupeById([...ledger.advance, ...ledger.resolve]);
  for (const entry of committed) {
    if (!draftEchoesEntry(draftContent, entry)) {
      violations.push({
        severity: "warning",
        category: "hook 账需语义复核",
        description: `memo 在 advance/resolve 里声明要处理 ${entry.id}，但确定性关键词检查没有找到对应落点`,
        suggestion: `复核正文是否已经用动作、对话、物件或信息变化推进了 ${entry.id}；若没有，请补具体场景，若已推进，可忽略这条确定性提示`,
        source: "deterministic",
        verification: "unverified",
        repairTarget: "prose",
      });
    }
  }

  // "揭 1 埋 1" hard floor: when anything was resolved, at least the same
  // number of new hooks must have been opened. We count both `[new]`
  // placeholder lines (newOpenCount — the normal way planners declare fresh
  // hooks without an id) and any id-bearing lines under `open:` (rare, but
  // legal if a planner re-opens a previously paused hook).
  const resolvedCount = ledger.resolve.length;
  const openedCount = ledger.open.length + ledger.newOpenCount;
  if (resolvedCount > 0 && openedCount < resolvedCount) {
    violations.push({
      severity: "warning",
      category: "hook 账揭 1 埋 1 违规",
      description: `本章 resolve 了 ${resolvedCount} 个钩子，但 open 只有 ${openedCount} 个新钩子。只揭不埋会让读者豁然开朗后索然无味，本书的前进拉力被削弱。`,
      suggestion: `在 memo 的 open 段下至少再埋 ${resolvedCount - openedCount} 个与本章已揭钩子相关的新钩子。新钩子最好与已揭钩子彼此关联，不要凭空冒出来。`,
      source: "deterministic",
      verification: "unverified",
      repairTarget: "next-plan",
    });
  }

  return violations;
}

export interface HookOpsFromLedgerOptions {
  /** The authoritative live hook snapshot; memo IDs are never trusted alone. */
  readonly activeHooks: ReadonlyArray<StoredHook>;
  readonly chapterNumber: number;
}

export class HookLedgerReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookLedgerReferenceError";
  }
}

export function hookOpsFromLedger(
  memoBody: string,
  options?: HookOpsFromLedgerOptions,
): HookOps {
  const ledger = parseHookLedger(memoBody);
  const entries = [...ledger.open, ...ledger.advance, ...ledger.resolve, ...ledger.defer];
  if (entries.length > 0 && !options) {
    throw new HookLedgerReferenceError(
      "an authoritative active hook snapshot is required for stable ledger IDs",
    );
  }
  const knownHooks = new Map((options?.activeHooks ?? []).map((hook) => [hook.hookId, hook]));
  for (const entry of entries) {
    if (!knownHooks.has(entry.id)) {
      throw new HookLedgerReferenceError(`unknown stable hook ID ${entry.id} in chapter memo`);
    }
  }
  return {
    upsert: dedupeById([...ledger.open, ...ledger.advance]).map((entry) => toAdvancingHookRecord(
      knownHooks.get(entry.id)!,
      options!.chapterNumber,
    )),
    mention: [],
    resolve: dedupeById(ledger.resolve).map((entry) => entry.id),
    defer: dedupeById(ledger.defer).map((entry) => entry.id),
  };
}

export function bindExpectedHookOperationsV2(
  memoBody: string,
  options: HookOpsFromLedgerOptions,
): HookOperationIntentV2 {
  const ledger = parseHookLedger(memoBody);
  const knownHooks = new Map(options.activeHooks.map((hook) => [hook.hookId, hook] as const));
  const entries: Array<{ readonly action: ExpectedHookOperationAction; readonly entry: HookLedgerEntry }> = [
    ...ledger.open.map((entry) => ({ action: "advance" as const, entry })),
    ...ledger.advance.map((entry) => ({ action: "advance" as const, entry })),
    ...ledger.resolve.map((entry) => ({ action: "resolve" as const, entry })),
    ...ledger.defer.map((entry) => ({ action: "defer" as const, entry })),
  ];
  const seen = new Map<string, ExpectedHookOperationAction>();

  const operations = entries.map(({ action, entry }) => {
    const previousAction = seen.get(entry.id);
    if (previousAction !== undefined) {
      const kind = previousAction === action ? "duplicate" : "contradictory";
      throw new HookOperationContractError(
        `${kind} hook operation for ${entry.id}: ${previousAction} and ${action}`,
      );
    }
    seen.set(entry.id, action);

    const hook = knownHooks.get(entry.id);
    if (!hook) {
      throw new HookOperationContractError(`unknown stable hook ID ${entry.id}`);
    }
    if (action === "resolve" && entry.descriptor.trim().length === 0) {
      throw new HookOperationContractError(
        `resolve operation ${entry.id} requires planned evidence`,
      );
    }

    return {
      hookId: entry.id,
      action,
      canonicalPayoffHash: hashCanonicalHookPayoff(entry.id, hook.expectedPayoff ?? ""),
      canonicalExpectedPayoff: hook.expectedPayoff ?? "",
      plannedEvidence: entry.descriptor,
    };
  });

  const contract = HookOperationIntentV2Schema.parse({ schemaVersion: 2, operations });
  assertHookContractCurrent(contract, options.activeHooks);
  return contract;
}

export function acceptanceCriteriaFromHookOps(
  hookOps: HookOps,
  language: "zh" | "en",
): string[] {
  const actionLabel = language === "en"
    ? { upsert: "advanced", mention: "mentioned", resolve: "resolved", defer: "explicitly deferred" }
    : { upsert: "通过运行时 upsert 推进", mention: "被正文提及", resolve: "在运行时真相中回收", defer: "在运行时真相中明确延后" };
  return [
    ...hookOps.upsert.map((record) => language === "en"
      ? `Hook ${record.hookId} is ${actionLabel.upsert} through an advancing runtime upsert.`
      : `伏笔 ${record.hookId} 必须通过运行时 upsert 推进。`),
    ...hookOps.mention.map((hookId) => language === "en"
      ? `Hook ${hookId} is ${actionLabel.mention} through observable chapter action.`
      : `伏笔 ${hookId} 必须${actionLabel.mention}。`),
    ...hookOps.resolve.map((hookId) => language === "en"
      ? `Hook ${hookId} is ${actionLabel.resolve} in runtime truth.`
      : `伏笔 ${hookId} 必须${actionLabel.resolve}。`),
    ...hookOps.defer.map((hookId) => language === "en"
      ? `Hook ${hookId} is ${actionLabel.defer} in runtime truth.`
      : `伏笔 ${hookId} 必须${actionLabel.defer}。`),
  ];
}

export function acceptanceCriteriaFromHookContractV2(
  contract: HookOperationIntentV2,
  language: "zh" | "en",
): string[] {
  return contract.operations.map((operation) => {
    const canonical = operation.canonicalExpectedPayoff.trim();
    if (language === "en") {
      if (operation.action === "resolve") {
        return `Hook ${operation.hookId} resolves only when chapter evidence satisfies the canonical payoff: ${canonical}`;
      }
      return `Hook ${operation.hookId} performs the governed ${operation.action} operation without contradicting its canonical payoff${canonical ? `: ${canonical}` : "."}`;
    }
    if (operation.action === "resolve") {
      return `伏笔 ${operation.hookId} 只有在正文证据兑现权威回收目标时才能回收：${canonical}`;
    }
    return `伏笔 ${operation.hookId} 必须执行受治理的 ${operation.action} 操作，且不得违背权威回收目标${canonical ? `：${canonical}` : "。"}`;
  });
}

function toAdvancingHookRecord(hook: StoredHook, chapterNumber: number): HookRecord {
  const candidate = {
    hookId: hook.hookId,
    startChapter: hook.startChapter,
    type: hook.type || "unspecified",
    status: "progressing" as const,
    lastAdvancedChapter: chapterNumber,
    expectedPayoff: hook.expectedPayoff ?? "",
    ...(normalizeHookPayoffTiming(hook.payoffTiming)
      ? { payoffTiming: normalizeHookPayoffTiming(hook.payoffTiming) }
      : {}),
    notes: hook.notes ?? "",
    ...(hook.dependsOn ? { dependsOn: [...hook.dependsOn] } : {}),
    ...(hook.paysOffInArc ? { paysOffInArc: hook.paysOffInArc } : {}),
    ...(hook.coreHook !== undefined ? { coreHook: hook.coreHook } : {}),
    ...(hook.halfLifeChapters !== undefined ? { halfLifeChapters: hook.halfLifeChapters } : {}),
    advancedCount: (hook.advancedCount ?? 0) + 1,
    // Advancing a selected dormant architect seed is the explicit activation
    // event. Keeping promoted=false would make the hook disappear from active
    // governance again on the next chapter.
    promoted: true,
  };
  const parsed = HookRecordSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new HookLedgerReferenceError(`active hook ${hook.hookId} is not a valid runtime record`);
  }
  return parsed.data;
}

function extractLedgerSection(memoBody: string): string | undefined {
  for (const pattern of LEDGER_HEADING_PATTERNS) {
    const match = memoBody.match(pattern);
    if (!match || match.index === undefined) continue;
    const start = match.index + match[0].length;
    const rest = memoBody.slice(start);
    const nextHeading = rest.match(/\n#{2,3}\s/);
    const end = nextHeading ? nextHeading.index ?? rest.length : rest.length;
    return rest.slice(0, end);
  }
  return undefined;
}

function extractLedgerEntry(line: string): HookLedgerEntry | undefined {
  const cleaned = line.replace(/^-+\s*/, "").trim();
  if (cleaned.startsWith("[new]") || cleaned.startsWith("[NEW]")) return undefined;

  // Reject whole-line placeholders first — "- 无", "- n/a", "- none" etc.
  const firstWord = cleaned.split(/\s+/)[0] ?? "";
  if (PLACEHOLDER_TOKENS.test(firstWord)) return undefined;

  // Stable IDs created by the runtime can be descriptive slugs longer than
  // 20 characters. Parse the complete token; truncating it changes identity
  // and makes an authoritative hook look fabricated.
  const idMatch = cleaned.match(/^([A-Za-z\u4e00-\u9fff][A-Za-z0-9_\-\u4e00-\u9fff]*)/);
  if (!idMatch) return undefined;

  const candidate = idMatch[1]!;
  if (SUBSECTION_WORDS.test(candidate)) return undefined;
  if (PLACEHOLDER_TOKENS.test(candidate)) return undefined;

  const descriptor = cleaned.slice(candidate.length).trim();
  return { id: candidate, descriptor, keywords: extractKeywords(descriptor) };
}

/**
 * Extract content-matching tokens from a ledger line's descriptor.
 *
 * Priority 1: quoted hook name — `H007 "胖虎借条" → ...` — this is the most
 * informative token the planner attached, and it's what the writer should
 * echo. We split compound CJK names into leading/trailing 2-grams so
 * partial echoes still count.
 *
 * Priority 2: if no quoted name, fall back to the descriptor text UP TO the
 * first state-transition arrow (→ or ->), same CJK/ASCII splitting. Anything
 * AFTER the arrow describes new state, not the hook itself, and risks
 * character-name false positives.
 */
function extractKeywords(descriptor: string): ReadonlyArray<string> {
  if (!descriptor) return [];

  // Try the quoted-name anchor first — matches "..." or "..." quotes.
  const quotedMatch = descriptor.match(/[""]([^""\n]+)[""]/);
  const source = quotedMatch ? quotedMatch[1]! : descriptor.split(/[→]|->/, 1)[0]!;

  const cjkRuns = source.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const cjkTokens: string[] = [];
  for (const run of cjkRuns) {
    cjkTokens.push(run);
    if (run.length >= 3) {
      for (let index = 0; index <= run.length - 2; index++) {
        cjkTokens.push(run.slice(index, index + 2));
      }
    }
    if (run.length >= 4) {
      cjkTokens.push(run.slice(0, 3));
      cjkTokens.push(run.slice(-3));
    }
  }
  const ascii = (source.match(/[A-Za-z]{3,}/g) ?? []).map((w) => w.toLowerCase());
  return dedupeStrings([...cjkTokens, ...ascii].filter((tok) => !ASCII_STOPWORDS.has(tok)));
}

const ASCII_STOPWORDS = new Set([
  "and", "the", "for", "with", "from", "that", "into", "then",
  "open", "close", "advance", "resolve", "defer", "new",
  "planted", "pressured", "near", "payoff", "ready", "stale",
]);

function draftEchoesEntry(draft: string, entry: HookLedgerEntry): boolean {
  if (entry.keywords.length > 0) {
    const draftLower = draft.toLowerCase();
    return entry.keywords.some((kw) => {
      // ASCII keywords are already lowercased; CJK keywords case doesn't matter.
      return /^[a-z]/.test(kw) ? draftLower.includes(kw) : draft.includes(kw);
    });
  }
  // Bare-id ledger line with no descriptor — fall back to ID match.
  if (/^[A-Za-z0-9_-]+$/.test(entry.id)) {
    return new RegExp(`\\b${escapeRegex(entry.id)}\\b`).test(draft);
  }
  return draft.includes(entry.id);
}

function dedupeById(entries: ReadonlyArray<HookLedgerEntry>): HookLedgerEntry[] {
  const seen = new Set<string>();
  const result: HookLedgerEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
  }
  return result;
}

function dedupeStrings(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const INTERNAL = {
  SUBSECTION_KEYS,
  extractLedgerSection,
  extractLedgerEntry,
  extractKeywords,
};
