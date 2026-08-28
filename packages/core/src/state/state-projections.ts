import type {
  ChapterSummariesState,
  CurrentStateState,
  HooksState,
} from "../models/runtime-state.js";
import type { WritingLanguage } from "../models/writing-language.js";
import {
  localizeHookPayoffTiming,
  resolveHookPayoffTiming,
} from "../utils/hook-lifecycle.js";
import {
  computeHookDiagnostics,
  renderHookDiagnosticMarker,
} from "../utils/hook-stale-detection.js";
import { selectWritingText } from "../utils/writing-surface.js";

export function renderHooksProjection(
  state: HooksState,
  language: WritingLanguage = "zh",
  options?: { readonly currentChapter?: number },
): string {
  const title = selectWritingText(language, {
    zh: "# 伏笔池",
    en: "# Pending Hooks",
    vi: "# Tình tiết cài cắm đang chờ",
  });
  // Phase 7 + hotfixes 1 & 2: depends_on / pays_off_in_arc / core_hook / half_life / promoted
  // are visible columns, so writer and reviewer both see the causal chain, planned payoff arc,
  // stale threshold, and promotion flag. stale / blocked diagnostic flags are appended to the
  // status cell.
  const headers = selectWritingText(language, {
    en: [
      "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | payoff_timing | depends_on | pays_off_in_arc | core_hook | half_life | promoted | notes |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ],
    zh: [
      "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 回收节奏 | 上游依赖 | 回收卷 | 核心 | 半衰期 | 升级 | 备注 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ],
    vi: [
      "| mã_tình_tiết | chương_bắt_đầu | loại | trạng_thái | chương_cập_nhật_gần_nhất | kết_quả_dự_kiến | nhịp_giải_quyết | phụ_thuộc | hồi_giải_quyết | cốt_lõi | chu_kỳ | đã_nâng_cấp | ghi_chú |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ],
  });

  const currentChapter = options?.currentChapter;
  const diagnostics = typeof currentChapter === "number"
    ? computeHookDiagnostics({ hooks: state.hooks, currentChapter })
    : null;

  const rows = [...state.hooks]
    .sort((left, right) => (
      left.startChapter - right.startChapter
      || left.lastAdvancedChapter - right.lastAdvancedChapter
      || left.hookId.localeCompare(right.hookId)
    ))
    .map((hook) => {
      const diag = diagnostics?.get(hook.hookId);
      const marker = diag
        ? language === "vi"
          ? renderNeutralHookDiagnosticMarker(diag)
          : renderHookDiagnosticMarker(diag, language)
        : "";
      const statusCell = marker
        ? `${hook.status} (${marker})`
        : hook.status;
      return `| ${
        [
          hook.hookId,
          hook.startChapter,
          hook.type,
          statusCell,
          hook.lastAdvancedChapter,
          hook.expectedPayoff,
          language === "vi"
            ? resolveHookPayoffTiming(hook)
            : localizeHookPayoffTiming(resolveHookPayoffTiming(hook), language),
          renderDependsOnCell(hook.dependsOn ?? [], language),
          hook.paysOffInArc ?? "",
          renderCoreHookCell(hook.coreHook === true, language),
          renderHalfLifeCell(hook.halfLifeChapters),
          renderPromotedCell(hook.promoted, language),
          hook.notes,
        ].map(escapeTableCell).join(" | ")
      } |`;
    });

  return [title, "", ...headers, ...rows, ""].join("\n");
}

function renderDependsOnCell(ids: ReadonlyArray<string>, language: WritingLanguage): string {
  if (ids.length === 0) {
    return selectWritingText(language, { zh: "无", en: "none", vi: "không có" });
  }
  return `[${ids.join(", ")}]`;
}

function renderCoreHookCell(isCore: boolean, language: WritingLanguage): string {
  return selectWritingText(language, {
    zh: isCore ? "是" : "否",
    en: isCore ? "true" : "false",
    vi: isCore ? "có" : "không",
  });
}

function renderHalfLifeCell(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  return String(Math.trunc(value));
}

function renderPromotedCell(value: boolean | undefined, language: WritingLanguage): string {
  if (value === undefined) return "";
  return selectWritingText(language, {
    zh: value ? "是" : "否",
    en: value ? "true" : "false",
    vi: value ? "có" : "không",
  });
}

function renderNeutralHookDiagnosticMarker(diagnostics: {
  readonly stale: boolean;
  readonly blocked: boolean;
  readonly distance: number;
  readonly halfLife: number;
  readonly missingUpstream: ReadonlyArray<string>;
  readonly blockedDistance: number;
}): string {
  const tokens: string[] = [];
  if (diagnostics.stale) {
    tokens.push(`stale(d=${diagnostics.distance},half=${diagnostics.halfLife})`);
  }
  if (diagnostics.blocked) {
    const distance = diagnostics.blockedDistance > 0
      ? `,distance=${diagnostics.blockedDistance}`
      : "";
    tokens.push(`blocked=[${diagnostics.missingUpstream.join(", ")}]${distance}`);
  }
  return tokens.join("; ");
}

export function renderChapterSummariesProjection(
  state: ChapterSummariesState,
  language: WritingLanguage = "zh",
): string {
  const { title, headers } = selectWritingText(language, {
    en: {
      title: "# Chapter Summaries",
      headers: [
      "| Chapter | Title | Characters | Key Events | State Changes | Hook Activity | Mood | Chapter Type |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ],
    },
    zh: {
      title: "# 章节摘要",
      headers: [
      "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ],
    },
    vi: {
      title: "# Tóm tắt chương",
      headers: [
        "| Chương | Tiêu đề | Nhân vật | Sự kiện chính | Thay đổi trạng thái | Diễn biến tình tiết cài cắm | Sắc thái | Loại chương |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ],
    },
  });

  const rows = [...state.rows]
    .sort((left, right) => left.chapter - right.chapter)
    .map((summary) => `| ${
      [
        summary.chapter,
        summary.title,
        summary.characters,
        summary.events,
        summary.stateChanges,
        summary.hookActivity,
        summary.mood,
        summary.chapterType,
      ].map(escapeTableCell).join(" | ")
    } |`);

  return [title, "", ...headers, ...rows, ""].join("\n");
}

export function renderCurrentStateProjection(
  state: CurrentStateState,
  language: WritingLanguage = "zh",
): string {
  const layout = selectWritingText(language, {
    en: {
      title: "# Current State",
      tableHeader: "| Field | Value |",
      labels: {
        chapter: "Current Chapter",
        location: "Current Location",
        protagonistState: "Protagonist State",
        goal: "Current Goal",
        constraint: "Current Constraint",
        alliances: "Current Alliances",
        conflict: "Current Conflict",
      },
      placeholders: "(not set)",
      additionalTitle: "## Additional State",
    },
    zh: {
      title: "# 当前状态",
      tableHeader: "| 字段 | 值 |",
      labels: {
        chapter: "当前章节",
        location: "当前位置",
        protagonistState: "主角状态",
        goal: "当前目标",
        constraint: "当前限制",
        alliances: "当前敌我",
        conflict: "当前冲突",
      },
      placeholders: "（未设定）",
      additionalTitle: "## 其他状态",
    },
    vi: {
      title: "# Trạng thái hiện tại",
      tableHeader: "| Trường | Giá trị |",
      labels: {
        chapter: "Chương hiện tại",
        location: "Vị trí hiện tại",
        protagonistState: "Trạng thái nhân vật chính",
        goal: "Mục tiêu hiện tại",
        constraint: "Ràng buộc hiện tại",
        alliances: "Quan hệ hiện tại",
        conflict: "Xung đột hiện tại",
      },
      placeholders: "(chưa thiết lập)",
      additionalTitle: "## Trạng thái bổ sung",
    },
  });

  const legacySlots = [
    {
      label: layout.labels.location,
      aliases: ["Current Location", "当前位置"],
    },
    {
      label: layout.labels.protagonistState,
      aliases: ["Protagonist State", "主角状态"],
    },
    {
      label: layout.labels.goal,
      aliases: ["Current Goal", "当前目标"],
    },
    {
      label: layout.labels.constraint,
      aliases: ["Current Constraint", "当前限制"],
    },
    {
      label: layout.labels.alliances,
      aliases: ["Current Alliances", "Current Relationships", "当前敌我"],
    },
    {
      label: layout.labels.conflict,
      aliases: ["Current Conflict", "当前冲突"],
    },
  ] as const;
  const slots = language === "vi"
    ? [
      { ...legacySlots[0], aliases: [...legacySlots[0].aliases, "Vị trí hiện tại"] },
      { ...legacySlots[1], aliases: [...legacySlots[1].aliases, "Trạng thái nhân vật chính"] },
      { ...legacySlots[2], aliases: [...legacySlots[2].aliases, "Mục tiêu hiện tại"] },
      { ...legacySlots[3], aliases: [...legacySlots[3].aliases, "Ràng buộc hiện tại"] },
      { ...legacySlots[4], aliases: [...legacySlots[4].aliases, "Quan hệ hiện tại"] },
      { ...legacySlots[5], aliases: [...legacySlots[5].aliases, "Xung đột hiện tại"] },
    ]
    : legacySlots;

  const knownPredicates = new Set(
    slots.flatMap((slot) => slot.aliases.map(normalizePredicate)),
  );
  const lines = [
    layout.title,
    "",
    layout.tableHeader,
    "| --- | --- |",
    `| ${layout.labels.chapter} | ${escapeTableCell(state.chapter)} |`,
    ...slots.map((slot) => {
      const value = findFactValue(state, slot.aliases) ?? layout.placeholders;
      return `| ${slot.label} | ${escapeTableCell(value)} |`;
    }),
  ];

  const additionalFacts = [...state.facts]
    .filter((fact) => !knownPredicates.has(normalizePredicate(fact.predicate)))
    .sort((left, right) => compareAdditionalFacts(left.predicate, right.predicate));

  if (additionalFacts.length === 0) {
    return [...lines, ""].join("\n");
  }

  return [
    ...lines,
    "",
    layout.additionalTitle,
    ...additionalFacts.map((fact) => renderAdditionalFact(fact.predicate, fact.object)),
    "",
  ].join("\n");
}

function findFactValue(
  state: CurrentStateState,
  aliases: ReadonlyArray<string>,
): string | undefined {
  const aliasSet = new Set(aliases.map(normalizePredicate));
  return state.facts.find((fact) => aliasSet.has(normalizePredicate(fact.predicate)))?.object;
}

function renderAdditionalFact(predicate: string, object: string): string {
  if (/^note_\d+$/i.test(predicate)) {
    return `- ${object}`;
  }
  return `- ${predicate}: ${object}`;
}

function compareAdditionalFacts(left: string, right: string): number {
  const leftNote = left.match(/^note_(\d+)$/i);
  const rightNote = right.match(/^note_(\d+)$/i);
  if (leftNote && rightNote) {
    return Number.parseInt(leftNote[1] ?? "0", 10) - Number.parseInt(rightNote[1] ?? "0", 10);
  }
  if (leftNote) return -1;
  if (rightNote) return 1;
  return left.localeCompare(right);
}

function normalizePredicate(value: string): string {
  return value.trim().toLowerCase();
}

function escapeTableCell(value: string | number): string {
  return String(value).replace(/\|/g, "\\|").trim();
}
