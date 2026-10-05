import type { AuditIssue } from "../agents/continuity.js";
import { computeChapterContentHash } from "../audit/chapter-audit-evaluator.js";
import { HookRecordSchema, type HookOps, type HookRecord } from "../models/runtime-state.js";
import type { StoredHook } from "../state/memory-db.js";
import {
  HookOperationContractError,
  HookOperationIntentV2Schema,
  assertHookContractCurrent,
  hashCanonicalHookPayoff,
  type ExpectedHookOperationV2,
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

/**
 * Cross-run reconciliation key for the "memo declared a hook the draft never
 * echoes" advisory. FROZEN: persisted audit runs on disk match findings by
 * ruleId, so localizing the user-facing `category` must never rewrite this.
 * It keeps its historical Chinese text on purpose.
 */
const HOOK_LEDGER_SEMANTIC_REVIEW_RULE_ID = "hook 账需语义复核";

/**
 * Rule id for the escalated resolve-evidence check. A resolve commitment the
 * draft never echoes rips a hook out of the ledger without prose proof — the
 * hook is gone forever and the debt quietly stays open (G1 ch20: four hooks
 * declared resolved, none evidenced, chapter passed at 90). Distinct id so
 * persisted runs can tell the blocker apart from the advisory.
 */
const HOOK_RESOLVE_EVIDENCE_RULE_ID = "hook-resolve-evidence";

export interface HookLedgerEntry {
  readonly id: string;
  /** Raw text of the ledger line after the hook_id. */
  readonly descriptor: string;
  /** 2+ char CJK sequences and 3+ letter ASCII words extracted from descriptor. */
  readonly keywords: ReadonlyArray<string>;
  /** The cleaned ledger line as written, for actionable error feedback. */
  readonly rawLine: string;
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
 * instead of leaving it blank. Vietnamese negations (không/chưa/ko/chẳng) are
 * included because a VI planner writes "- Không có hook nào..." for an empty
 * slot; the ID regex below stops at the first diacritic, so without this the
 * line collapses to the bogus id "Kh"/"Ch". The pattern is anchored ^...$ and
 * matched against a whole whitespace-delimited token, so a real slug such as
 * "khong-co-nhan-chung" (one hyphenated token, no diacritics) never matches.
 */
const PLACEHOLDER_TOKENS = /^(无|空|none|nil|null|暂无|n\/a|na|n-a|tbd|todo|待定|không|chưa|ko|chẳng)$/i;

/** Subsection heading words that must not be parsed as hook_ids. */
const SUBSECTION_WORDS = /^(open|advance|resolve|defer|new)$/i;

export function parseHookLedger(memoBody: string, knownHookIds?: ReadonlySet<string>): HookLedger {
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
    if (!entry) continue;

    // Under open:, a line whose leading token is not a known hook ID is a
    // brand-new hook declaration — models regularly emit the description
    // without the [new] marker, and Vietnamese prose leads ("Khóa ...",
    // "Không ...") parse as bogus truncated IDs like "Kh". open: is the only
    // subsection where unknown IDs are structurally safe to reclassify: new
    // hooks have no ID yet, and a real re-opened hook always matches a known
    // ID. The stable ID is synthesized later by settlement, never taken from
    // this token. Under advance/resolve/defer an unknown ID stays a hard
    // contract error — those sections must reference existing hooks.
    if (current === "open" && knownHookIds !== undefined && !knownHookIds.has(entry.id)) {
      newOpenCount += 1;
      continue;
    }

    result[current].push(entry);
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
  // Advance commitments stay advisory: the keyword echo is a heuristic and a
  // miss usually means the prose used different words for the same beat.
  // RESOLVE commitments are different — a resolve rips the hook out of the
  // ledger permanently, so a resolve with zero echo is a state-breaking lie,
  // not a wording mismatch. When the descriptor yields measurable keywords
  // and none appear in the draft, that is a verified critical blocker with
  // bound content evidence. Descriptors with no measurable keywords (bare id
  // or a fully accented Vietnamese descriptor) stay advisory: absence of a
  // measurable keyword proves nothing.
  const committedAdvances = dedupeById(ledger.advance);
  const committedResolves = dedupeById(ledger.resolve);
  for (const entry of committedAdvances) {
    if (!draftEchoesEntry(draftContent, entry)) {
      violations.push({
        severity: "warning",
        ruleId: HOOK_LEDGER_SEMANTIC_REVIEW_RULE_ID,
        category: "hook cần đối chiếu ngữ nghĩa",
        description: `memo khai báo sẽ xử lý ${entry.id} trong advance/resolve, nhưng kiểm tra từ khóa xác định không tìm thấy điểm nào tương ứng trong bản nháp`,
        suggestion: `đối chiếu xem phần thân bản đã đẩy tiến ${entry.id} bằng hành động, đối thoại, đồ vật hay đổi thông tin chưa; nếu chưa thì hãy bổ sung một cảnh cụ thể, nếu đã đẩy tiến rồi thì có thể bỏ qua gợi ý xác định này`,
        source: "deterministic",
        verification: "unverified",
        repairTarget: "prose",
      });
    }
  }
  for (const entry of committedResolves) {
    if (draftEchoesEntry(draftContent, entry)) continue;
    if (entry.keywords.length === 0) {
      violations.push({
        severity: "warning",
        ruleId: HOOK_LEDGER_SEMANTIC_REVIEW_RULE_ID,
        category: "hook cần đối chiếu ngữ nghĩa",
        description: `memo khai báo sẽ xử lý ${entry.id} trong advance/resolve, nhưng kiểm tra từ khóa xác định không tìm thấy điểm nào tương ứng trong bản nháp`,
        suggestion: `đối chiếu xem phần thân bản đã đẩy tiến ${entry.id} bằng hành động, đối thoại, đồ vật hay đổi thông tin chưa; nếu chưa thì hãy bổ sung một cảnh cụ thể, nếu đã đẩy tiến rồi thì có thể bỏ qua gợi ý xác định này`,
        source: "deterministic",
        verification: "unverified",
        repairTarget: "prose",
      });
      continue;
    }
    violations.push({
      severity: "critical",
      ruleId: HOOK_RESOLVE_EVIDENCE_RULE_ID,
      category: "hook resolve thiếu bằng chứng trong bản nháp",
      description: `memo khai báo resolve ${entry.id}, nhưng bản nháp không chứa bất kỳ từ khóa nhận diện nào của hook (${entry.keywords.join(", ")}); hook bị rút khỏi ledger mà văn không chứng minh đã giải quyết`,
      suggestion: `thêm vào bản nháp một cảnh cụ thể chứng minh ${entry.id} được giải quyết (đồ vật, đối thoại, quyết định hiển hiện trong văn), hoặc hạ xuống advance/defer nếu chương chưa thật sự chốt hook này`,
      source: "deterministic",
      verification: "verified",
      repairTarget: "prose",
      evidence: { contentHash: computeChapterContentHash(draftContent) },
    });
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
  const knownIds = new Set((options?.activeHooks ?? []).map((hook) => hook.hookId));
  const ledger = parseHookLedger(memoBody, knownIds);
  const entries = [...ledger.open, ...ledger.advance, ...ledger.resolve, ...ledger.defer];
  if (entries.length > 0 && !options) {
    throw new HookLedgerReferenceError(
      "an authoritative active hook snapshot is required for stable ledger IDs",
    );
  }
  const knownHooks = new Map((options?.activeHooks ?? []).map((hook) => [hook.hookId, hook]));
  for (const entry of entries) {
    if (!knownHooks.has(entry.id)) {
      throw new HookLedgerReferenceError(
        `unknown stable hook ID ${entry.id} in chapter memo (line "${entry.rawLine}" does not begin with an existing hook ID)`,
      );
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

/**
 * Repair one demonstrated model failure mode in memo ledgers: a hook ID
 * truncated mid-token (the model "fixes" awkward repeated suffixes). An
 * unknown ledger ID that is a unique prefix of exactly one authoritative
 * hook ID is rewritten to the canonical ID; ambiguous or genuinely unknown
 * IDs are left untouched so strict validation still fails closed.
 */
export function canonicalizeMemoHookIds(
  memoBody: string,
  authoritativeHooks: ReadonlyArray<StoredHook>,
): string {
  if (authoritativeHooks.length === 0) return memoBody;
  const ledger = parseHookLedger(memoBody);
  const knownIds = new Set(authoritativeHooks.map((hook) => hook.hookId));
  const entries = [...ledger.open, ...ledger.advance, ...ledger.resolve, ...ledger.defer];
  let updated = memoBody;
  for (const entry of entries) {
    if (knownIds.has(entry.id)) continue;
    const prefixMatches = [...knownIds].filter((id) => id.startsWith(entry.id));
    if (prefixMatches.length !== 1) continue;
    const canonical = prefixMatches[0]!;
    const boundary = new RegExp(`${escapeRegExp(entry.id)}(?![A-Za-z0-9_-])`, "gu");
    if (!boundary.test(updated)) continue;
    boundary.lastIndex = 0;
    updated = updated.replace(boundary, canonical);
  }
  return updated;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Open-hook debt level at which memo-level debt governance kicks in. */
export const HOOK_DEBT_OPEN_FLOOR = 6;
/** Brand-new hooks a high-debt chapter memo may open. */
export const HOOK_DEBT_MAX_NEW_OPENS = 2;

export interface HookDebtGovernanceOptions {
  /** The authoritative live hook snapshot (stable IDs, not memo claims). */
  readonly activeHooks: ReadonlyArray<StoredHook>;
  readonly chapterNumber: number;
  /**
   * Book-wide hook capacity (planner hook budget). When set, brand-new opens
   * beyond `capacity - activeHooks.length` are rejected so an overfull memo
   * re-plans itself instead of failing at the LLM auditor after the chapter
   * has already been written.
   */
  readonly hookCapacity?: number;
}

export interface HookDebtGovernanceAssessment {
  readonly compliant: boolean;
  /** Human-readable violations, phrased as planner correction feedback. */
  readonly violations: ReadonlyArray<string>;
}

/**
 * Deterministic memo-level hook-debt governance. Once open debt reaches
 * HOOK_DEBT_OPEN_FLOOR, the memo must service at least one ready hook
 * (advance/resolve on an immediate/near-term or promoted hook) and may open
 * at most HOOK_DEBT_MAX_NEW_OPENS brand-new hooks. Below that floor the memo
 * stays free-form; the ledger's own 1-bury-1 warning keeps soft pressure.
 */
export function assessMemoHookDebtGovernance(
  memoBody: string,
  options: HookDebtGovernanceOptions,
): HookDebtGovernanceAssessment {
  const debtHooks = options.activeHooks.filter(
    (hook) => hook.status === "open" || hook.status === "progressing",
  );
  if (debtHooks.length < HOOK_DEBT_OPEN_FLOOR) {
    return { compliant: true, violations: [] };
  }

  const ledger = parseHookLedger(memoBody, new Set(options.activeHooks.map((hook) => hook.hookId)));
  const violations: string[] = [];

  const readyIds = new Set(debtHooks
    .filter((hook) => {
      const timing = normalizeHookPayoffTiming(hook.payoffTiming);
      return timing === "immediate" || timing === "near-term" || hook.promoted === true;
    })
    .map((hook) => hook.hookId));
  if (readyIds.size > 0) {
    const servicedReadyHook = [...ledger.open, ...ledger.advance, ...ledger.resolve]
      .some((entry) => readyIds.has(entry.id));
    if (!servicedReadyHook) {
      violations.push(
        `Open hook debt is ${debtHooks.length} (>= ${HOOK_DEBT_OPEN_FLOOR}); the memo must advance or resolve at least one ready hook (immediate/near-term or promoted, e.g. ${[...readyIds].slice(0, 4).join(", ")}). Deferring every ready hook while the debt keeps growing is not allowed.`,
      );
    }
  }

  if (ledger.newOpenCount > HOOK_DEBT_MAX_NEW_OPENS) {
    violations.push(
      `Open hook debt is ${debtHooks.length} (>= ${HOOK_DEBT_OPEN_FLOOR}); the memo opens ${ledger.newOpenCount} brand-new hooks but at most ${HOOK_DEBT_MAX_NEW_OPENS} new opens are allowed this chapter.`,
    );
  }

  if (options.hookCapacity !== undefined && ledger.newOpenCount > 0) {
    const remaining = Math.max(0, options.hookCapacity - debtHooks.length);
    if (ledger.newOpenCount > remaining) {
      violations.push(
        `Hook budget: ${debtHooks.length} active hooks against capacity ${options.hookCapacity} — only ${remaining} new hook(s) allowed, but the memo opens ${ledger.newOpenCount}. Resolve or advance existing debt instead of opening new threads.`,
      );
    }
  }

  return { compliant: violations.length === 0, violations };
}

export function bindExpectedHookOperationsV2(
  memoBody: string,
  options: HookOpsFromLedgerOptions,
): HookOperationIntentV2 {
  const knownHooks = new Map(options.activeHooks.map((hook) => [hook.hookId, hook] as const));
  const ledger = parseHookLedger(memoBody, new Set(knownHooks.keys()));
  const entries: Array<{ readonly action: ExpectedHookOperationAction; readonly entry: HookLedgerEntry }> = [
    ...ledger.open.map((entry) => ({ action: "advance" as const, entry })),
    ...ledger.advance.map((entry) => ({ action: "advance" as const, entry })),
    ...ledger.resolve.map((entry) => ({ action: "resolve" as const, entry })),
    ...ledger.defer.map((entry) => ({ action: "defer" as const, entry })),
  ];
  const seen = new Map<string, ExpectedHookOperationAction>();

  const operations = entries.flatMap(({ action, entry }): ExpectedHookOperationV2[] => {
    const previousAction = seen.get(entry.id);
    if (previousAction !== undefined) {
      if (previousAction === action) {
        // Models repeat identical hook lines; identical duplicates are
        // idempotent, so drop the later line instead of discarding the whole
        // candidate. Contradictory actions still fail closed below.
        return [];
      }
      throw new HookOperationContractError(
        `contradictory hook operation for ${entry.id}: ${previousAction} and ${action}`,
      );
    }
    seen.set(entry.id, action);

    const hook = knownHooks.get(entry.id);
    if (!hook) {
      throw new HookOperationContractError(
        `unknown stable hook ID ${entry.id} (line "${entry.rawLine}" does not begin with an existing hook ID); `
        + `if this line was meant to express an empty slot, write exactly "- none" instead of a prose sentence`,
      );
    }
    if (action === "resolve" && entry.descriptor.trim().length === 0) {
      throw new HookOperationContractError(
        `resolve operation ${entry.id} requires planned evidence`,
      );
    }

    return [{
      hookId: entry.id,
      action,
      canonicalPayoffHash: hashCanonicalHookPayoff(entry.id, hook.expectedPayoff ?? ""),
      canonicalExpectedPayoff: hook.expectedPayoff ?? "",
      plannedEvidence: entry.descriptor,
    }];
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
  return { id: candidate, descriptor, keywords: extractKeywords(descriptor), rawLine: cleaned };
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
