import { memo, useMemo, useState, useEffect } from "react";
import type { ChatActionPayload, ChatRequestedIntent, ChatSessionKind, ToolExecution, PipelineStage } from "../../store/chat/types";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../ui/collapsible";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronDown,
  Wrench,
  Check,
} from "lucide-react";
import { buildApiUrl } from "../../hooks/use-api";
import { translateAppString } from "../../lib/app-language";
import type { StringKey } from "../../i18n/catalog";
import type { AuditDecision, OperationTelemetry, RevisionOutcome } from "../../shared/contracts";
import { chatSelectors, useChatStore } from "../../store/chat";
import { usePreferencesStore } from "../../store/preferences";
import {
  NarrativeForecastPreview,
  getNarrativeForecastPreviewDetails,
} from "./NarrativeForecastPreview";

const t = translateAppString;

// The API emits these labels in the project's writing language. They are
// display-only chrome, so map the known stable labels back to catalog keys at
// the UI boundary. Unknown labels remain untouched because they may be raw
// tool/provider content rather than chrome.
const RUNTIME_LABEL_KEYS: Readonly<Record<string, StringKey>> = {
  "建书": "runtime.agent.architect",
  "Book setup": "runtime.agent.architect",
  "写作": "runtime.agent.writer",
  "Writing": "runtime.agent.writer",
  "Write": "runtime.agent.writer",
  "审计": "runtime.agent.auditor",
  "Audit": "runtime.agent.auditor",
  "修订": "runtime.agent.reviser",
  "Revision": "runtime.agent.reviser",
  "Revise": "runtime.agent.reviser",
  "导出": "runtime.agent.exporter",
  "Export": "runtime.agent.exporter",
  "读取文件": "runtime.tool.read",
  "Read file": "runtime.tool.read",
  "编辑文件": "runtime.tool.edit",
  "Edit file": "runtime.tool.edit",
  "搜索": "runtime.tool.grep",
  "Search": "runtime.tool.grep",
  "列目录": "runtime.tool.ls",
  "List directory": "runtime.tool.ls",
  "整理上下文": "runtime.tool.contextCompression",
  "Organize context": "runtime.tool.contextCompression",
  "确认动作": "runtime.tool.proposeAction",
  "Confirm action": "runtime.tool.proposeAction",
  "短篇生产": "runtime.tool.shortFiction",
  "Short fiction": "runtime.tool.shortFiction",
  "生成封面": "runtime.tool.generateCover",
  "Cover generation": "runtime.tool.generateCover",
  "剧本创作": "runtime.tool.createScript",
  "Script creation": "runtime.tool.createScript",
  "分镜创作": "runtime.tool.createStoryboard",
  "Storyboard creation": "runtime.tool.createStoryboard",
  "互动影游": "runtime.tool.createInteractiveFilm",
  "Interactive film": "runtime.tool.createInteractiveFilm",
  "编辑互动世界": "runtime.tool.editWorld",
  "Edit interactive world": "runtime.tool.editWorld",
  "启动互动世界": "runtime.tool.startWorld",
  "Start interactive world": "runtime.tool.startWorld",
  "重做互动回合": "runtime.tool.reviseTurn",
  "Redo interactive turn": "runtime.tool.reviseTurn",
  "推进互动世界": "runtime.tool.advanceWorld",
  "Advance interactive world": "runtime.tool.advanceWorld",
  "剧情多线推演": "runtime.tool.createForecast",
  "Narrative forecast": "runtime.tool.createForecast",
  "核验剧情推演": "runtime.tool.recheckForecast",
  "Recheck forecast": "runtime.tool.recheckForecast",
  "采用候选分支": "runtime.tool.selectBranch",
  "Select candidate branch": "runtime.tool.selectBranch",
  "翻译项目": "translation.projects",
  "Translation": "translation.projects",
  "同人创作": "import.fanfic",
  "Fanfiction": "import.fanfic",
  "导入续写": "nav.createContinuation",
  "Continuation import": "nav.createContinuation",
  "番外创作": "import.spinoff",
  "Side story": "import.spinoff",
  "仿写创作": "import.imitation",
  "Style imitation": "import.imitation",
  "生成基础设定": "progress.generateFoundation",
  "Generate foundation": "progress.generateFoundation",
  "保存书籍配置": "progress.saveBookConfig",
  "Save book config": "progress.saveBookConfig",
  "写入基础设定文件": "progress.writeFoundationFiles",
  "Write foundation files": "progress.writeFoundationFiles",
  "初始化控制文档": "progress.initializeControlDocs",
  "Initialize control documents": "progress.initializeControlDocs",
  "创建初始快照": "progress.createInitialSnapshot",
  "Create initial snapshot": "progress.createInitialSnapshot",
  "准备章节输入": "progress.prepareChapterInput",
  "Prepare chapter input": "progress.prepareChapterInput",
  "撰写章节草稿": "progress.draftChapter",
  "Write chapter draft": "progress.draftChapter",
  "落盘最终章节": "progress.saveFinalChapter",
  "Save final chapter": "progress.saveFinalChapter",
  "生成最终真相文件": "progress.generateFinalTruthFiles",
  "Generate final truth files": "progress.generateFinalTruthFiles",
  "校验真相文件变更": "progress.validateTruthChanges",
  "Validate truth file changes": "progress.validateTruthChanges",
  "同步记忆索引": "progress.syncMemoryIndex",
  "Sync memory index": "progress.syncMemoryIndex",
  "更新章节索引与快照": "progress.updateChapterIndexSnapshot",
  "Update chapter index and snapshot": "progress.updateChapterIndexSnapshot",
  "更新索引与快照": "progress.updateChapterIndexSnapshot",
  "Update index and snapshot": "progress.updateChapterIndexSnapshot",
  "加载修订上下文": "interactive.context.title",
  "Load revision context": "interactive.context.title",
  "修订章节": "interactive.audit.chapterRevision",
  "Revise chapter": "interactive.audit.chapterRevision",
  "落盘修订结果": "interactive.audit.fixed",
  "Save revision result": "interactive.audit.fixed",
  "审计章节": "book.audit",
  "Audit chapter": "book.audit",
};

function localizeRuntimeLabel(label: string): string {
  const key = RUNTIME_LABEL_KEYS[label];
  return key ? t(key) : label;
}

// -- Status rendering helpers --

function ExecStatusBadge({ status }: { status: ToolExecution["status"] }) {
  switch (status) {
    case "running":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-primary">
          <Loader2 size={12} className="animate-spin" />
          <span>{t("interactive.tool.running")}</span>
        </span>
      );
    case "processing":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" style={{ animationDuration: "2s" }} />
          <span>{t("interactive.tool.processingResult")}</span>
        </span>
      );
    case "completed":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
          <CheckCircle2 size={12} />
          <span>{t("interactive.tool.completed")}</span>
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-destructive">
          <XCircle size={12} />
          <span>{t("interactive.tool.failed")}</span>
        </span>
      );
  }
}

function StageIcon({ status }: { status: PipelineStage["status"] }) {
  switch (status) {
    case "pending":
      return <span className="w-4 h-4 rounded-full border border-border/60 flex items-center justify-center shrink-0 text-[8px] text-muted-foreground/40">○</span>;
    case "active":
      return <Loader2 size={14} className="text-primary animate-spin shrink-0" />;
    case "completed":
      return <CheckCircle2 size={14} className="text-green-600 dark:text-green-400 shrink-0" />;
  }
}

function formatProgress(progress: NonNullable<PipelineStage["progress"]>): string {
  const secs = Math.round(progress.elapsedMs / 1000);
  const statusLabel = progress.status === "thinking" ? t("interactive.tool.thinking") : progress.status ?? "";
  const chars = progress.totalChars > 0
    ? progress.chineseChars > 0 ? `${progress.totalChars}字` : `${progress.totalChars} chars`
    : "";
  const parts = [statusLabel, `${secs}s`, chars].filter(Boolean);
  return parts.join(" · ");
}

function formatDuration(startedAt: number, completedAt?: number): string {
  const ms = (completedAt ?? Date.now()) - startedAt;
  const secs = Math.round(ms / 1000);
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function encodeProjectPath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function extractResultPath(result: string | undefined, label: string): string | null {
  if (!result) return null;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = result.match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"));
  const path = match?.[1]?.trim();
  return path || null;
}

export interface GeneratedArtifactDetails {
  readonly kind: "short_fiction_created" | "cover_generated" | "script_created" | "storyboard_created" | "interactive_film_created";
  readonly title?: string;
  readonly storyId?: string;
  readonly projectId?: string;
  readonly finalMarkdownPath?: string;
  readonly salesPackagePath?: string;
  readonly coverPromptPath?: string;
  readonly coverImagePath?: string;
  readonly coverError?: string;
  readonly specPath?: string;
  readonly scriptPath?: string;
  readonly storyboardPath?: string;
  readonly storyGraphPath?: string;
  readonly storyTreePath?: string;
  readonly flagsPath?: string;
  readonly imagePromptsPath?: string;
  readonly assetsManifestPath?: string;
  readonly skillIds?: ReadonlyArray<string>;
}

export interface PlayToolDetails {
  readonly kind: "play_world_started" | "play_turn_advanced" | "play_turn_revised" | "play_variant_restored";
  readonly title?: string;
  readonly worldId?: string;
  readonly runId?: string;
  readonly turn?: number;
  readonly sceneImageUrl?: string;
  readonly sceneText?: string;
  readonly suggestedActions?: readonly string[];
  readonly variantId?: string;
  readonly skillIds?: ReadonlyArray<string>;
}

export interface PlayEditDetails {
  readonly kind: "play_world_updated";
  readonly worldId?: string;
  readonly runId?: string;
  readonly updatedWorldContract?: boolean;
  readonly updatedVisualContract?: boolean;
  readonly updatedPremise?: boolean;
  readonly updatedEntities?: number;
}

export interface ProposedActionDetails {
  readonly kind: "proposed_action";
  readonly execId: string;
  readonly action: ChatRequestedIntent;
  readonly targetSessionKind: ChatSessionKind;
  readonly sameSession?: boolean;
  readonly title?: string;
  readonly summary?: string;
  readonly instruction?: string;
  readonly requestedSkills?: ReadonlyArray<string>;
  readonly actionPayload?: ChatActionPayload;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nestedNumberField(record: Record<string, unknown>, objectKey: string, key: string): number | undefined {
  const value = record[objectKey];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return numberField(value as Record<string, unknown>, key);
}

function actionPayloadField(record: Record<string, unknown>): ChatActionPayload | undefined {
  const value = record.actionPayload;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as ChatActionPayload;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const out = Array.from(new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  ));
  return out.length > 0 ? out : undefined;
}

function rawStringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getExecutionSkillIds(exec: ToolExecution): ReadonlyArray<string> {
  if (!exec.details || typeof exec.details !== "object" || Array.isArray(exec.details)) return [];
  return rawStringArrayField(exec.details as Record<string, unknown>, "skillIds");
}

function SkillUsagePreview({ exec }: { exec: ToolExecution }) {
  const skills = getExecutionSkillIds(exec);
  if (skills.length === 0) return null;
  return (
    <div className="mx-3 mb-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <span className="font-semibold text-foreground/80">{t("interactive.context.skills")}</span>
      {skills.map((skill) => (
        <span key={skill} className="rounded-full border border-border/50 bg-background/60 px-2 py-0.5 font-mono text-[11px]">
          {skill}
        </span>
      ))}
    </div>
  );
}

interface ChapterContextTraceDetails {
  readonly chapterNumber?: number;
  readonly tracePath: string;
  readonly selectedSources: ReadonlyArray<string>;
  readonly protectedSources: ReadonlyArray<string>;
  readonly compressibleSources: ReadonlyArray<string>;
  readonly protectedTokens?: number;
  readonly compressibleTokens?: number;
  readonly totalSelectedTokens?: number;
  readonly retrievalEngine?: string;
  readonly retrievalCandidateCount: number;
  readonly semanticSelectedCount: number;
  readonly compressedSources: ReadonlyArray<string>;
}

function parseChapterContextTrace(value: unknown, chapterNumber?: number): ChapterContextTraceDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const tracePath = stringField(record, "tracePath");
  if (!tracePath) return null;
  const tokenBudget = record.tokenBudget && typeof record.tokenBudget === "object" && !Array.isArray(record.tokenBudget)
    ? record.tokenBudget as Record<string, unknown>
    : {};
  const retrieval = record.retrieval && typeof record.retrieval === "object" && !Array.isArray(record.retrieval)
    ? record.retrieval as Record<string, unknown>
    : {};
  const compression = record.compression && typeof record.compression === "object" && !Array.isArray(record.compression)
    ? record.compression as Record<string, unknown>
    : {};
  return {
    chapterNumber,
    tracePath,
    selectedSources: rawStringArrayField(record, "selectedSources"),
    protectedSources: rawStringArrayField(record, "protectedSources"),
    compressibleSources: rawStringArrayField(record, "compressibleSources"),
    protectedTokens: numberField(tokenBudget, "protectedTokens"),
    compressibleTokens: numberField(tokenBudget, "compressibleTokens"),
    totalSelectedTokens: numberField(tokenBudget, "totalSelectedTokens"),
    retrievalEngine: stringField(retrieval, "engine"),
    retrievalCandidateCount: Array.isArray(retrieval.candidates) ? retrieval.candidates.length : 0,
    semanticSelectedCount: rawStringArrayField(retrieval, "semanticSelectedIds").length,
    compressedSources: rawStringArrayField(compression, "compressedSources"),
  };
}

export function getChapterContextTraceDetails(exec: ToolExecution): ReadonlyArray<ChapterContextTraceDetails> {
  if (exec.tool !== "sub_agent" || !exec.details || typeof exec.details !== "object" || Array.isArray(exec.details)) return [];
  const details = exec.details as Record<string, unknown>;
  if (details.kind === "chapter_written") {
    const trace = parseChapterContextTrace(details.contextTrace, numberField(details, "chapterNumber"));
    return trace ? [trace] : [];
  }
  if (details.kind !== "chapters_written" || !Array.isArray(details.chapters)) return [];
  return details.chapters.flatMap((chapter) => {
    if (!chapter || typeof chapter !== "object" || Array.isArray(chapter)) return [];
    const record = chapter as Record<string, unknown>;
    const trace = parseChapterContextTrace(record.contextTrace, numberField(record, "chapterNumber"));
    return trace ? [trace] : [];
  });
}

function ChapterContextTracePreview({ exec }: { exec: ToolExecution }) {
  const traces = getChapterContextTraceDetails(exec);
  if (traces.length === 0) return null;
  return (
    <div className="mx-3 mb-3 mt-1 rounded-xl border border-border/50 bg-background/55 px-3 py-2.5 text-xs">
      <div className="font-semibold text-foreground">{t("interactive.context.title")}</div>
      <div className="mt-2 space-y-2">
        {traces.map((trace) => (
          <details key={`${trace.chapterNumber ?? 0}:${trace.tracePath}`} className="rounded-lg border border-border/40 px-2.5 py-2">
            <summary className="cursor-pointer select-none font-medium text-foreground">
              {trace.chapterNumber
                ? t("interactive.context.chapterNumber", { number: trace.chapterNumber })
                : t("interactive.context.chapter")}
              {trace.retrievalEngine ? ` · ${trace.retrievalEngine}` : ""}
            </summary>
            <div className="mt-2 space-y-1.5 text-muted-foreground">
              <div>
                {t("interactive.context.budget")}: {trace.totalSelectedTokens ?? 0}
                {` · ${t("interactive.context.protected")} ${trace.protectedTokens ?? 0}`}
                {` · ${t("interactive.context.compressible")} ${trace.compressibleTokens ?? 0}`}
              </div>
              <div>
                {t("interactive.context.retrieval")}: {trace.retrievalCandidateCount} {t("interactive.context.bm25Candidates")}
                {trace.semanticSelectedCount > 0 ? ` · ${trace.semanticSelectedCount} ${t("interactive.context.semanticSelections")}` : ""}
              </div>
              {trace.compressedSources.length > 0 && (
                <div>{t("interactive.context.semanticCompaction")}: {trace.compressedSources.join(" · ")}</div>
              )}
              <div>{t("interactive.context.allSources")}:</div>
              <ul className="space-y-0.5 font-mono text-[11px]">
                {trace.selectedSources.map((source) => <li key={source}>{source}</li>)}
              </ul>
              <div className="font-mono text-[11px]">{trace.tracePath}</div>
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

interface ChapterRevisionIssueDetails {
  readonly severity: string;
  readonly category: string;
  readonly description: string;
  readonly suggestion?: string;
}

interface ChapterRevisionDetails extends Pick<OperationTelemetry, "decision" | "verifiedBlockerCount" | "revisionAttempted" | "revisionOutcome" | "rejectionReason" | "provider" | "model"> {
  readonly chapterNumber?: number;
  readonly applied: boolean;
  readonly status?: string;
  readonly auditPassed?: boolean;
  readonly fixedIssues: ReadonlyArray<string>;
  readonly auditIssues: ReadonlyArray<ChapterRevisionIssueDetails>;
  readonly skippedReason?: string;
}

const AUDIT_DECISION_LABEL_KEYS: Readonly<Record<AuditDecision, StringKey>> = {
  pass: "auditTelemetry.decision.pass",
  "repair-required": "auditTelemetry.decision.repairRequired",
  fail: "auditTelemetry.decision.fail",
  inconclusive: "auditTelemetry.decision.inconclusive",
};

const REVISION_OUTCOME_LABEL_KEYS: Readonly<Record<RevisionOutcome, StringKey>> = {
  "not-needed": "auditTelemetry.revision.notNeeded",
  accepted: "auditTelemetry.revision.accepted",
  rejected: "auditTelemetry.revision.rejected",
  inconclusive: "auditTelemetry.revision.inconclusive",
};

interface ChapterStateResyncDetails {
  readonly chapterNumber?: number;
  readonly status?: string;
  readonly auditPassed?: boolean;
  readonly auditIssues: ReadonlyArray<ChapterRevisionIssueDetails>;
  readonly summary?: string;
}

function parseChapterAuditIssues(value: unknown): ReadonlyArray<ChapterRevisionIssueDetails> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((issue) => {
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) return [];
    const record = issue as Record<string, unknown>;
    const description = stringField(record, "description");
    if (!description) return [];
    return [{
      severity: stringField(record, "severity") ?? "warning",
      category: stringField(record, "category") ?? "review",
      description,
      suggestion: stringField(record, "suggestion"),
    }];
  });
}

function auditDecisionField(record: Record<string, unknown>): AuditDecision | undefined {
  const value = stringField(record, "decision");
  return value === "pass" || value === "repair-required" || value === "fail" || value === "inconclusive" ? value : undefined;
}

function revisionOutcomeField(record: Record<string, unknown>): RevisionOutcome | undefined {
  const value = stringField(record, "revisionOutcome");
  return value === "not-needed" || value === "accepted" || value === "rejected" || value === "inconclusive" ? value : undefined;
}

export function getChapterRevisionDetails(exec: ToolExecution): ChapterRevisionDetails | null {
  if (exec.tool !== "sub_agent" || !exec.details || typeof exec.details !== "object" || Array.isArray(exec.details)) return null;
  const details = exec.details as Record<string, unknown>;
  if (details.kind !== "chapter_revision") return null;
  return {
    chapterNumber: numberField(details, "chapterNumber"),
    applied: details.applied === true,
    status: stringField(details, "status"),
    auditPassed: typeof details.auditPassed === "boolean" ? details.auditPassed : undefined,
    fixedIssues: rawStringArrayField(details, "fixedIssues"),
    auditIssues: parseChapterAuditIssues(details.auditIssues),
    skippedReason: stringField(details, "skippedReason"),
    decision: auditDecisionField(details),
    verifiedBlockerCount: numberField(details, "verifiedBlockerCount"),
    revisionAttempted: booleanField(details, "revisionAttempted"),
    revisionOutcome: revisionOutcomeField(details),
    rejectionReason: stringField(details, "rejectionReason"),
    provider: stringField(details, "provider"),
    model: stringField(details, "model"),
  };
}

export function getChapterStateResyncDetails(exec: ToolExecution): ChapterStateResyncDetails | null {
  if (exec.tool !== "resync_chapter_state" || !exec.details || typeof exec.details !== "object" || Array.isArray(exec.details)) return null;
  const details = exec.details as Record<string, unknown>;
  if (details.kind !== "chapter_state_resynced") return null;
  return {
    chapterNumber: numberField(details, "chapterNumber"),
    status: stringField(details, "status"),
    auditPassed: typeof details.auditPassed === "boolean" ? details.auditPassed : undefined,
    auditIssues: parseChapterAuditIssues(details.auditIssues),
    summary: stringField(details, "summary"),
  };
}

function ChapterAuditIssues({
  issues,
  title,
}: {
  readonly issues: ReadonlyArray<ChapterRevisionIssueDetails>;
  readonly title: string;
}) {
  if (issues.length === 0) return null;
  return (
    <div className="mt-2 space-y-1.5">
      <div className="text-[13px] font-medium text-foreground">{title}</div>
      {issues.map((issue, index) => (
        <div key={`${issue.category}:${index}`} className="rounded-lg border border-border/40 bg-background/55 px-2.5 py-2 text-[12px] leading-5 text-muted-foreground">
          <div className="font-medium text-foreground">[{issue.severity}] {issue.category}</div>
          <div>{issue.description}</div>
          {issue.suggestion && <div className="mt-0.5">{t("interactive.audit.suggestion")}{t("interactive.tool.separator")}{issue.suggestion}</div>}
        </div>
      ))}
    </div>
  );
}

function ChapterRevisionPreview({ exec }: { exec: ToolExecution }) {
  const details = getChapterRevisionDetails(exec);
  if (!details) return null;
  const passed = details.applied && details.auditPassed === true;
  return (
    <div
      data-testid="chapter-revision-preview"
      className={`mx-3 mb-3 mt-1 rounded-xl border px-3 py-2.5 ${passed ? "border-emerald-500/25 bg-emerald-500/5" : "border-amber-500/25 bg-amber-500/5"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[15px] font-semibold text-foreground">
          {details.chapterNumber
            ? t("interactive.audit.chapterRevisionNumber", { number: details.chapterNumber })
            : t("interactive.audit.chapterRevision")}
        </div>
        <div className={`rounded-full px-2 py-0.5 text-[12px] font-semibold ${passed ? "bg-emerald-500/15 text-emerald-600" : "bg-amber-500/15 text-amber-600"}`}>
          {!details.applied
            ? t("interactive.audit.originalKept")
            : details.auditPassed
              ? t("interactive.audit.passed")
              : t("interactive.audit.reviewRequired")}
        </div>
      </div>
      {details.skippedReason && (
        <div className="mt-2 text-[13px] leading-5 text-muted-foreground">{details.skippedReason}</div>
      )}
      {(details.decision || details.verifiedBlockerCount !== undefined || details.revisionAttempted !== undefined || details.revisionOutcome || details.rejectionReason || details.provider || details.model) && (
        <div className="mt-2 grid min-w-0 gap-1 text-[12px] leading-5 text-muted-foreground sm:grid-cols-2">
          {details.decision && <div className="break-words">{t("auditTelemetry.decision")}{t("interactive.tool.separator")}{t(AUDIT_DECISION_LABEL_KEYS[details.decision])}</div>}
          {details.verifiedBlockerCount !== undefined && <div>{t("auditTelemetry.verifiedBlockers")}{t("interactive.tool.separator")}{details.verifiedBlockerCount}</div>}
          {details.revisionAttempted !== undefined && <div>{t("auditTelemetry.revisionAttempted")}{t("interactive.tool.separator")}{details.revisionAttempted ? t("auditTelemetry.yes") : t("auditTelemetry.no")}</div>}
          {details.revisionOutcome && <div>{t("auditTelemetry.revisionOutcome")}{t("interactive.tool.separator")}{t(REVISION_OUTCOME_LABEL_KEYS[details.revisionOutcome])}</div>}
          {details.rejectionReason && <div className="break-words">{t("auditTelemetry.reason")}{t("interactive.tool.separator")}{details.rejectionReason}</div>}
          {(details.provider || details.model) && <div className="break-words">{t("auditTelemetry.provider")}{t("interactive.tool.separator")}{[details.provider, details.model].filter(Boolean).join(" / ")}</div>}
        </div>
      )}
      {details.fixedIssues.length > 0 && (
        <div className="mt-2 text-[13px] leading-5 text-muted-foreground">
          <span className="font-medium text-foreground">{t("interactive.audit.fixed")}{t("interactive.tool.separator")}</span>
          {details.fixedIssues.join("；")}
        </div>
      )}
      <ChapterAuditIssues issues={details.auditIssues} title={t("interactive.audit.remainingIssues")} />
    </div>
  );
}

function ChapterStateResyncPreview({ exec }: { exec: ToolExecution }) {
  const details = getChapterStateResyncDetails(exec);
  if (!details) return null;
  const passed = details.auditPassed === true;
  return (
    <div
      data-testid="chapter-state-resync-preview"
      className={`mx-3 mb-3 mt-1 rounded-xl border px-3 py-2.5 ${passed ? "border-emerald-500/25 bg-emerald-500/5" : "border-amber-500/25 bg-amber-500/5"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[15px] font-semibold text-foreground">
          {details.chapterNumber
            ? t("interactive.audit.stateResyncedNumber", { number: details.chapterNumber })
            : t("interactive.audit.stateResynced")}
        </div>
        <div className={`rounded-full px-2 py-0.5 text-[12px] font-semibold ${passed ? "bg-emerald-500/15 text-emerald-600" : "bg-amber-500/15 text-amber-600"}`}>
          {passed ? t("interactive.audit.passed") : t("interactive.audit.revisionRequired")}
        </div>
      </div>
      {details.summary && <div className="mt-2 text-[13px] leading-5 text-muted-foreground">{details.summary}</div>}
      <ChapterAuditIssues issues={details.auditIssues} title={t("interactive.audit.issues")} />
    </div>
  );
}

export function getGeneratedArtifactDetails(exec: ToolExecution): GeneratedArtifactDetails | null {
  if (!["short_fiction_run", "generate_cover", "script_create", "storyboard_create", "interactive_film_create"].includes(exec.tool)) return null;
  if (!exec.details || typeof exec.details !== "object") return null;
  const record = exec.details as Record<string, unknown>;
  if (
    record.kind !== "short_fiction_created"
    && record.kind !== "cover_generated"
    && record.kind !== "script_created"
    && record.kind !== "storyboard_created"
    && record.kind !== "interactive_film_created"
  ) return null;
  return {
    kind: record.kind,
    title: stringField(record, "title"),
    storyId: stringField(record, "storyId"),
    projectId: stringField(record, "projectId"),
    finalMarkdownPath: stringField(record, "finalMarkdownPath"),
    salesPackagePath: stringField(record, "salesPackagePath"),
    coverPromptPath: stringField(record, "coverPromptPath"),
    coverImagePath: stringField(record, "coverImagePath"),
    coverError: stringField(record, "coverError"),
    specPath: stringField(record, "specPath"),
    scriptPath: stringField(record, "scriptPath"),
    storyboardPath: stringField(record, "storyboardPath"),
    storyGraphPath: stringField(record, "storyGraphPath"),
    storyTreePath: stringField(record, "storyTreePath"),
    flagsPath: stringField(record, "flagsPath"),
    imagePromptsPath: stringField(record, "imagePromptsPath"),
    assetsManifestPath: stringField(record, "assetsManifestPath"),
    skillIds: stringArrayField(record, "skillIds"),
  };
}

function ScriptStoryboardResultPreview({ exec, onOpenFilmStudio }: { exec: ToolExecution; onOpenFilmStudio?: (projectId: string) => void }) {
  const openProjectArtifact = useChatStore((s) => s.openProjectArtifact);
  if (!["script_create", "storyboard_create", "interactive_film_create"].includes(exec.tool) || exec.status !== "completed") return null;
  const details = getGeneratedArtifactDetails(exec);
  if (!details || (
    details.kind !== "script_created"
    && details.kind !== "storyboard_created"
    && details.kind !== "interactive_film_created"
  )) return null;
  const maybeRows: Array<readonly [string, string] | null> = [
    details.specPath ? [t("interactive.tool.spec"), details.specPath] : null,
    details.storyGraphPath ? [t("interactive.tool.storyGraph"), details.storyGraphPath] : null,
    details.storyTreePath ? [t("interactive.tool.storyTree"), details.storyTreePath] : null,
    details.flagsPath ? [t("interactive.tool.flags"), details.flagsPath] : null,
    details.scriptPath ? [t("interactive.tool.script"), details.scriptPath] : null,
    details.storyboardPath ? [t("interactive.tool.storyboard"), details.storyboardPath] : null,
    details.imagePromptsPath ? [t("interactive.tool.imagePrompts"), details.imagePromptsPath] : null,
    details.assetsManifestPath ? [t("interactive.tool.imageAssets"), details.assetsManifestPath] : null,
  ];
  const rows = maybeRows.filter((row): row is readonly [string, string] => Boolean(row));
  if (rows.length === 0 && !(details.kind === "interactive_film_created" && details.projectId)) return null;
  return (
    <div className="mx-3 mb-3 mt-1 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[16px] leading-6 font-semibold text-primary">
          {details.kind === "script_created"
            ? t("interactive.tool.scriptGenerated")
            : details.kind === "storyboard_created"
              ? t("interactive.tool.storyboardGenerated")
              : t("interactive.tool.filmGenerated")}
        </div>
        {details.kind === "interactive_film_created" && details.projectId && onOpenFilmStudio && (
          <button
            type="button"
            data-testid="open-film-studio"
            onClick={() => onOpenFilmStudio(details.projectId!)}
            className="shrink-0 rounded-lg bg-primary px-3 py-1 text-[13px] font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
          >
            {t("interactive.tool.openWizard")}
          </button>
        )}
      </div>
      {rows.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {rows.map(([label, path]) => (
            <button
              key={label}
              type="button"
              onClick={() => openProjectArtifact(path)}
              className="group flex w-full items-start justify-between gap-3 rounded-lg border border-transparent px-2 py-1.5 text-left transition hover:border-primary/25 hover:bg-background/65"
            >
              <span className="min-w-0 text-[13px] leading-5 text-muted-foreground break-all">
                <span className="font-medium text-foreground">{label}{t("interactive.tool.separator")}</span>{path}
              </span>
              <span className="mt-0.5 shrink-0 rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary opacity-80 transition group-hover:opacity-100">
                {t("interactive.tool.view")}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ShortFictionResultPreview({ exec }: { exec: ToolExecution }) {
  if (!["short_fiction_run", "generate_cover"].includes(exec.tool) || exec.status !== "completed") return null;
  const details = getGeneratedArtifactDetails(exec);
  const coverPath = details?.coverImagePath ?? extractResultPath(exec.result, "Cover image");
  const coverError = details?.coverError ?? extractResultPath(exec.result, "Cover image reason");
  if (!coverPath || !/\.(png|jpe?g|webp)$/iu.test(coverPath)) {
    if (!coverError) return null;
    return (
      <div className="mx-3 mb-3 mt-1 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        {t("interactive.tool.coverNotGenerated")}{coverError}
      </div>
    );
  }

  const coverUrl = buildApiUrl(`/project/files/${encodeProjectPath(coverPath)}`);
  if (!coverUrl) return null;
  const title = details?.title ?? details?.storyId ?? t("interactive.tool.shortCover");

  return (
    <div className="mx-3 mb-3 mt-1 overflow-hidden rounded-xl border border-border/40 bg-background/70">
      <img
        src={coverUrl}
        alt={title}
        className="block max-h-[360px] w-full object-contain bg-muted/20"
        loading="lazy"
      />
      <div className="border-t border-border/40 px-3 py-2 text-[11px] text-muted-foreground break-all">
        {coverPath}
      </div>
    </div>
  );
}

export function getPlayToolDetails(exec: ToolExecution): PlayToolDetails | null {
  if (!["play_start", "play_step", "play_revise"].includes(exec.tool)) return null;
  if (!exec.details || typeof exec.details !== "object") return null;
  const record = exec.details as Record<string, unknown>;
  if (
    record.kind !== "play_world_started"
    && record.kind !== "play_turn_advanced"
    && record.kind !== "play_turn_revised"
    && record.kind !== "play_variant_restored"
  ) return null;
  const suggested = Array.isArray(record.suggestedActions)
    ? record.suggestedActions.filter((item): item is string => typeof item === "string")
    : [];
  return {
    kind: record.kind,
    title: stringField(record, "title"),
    worldId: stringField(record, "worldId"),
    runId: stringField(record, "runId"),
    turn: numberField(record, "turn")
      ?? nestedNumberField(record, "currentState", "turn")
      ?? (record.kind === "play_world_started" ? 0 : undefined),
    sceneImageUrl: stringField(record, "sceneImageUrl"),
    sceneText: stringField(record, "sceneText"),
    suggestedActions: suggested,
    variantId: stringField(record, "variantId"),
    skillIds: stringArrayField(record, "skillIds"),
  };
}

type PlayRunImageIndex = {
  readonly sceneImageUrls?: Record<string, string>;
  readonly sceneImageUrl?: string;
};

function sceneImageKey(details: PlayToolDetails): string | null {
  return details.turn == null ? null : `scene-turn-${Math.trunc(details.turn)}`;
}

export function buildPlaySceneImageUrl(details: PlayToolDetails, run?: PlayRunImageIndex | null): string | null {
  if (details.sceneImageUrl) {
    return buildApiUrl(details.sceneImageUrl);
  }
  const key = sceneImageKey(details);
  const fromIndex = key ? run?.sceneImageUrls?.[key] : undefined;
  if (fromIndex) return buildApiUrl(fromIndex);
  if (key === "scene-turn-0" && run?.sceneImageUrl) return buildApiUrl(run.sceneImageUrl);
  return null;
}

export function buildPlayRunStatusUrl(details: PlayToolDetails): string | null {
  if (!details.worldId || !details.runId || details.turn == null) return null;
  return buildApiUrl(
    `/play/runs/${encodeURIComponent(details.worldId)}/${encodeURIComponent(details.runId)}`,
  );
}

function PlaySceneImagePreview({ details }: { details: PlayToolDetails }) {
  const runUrl = useMemo(() => buildPlayRunStatusUrl(details), [details]);
  const directUrl = useMemo(() => buildPlaySceneImageUrl(details), [details]);
  const [readyUrl, setReadyUrl] = useState<string | null>(null);

  useEffect(() => {
    setReadyUrl(null);
    if (directUrl) {
      setReadyUrl(directUrl);
      return;
    }
    if (!runUrl) return;
    let cancelled = false;
    let timer: number | undefined;
    let attempt = 0;
    const maxAttempts = 40;

    const probe = async () => {
      try {
        const response = await fetch(runUrl);
        if (response.ok) {
          const data = await response.json() as PlayRunImageIndex;
          const url = buildPlaySceneImageUrl(details, data);
          if (url && !cancelled) {
            setReadyUrl(url);
            return;
          }
        }
      } catch {
        // The run may not exist yet, or the image may still be generating.
      }
      if (cancelled) return;
      attempt += 1;
      if (attempt < maxAttempts) {
        timer = window.setTimeout(() => void probe(), 2000);
      }
    };

    void probe();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [details, directUrl, runUrl]);

  if (!readyUrl) return null;

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border/40 bg-background/80">
      <img
        src={readyUrl}
        alt={t("interactive.tool.sceneIllustration")}
        className="block max-h-[420px] w-full object-contain bg-muted/20"
        loading="lazy"
      />
      {details.turn != null && (
        <div className="border-t border-border/40 px-3 py-2.5 text-[14px] leading-6 text-muted-foreground">
          {t("interactive.tool.sceneIllustrationTurn", { turn: Math.trunc(details.turn) })}
        </div>
      )}
    </div>
  );
}

export function getPlayEditDetails(exec: ToolExecution): PlayEditDetails | null {
  if (exec.tool !== "play_edit") return null;
  if (!exec.details || typeof exec.details !== "object") return null;
  const record = exec.details as Record<string, unknown>;
  if (record.kind !== "play_world_updated") return null;
  return {
    kind: "play_world_updated",
    worldId: stringField(record, "worldId"),
    runId: stringField(record, "runId"),
    updatedWorldContract: booleanField(record, "updatedWorldContract"),
    updatedVisualContract: booleanField(record, "updatedVisualContract"),
    updatedPremise: booleanField(record, "updatedPremise"),
    updatedEntities: numberField(record, "updatedEntities"),
  };
}

export function getProposedActionDetails(exec: ToolExecution): ProposedActionDetails | null {
  if (exec.tool !== "propose_action") return null;
  if (!exec.details || typeof exec.details !== "object") return null;
  const record = exec.details as Record<string, unknown>;
  if (record.kind !== "proposed_action") return null;
  const action = stringField(record, "action") as ChatRequestedIntent | undefined;
  const targetSessionKind = stringField(record, "targetSessionKind") as ChatSessionKind | undefined;
  const instruction = stringField(record, "instruction");
  if (!action || !targetSessionKind || !instruction) return null;
  return {
    kind: "proposed_action",
    execId: exec.id,
    action,
    targetSessionKind,
    sameSession: booleanField(record, "sameSession"),
    title: stringField(record, "title"),
    summary: stringField(record, "summary"),
    instruction,
    requestedSkills: stringArrayField(record, "requestedSkills"),
    actionPayload: actionPayloadField(record),
  };
}

export function getProposedActionContractRows(details: ProposedActionDetails): ReadonlyArray<{ label: string; value: string }> {
  const createBook = details.actionPayload?.createBook;
  if (details.action === "create_book" && createBook?.language) {
    return [{
      label: t("create.writingLanguage"),
      value: createBook.language,
    }];
  }
  const playStart = details.actionPayload?.playStart;
  if (details.action !== "play_start" || !playStart) return [];
  const rows: Array<{ label: string; value: string }> = [];
  const worldContract = playStart.worldContract?.trim();
  if (worldContract) rows.push({ label: t("interactive.tool.worldContract"), value: worldContract });
  const visualContract = playStart.visualContract?.trim();
  if (visualContract) rows.push({ label: t("interactive.tool.visualContract"), value: visualContract });
  return rows;
}

function ProposedActionPreview({
  exec,
  onProposedAction,
  onRejectProposedAction,
}: {
  exec: ToolExecution;
  onProposedAction?: (details: ProposedActionDetails) => void;
  onRejectProposedAction?: (details: ProposedActionDetails) => void;
}) {
  const resolvedProposals = useChatStore((s) => s.resolvedProposals);
  const isActiveSessionStreaming = useChatStore(chatSelectors.isActiveSessionStreaming);
  if (exec.tool !== "propose_action" || exec.status !== "completed") return null;
  const details = getProposedActionDetails(exec);
  if (!details) return null;
  // A proposed action is one-shot: once confirmed or rejected the card locks so
  // the production action can't be re-fired. While a run is in flight the
  // confirm button reflects "执行中…" instead of silently swallowing the click.
  const resolution = resolvedProposals[details.execId];
  const streaming = isActiveSessionStreaming;
  const locked = resolution !== undefined;
  const contractRows = getProposedActionContractRows(details);
  return (
    <div className="mx-3 mb-3 mt-1 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3.5">
      <div className="text-[17px] leading-6 font-semibold text-foreground">{details.title ?? t("interactive.tool.confirmAction")}</div>
      {details.summary && (
        <div className="mt-1.5 whitespace-pre-wrap break-words text-[15px] leading-7 text-muted-foreground">{details.summary}</div>
      )}
      <div className="mt-2.5 whitespace-pre-wrap break-words rounded-lg bg-background/70 px-3 py-2.5 text-[15px] leading-7 text-muted-foreground">
        {details.instruction}
      </div>
      {contractRows.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {contractRows.map((row) => (
            <div key={row.label} className="rounded-lg border border-border/50 bg-background/60 px-3 py-2.5">
              <div className="text-[13px] leading-5 font-semibold text-foreground">{row.label}</div>
              <div className="mt-1 whitespace-pre-wrap break-words text-[15px] leading-7 text-muted-foreground">{row.value}</div>
            </div>
          ))}
        </div>
      )}
      {resolution === "confirmed" ? (
        <div className="mt-3 flex items-center gap-1.5 text-[15px] leading-6 font-medium text-primary">
          <Check size={15} className="shrink-0" />
          {t("interactive.tool.executed")}
        </div>
      ) : resolution === "rejected" ? (
        <div className="mt-3 text-[15px] leading-6 font-medium text-muted-foreground">{t("interactive.tool.cancelled")}</div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="confirm-action"
            onClick={() => onProposedAction?.(details)}
            disabled={!onProposedAction || streaming || locked}
            className="rounded-lg bg-primary px-3.5 py-2 text-[15px] leading-6 font-medium text-primary-foreground disabled:opacity-50"
          >
            {streaming ? t("interactive.tool.runningEllipsis") : t("interactive.tool.continue")}
          </button>
          <button
            type="button"
            onClick={() => onRejectProposedAction?.(details)}
            disabled={!onRejectProposedAction || streaming || locked}
            className="rounded-lg border border-border/60 bg-background/80 px-3.5 py-2 text-[15px] leading-6 font-medium text-muted-foreground disabled:opacity-50"
          >
            {t("common.cancel")}
          </button>
        </div>
      )}
    </div>
  );
}

function PlayResultPreview({ exec }: { exec: ToolExecution }) {
  if (!["play_start", "play_step", "play_revise"].includes(exec.tool) || exec.status !== "completed") return null;
  const details = getPlayToolDetails(exec);
  if (!details?.sceneText) return null;
  const label = details.kind === "play_world_started"
    ? t("interactive.tool.playWorldStarted")
    : details.kind === "play_turn_revised"
      ? t("interactive.tool.playTurnRedone")
      : details.kind === "play_variant_restored"
        ? t("interactive.tool.playVariantSwitched")
        : t("interactive.tool.playWorldAdvanced");
  return (
    <div className="mx-3 mb-3 mt-1 rounded-xl border border-primary/20 bg-primary/5 px-3 py-3">
      <div className="mb-2 text-[16px] leading-6 font-semibold text-primary">
        {label}
      </div>
      <div className="whitespace-pre-wrap text-base leading-7 text-foreground">{details.sceneText}</div>
      <PlaySceneImagePreview details={details} />
    </div>
  );
}

function PlayEditPreview({ exec }: { exec: ToolExecution }) {
  if (exec.tool !== "play_edit" || exec.status !== "completed") return null;
  const details = getPlayEditDetails(exec);
  if (!details) return null;
  const changes = [
    details.updatedWorldContract ? t("interactive.tool.worldContract") : "",
    details.updatedVisualContract ? t("interactive.tool.visualContract") : "",
    details.updatedPremise ? t("interactive.tool.worldPremise") : "",
    details.updatedEntities && details.updatedEntities > 0
      ? t("interactive.tool.cards", { count: details.updatedEntities })
      : "",
  ].filter(Boolean);
  return (
    <div className="mx-3 mb-3 mt-1 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2.5">
      <div className="text-[16px] leading-6 font-semibold text-primary">{t("interactive.tool.settingsUpdated")}</div>
      <div className="mt-1 text-xs leading-5 text-muted-foreground">
        {changes.length > 0 ? changes.join(" · ") : t("interactive.tool.writtenWorld")}
      </div>
    </div>
  );
}

function hasStructuredResultPreview(exec: ToolExecution): boolean {
  if (getProposedActionDetails(exec)) return true;
  if (getPlayToolDetails(exec)?.sceneText) return true;
  if (getChapterRevisionDetails(exec)) return true;
  if (getChapterStateResyncDetails(exec)) return true;
  return Boolean(getPlayEditDetails(exec));
}

function isPipelineTool(tool: string): boolean {
  return tool === "sub_agent"
    || tool === "resync_chapter_state"
    || tool === "context_compression"
    || tool === "propose_action"
    || tool === "translation_create"
    || tool === "fanfic_create"
    || tool === "continuation_import"
    || tool === "spinoff_create"
    || tool === "imitation_create"
    || tool === "short_fiction_run"
    || tool === "script_create"
    || tool === "storyboard_create"
    || tool === "interactive_film_create"
    || tool === "generate_cover"
    || tool === "play_edit"
    || tool === "play_start"
    || tool === "play_revise"
    || tool === "play_step"
    || tool === "create_narrative_forecast"
    || tool === "get_narrative_forecast"
    || tool === "select_narrative_branch";
}

// -- Live elapsed timer hook --

function useElapsedTimer(startedAt: number, active: boolean): number {
  const [elapsed, setElapsed] = useState(() => active ? Date.now() - startedAt : 0);
  useEffect(() => {
    if (!active) return;
    setElapsed(Date.now() - startedAt);
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [startedAt, active]);
  return elapsed;
}

// -- Pipeline operation (sub_agent) --

/**
 * Uncontrolled <details>: `open` only sets the initial state, so manual
 * toggling keeps working (React leaves the DOM alone while the prop value is
 * unchanged). The key remounts the element when the global preference flips,
 * re-applying the new default.
 */
export function PipelineResultDetails({ result, defaultOpen }: { result: string; defaultOpen: boolean }) {
  return (
    <details
      key={defaultOpen ? "result-default-open" : "result-default-collapsed"}
      open={defaultOpen}
      className="mx-3 mb-3 mt-1 rounded-lg border border-border/40 bg-background/60 px-2.5 py-2 text-xs"
    >
      <summary className="cursor-pointer select-none font-medium text-muted-foreground hover:text-foreground">
        {t("interactive.tool.viewResult")}
      </summary>
      <div className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words leading-5 text-foreground">
        {result}
      </div>
    </details>
  );
}

function PipelineExecution({
  exec,
  onProposedAction,
  onRejectProposedAction,
  onOpenFilmStudio,
  onSelectNarrativeBranch,
  onRecheckNarrativeForecast,
}: {
  exec: ToolExecution;
  onProposedAction?: (details: ProposedActionDetails) => void;
  onRejectProposedAction?: (details: ProposedActionDetails) => void;
  onOpenFilmStudio?: (projectId: string) => void;
  onSelectNarrativeBranch?: (forecastId: string, branchId: string) => void | Promise<void>;
  onRecheckNarrativeForecast?: (forecastId: string) => void | Promise<void>;
}) {
  const isActive = exec.status === "running" || exec.status === "processing";
  const [open, setOpen] = useState(isActive);
  const elapsedMs = useElapsedTimer(exec.startedAt, isActive);
  const toolDetailsDefaultOpen = usePreferencesStore((s) => s.toolDetailsDefaultOpen);

  useEffect(() => {
    if (exec.status === "running") setOpen(true);
    if (exec.status === "completed") {
      const timer = setTimeout(() => setOpen(false), 500);
      return () => clearTimeout(timer);
    }
  }, [exec.status]);

  const bookId = exec.args?.bookId as string | undefined;
  const forecastDetails = getNarrativeForecastPreviewDetails(exec);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border border-border/40 bg-card/60">
      <CollapsibleTrigger className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl hover:bg-card/80 transition-colors cursor-pointer">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[16px] leading-6 font-medium text-foreground truncate">
            {localizeRuntimeLabel(exec.label)}
            {bookId && <span className="text-muted-foreground font-normal"> · {bookId}</span>}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[12px] text-muted-foreground/60">
            {isActive
              ? formatDuration(exec.startedAt, exec.startedAt + elapsedMs)
              : exec.completedAt ? formatDuration(exec.startedAt, exec.completedAt) : ""}
          </span>
          <ExecStatusBadge status={exec.status} />
          <ChevronDown size={16} className={`text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
      </CollapsibleTrigger>
      <ProposedActionPreview
        exec={exec}
        onProposedAction={onProposedAction}
        onRejectProposedAction={onRejectProposedAction}
      />
      <SkillUsagePreview exec={exec} />
      <ShortFictionResultPreview exec={exec} />
      <ScriptStoryboardResultPreview exec={exec} onOpenFilmStudio={onOpenFilmStudio} />
      <PlayResultPreview exec={exec} />
      <PlayEditPreview exec={exec} />
      <ChapterContextTracePreview exec={exec} />
      <ChapterRevisionPreview exec={exec} />
      <ChapterStateResyncPreview exec={exec} />
      <NarrativeForecastPreview
        exec={exec}
        onSelectBranch={onSelectNarrativeBranch}
        onRecheck={onRecheckNarrativeForecast}
      />
      {!forecastDetails && !hasStructuredResultPreview(exec) && typeof exec.result === "string" && exec.result.trim() && (
        <PipelineResultDetails result={exec.result} defaultOpen={toolDetailsDefaultOpen} />
      )}
      <CollapsibleContent>
        <div className="px-3 pb-3 pt-1">
          {exec.stages && exec.stages.length > 0 && (
            <ol className="mb-2 space-y-1.5">
              {exec.stages.map((stage) => (
                <li
                  key={stage.label}
                  className={[
                    "flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs",
                    stage.status === "active" ? "bg-primary/5 text-foreground" : "text-muted-foreground",
                  ].join(" ")}
                >
                  <StageIcon status={stage.status} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{localizeRuntimeLabel(stage.label)}</div>
                    {stage.progress && (
                      <div className="mt-0.5 text-[10px] text-muted-foreground/70">
                        {formatProgress(stage.progress)}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
          {/* Real-time execution logs */}
          {exec.logs && exec.logs.length > 0 && (
            <ul className="space-y-0.5">
              {exec.logs.map((log, i) => {
                const isError = log.startsWith("[error]") || /error/i.test(log);
                const isWarn = log.startsWith("[warning]") || /warning|警告/i.test(log);
                return (
                  <li key={i} className={`text-xs font-mono break-words ${isError ? "text-destructive" : isWarn ? "text-yellow-600 dark:text-yellow-400" : "text-muted-foreground"}`}>
                    {log}
                  </li>
                );
              })}
            </ul>
          )}
          {exec.status === "error" && exec.error && (
            <div className="mt-2 text-xs text-destructive bg-destructive/5 rounded-lg px-2.5 py-2">
              {exec.error}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// -- Utility tools (read/edit/grep/ls) grouped --

function UtilityExecStatusIcon({ status }: { status: ToolExecution["status"] }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 size={10} className="text-green-600 dark:text-green-400 shrink-0" />;
    case "error":
      return <XCircle size={10} className="text-destructive shrink-0" />;
    case "running":
    case "processing":
      return <Loader2 size={10} className="animate-spin text-primary shrink-0" />;
  }
}

export function UtilityExecutionRow({ exec }: { exec: ToolExecution }) {
  const title = `${exec.tool} ${String(exec.args?.path ?? exec.args?.pattern ?? "")}`;
  const hasResult = typeof exec.result === "string" && exec.result.trim().length > 0;

  if (!hasResult) {
    return (
      <div className="flex items-center gap-2">
        <span className="font-mono truncate">{title}</span>
        <UtilityExecStatusIcon status={exec.status} />
      </div>
    );
  }

  // Uncontrolled <details>, always collapsed by default: utility results are
  // reference material, expanding them all would flood the transcript.
  return (
    <details className="group">
      <summary className="flex cursor-pointer select-none items-center gap-2 list-none [&::-webkit-details-marker]:hidden hover:text-foreground transition-colors">
        <span className="font-mono truncate">{title}</span>
        <UtilityExecStatusIcon status={exec.status} />
        <ChevronDown size={10} className="shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-1 mb-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/40 bg-background/60 px-2 py-1.5 leading-5">
        {exec.result}
      </div>
    </details>
  );
}

function UtilityToolsGroup({ execs }: { execs: ToolExecution[] }) {
  const [open, setOpen] = useState(false);
  const allDone = execs.every(e => e.status === "completed" || e.status === "error");
  const hasError = execs.some(e => e.status === "error");

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer text-xs text-muted-foreground">
        <Wrench size={12} />
        <span>{t(execs.length === 1 ? "interactive.tool.fileOperation" : "interactive.tool.fileOperations", { count: execs.length })}</span>
        {allDone && !hasError && <CheckCircle2 size={10} className="text-green-600 dark:text-green-400" />}
        {hasError && <XCircle size={10} className="text-destructive" />}
        {!allDone && <Loader2 size={10} className="animate-spin text-primary" />}
        <ChevronDown size={10} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="pl-6 space-y-0.5 py-1">
          {execs.map((exec) => (
            <li key={exec.id} className="text-xs text-muted-foreground">
              <UtilityExecutionRow exec={exec} />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

// -- Main component --

export interface ToolExecutionStepsProps {
  executions: ToolExecution[];
  onProposedAction?: (details: ProposedActionDetails) => void;
  onRejectProposedAction?: (details: ProposedActionDetails) => void;
  onOpenFilmStudio?: (projectId: string) => void;
  onSelectNarrativeBranch?: (forecastId: string, branchId: string) => void | Promise<void>;
  onRecheckNarrativeForecast?: (forecastId: string) => void | Promise<void>;
}

/**
 * Group executions chronologically: pipeline ops render individually,
 * consecutive utility tools are merged into a single collapsed group.
 */
type RenderGroup =
  | { type: "pipeline"; exec: ToolExecution }
  | { type: "utilities"; execs: ToolExecution[] };

export function groupToolExecutionsChronologically(executions: ToolExecution[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  let utilBuf: ToolExecution[] = [];

  const flushUtils = () => {
    if (utilBuf.length > 0) {
      groups.push({ type: "utilities", execs: utilBuf });
      utilBuf = [];
    }
  };

  for (const exec of executions) {
    if (isPipelineTool(exec.tool)) {
      flushUtils();
      groups.push({ type: "pipeline", exec });
    } else {
      utilBuf.push(exec);
    }
  }
  flushUtils();
  return groups;
}

export const ToolExecutionSteps = memo(function ToolExecutionSteps({
  executions,
  onProposedAction,
  onRejectProposedAction,
  onOpenFilmStudio,
  onSelectNarrativeBranch,
  onRecheckNarrativeForecast,
}: ToolExecutionStepsProps) {
  const groups = useMemo(() => groupToolExecutionsChronologically(executions), [executions]);

  return (
    <div className="space-y-2 mt-2">
      {groups.map((g, i) =>
        g.type === "pipeline"
          ? (
              <PipelineExecution
                key={g.exec.id}
                exec={g.exec}
                onProposedAction={onProposedAction}
                onRejectProposedAction={onRejectProposedAction}
                onOpenFilmStudio={onOpenFilmStudio}
                onSelectNarrativeBranch={onSelectNarrativeBranch}
                onRecheckNarrativeForecast={onRecheckNarrativeForecast}
              />
            )
          : <UtilityToolsGroup key={`utils-${i}`} execs={g.execs} />
      )}
    </div>
  );
});

ToolExecutionSteps.displayName = "ToolExecutionSteps";
