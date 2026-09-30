import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildImportFoundationSource, PipelineRunner, type ChapterPipelineResult } from "../pipeline/runner.js";
import * as llmProvider from "../llm/provider.js";
import { StateManager } from "../state/manager.js";
import { ArchitectAgent } from "../agents/architect.js";
import { PlannerAgent } from "../agents/planner.js";
import * as ComposerModule from "../agents/composer.js";
import { WriterAgent, type SettleChapterStateInput, type WriteChapterOutput } from "../agents/writer.js";
import { ContinuityAuditor, type AuditIssue, type AuditResult } from "../agents/continuity.js";
import { ReviserAgent, type ReviseOutput } from "../agents/reviser.js";
import { ChapterAnalyzerAgent } from "../agents/chapter-analyzer.js";
import { StateValidatorAgent } from "../agents/state-validator.js";
import {
  FoundationReviewerAgent,
  FoundationReviewParseError,
} from "../agents/foundation-reviewer.js";
import { PolisherAgent } from "../agents/polisher.js";
import type { BookConfig } from "../models/book.js";
import { ChapterMetaSchema, type ChapterMeta } from "../models/chapter.js";
import { MemoryDB } from "../state/memory-db.js";
import * as memoryDbModule from "../state/memory-db.js";
import { buildLengthSpec, countChapterLength } from "../utils/length-metrics.js";
import { computeChapterContentHash } from "../audit/chapter-audit-evaluator.js";
import {
  auditRunRelativePath,
  createAuditRunWrite,
  serializeAuditRun,
  type AuditRunV1,
} from "../audit/audit-run.js";
import {
  listChapterVersions,
  readChapterVersion,
  saveChapterUserBrief,
} from "../state/chapter-workspace.js";
import {
  resolveWritingLanguageProfile,
  type WritingLanguageProfile,
} from "../utils/language.js";
import * as atomicFileSetModule from "../utils/atomic-file-set.js";
import type { AtomicFileWrite } from "../utils/atomic-file-set.js";
import * as hookPromotionModule from "../utils/hook-promotion.js";
import { loadPersistedPlan, savePersistedPlan } from "../pipeline/persisted-governed-plan.js";

const require = createRequire(import.meta.url);
const hasNodeSqlite = (() => {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

const sqliteIt = hasNodeSqlite ? it : it.skip;
const SLOW_PIPELINE_TEST_TIMEOUT_MS = 15_000;

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

const PACING_TEST_MEMO_BODY = `## 当前任务
Advance the governed chapter through one concrete causal change in the active conflict.

## 场景与篇幅预算
- One bounded scene carries the conflict forward without adding an unrelated subplot.

## 读者此刻在等什么
The reader is waiting for the next causal turn and visible evidence of its consequence.

## 该兑现的 / 暂不掀的
- Keep the current hook stable while paying off only the evidence scheduled for this chapter.

## 日常/过渡承担什么任务
- Carry state forward and preserve the established transition between the two conflict beats.

## 关键抉择过三连问
The protagonist makes a motivated choice that fits the present goal, interests, and characterization.

## 章尾必须发生的改变
- The situation changes in a way that leaves a concrete state difference for the next chapter.

## 本章 hook 账
No hook operation is required beyond the typed operations stored in the governed chapter intent.

## 不要做
- Do not contradict established state.`;

async function savePacingPlan(
  bookDir: string,
  chapter: number,
  pacingCode: "setup" | "escalation" | "reveal" | "reversal" | "payoff" | "aftermath" | "bridge" | "unknown",
  pacingOverrideReason?: string,
): Promise<void> {
  await mkdir(join(bookDir, "story", "runtime"), { recursive: true });
  await savePersistedPlan(bookDir, {
    intent: {
      chapter,
      goal: "Advance the governed chapter.",
      mustKeep: [],
      mustAvoid: [],
      styleEmphasis: [],
      acceptanceCriteria: [],
      pacingCode,
      ...(pacingOverrideReason ? { pacingOverrideReason } : {}),
      expectedHookOps: { upsert: [], mention: [], resolve: [], defer: [] },
    },
    memo: {
      chapter,
      goal: "Advance the governed chapter.",
      isGoldenOpening: false,
      body: PACING_TEST_MEMO_BODY,
      threadRefs: [],
    },
    intentMarkdown: "# Chapter Intent\n",
    plannerInputs: [],
    runtimePath: join(bookDir, "story", "runtime", `chapter-${String(chapter).padStart(4, "0")}.intent.md`),
  });
}

describe("buildImportFoundationSource", () => {
  it("selects complete opening, middle, and ending chapters without truncating their text", () => {
    const chapters = Array.from({ length: 36 }, (_, index) => {
      const n = index + 1;
      return {
        title: `第${n}章 标题${n}`,
        content: `OPEN-${n}\n${"正文".repeat(3000)}\nTAIL-${n}`,
      };
    });
    const fullText = chapters.map((chapter, index) => `第${index + 1}章 ${chapter.title}\n\n${chapter.content}`).join("\n\n---\n\n");

    const source = buildImportFoundationSource(chapters, "zh", {
      maxFullTextChars: 20_000,
    });

    expect(source.length).toBeLessThan(fullText.length / 2);
    expect(source).toContain("导入基础设定压缩资料包");
    expect(source).toContain("未选章节将在后续顺序回放");
    expect(source).toContain("完整章节标题目录");
    expect(source).toContain("第1章 第1章 标题1");
    expect(source).toContain("第36章 第36章 标题36");
    expect(source).toContain("OPEN-1");
    expect(source).toContain("TAIL-36");
    expect(source).toContain("正文".repeat(3000));
    expect(source).not.toContain("OPEN-5");
  });
});

const CRITICAL_ISSUE: AuditIssue = {
  severity: "critical",
  category: "continuity",
  description: "Fix the chapter state",
  suggestion: "Repair the contradiction",
};

function createAuditResult(overrides: Partial<AuditResult>): AuditResult {
  return {
    passed: true,
    issues: [],
    summary: "ok",
    overallScore: 90,
    tokenUsage: ZERO_USAGE,
    ...overrides,
  };
}

function createWriterOutput(overrides: Partial<WriteChapterOutput> = {}): WriteChapterOutput {
  return {
    chapterNumber: 1,
    title: "Test Chapter",
    content: "Original chapter body.",
    wordCount: "Original chapter body.".length,
    preWriteCheck: "check",
    postSettlement: "settled",
    updatedState: "writer state",
    updatedLedger: "writer ledger",
    updatedHooks: "writer hooks",
    chapterSummary: "| 1 | Original summary |",
    updatedSubplots: "writer subplots",
    updatedEmotionalArcs: "writer emotions",
    updatedCharacterMatrix: "writer matrix",
    postWriteErrors: [],
    postWriteWarnings: [],
    tokenUsage: ZERO_USAGE,
    ...overrides,
  };
}

function createReviseOutput(overrides: Partial<ReviseOutput> = {}): ReviseOutput {
  return {
    revisedContent: "Revised chapter body.",
    wordCount: "Revised chapter body.".length,
    fixedIssues: ["fixed"],
    tokenUsage: ZERO_USAGE,
    ...overrides,
  };
}

function createAnalyzedOutput(overrides: Partial<WriteChapterOutput> = {}): WriteChapterOutput {
  return createWriterOutput({
    content: "Analyzed final chapter body.",
    wordCount: "Analyzed final chapter body.".length,
    updatedState: "analyzed state",
    updatedLedger: "analyzed ledger",
    updatedHooks: "analyzed hooks",
    chapterSummary: "| 1 | Revised summary |",
    updatedSubplots: "analyzed subplots",
    updatedEmotionalArcs: "analyzed emotions",
    updatedCharacterMatrix: "analyzed matrix",
    ...overrides,
  });
}

function createSettledRevisionOutput(
  input: SettleChapterStateInput,
  overrides: Partial<WriteChapterOutput> = {},
): WriteChapterOutput {
  const updatedState = createStateCard({
    chapter: input.chapterNumber,
    location: "Revision test location",
    protagonistState: "Revision state settled from the new body.",
    goal: "Continue the revised chapter direction.",
    conflict: "Revision state remains internally consistent.",
  });
  const summaryRow = {
    chapter: input.chapterNumber,
    title: input.title,
    characters: "Test protagonist",
    events: "Revised chapter settled",
    stateChanges: "State updated",
    hookActivity: "No hook changes",
    mood: "tense",
    chapterType: "mainline",
  };
  return createWriterOutput({
    chapterNumber: input.chapterNumber,
    title: input.title,
    content: input.content,
    wordCount: input.content.length,
    runtimeStateDelta: {
      chapter: input.chapterNumber,
      hookOps: { upsert: [], mention: [], resolve: [], defer: [] },
      newHookCandidates: [],
      chapterSummary: summaryRow,
      subplotOps: [],
      emotionalArcOps: [],
      characterMatrixOps: [],
      notes: [],
    },
    runtimeStateSnapshot: {
      manifest: {
        schemaVersion: 2,
        language: input.book.language ?? "zh",
        lastAppliedChapter: input.chapterNumber,
        projectionVersion: 1,
        migrationWarnings: [],
      },
      currentState: {
        chapter: input.chapterNumber,
        facts: [],
      },
      hooks: { hooks: [] },
      chapterSummaries: { rows: [summaryRow] },
    },
    updatedState,
    updatedHooks: "# Pending Hooks\n",
    chapterSummary: `| ${input.chapterNumber} | ${input.title} | Test protagonist | Revised chapter settled | State updated | No hook changes | tense | mainline |`,
    updatedChapterSummaries: `# Chapter Summaries\n\n| Chapter | Title | Characters | Key Events | State Changes | Hook Activity | Mood | Chapter Type |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| ${input.chapterNumber} | ${input.title} | Test protagonist | Revised chapter settled | State updated | No hook changes | tense | mainline |\n`,
    ...overrides,
  });
}

async function snapshotRevisionBaseline(
  state: StateManager,
  bookId: string,
  chapterNumber: number,
): Promise<void> {
  const storyDir = join(state.bookDir(bookId), "story");
  await readFile(join(storyDir, "current_state.md"), "utf-8").catch(() =>
    writeFile(join(storyDir, "current_state.md"), createStateCard({
      chapter: chapterNumber,
      location: "Baseline location",
      protagonistState: "Baseline protagonist state.",
      goal: "Baseline goal.",
      conflict: "Baseline conflict.",
    }), "utf-8"));
  await readFile(join(storyDir, "pending_hooks.md"), "utf-8").catch(() =>
    writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"));
  await state.snapshotState(bookId, chapterNumber);
}

function createStateCard(params: {
  readonly chapter: number;
  readonly location: string;
  readonly protagonistState: string;
  readonly goal: string;
  readonly conflict: string;
}): string {
  return [
    "# Current State",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Current Chapter | ${params.chapter} |`,
    `| Current Location | ${params.location} |`,
    `| Protagonist State | ${params.protagonistState} |`,
    `| Current Goal | ${params.goal} |`,
    "| Current Constraint | The city gates are watched. |",
    "| Current Alliances | Mentor allies are scattered. |",
    `| Current Conflict | ${params.conflict} |`,
    "",
  ].join("\n");
}

function createCaptureLogger() {
  const infos: string[] = [];
  const warnings: string[] = [];

  const logger = {
    debug() {},
    info(message: string) {
      infos.push(message);
    },
    warn(message: string) {
      warnings.push(message);
    },
    error() {},
    child() {
      return logger;
    },
  };

  return { logger, infos, warnings };
}

async function createRunnerFixture(
  configOverrides: Partial<ConstructorParameters<typeof PipelineRunner>[0]> = {},
): Promise<{
  root: string;
  runner: PipelineRunner;
  state: StateManager;
  bookId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "inkos-runner-test-"));
  const state = new StateManager(root);
  const bookId = "test-book";
  const now = "2026-03-19T00:00:00.000Z";
  const book: BookConfig = {
    id: bookId,
    title: "Test Book",
    platform: "tomato",
    genre: "xuanhuan",
    status: "active",
    targetChapters: 10,
    chapterWordCount: 3000,
    createdAt: now,
    updatedAt: now,
  };

  await state.saveBookConfig(bookId, book);
  await mkdir(join(state.bookDir(bookId), "story"), { recursive: true });
  await mkdir(join(state.bookDir(bookId), "chapters"), { recursive: true });

  const runner = new PipelineRunner({
    client: {
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      defaults: {
        temperature: 0.7,
        maxTokens: 4096,
        thinkingBudget: 0,
      },
    } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
    model: "test-model",
    projectRoot: root,
    ...configOverrides,
  });

  return { root, runner, state, bookId };
}

async function enableViWriting(root: string): Promise<() => void> {
  const previous = process.env.INKOS_EXPERIMENTAL_WRITING_VI;
  process.env.INKOS_EXPERIMENTAL_WRITING_VI = "1";
  await mkdir(join(root, ".inkos"), { recursive: true });
  await writeFile(join(root, ".inkos", "vi-writing-v1.json"), JSON.stringify({
    schemaVersion: 1,
    contractVersion: "vi-writing-v1",
    projectRoot: root,
  }), "utf-8");
  return () => {
    if (previous === undefined) delete process.env.INKOS_EXPERIMENTAL_WRITING_VI;
    else process.env.INKOS_EXPERIMENTAL_WRITING_VI = previous;
  };
}

function productionAuditRun(input: {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly contentHash: string;
  readonly operationId?: string;
  readonly attemptId?: string;
  readonly phase?: AuditRunV1["phase"];
  readonly decision?: AuditRunV1["decision"];
}): AuditRunV1 {
  const operationId = input.operationId ?? randomUUID();
  const attemptId = input.attemptId ?? randomUUID();
  const phase = input.phase ?? "initial";
  const decision = input.decision ?? "pass";
  return {
    schemaVersion: 1,
    kind: "audit-run-v1",
    operationId,
    attemptId,
    operation: phase === "post-revision" ? "revise" : "write",
    phase,
    bookId: input.bookId,
    chapterNumber: input.chapterNumber,
    startedAt: "2026-08-29T00:00:00.000Z",
    completedAt: "2026-08-29T00:00:01.000Z",
    durationMs: 1000,
    contentHash: input.contentHash,
    length: {
      count: 220,
      countingMode: "zh_chars",
      target: 220,
      softMin: 190,
      softMax: 250,
      hardMin: 160,
      hardMax: 280,
    },
    decision,
    passed: decision === "pass",
    overallScore: decision === "pass" ? 95 : 50,
    findings: [],
    revision: { attempted: false, candidateProduced: false, accepted: false },
    canonicalCommitOutcome: "terminal-commit",
    provenance: {
      source: "pipeline-runner",
      operationId,
      attemptId,
      phase,
    },
    retryCounts: { transport: 0, output: 0, quality: 0 },
    tokenUsage: ZERO_USAGE,
  };
}

async function writeProductionAuditRun(bookDir: string, run: AuditRunV1): Promise<string> {
  const relativePath = auditRunRelativePath(run);
  const target = join(bookDir, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, serializeAuditRun(run), "utf-8");
  return relativePath;
}

async function writeProductionResumeSnapshot(input: {
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly operationId: string;
  readonly attemptId: string;
  readonly snapshotId?: string;
  readonly phase?: AuditRunV1["phase"];
  readonly contentHash?: string;
  readonly status?: "running" | "failed" | "complete" | "needs-review" | "cancelled";
}): Promise<string> {
  const padded = String(input.chapterNumber).padStart(4, "0");
  const runPath = join(input.bookDir, "story", "runtime", `chapter-${padded}.run.json`);
  await mkdir(dirname(runPath), { recursive: true });
  await writeFile(runPath, JSON.stringify({
    version: 1,
    kind: "long-fiction",
    id: input.snapshotId ?? `test-book:chapter-${padded}`,
    status: input.status ?? "running",
    stage: `chapter-${input.chapterNumber}`,
    artifacts: [],
    observations: [],
    model: "test-model",
    skillIds: ["inkos-long-writing"],
    resumeCursor: String(input.chapterNumber),
    operationId: input.operationId,
    attemptId: input.attemptId,
    phase: input.phase ?? "initial",
    ...(input.contentHash ? { contentHash: input.contentHash } : {}),
    updatedAt: "2026-08-29T00:00:00.000Z",
  }, null, 2), "utf-8");
  return runPath;
}

async function writeRawProductionSnapshot(
  bookDir: string,
  chapterNumber: number,
  content: string,
): Promise<string> {
  const padded = String(chapterNumber).padStart(4, "0");
  const runPath = join(bookDir, "story", "runtime", `chapter-${padded}.run.json`);
  await mkdir(dirname(runPath), { recursive: true });
  await writeFile(runPath, content, "utf-8");
  return runPath;
}

describe("PipelineRunner", () => {
  beforeEach(() => {
    vi.spyOn(PlannerAgent.prototype, "planChapter").mockImplementation(async (input) => {
      const chapterNumber = input.chapterNumber;
      const goal = input.externalContext ?? "test goal";
      const memo = {
        chapter: chapterNumber,
        goal,
        isGoldenOpening: false,
        body: "",
        threadRefs: [] as string[],
      };
      const intentMarkdown = [
        "# Chapter Intent",
        "",
        "## Goal",
        goal,
        "",
        "## Outline Node",
        "(not found)",
        "",
        "## Must Keep",
        "- none",
        "",
        "## Must Avoid",
        "- none",
        "",
        "## Style Emphasis",
        "- none",
        "",
      ].join("\n");
      const runtimeDir = join(input.bookDir, "story", "runtime");
      const { mkdir: mkdirFs, writeFile: writeFileFs } = await import("node:fs/promises");
      await mkdirFs(runtimeDir, { recursive: true });
      const runtimePath = join(runtimeDir, `chapter-${String(chapterNumber).padStart(4, "0")}.intent.md`);
      await writeFileFs(runtimePath, intentMarkdown, "utf-8");
      return {
        intent: {
          chapter: chapterNumber,
          goal,
          mustKeep: [],
          mustAvoid: [],
          styleEmphasis: [],
          acceptanceCriteria: [],
          pacingCode: "unknown" as const,
          expectedHookOps: { upsert: [], mention: [], resolve: [], defer: [] },
        },
        memo,
        intentMarkdown,
        plannerInputs: [runtimePath],
        runtimePath,
      };
    });
    vi.spyOn(FoundationReviewerAgent.prototype, "review").mockResolvedValue({
      passed: true,
      totalScore: 85,
      dimensions: [],
      overallFeedback: "auto-pass for test",
    });
    vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({
      warnings: [],
      passed: true,
    });
    vi.spyOn(WriterAgent.prototype, "settleChapterState").mockImplementation(
      async (input) => createSettledRevisionOutput(input),
    );
    // Default reviser mock: return input content unchanged so the review cycle's
    // repair loop exits immediately when triggered by length-out-of-range content.
    // Tests that need specific revision behavior override this mock explicitly.
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockImplementation(
      async (_bookDir, chapterContent, _chapterNumber, _issues, _mode, _genre, _options) =>
        createReviseOutput({
          revisedContent: chapterContent,
          wordCount: chapterContent.length,
        }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects disabled Vietnamese writing before lock, bootstrap, or agent work", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-runner-vi-disabled-"));
    const state = new StateManager(root);
    const bookId = "vi-disabled";
    await state.saveBookConfig(bookId, {
      id: bookId,
      title: "VI Disabled",
      platform: "other",
      genre: "other",
      language: "vi",
      status: "active",
      targetChapters: 10,
      chapterWordCount: 2000,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    const runner = new PipelineRunner({
      client: {} as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
    });
    const acquireBookLock = vi.spyOn(StateManager.prototype, "acquireBookLock")
      .mockRejectedValue(new Error("lock must not be acquired"));
    const ensureControlDocuments = vi.spyOn(StateManager.prototype, "ensureControlDocuments");
    const getNextChapterNumber = vi.spyOn(StateManager.prototype, "getNextChapterNumber");
    const writeChapter = vi.spyOn(WriterAgent.prototype, "writeChapter");
    const previous = process.env.INKOS_EXPERIMENTAL_WRITING_VI;
    delete process.env.INKOS_EXPERIMENTAL_WRITING_VI;

    try {
      await expect(runner.writeNextChapter(bookId)).rejects.toMatchObject({
        name: "WritingLanguagePreflightError",
        code: "WRITING_LANGUAGE_DISABLED",
      });
      expect(acquireBookLock).not.toHaveBeenCalled();
      expect(ensureControlDocuments).not.toHaveBeenCalled();
      expect(getNextChapterNumber).not.toHaveBeenCalled();
      expect(writeChapter).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.INKOS_EXPERIMENTAL_WRITING_VI;
      else process.env.INKOS_EXPERIMENTAL_WRITING_VI = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("revalidates book language after acquiring the writeNext lock", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const initialBook = await state.loadBookConfig(bookId);
    const acquireBookLock = vi.spyOn(StateManager.prototype, "acquireBookLock")
      .mockImplementation(async () => {
        await state.saveBookConfig(bookId, { ...initialBook, language: "vi" });
        return async () => undefined;
      });
    const ensureControlDocuments = vi.spyOn(StateManager.prototype, "ensureControlDocuments");
    const getNextChapterNumber = vi.spyOn(StateManager.prototype, "getNextChapterNumber")
      .mockRejectedValue(new Error("getNextChapterNumber must not run"));
    const writeChapter = vi.spyOn(WriterAgent.prototype, "writeChapter");
    const previous = process.env.INKOS_EXPERIMENTAL_WRITING_VI;
    delete process.env.INKOS_EXPERIMENTAL_WRITING_VI;

    try {
      await expect(runner.writeNextChapter(bookId)).rejects.toMatchObject({
        name: "WritingLanguagePreflightError",
        code: "WRITING_LANGUAGE_DISABLED",
      });
      expect(acquireBookLock).toHaveBeenCalledTimes(1);
      expect(ensureControlDocuments).not.toHaveBeenCalled();
      expect(getNextChapterNumber).not.toHaveBeenCalled();
      expect(writeChapter).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.INKOS_EXPERIMENTAL_WRITING_VI;
      else process.env.INKOS_EXPERIMENTAL_WRITING_VI = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preflights Vietnamese getBookStatus before its legacy bootstrap path", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-runner-vi-status-"));
    const state = new StateManager(root);
    const bookId = "vi-status";
    await state.saveBookConfig(bookId, {
      id: bookId,
      title: "VI Status",
      platform: "other",
      genre: "other",
      language: "vi",
      status: "active",
      targetChapters: 10,
      chapterWordCount: 2000,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    const runner = new PipelineRunner({
      client: {} as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
    });
    const getNextChapterNumber = vi.spyOn(StateManager.prototype, "getNextChapterNumber")
      .mockRejectedValue(new Error("bootstrap must not run"));
    const previous = process.env.INKOS_EXPERIMENTAL_WRITING_VI;
    delete process.env.INKOS_EXPERIMENTAL_WRITING_VI;

    try {
      await expect(runner.getBookStatus(bookId)).rejects.toMatchObject({
        name: "WritingLanguagePreflightError",
        code: "WRITING_LANGUAGE_DISABLED",
      });
      expect(getNextChapterNumber).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.INKOS_EXPERIMENTAL_WRITING_VI;
      else process.env.INKOS_EXPERIMENTAL_WRITING_VI = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an existing partial Vietnamese book directory before agent or file work", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-runner-vi-partial-"));
    const state = new StateManager(root);
    const bookId = "vi-partial";
    const bookDir = state.bookDir(bookId);
    await mkdir(bookDir, { recursive: true });
    const sentinelPath = join(bookDir, "KEEP.txt");
    await writeFile(sentinelPath, "keep this partial directory", "utf-8");
    const restoreVi = await enableViWriting(root);
    const runner = new PipelineRunner({
      client: {} as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
    });
    const generateFoundation = vi.spyOn(ArchitectAgent.prototype, "generateFoundation")
      .mockResolvedValue({
        storyBible: "# Story Bible\n",
        volumeOutline: "# Volume Outline\n",
        bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n",
        currentState: "# Current State\n",
        pendingHooks: "# Pending Hooks\n",
      });

    try {
      await expect(runner.initBook({
        id: bookId,
        title: "VI Partial",
        platform: "other",
        genre: "other",
        language: "vi",
        status: "outlining",
        targetChapters: 10,
        chapterWordCount: 2000,
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
      })).rejects.toThrow(/already exists/i);
      expect(generateFoundation).not.toHaveBeenCalled();
      await expect(readFile(sentinelPath, "utf-8")).resolves.toBe("keep this partial directory");
    } finally {
      restoreVi();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a Vietnamese target directory that appears after foundation generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-runner-vi-late-partial-"));
    const state = new StateManager(root);
    const bookId = "vi-late-partial";
    const bookDir = state.bookDir(bookId);
    const sentinelPath = join(bookDir, "KEEP.txt");
    const restoreVi = await enableViWriting(root);
    const runner = new PipelineRunner({
      client: {} as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
    });
    vi.spyOn(ArchitectAgent.prototype, "generateFoundation").mockImplementation(async () => {
      await mkdir(bookDir, { recursive: true });
      await writeFile(sentinelPath, "late concurrent directory", "utf-8");
      return {
        storyBible: "# Story Bible\n",
        volumeOutline: "# Volume Outline\n",
        bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n",
        currentState: "# Current State\n",
        pendingHooks: "# Pending Hooks\n",
      };
    });

    try {
      await expect(runner.initBook({
        id: bookId,
        title: "VI Late Partial",
        platform: "other",
        genre: "other",
        language: "vi",
        status: "outlining",
        targetChapters: 10,
        chapterWordCount: 2000,
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
      })).rejects.toThrow(/appeared during Vietnamese creation/i);
      await expect(readFile(sentinelPath, "utf-8")).resolves.toBe("late concurrent directory");
    } finally {
      restoreVi();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("freezes the implicit audit target before waiting for one lock", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const bookDir = state.bookDir(bookId);
    const chaptersDir = join(bookDir, "chapters");
    const chapterOne: ChapterMeta = {
      number: 1,
      title: "First",
      status: "drafted",
      wordCount: 20,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    };
    const chapterTwo: ChapterMeta = {
      ...chapterOne,
      number: 2,
      title: "Second",
    };
    await writeFile(join(chaptersDir, "0001_First.md"), "# 第一章\n\n第一章正文。", "utf-8");
    await state.saveChapterIndex(bookId, [chapterOne]);

    let lockDepth = 0;
    const acquireBookLock = vi.spyOn(StateManager.prototype, "acquireBookLock")
      .mockImplementation(async () => {
        await writeFile(join(chaptersDir, "0002_Second.md"), "# 第二章\n\n第二章正文。", "utf-8");
        await writeFile(
          join(chaptersDir, "index.json"),
          JSON.stringify([chapterOne, chapterTwo], null, 2),
          "utf-8",
        );
        lockDepth += 1;
        return async () => {
          lockDepth -= 1;
        };
      });
    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockImplementation(async (_bookDir, _content, chapterNumber) => {
        expect(lockDepth).toBe(1);
        expect(chapterNumber).toBe(1);
        return createAuditResult({ passed: true, summary: "first chapter audited" });
      });
    const originalSaveChapterIndex = StateManager.prototype.saveChapterIndex;
    const saveChapterIndex = vi.spyOn(StateManager.prototype, "saveChapterIndex")
      .mockImplementation(async function (this: StateManager, id, index, options) {
        expect(lockDepth).toBe(1);
        return originalSaveChapterIndex.call(this, id, index, options);
      });

    try {
      const result = await runner.auditDraft(bookId);
      const savedIndex = await state.loadChapterIndex(bookId);

      expect(result.chapterNumber).toBe(1);
      expect(acquireBookLock).toHaveBeenCalledTimes(1);
      expect(auditChapter).toHaveBeenCalledTimes(1);
      expect(saveChapterIndex).not.toHaveBeenCalled();
      expect(lockDepth).toBe(0);
      expect(savedIndex.find((chapter) => chapter.number === 1)?.status).toBe("audit-failed");
      expect(savedIndex.find((chapter) => chapter.number === 2)?.status).toBe("drafted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("manual audit enforces persisted hard length and atomically writes its run with the index", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const bookDir = state.bookDir(bookId);
    const chaptersDir = join(bookDir, "chapters");
    await writeFile(join(chaptersDir, "0001_Short.md"), "# 第一章\n\n太短。", "utf-8");
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "Short",
      status: "drafted",
      wordCount: 3,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
      lengthTelemetry: {
        language: "zh",
        target: 220,
        softMin: 190,
        softMax: 250,
        hardMin: 160,
        hardMax: 280,
        countingMode: "zh_chars",
        writerCount: 3,
        postReviseCount: 0,
        finalCount: 3,
        repairApplied: false,
        lengthWarning: true,
      },
    }]);
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({ passed: true, overallScore: 95, issues: [] }),
    );
    const saveChapterIndex = vi.spyOn(StateManager.prototype, "saveChapterIndex");
    const originalCommit = atomicFileSetModule.commitAtomicFileSet;
    const commitAtomicFileSet = vi.spyOn(atomicFileSetModule, "commitAtomicFileSet")
      .mockImplementation((input) => originalCommit(input));

    try {
      const result = await runner.auditDraft(bookId, 1);
      const savedIndex = await state.loadChapterIndex(bookId);
      const writes = commitAtomicFileSet.mock.calls[0]?.[0].writes ?? [];

      expect(result.decision).toBe("fail");
      expect(result.issues.filter((issue) => issue.ruleId === "length.hard-range")).toHaveLength(1);
      expect(saveChapterIndex).not.toHaveBeenCalled();
      expect(commitAtomicFileSet).toHaveBeenCalledTimes(1);
      expect(writes.map((write) => write.relativePath)).toEqual(expect.arrayContaining([
        join("chapters", "index.json"),
        expect.stringContaining(".manual.audit-run-v1.json"),
      ]));
      expect(savedIndex[0]).toMatchObject({
        status: "audit-failed",
        auditDecision: "fail",
        auditAttemptId: expect.any(String),
        auditRunPaths: [expect.stringContaining(".manual.audit-run-v1.json")],
        auditProvenance: expect.objectContaining({ phase: "manual" }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("manual inconclusive audit preserves the existing canonical status", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const body = "正文".repeat(120);
    await writeFile(join(chaptersDir, "0001_Approved.md"), `# 第一章\n\n${body}`, "utf-8");
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "Approved",
      status: "approved",
      wordCount: body.length,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }]);
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({ passed: false, overallScore: undefined, parseFailed: true }),
    );

    try {
      const result = await runner.auditDraft(bookId, 1);
      const savedIndex = await state.loadChapterIndex(bookId);

      expect(result.decision).toBe("inconclusive");
      expect(savedIndex[0]?.status).toBe("approved");
      expect(savedIndex[0]?.auditDecision).toBe("inconclusive");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an index-backed audit target deleted while waiting for the lock", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const chapter: ChapterMeta = {
      number: 1,
      title: "First",
      status: "drafted",
      wordCount: 20,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    };
    await writeFile(join(chaptersDir, "0001_First.md"), "# 第一章\n\n第一章正文。", "utf-8");
    await state.saveChapterIndex(bookId, [chapter]);

    const acquireBookLock = vi.spyOn(StateManager.prototype, "acquireBookLock")
      .mockImplementation(async () => {
        await writeFile(join(chaptersDir, "index.json"), "[]", "utf-8");
        return async () => undefined;
      });
    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValue(createAuditResult({ passed: true }));
    const saveChapterIndex = vi.spyOn(StateManager.prototype, "saveChapterIndex");
    const persistAuditDriftGuidance = vi.fn(async () => undefined);
    const emitWebhook = vi.fn(async () => undefined);
    Object.assign(runner as object, { persistAuditDriftGuidance, emitWebhook });

    try {
      await expect(runner.auditDraft(bookId)).rejects.toMatchObject({
        name: "WritingLanguagePreflightError",
        code: "STATE_PREFLIGHT_FAILED",
      });
      expect(acquireBookLock).toHaveBeenCalledTimes(1);
      expect(auditChapter).not.toHaveBeenCalled();
      expect(saveChapterIndex).not.toHaveBeenCalled();
      expect(persistAuditDriftGuidance).not.toHaveBeenCalled();
      expect(emitWebhook).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("revalidates exact Vietnamese audit telemetry after acquiring the lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-runner-vi-audit-race-"));
    const state = new StateManager(root);
    const bookId = "vi-audit-race";
    const bookDir = state.bookDir(bookId);
    const chaptersDir = join(bookDir, "chapters");
    await state.saveBookConfig(bookId, {
      id: bookId,
      title: "VI Audit Race",
      platform: "other",
      genre: "other",
      language: "vi",
      status: "active",
      targetChapters: 10,
      chapterWordCount: 2000,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    await mkdir(join(bookDir, "story", "state"), { recursive: true });
    await mkdir(chaptersDir, { recursive: true });
    await writeFile(join(bookDir, "story", "state", "manifest.json"), JSON.stringify({
      schemaVersion: 2,
      language: "vi",
      lastAppliedChapter: 1,
      projectionVersion: 1,
      migrationWarnings: [],
    }), "utf-8");
    await writeFile(join(chaptersDir, "0001_Mua.md"), "# Chương 1\n\nMưa rơi ngoài hiên.", "utf-8");
    const chapter: ChapterMeta = {
      number: 1,
      title: "Mưa",
      status: "drafted",
      wordCount: 5,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
      lengthTelemetry: {
        language: "vi",
        target: 2000,
        softMin: 1728,
        softMax: 2272,
        hardMin: 1455,
        hardMax: 2545,
        countingMode: "vi_wordlike_tokens_v1",
        writerCount: 5,
        postReviseCount: 0,
        finalCount: 5,
        repairApplied: false,
        lengthWarning: true,
      },
    };
    await state.saveChapterIndex(bookId, [chapter]);
    const restoreVi = await enableViWriting(root);
    const runner = new PipelineRunner({
      client: {} as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
    });
    const acquireBookLock = vi.spyOn(StateManager.prototype, "acquireBookLock")
      .mockImplementation(async () => {
        await writeFile(join(chaptersDir, "index.json"), JSON.stringify([{
          ...chapter,
          lengthTelemetry: {
            ...chapter.lengthTelemetry!,
            language: "en",
            countingMode: "en_words",
          },
        }], null, 2), "utf-8");
        return async () => undefined;
      });
    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValue(createAuditResult({ passed: true }));
    const saveChapterIndex = vi.spyOn(StateManager.prototype, "saveChapterIndex");

    try {
      await expect(runner.auditDraft(bookId)).rejects.toMatchObject({
        name: "WritingLanguagePreflightError",
        code: "STATE_LANGUAGE_MISMATCH",
      });
      expect(acquireBookLock).toHaveBeenCalledTimes(1);
      expect(auditChapter).not.toHaveBeenCalled();
      expect(saveChapterIndex).not.toHaveBeenCalled();
    } finally {
      restoreVi();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on invalid or telemetry-less Vietnamese chapter indexes", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-runner-vi-index-strict-"));
    const state = new StateManager(root);
    const bookId = "vi-index-strict";
    const bookDir = state.bookDir(bookId);
    const chaptersDir = join(bookDir, "chapters");
    await state.saveBookConfig(bookId, {
      id: bookId,
      title: "VI Index Strict",
      platform: "other",
      genre: "other",
      language: "vi",
      status: "active",
      targetChapters: 10,
      chapterWordCount: 2000,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    await mkdir(join(bookDir, "story", "state"), { recursive: true });
    await mkdir(chaptersDir, { recursive: true });
    await writeFile(join(bookDir, "story", "state", "manifest.json"), JSON.stringify({
      schemaVersion: 2,
      language: "vi",
      lastAppliedChapter: 1,
      projectionVersion: 1,
      migrationWarnings: [],
    }), "utf-8");
    await writeFile(join(chaptersDir, "0001_Mua.md"), "# Chương 1\n\nMưa rơi ngoài hiên.", "utf-8");
    const indexPath = join(chaptersDir, "index.json");
    await writeFile(indexPath, "{invalid", "utf-8");
    const restoreVi = await enableViWriting(root);
    const runner = new PipelineRunner({
      client: {} as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
    });
    const acquireBookLock = vi.spyOn(StateManager.prototype, "acquireBookLock");
    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValue(createAuditResult({ passed: true }));
    const saveChapterIndex = vi.spyOn(StateManager.prototype, "saveChapterIndex");

    try {
      await expect(runner.auditDraft(bookId, 1)).rejects.toMatchObject({
        name: "WritingLanguagePreflightError",
        code: "STATE_PREFLIGHT_FAILED",
      });

      await writeFile(indexPath, JSON.stringify([{
        number: 1,
        title: "Mưa",
        status: "drafted",
        wordCount: 5,
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
        auditIssues: [],
        lengthWarnings: [],
      }], null, 2), "utf-8");
      await expect(runner.auditDraft(bookId, 1)).rejects.toMatchObject({
        name: "WritingLanguagePreflightError",
        code: "STATE_LANGUAGE_MISMATCH",
      });

      expect(acquireBookLock).not.toHaveBeenCalled();
      expect(auditChapter).not.toHaveBeenCalled();
      expect(saveChapterIndex).not.toHaveBeenCalled();
    } finally {
      restoreVi();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("freezes the implicit revise target before waiting for the lock", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const bookDir = state.bookDir(bookId);
    const chaptersDir = join(bookDir, "chapters");
    const chapterOne: ChapterMeta = {
      number: 1,
      title: "First",
      status: "audit-failed",
      wordCount: 20,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    };
    const chapterTwo: ChapterMeta = {
      ...chapterOne,
      number: 2,
      title: "Second",
    };
    await state.ensureControlDocuments(bookId);
    await writeFile(join(chaptersDir, "0001_First.md"), `# 第一章\n\n${"林越推开旧门。".padEnd(2200, "续")}`, "utf-8");
    await state.saveChapterIndex(bookId, [chapterOne]);
    const acquireBookLock = vi.spyOn(StateManager.prototype, "acquireBookLock")
      .mockImplementation(async () => {
        await writeFile(join(chaptersDir, "0002_Second.md"), "# 第二章\n\n林越没有回头。", "utf-8");
        await writeFile(
          join(chaptersDir, "index.json"),
          JSON.stringify([chapterOne, chapterTwo], null, 2),
          "utf-8",
        );
        return async () => undefined;
      });
    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValue(createAuditResult({ passed: true, summary: "clean" }));
    Object.assign(runner as object, {
      createGovernedArtifacts: vi.fn(async () => undefined),
    });

    try {
      const result = await runner.reviseDraft(bookId);

      expect(result.chapterNumber).toBe(1);
      expect(acquireBookLock).toHaveBeenCalledTimes(1);
      expect(auditChapter).toHaveBeenCalledTimes(1);
      expect(auditChapter.mock.calls[0]?.[1]).toContain("旧门");
      expect(auditChapter.mock.calls[0]?.[2]).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("revalidates exact Vietnamese revise telemetry after acquiring the lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-runner-vi-revise-race-"));
    const state = new StateManager(root);
    const bookId = "vi-revise-race";
    const bookDir = state.bookDir(bookId);
    const chaptersDir = join(bookDir, "chapters");
    await state.saveBookConfig(bookId, {
      id: bookId,
      title: "VI Revise Race",
      platform: "other",
      genre: "other",
      language: "vi",
      status: "active",
      targetChapters: 10,
      chapterWordCount: 2000,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    await mkdir(join(bookDir, "story", "state"), { recursive: true });
    await mkdir(chaptersDir, { recursive: true });
    await writeFile(join(bookDir, "story", "state", "manifest.json"), JSON.stringify({
      schemaVersion: 2,
      language: "vi",
      lastAppliedChapter: 1,
      projectionVersion: 1,
      migrationWarnings: [],
    }), "utf-8");
    await writeFile(join(chaptersDir, "0001_Mua.md"), "# Chương 1\n\nMưa rơi ngoài hiên.", "utf-8");
    const chapter: ChapterMeta = {
      number: 1,
      title: "Mưa",
      status: "audit-failed",
      wordCount: 5,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
      lengthTelemetry: {
        language: "vi",
        target: 2000,
        softMin: 1728,
        softMax: 2272,
        hardMin: 1455,
        hardMax: 2545,
        countingMode: "vi_wordlike_tokens_v1",
        writerCount: 5,
        postReviseCount: 0,
        finalCount: 5,
        repairApplied: false,
        lengthWarning: true,
      },
    };
    await state.saveChapterIndex(bookId, [chapter]);
    const restoreVi = await enableViWriting(root);
    const runner = new PipelineRunner({
      client: {} as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
    });
    const acquireBookLock = vi.spyOn(StateManager.prototype, "acquireBookLock")
      .mockImplementation(async () => {
        await writeFile(join(chaptersDir, "index.json"), JSON.stringify([{
          ...chapter,
          lengthTelemetry: {
            ...chapter.lengthTelemetry!,
            language: "en",
            countingMode: "en_words",
          },
        }], null, 2), "utf-8");
        return async () => undefined;
      });
    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValue(createAuditResult({ passed: true }));
    const saveChapterIndex = vi.spyOn(StateManager.prototype, "saveChapterIndex");

    try {
      await expect(runner.reviseDraft(bookId)).rejects.toMatchObject({
        name: "WritingLanguagePreflightError",
        code: "STATE_LANGUAGE_MISMATCH",
      });
      expect(acquireBookLock).toHaveBeenCalledTimes(1);
      expect(auditChapter).not.toHaveBeenCalled();
      expect(saveChapterIndex).not.toHaveBeenCalled();
    } finally {
      restoreVi();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses one locked book profile for resync and audit without a nested lock", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const initialBook = await state.loadBookConfig(bookId);
    const chapter: ChapterMeta = {
      number: 1,
      title: "First",
      status: "drafted",
      wordCount: 20,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    };
    await writeFile(join(state.bookDir(bookId), "chapters", "0001_First.md"), "# 第一章\n\n正文。", "utf-8");
    await state.saveChapterIndex(bookId, [chapter]);
    let lockDepth = 0;
    const acquireBookLock = vi.spyOn(StateManager.prototype, "acquireBookLock")
      .mockImplementation(async () => {
        await state.saveBookConfig(bookId, { ...initialBook, language: "en" });
        lockDepth += 1;
        return async () => {
          lockDepth -= 1;
        };
      });
    const chapterResult = {
      chapterNumber: 1,
      title: "First",
      wordCount: 20,
      auditResult: createAuditResult({ passed: true }),
      revised: false,
      status: "ready-for-review" as const,
    };
    const auditResult = { ...createAuditResult({ passed: true }), chapterNumber: 1 };
    const internalResync = vi.fn(async (
      _book: BookConfig,
      _profile: WritingLanguageProfile,
      _targetChapter: number,
    ) => {
      expect(lockDepth).toBe(1);
      return chapterResult;
    });
    const internalAudit = vi.fn(async (
      _book: BookConfig,
      targetChapter: number,
      _profile: WritingLanguageProfile,
    ) => {
      expect(lockDepth).toBe(1);
      expect(targetChapter).toBe(1);
      return auditResult;
    });
    Object.assign(runner as object, {
      _resyncChapterArtifactsLocked: internalResync,
      _auditDraftLocked: internalAudit,
    });
    const publicAudit = vi.spyOn(runner, "auditDraft").mockResolvedValue(auditResult);

    try {
      const result = await runner.resyncChapterStateAndAudit(bookId, 1);

      expect(result).toEqual({ chapter: chapterResult, audit: auditResult });
      expect(acquireBookLock).toHaveBeenCalledTimes(1);
      expect(internalResync.mock.calls[0]?.[0]).toMatchObject({ id: bookId, language: "en" });
      expect(internalResync.mock.calls[0]?.[1]).toMatchObject({ language: "en" });
      expect(internalResync.mock.calls[0]?.[2]).toBe(1);
      expect(internalAudit).toHaveBeenCalledTimes(1);
      expect(internalAudit.mock.calls[0]?.[0]).toMatchObject({ id: bookId, language: "en" });
      expect(internalAudit.mock.calls[0]?.[2]).toMatchObject({ language: "en" });
      expect(publicAudit).not.toHaveBeenCalled();
      expect(lockDepth).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a deleted composite audit target before resync writes", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const chapter: ChapterMeta = {
      number: 1,
      title: "First",
      status: "drafted",
      wordCount: 20,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    };
    await writeFile(join(chaptersDir, "0001_First.md"), "# 第一章\n\n正文。", "utf-8");
    await state.saveChapterIndex(bookId, [chapter]);
    vi.spyOn(StateManager.prototype, "acquireBookLock").mockImplementation(async () => {
      await writeFile(join(chaptersDir, "index.json"), "[]", "utf-8");
      return async () => undefined;
    });
    const internalResync = vi.fn(async () => ({
      chapterNumber: 1,
      title: "First",
      wordCount: 20,
      auditResult: createAuditResult({ passed: true }),
      revised: false,
      status: "ready-for-review" as const,
    }));
    const internalAudit = vi.fn(async () => ({
      ...createAuditResult({ passed: true }),
      chapterNumber: 1,
    }));
    Object.assign(runner as object, {
      _resyncChapterArtifactsLocked: internalResync,
      _auditDraftLocked: internalAudit,
    });

    try {
      await expect(runner.resyncChapterStateAndAudit(bookId)).rejects.toMatchObject({
        name: "WritingLanguagePreflightError",
        code: "STATE_PREFLIGHT_FAILED",
      });
      expect(internalResync).not.toHaveBeenCalled();
      expect(internalAudit).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows Vietnamese resync through the locked public path", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const restoreVi = await enableViWriting(root);
    const profile = resolveWritingLanguageProfile("vi");
    const chapterResult = {
      chapterNumber: 1,
      title: "Mưa",
      wordCount: 4,
      auditResult: createAuditResult({ passed: false }),
      revised: false,
      status: "audit-failed" as const,
    };
    const auditResult = { ...createAuditResult({ passed: true }), chapterNumber: 1 };
    const lockedProfile = vi.fn(async () => profile);
    const resync = vi.fn(async () => chapterResult);
    const audit = vi.fn(async () => auditResult);
    Object.assign(runner as object, {
      resolveExplicitBookLanguage: vi.fn(async () => "vi"),
      selectChapterTargetReadOnly: vi.fn(async () => ({
        chapterNumber: 1,
        telemetry: { language: "vi", countingMode: "vi_wordlike_tokens_v1" },
      })),
      reselectFrozenChapterTargetReadOnly: vi.fn(async () => ({
        chapterNumber: 1,
        telemetry: { language: "vi", countingMode: "vi_wordlike_tokens_v1" },
      })),
      preflightResolvedBook: lockedProfile,
      _resyncChapterArtifactsLocked: resync,
      _auditDraftLocked: audit,
    });

    try {
      await state.saveBookConfig(bookId, {
        ...(await state.loadBookConfig(bookId)),
        language: "vi",
      });
      const result = await runner.resyncChapterStateAndAudit(bookId, 1);

      expect(result).toEqual({ chapter: chapterResult, audit: auditResult });
      expect(resync).toHaveBeenCalledWith(expect.objectContaining({ language: "vi" }), profile, 1, {});
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ language: "vi" }), 1, profile);
    } finally {
      restoreVi();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("atomically resyncs the latest Vietnamese chapter from typed baseline truth", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const restoreVi = await enableViWriting(root);
    const book = await state.loadBookConfig(bookId);
    const bookDir = state.bookDir(bookId);
    const chaptersDir = join(bookDir, "chapters");
    const body = "Lan bước qua hiên mưa và giữ chặt cuốn sổ cũ.";
    const chapter: ChapterMeta = {
      number: 1,
      title: "Mưa",
      status: "audit-failed",
      wordCount: 999,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      auditIssues: ["fresh audit required"],
      lengthWarnings: [],
      lengthTelemetry: {
        language: "vi",
        target: 2000,
        softMin: 1700,
        softMax: 2300,
        hardMin: 1,
        hardMax: 100,
        countingMode: "vi_wordlike_tokens_v1",
        writerCount: 999,
        postReviseCount: 999,
        finalCount: 999,
        repairApplied: false,
        lengthWarning: false,
      },
    };
    await writeFile(join(chaptersDir, "0001_Mua.md"), `# Chương 1: Mưa\n\n${body}`, "utf-8");
    await state.saveChapterIndex(bookId, [chapter]);
    await snapshotRevisionBaseline(state, bookId, 0);
    const settled = createSettledRevisionOutput({
      book: { ...book, language: "vi" },
      bookDir,
      chapterNumber: 1,
      baselineChapter: 0,
      title: chapter.title,
      content: body,
    });
    const commitAtomicFileSet = vi.spyOn(atomicFileSetModule, "commitAtomicFileSet");
    const saveChapter = vi.spyOn(WriterAgent.prototype, "saveChapter");
    const saveChapterIndex = vi.spyOn(StateManager.prototype, "saveChapterIndex");
    const snapshotState = vi.spyOn(StateManager.prototype, "snapshotState");
    const settleChapterState = vi.spyOn(WriterAgent.prototype, "settleChapterState").mockResolvedValue(settled);
    vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({
      passed: true,
      repairRequired: false,
      warnings: [],
    });
    Object.assign(runner as object, {
      createGovernedArtifacts: vi.fn(async () => undefined),
      loadGenreProfile: vi.fn(async () => ({ profile: { numericalSystem: false } })),
      syncNarrativeMemoryIndex: vi.fn(async () => undefined),
      syncCurrentStateFactHistory: vi.fn(async () => undefined),
    });

    try {
    const result = await (runner as unknown as {
        _resyncChapterArtifactsLocked(
          lockedBook: BookConfig,
          profile: WritingLanguageProfile,
          chapterNumber?: number,
          options?: { readonly allowNewHooks?: boolean },
        ): Promise<ChapterPipelineResult>;
      })._resyncChapterArtifactsLocked({ ...book, language: "vi" }, resolveWritingLanguageProfile("vi"), 1);
      const committedPaths = commitAtomicFileSet.mock.calls[0]?.[0].writes.map((write) => write.relativePath);
      const savedChapter = await readFile(join(chaptersDir, "0001_Mưa.md"), "utf-8");
      const savedIndex = await state.loadChapterIndex(bookId);

      expect(result).toMatchObject({ chapterNumber: 1, status: "audit-failed" });
      expect(settleChapterState).toHaveBeenCalledWith(expect.objectContaining({
        allowNewHooks: false,
      }));
      expect(result.wordCount).toBe(countChapterLength(body, "vi_wordlike_tokens_v1"));
      expect(savedChapter).toBe(`# Chương 1: Mưa\n\n${body}`);
      expect(savedIndex[0]).toMatchObject({
        status: "audit-failed",
        wordCount: countChapterLength(body, "vi_wordlike_tokens_v1"),
        auditDecision: "inconclusive",
        auditRunPaths: [],
        verifiedBlockerCount: 0,
      });
      expect(savedIndex[0]?.auditIssues).toEqual([
        "[warning] Vietnamese resync requires a fresh audit before continuation.",
      ]);
      expect(committedPaths).toEqual(expect.arrayContaining([
        join("chapters", "0001_Mưa.md"),
        join("chapters", "index.json"),
        join("story", "state", "manifest.json"),
        join("story", "state", "current_state.json"),
        join("story", "state", "hooks.json"),
        join("story", "state", "chapter_summaries.json"),
      ]));
      expect(commitAtomicFileSet).toHaveBeenCalledTimes(1);
      expect(saveChapter).not.toHaveBeenCalled();
      expect(saveChapterIndex).not.toHaveBeenCalled();
      expect(snapshotState).toHaveBeenCalledTimes(1);
      await expect(stat(join(bookDir, "story", "snapshots", "1", "state", "manifest.json"))).resolves.toBeTruthy();
    } finally {
      restoreVi();
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("runs Vietnamese resync and fresh audit as two ordered atomic phases", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const restoreVi = await enableViWriting(root);
    const book = await state.loadBookConfig(bookId);
    const bookDir = state.bookDir(bookId);
    const chaptersDir = join(bookDir, "chapters");
    const body = "Lan đặt cuốn sổ lên bàn rồi đọc dấu mực mới dưới ngọn đèn.";
    const telemetry = {
      language: "vi" as const,
      target: 2000,
      softMin: 1700,
      softMax: 2300,
      hardMin: 1,
      hardMax: 100,
      countingMode: "vi_wordlike_tokens_v1" as const,
      writerCount: 12,
      postReviseCount: 0,
      finalCount: 12,
      repairApplied: false,
      lengthWarning: false,
    };
    await state.saveBookConfig(bookId, { ...book, language: "vi" });
    await writeFile(join(chaptersDir, "0001_So.md"), `# Chương 1: Sổ\n\n${body}`, "utf-8");
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "Sổ",
      status: "audit-failed",
      wordCount: 12,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      auditIssues: ["old audit must not remain attached"],
      lengthWarnings: [],
      lengthTelemetry: telemetry,
      auditDecision: "fail",
      auditRunPaths: ["story/audit/runs/chapter-0001/old.json"],
      verifiedBlockerCount: 2,
    }]);
    await snapshotRevisionBaseline(state, bookId, 0);
    const settled = createSettledRevisionOutput({
      book: { ...book, language: "vi" },
      bookDir,
      chapterNumber: 1,
      baselineChapter: 0,
      title: "Sổ",
      content: body,
    });
    const settle = vi.spyOn(WriterAgent.prototype, "settleChapterState").mockResolvedValue(settled);
    vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({
      passed: true,
      repairRequired: false,
      warnings: [],
    });
    const acquireBookLock = vi.spyOn(StateManager.prototype, "acquireBookLock");
    const commitAtomicFileSet = vi.spyOn(atomicFileSetModule, "commitAtomicFileSet");
    const auditedBodies: string[] = [];
    const evaluateMergedAudit = vi.fn(async (params: { readonly chapterContent: string }) => {
      auditedBodies.push(params.chapterContent);
      return {
        auditResult: createAuditResult({
          passed: true,
          decision: "pass",
          contentHash: computeChapterContentHash(params.chapterContent),
        }),
        aiTellCount: 0,
        blockingCount: 0,
        criticalCount: 0,
        revisionBlockingIssues: [],
      };
    });
    Object.assign(runner as object, {
      createGovernedArtifacts: vi.fn(async () => undefined),
      loadGenreProfile: vi.fn(async () => ({ profile: { numericalSystem: false } })),
      syncNarrativeMemoryIndex: vi.fn(async () => undefined),
      syncCurrentStateFactHistory: vi.fn(async () => undefined),
      persistAuditDriftGuidance: vi.fn(async () => undefined),
      emitWebhook: vi.fn(async () => undefined),
      evaluateMergedAudit,
    });

    try {
      const result = await runner.resyncChapterStateAndAudit(bookId, 1, { allowNewHooks: false });
      const savedIndex = await state.loadChapterIndex(bookId);
      const runPath = savedIndex[0]?.auditRunPaths?.at(-1);
      const auditRun = JSON.parse(await readFile(join(bookDir, runPath!), "utf-8")) as {
        readonly contentHash: string;
        readonly canonicalCommitOutcome: string;
      };

      expect(result.audit.decision).toBe("pass");
      expect(result.chapter.status).toBe("audit-failed");
      expect(auditedBodies).toEqual([body]);
      expect(settle).toHaveBeenCalledWith(expect.objectContaining({
        baselineChapter: 0,
        allowNewHooks: false,
        allowReapply: true,
      }));
      expect(acquireBookLock).toHaveBeenCalledTimes(1);
      expect(commitAtomicFileSet).toHaveBeenCalledTimes(2);
      expect(savedIndex[0]).toMatchObject({
        status: "ready-for-review",
        auditDecision: "pass",
        verifiedBlockerCount: 0,
      });
      expect(auditRun).toMatchObject({
        contentHash: computeChapterContentHash(body),
        canonicalCommitOutcome: "unchanged",
      });

      evaluateMergedAudit.mockRejectedValue(new Error("auditor unavailable"));
      await expect(runner.resyncChapterStateAndAudit(bookId, 1, { allowNewHooks: false }))
        .rejects.toThrow("auditor unavailable");
      const failedIndex = await state.loadChapterIndex(bookId);
      expect(failedIndex[0]).toMatchObject({
        status: "audit-failed",
        auditDecision: "inconclusive",
        auditRunPaths: [],
      });
      expect(commitAtomicFileSet).toHaveBeenCalledTimes(3);
    } finally {
      restoreVi();
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("fails closed without mutating a Vietnamese chapter when typed settlement is missing", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const restoreVi = await enableViWriting(root);
    const book = await state.loadBookConfig(bookId);
    const bookDir = state.bookDir(bookId);
    const chaptersDir = join(bookDir, "chapters");
    const body = "Lan nhìn thấy dấu mực mới trên cuốn sổ.";
    const chapter: ChapterMeta = {
      number: 1,
      title: "Mực mới",
      status: "audit-failed",
      wordCount: 8,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    };
    const chapterPath = join(chaptersDir, "0001_Muc_moi.md");
    await writeFile(chapterPath, `# Chương 1: Mực mới\n\n${body}`, "utf-8");
    await state.saveChapterIndex(bookId, [chapter]);
    await snapshotRevisionBaseline(state, bookId, 0);
    const indexBefore = await readFile(join(chaptersDir, "index.json"), "utf-8");
    const chapterBefore = await readFile(chapterPath, "utf-8");
    const commitAtomicFileSet = vi.spyOn(atomicFileSetModule, "commitAtomicFileSet");
    vi.spyOn(WriterAgent.prototype, "settleChapterState").mockResolvedValue(createWriterOutput({
      chapterNumber: 1,
      title: chapter.title,
      content: body,
      updatedState: "legacy state",
      updatedHooks: "legacy hooks",
    }));
    vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({
      passed: true,
      repairRequired: false,
      warnings: [],
    });
    Object.assign(runner as object, {
      createGovernedArtifacts: vi.fn(async () => undefined),
      loadGenreProfile: vi.fn(async () => ({ profile: { numericalSystem: false } })),
    });

    try {
      await expect((runner as unknown as {
        _resyncChapterArtifactsLocked(
          lockedBook: BookConfig,
          profile: WritingLanguageProfile,
          chapterNumber?: number,
        ): Promise<ChapterPipelineResult>;
      })._resyncChapterArtifactsLocked({ ...book, language: "vi" }, resolveWritingLanguageProfile("vi"), 1))
        .rejects.toMatchObject({ code: "STATE_PREFLIGHT_FAILED" });
      expect(await readFile(join(chaptersDir, "index.json"), "utf-8")).toBe(indexBefore);
      expect(await readFile(chapterPath, "utf-8")).toBe(chapterBefore);
      expect(commitAtomicFileSet).not.toHaveBeenCalled();
    } finally {
      restoreVi();
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("keeps explicit telemetry language independent from its counting mode", async () => {
    const { root, runner } = await createRunnerFixture();
    try {
      const telemetry = (runner as unknown as {
        buildLengthTelemetry: (params: {
          language: "vi";
          lengthSpec: {
            target: number;
            softMin: number;
            softMax: number;
            hardMin: number;
            hardMax: number;
            countingMode: "en_words";
          };
          writerCount: number;
          postReviseCount: number;
          finalCount: number;
          repairApplied: boolean;
          lengthWarning: boolean;
        }) => { language?: string; countingMode: string };
      }).buildLengthTelemetry({
        language: "vi",
        lengthSpec: {
          target: 900,
          softMin: 778,
          softMax: 1022,
          hardMin: 655,
          hardMax: 1145,
          countingMode: "en_words",
        },
        writerCount: 700,
        postReviseCount: 750,
        finalCount: 800,
        repairApplied: true,
        lengthWarning: false,
      });

      expect(telemetry).toMatchObject({
        language: "vi",
        countingMode: "en_words",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a parent writing profile through nested operation context", async () => {
    const { root, runner } = await createRunnerFixture();
    const profile = resolveWritingLanguageProfile("vi");
    const signal = new AbortController().signal;
    try {
      const context = await runner.runWithAgentContext(
        { writingProfile: profile },
        () => runner.runWithAbortSignal(signal, async () => runner.createAgentContext("writer", "test-book")),
      );

      expect(context.writingProfile).toBe(profile);
      expect(context.signal).toBe(signal);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reuse override clients when credential sources differ", () => {
    const previousKeyA = process.env.TEST_KEY_A;
    const previousKeyB = process.env.TEST_KEY_B;
    process.env.TEST_KEY_A = "key-a";
    process.env.TEST_KEY_B = "key-b";

    try {
      const runner = new PipelineRunner({
        client: {
          provider: "openai",
          apiFormat: "chat",
          stream: false,
          defaults: {
            temperature: 0.7,
            maxTokens: 4096,
            thinkingBudget: 0,
          },
        } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
        model: "base-model",
        projectRoot: process.cwd(),
        defaultLLMConfig: {
          provider: "custom",
          service: "custom",
          configSource: "env",
          baseUrl: "https://base.example/v1",
          apiKey: "base-key",
          model: "base-model",
          temperature: 0.7,
          thinkingBudget: 0,
          apiFormat: "chat",
          stream: false,
        },
        modelOverrides: {
          writer: {
            model: "writer-model",
            provider: "custom",
            baseUrl: "https://shared.example/v1",
            apiKeyEnv: "TEST_KEY_A",
          },
          auditor: {
            model: "auditor-model",
            provider: "custom",
            baseUrl: "https://shared.example/v1",
            apiKeyEnv: "TEST_KEY_B",
          },
        },
      });

      const resolveOverride = (
        runner as unknown as {
          resolveOverride: (agent: string) => { model: string; client: unknown };
        }
      ).resolveOverride.bind(runner);

      const writerOverride = resolveOverride("writer");
      const auditorOverride = resolveOverride("auditor");

      expect(writerOverride.client).not.toBe(auditorOverride.client);
    } finally {
      if (previousKeyA === undefined) delete process.env.TEST_KEY_A;
      else process.env.TEST_KEY_A = previousKeyA;

      if (previousKeyB === undefined) delete process.env.TEST_KEY_B;
      else process.env.TEST_KEY_B = previousKeyB;
    }
  });

  it("initializes control documents during book creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-init-book-test-"));
    const bookId = "bootstrap-book";
    const brief = "# Author Intent\n\nKeep the narrative centered on mentor conflict.\n";
    const now = "2026-03-22T00:00:00.000Z";
    const book: BookConfig = {
      id: bookId,
      title: "Bootstrap Book",
      platform: "tomato",
      genre: "xuanhuan",
      status: "outlining",
      targetChapters: 10,
      chapterWordCount: 3000,
      createdAt: now,
      updatedAt: now,
    };

    const runner = new PipelineRunner({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          thinkingBudget: 0,
        },
      } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
      externalContext: brief,
    });

    vi.spyOn(ArchitectAgent.prototype, "generateFoundation").mockResolvedValue({
      storyBible: "# Story Bible\n",
      volumeOutline: "# Volume Outline\n",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n",
      currentState: "# Current State\n",
      pendingHooks: "# Pending Hooks\n",
    });

    try {
      await runner.initBook(book);

      const storyDir = join(root, "books", bookId, "story");
      const authorIntent = await readFile(join(storyDir, "author_intent.md"), "utf-8");
      const currentFocus = await readFile(join(storyDir, "current_focus.md"), "utf-8");
      const runtimeDir = await stat(join(storyDir, "runtime"));

      expect(authorIntent).toContain("mentor conflict");
      expect(currentFocus).toContain("当前聚焦");
      expect(runtimeDir.isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies creation-draft overrides while initializing a book", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-init-book-overrides-"));
    const bookId = "override-book";
    const book: BookConfig = {
      id: bookId,
      title: "Override Book",
      platform: "tomato",
      genre: "xuanhuan",
      status: "outlining",
      targetChapters: 20,
      chapterWordCount: 2800,
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };

    const runner = new PipelineRunner({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          thinkingBudget: 0,
        },
      } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
    });

    const generateFoundationSpy = vi.spyOn(ArchitectAgent.prototype, "generateFoundation").mockResolvedValue({
      storyBible: "# Story Bible\n",
      volumeOutline: "# Volume Outline\n",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n",
      currentState: "# Current State\n",
      pendingHooks: "# Pending Hooks\n",
    });

    try {
      await runner.initBook(book, {
        externalContext: "世界观重点：近未来港口城，账本与旧案牵出多方势力。",
        authorIntent: "# 作者意图\n\n写成冷硬、克制、利益驱动的商战悬疑。\n",
        currentFocus: "# 当前聚焦\n\n先把旧账线和港口势力网立住。\n",
      });

      expect(generateFoundationSpy).toHaveBeenCalledWith(
        book,
        expect.stringContaining("近未来港口城"),
        undefined,
      );

      const storyDir = join(root, "books", bookId, "story");
      await expect(readFile(join(storyDir, "author_intent.md"), "utf-8"))
        .resolves.toContain("冷硬、克制、利益驱动");
      await expect(readFile(join(storyDir, "current_focus.md"), "utf-8"))
        .resolves.toContain("旧账线和港口势力网");
      await expect(readFile(join(storyDir, "brief.md"), "utf-8"))
        .resolves.toContain("近未来港口城");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("feeds foundation review feedback into the regeneration call after a rejection", async () => {
    const { root, runner, bookId } = await createRunnerFixture();
    const reviewer = new FoundationReviewerAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          thinkingBudget: 0,
        },
      } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
      bookId,
    });
    const foundation = {
      storyBible: "# Story Bible",
      volumeOutline: "# Volume Outline",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules",
      currentState: "# Current State",
      pendingHooks: "# Pending Hooks",
    };
    const generate = vi.fn(async (_reviewFeedback?: string) => foundation);
    const reviewMock = vi.mocked(FoundationReviewerAgent.prototype.review);

    reviewMock.mockReset();
    reviewMock
      .mockResolvedValueOnce({
        passed: false,
        totalScore: 68,
        dimensions: [
          {
            name: "核心冲突",
            score: 58,
            feedback: "核心冲突不够集中，主线悬念没有站稳。",
          },
          {
            name: "开篇节奏",
            score: 76,
            feedback: "前五章起势偏慢，爆点不够前置。",
          },
        ],
        overallFeedback: "请把冲突收紧，并在更早的位置建立爆点。",
      })
      .mockResolvedValueOnce({
        passed: true,
        totalScore: 88,
        dimensions: [],
        overallFeedback: "通过",
      });

    try {
      const result = await (runner as unknown as {
        generateAndReviewFoundation: (params: {
          readonly generate: (reviewFeedback?: string) => Promise<typeof foundation>;
          readonly reviewer: FoundationReviewerAgent;
          readonly mode: "original";
          readonly language: "zh";
          readonly stageLanguage: "zh";
          readonly maxRetries: number;
        }) => Promise<typeof foundation>;
      }).generateAndReviewFoundation({
        generate,
        reviewer,
        mode: "original",
        language: "zh",
        stageLanguage: "zh",
        maxRetries: 2,
      });

      expect(result).toEqual(foundation);
      expect(generate).toHaveBeenCalledTimes(2);
      expect(generate.mock.calls[0]?.[0]).toBeUndefined();
      expect(generate.mock.calls[1]?.[0]).toContain("请把冲突收紧，并在更早的位置建立爆点。");
      expect(generate.mock.calls[1]?.[0]).toContain("核心冲突");
      expect(generate.mock.calls[1]?.[0]).toContain("核心冲突不够集中");
      expect(generate.mock.calls[1]?.[0]).toContain("开篇节奏");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the current foundation when review formatting cannot be parsed", async () => {
    const { root, runner, bookId } = await createRunnerFixture();
    const reviewer = new FoundationReviewerAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
      } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
      bookId,
    });
    const foundation = {
      storyBible: "# Story Bible",
      volumeOutline: "# Volume Outline",
      bookRules: "# Book Rules",
      currentState: "# Current State",
      pendingHooks: "# Pending Hooks",
    };
    const generate = vi.fn(async () => foundation);
    const reviewMock = vi.mocked(FoundationReviewerAgent.prototype.review);
    reviewMock.mockReset();
    reviewMock.mockRejectedValue(new FoundationReviewParseError([2, 3, 4, 5]));

    try {
      const result = await (runner as unknown as {
        generateAndReviewFoundation: (params: {
          readonly generate: () => Promise<typeof foundation>;
          readonly reviewer: FoundationReviewerAgent;
          readonly mode: "original";
          readonly language: "zh";
          readonly stageLanguage: "zh";
        }) => Promise<typeof foundation>;
      }).generateAndReviewFoundation({
        generate,
        reviewer,
        mode: "original",
        language: "zh",
        stageLanguage: "zh",
      });

      expect(result).toBe(foundation);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(reviewMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors configured foundation review retry count before accepting a rejected foundation", async () => {
    const { root, runner, bookId } = await createRunnerFixture({
      foundationReviewRetries: 4,
    } as Partial<ConstructorParameters<typeof PipelineRunner>[0]>);
    const reviewer = new FoundationReviewerAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          thinkingBudget: 0,
        },
      } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
      bookId,
    });
    const foundation = {
      storyBible: "# Story Bible",
      volumeOutline: "# Volume Outline",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules",
      currentState: "# Current State",
      pendingHooks: "# Pending Hooks",
    };
    const generate = vi.fn(async (_reviewFeedback?: string) => foundation);
    const reviewMock = vi.mocked(FoundationReviewerAgent.prototype.review);

    reviewMock.mockReset();
    reviewMock.mockResolvedValue({
      passed: false,
      totalScore: 72,
      dimensions: [],
      overallFeedback: "仍未达到可开写标准。",
    });

    try {
      await (runner as unknown as {
        generateAndReviewFoundation: (params: {
          readonly generate: (reviewFeedback?: string) => Promise<typeof foundation>;
          readonly reviewer: FoundationReviewerAgent;
          readonly mode: "original";
          readonly language: "zh";
          readonly stageLanguage: "zh";
        }) => Promise<typeof foundation>;
      }).generateAndReviewFoundation({
        generate,
        reviewer,
        mode: "original",
        language: "zh",
        stageLanguage: "zh",
      });

      expect(generate).toHaveBeenCalledTimes(5);
      expect(reviewMock).toHaveBeenCalledTimes(5);
      expect(generate.mock.calls[1]?.[0]).toContain("仍未达到可开写标准");
      expect(generate.mock.calls[4]?.[0]).toContain("仍未达到可开写标准");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bootstraps missing control documents for legacy books before writing", async () => {
    const { root, runner, bookId } = await createRunnerFixture();

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Legacy chapter body.",
        wordCount: "Legacy chapter body.".length,
      }),
    );

    try {
      await runner.writeDraft(bookId);

      const storyDir = join(root, "books", bookId, "story");
      const authorIntent = await readFile(join(storyDir, "author_intent.md"), "utf-8");
      const currentFocus = await readFile(join(storyDir, "current_focus.md"), "utf-8");
      const runtimeDir = await stat(join(storyDir, "runtime"));

      expect(authorIntent).toContain("Author Intent");
      expect(currentFocus).toContain("Current Focus");
      expect(runtimeDir.isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("commits writeDraft chapter, truth, runtime state and index through one canonical file set", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const bookDir = state.bookDir(bookId);
    const output = createWriterOutput({
      chapterNumber: 1,
      title: "Prepared Draft",
      content: "Prepared draft body.",
      wordCount: "Prepared draft body.".length,
    });
    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(output);
    const prepareChapterFileSet = vi.spyOn(WriterAgent.prototype, "prepareChapterFileSet")
      .mockResolvedValue({
        chapterFileName: "0001_prepared-draft.md",
        writes: [
          { relativePath: join("chapters", "0001_prepared-draft.md"), content: "prepared chapter" },
          { relativePath: join("story", "current_state.md"), content: "prepared truth" },
          { relativePath: join("story", "pending_hooks.md"), content: "prepared hooks" },
          { relativePath: join("story", "state", "manifest.json"), content: "prepared manifest" },
        ],
        deletes: [],
      });
    const saveChapter = vi.spyOn(WriterAgent.prototype, "saveChapter");
    const saveChapterIndex = vi.spyOn(StateManager.prototype, "saveChapterIndex");
    const syncLegacyStructuredStateFromMarkdown = vi.fn(async () => undefined);
    let canonicalCommitCompleted = false;
    const originalCommitAtomicFileSet = atomicFileSetModule.commitAtomicFileSet;
    const commitAtomicFileSet = vi.spyOn(atomicFileSetModule, "commitAtomicFileSet")
      .mockImplementation(async (input) => {
        await originalCommitAtomicFileSet(input);
        if (input.writes.some((write) => write.relativePath === join("chapters", "index.json"))) {
          canonicalCommitCompleted = true;
        }
      });
    const markBookActiveIfNeeded = vi.fn(async () => {
      expect(canonicalCommitCompleted).toBe(true);
    });
    const syncNarrativeMemoryIndex = vi.fn(async () => {
      expect(canonicalCommitCompleted).toBe(true);
    });
    const syncCurrentStateFactHistory = vi.fn(async () => {
      expect(canonicalCommitCompleted).toBe(true);
    });
    const emitWebhook = vi.fn(async () => {
      expect(canonicalCommitCompleted).toBe(true);
    });
    Object.assign(runner as object, {
      syncLegacyStructuredStateFromMarkdown,
      markBookActiveIfNeeded,
      syncNarrativeMemoryIndex,
      syncCurrentStateFactHistory,
      emitWebhook,
    });
    const snapshotState = vi.spyOn(StateManager.prototype, "snapshotState")
      .mockImplementation(async () => {
        expect(canonicalCommitCompleted).toBe(true);
      });

    try {
      const result = await runner.writeDraft(bookId);
      const committedInput = commitAtomicFileSet.mock.calls[0]?.[0];
      const committedIndex = JSON.parse(
        await readFile(join(bookDir, "chapters", "index.json"), "utf-8"),
      ) as ChapterMeta[];

      expect(prepareChapterFileSet).toHaveBeenCalledTimes(1);
      expect(commitAtomicFileSet).toHaveBeenCalledTimes(1);
      expect(committedInput?.writes.map((write) => write.relativePath)).toEqual(
        expect.arrayContaining([
          join("chapters", "0001_prepared-draft.md"),
          join("story", "current_state.md"),
          join("story", "pending_hooks.md"),
          join("story", "state", "manifest.json"),
          join("chapters", "index.json"),
        ]),
      );
      expect(result.filePath).toBe(join(bookDir, "chapters", "0001_prepared-draft.md"));
      expect(committedIndex[0]?.lengthTelemetry).toMatchObject({
        language: "zh",
        countingMode: "zh_chars",
      });
      expect(saveChapter).not.toHaveBeenCalled();
      expect(saveChapterIndex).not.toHaveBeenCalled();
      expect(syncLegacyStructuredStateFromMarkdown).not.toHaveBeenCalled();
      expect(snapshotState).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("commits writeNext chapter artifacts and index once before derived work", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const bookDir = state.bookDir(bookId);
    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({ content: "Canonical next chapter." }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({ passed: true, issues: [] }),
    );
    const prepareChapterFileSet = vi.spyOn(WriterAgent.prototype, "prepareChapterFileSet")
      .mockResolvedValue({
        chapterFileName: "0001_canonical-next.md",
        writes: [
          { relativePath: join("chapters", "0001_canonical-next.md"), content: "prepared chapter" },
          { relativePath: join("story", "current_state.md"), content: "prepared truth" },
          { relativePath: join("story", "state", "manifest.json"), content: "prepared manifest" },
        ],
        deletes: [],
      });
    const saveChapter = vi.spyOn(WriterAgent.prototype, "saveChapter");
    const saveChapterIndex = vi.spyOn(StateManager.prototype, "saveChapterIndex");
    const syncLegacyStructuredStateFromMarkdown = vi.fn(async () => undefined);
    let canonicalCommitCompleted = false;
    const originalCommitAtomicFileSet = atomicFileSetModule.commitAtomicFileSet;
    const commitAtomicFileSet = vi.spyOn(atomicFileSetModule, "commitAtomicFileSet")
      .mockImplementation(async (input) => {
        await originalCommitAtomicFileSet(input);
        if (input.writes.some((write) => write.relativePath === join("chapters", "index.json"))) {
          canonicalCommitCompleted = true;
        }
      });
    const assertAfterCommit = vi.fn(async () => {
      expect(canonicalCommitCompleted).toBe(true);
    });
    Object.assign(runner as object, {
      syncLegacyStructuredStateFromMarkdown,
      markBookActiveIfNeeded: assertAfterCommit,
      persistAuditDriftGuidance: assertAfterCommit,
      syncNarrativeMemoryIndex: assertAfterCommit,
      syncCurrentStateFactHistory: assertAfterCommit,
      emitWebhook: assertAfterCommit,
    });
    vi.spyOn(StateManager.prototype, "snapshotState").mockImplementation(assertAfterCommit);

    try {
      await runner.writeNextChapter(bookId);
      const canonicalCommits = commitAtomicFileSet.mock.calls
        .map(([input]) => input)
        .filter((input) => input.writes.some(
          (write) => write.relativePath === join("chapters", "index.json"),
        ));
      const committedPaths = canonicalCommits[0]?.writes.map((write) => write.relativePath);

      expect(prepareChapterFileSet).toHaveBeenCalledTimes(1);
      expect(canonicalCommits).toHaveLength(1);
      expect(committedPaths).toEqual(expect.arrayContaining([
        join("chapters", "0001_canonical-next.md"),
        join("story", "current_state.md"),
        join("story", "state", "manifest.json"),
        join("chapters", "index.json"),
      ]));
      expect(saveChapter).not.toHaveBeenCalled();
      expect(saveChapterIndex).not.toHaveBeenCalled();
      expect(syncLegacyStructuredStateFromMarkdown).not.toHaveBeenCalled();
      await expect(readFile(join(bookDir, "chapters", "index.json"), "utf-8"))
        .resolves.toContain('"language": "zh"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("keeps canonical draft files when a derived step fails", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const bookDir = state.bookDir(bookId);
    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({ title: "Durable Draft", content: "Durable draft body." }),
    );
    vi.spyOn(StateManager.prototype, "snapshotState").mockRejectedValue(
      new Error("snapshot unavailable"),
    );

    try {
      const result = await runner.writeDraft(bookId);

      await expect(readFile(result.filePath, "utf-8")).resolves.toContain("Durable draft body.");
      await expect(readFile(join(bookDir, "chapters", "index.json"), "utf-8"))
        .resolves.toContain("Durable Draft");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("rejects a failed canonical draft commit without running derived work", async () => {
    const { root, runner, bookId } = await createRunnerFixture();
    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(createWriterOutput());
    vi.spyOn(atomicFileSetModule, "commitAtomicFileSet").mockRejectedValue(
      new Error("canonical commit failed"),
    );
    const derivedWork = vi.fn(async () => undefined);
    Object.assign(runner as object, {
      markBookActiveIfNeeded: derivedWork,
      syncNarrativeMemoryIndex: derivedWork,
      syncCurrentStateFactHistory: derivedWork,
      emitWebhook: derivedWork,
    });
    const snapshotState = vi.spyOn(StateManager.prototype, "snapshotState");

    try {
      await expect(runner.writeDraft(bookId)).rejects.toThrow("canonical commit failed");
      expect(derivedWork).not.toHaveBeenCalled();
      expect(snapshotState).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("cleans staged files when initBook fails before foundation is complete", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-init-rollback-"));
    const runner = new PipelineRunner({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          thinkingBudget: 0,
        },
      } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
    });

    const now = "2026-03-29T00:00:00.000Z";
    const book: BookConfig = {
      id: "atomic-book",
      title: "Atomic Book",
      platform: "tomato",
      genre: "xuanhuan",
      status: "outlining",
      targetChapters: 12,
      chapterWordCount: 2200,
      createdAt: now,
      updatedAt: now,
    };

    vi.spyOn(ArchitectAgent.prototype, "generateFoundation").mockRejectedValue(
      new Error("missing book_rules section"),
    );

    try {
      await expect(runner.initBook(book)).rejects.toThrow("missing book_rules section");
      await expect(stat(join(root, "books", "atomic-book"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes writeDraft through planner and composer on the governed path", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });

    await Promise.all([
      writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), "# Current Focus\n\nBring focus back to the mentor conflict.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n\n- Why the mentor vanished after the trial.\n", "utf-8"),
    ]);

    const planChapter = vi.spyOn(PlannerAgent.prototype, "planChapter").mockImplementation(async (input) => {
      const runtimeDir = join(input.bookDir, "story", "runtime");
      await mkdir(runtimeDir, { recursive: true });
      const goal = "Ignore the guild chase and bring focus back to mentor conflict.";
      const memo = {
        chapter: input.chapterNumber,
        goal,
        isGoldenOpening: true,
        body: "",
        threadRefs: [] as string[],
      };
      const intentMarkdown = [
        "# Chapter Intent",
        "",
        "## Goal",
        goal,
        "",
        "## Outline Node",
        "Track the merchant guild trail.",
        "",
        "## Must Keep",
        "- Lin Yue still hides the broken oath token.",
        "",
        "## Must Avoid",
        "- none",
        "",
        "## Style Emphasis",
        "- none",
        "",
        "## Conflicts",
        "- outline_vs_request: allow local outline deferral",
        "",
        "## Chapter Brief",
        "- chapterType: confrontation",
        "- isGoldenOpening: true",
        "",
        "### Beat Outline",
        "- opening: Open on the conflict.",
        "",
        "### Hook Plan",
        "- none",
        "",
        "### Props And Setting",
        "- broken oath token",
        "",
      ].join("\n");
      const runtimePath = join(runtimeDir, `chapter-${String(input.chapterNumber).padStart(4, "0")}.intent.md`);
      await writeFile(runtimePath, intentMarkdown, "utf-8");
      return {
        intent: {
          chapter: input.chapterNumber,
          goal,
          outlineNode: "Track the merchant guild trail.",
          mustKeep: ["Lin Yue still hides the broken oath token."],
          mustAvoid: [],
          styleEmphasis: [],
          acceptanceCriteria: [],
          pacingCode: "unknown" as const,
          expectedHookOps: { upsert: [], mention: [], resolve: [], defer: [] },
        },
        memo,
        intentMarkdown,
        plannerInputs: [runtimePath],
        runtimePath,
      };
    });
    const composeChapter = vi.spyOn(ComposerModule, "composeGovernedChapter");
    const writeChapter = vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Governed draft body.",
        wordCount: "Governed draft body.".length,
      }),
    );

    try {
      const chapterContext = "Ignore the guild chase and bring focus back to mentor conflict.";
      await runner.writeDraft(bookId, chapterContext);

      expect(planChapter).toHaveBeenCalledTimes(1);
      expect(composeChapter).toHaveBeenCalledTimes(1);

      const writeInput = writeChapter.mock.calls[0]?.[0];
      expect(writeInput?.externalContext).toBe(chapterContext);
      expect(writeInput?.chapterIntent).toContain("# Chapter Intent");
      expect(writeInput?.chapterMemo).toEqual(expect.objectContaining({
        chapter: 1,
      }));
      expect(writeInput?.contextPackage?.selectedContext.length).toBeGreaterThan(0);

      const runtimeDir = join(state.bookDir(bookId), "story", "runtime");
      await expect(stat(join(runtimeDir, "chapter-0001.intent.md"))).resolves.toBeTruthy();
      await expect(stat(join(runtimeDir, "chapter-0001.context.json"))).resolves.toBeTruthy();
      await expect(stat(join(runtimeDir, "chapter-0001.rule-stack.yaml"))).resolves.toBeTruthy();
      await expect(stat(join(runtimeDir, "chapter-0001.trace.json"))).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses an existing planned intent for draft when no new context is provided on the governed path", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });

    await Promise.all([
      mkdir(join(state.bookDir(bookId), "story", "runtime"), { recursive: true }),
      writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), "# Current Focus\n\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n\n- Why the mentor vanished after the trial.\n", "utf-8"),
      writeFile(
        join(state.bookDir(bookId), "story", "runtime", "chapter-0001.intent.md"),
        [
          "# Chapter Intent",
          "",
          "## Goal",
          "Bring the focus back to the mentor conflict.",
          "",
          "## Outline Node",
          "Track the merchant guild trail.",
          "",
          "## Must Keep",
          "- Lin Yue still hides the broken oath token.",
          "",
          "## Must Avoid",
          "- Do not reveal the mastermind",
          "",
          "## Style Emphasis",
          "- Keep the narrative emotionally close to the mentor conflict.",
          "",
          "## Conflicts",
          "- outline_vs_request: allow local outline deferral",
          "",
          "## Chapter Brief",
          "- chapterType: confrontation",
          "- isGoldenOpening: true",
          "",
          "### Beat Outline",
          "- opening: Open on the conflict.",
          "",
          "### Hook Plan",
          "- none",
          "",
          "### Props And Setting",
          "- broken oath token",
          "",
          "## Pending Hooks Snapshot",
          "- none",
          "",
          "## Chapter Summaries Snapshot",
          "- none",
          "",
        ].join("\n"),
        "utf-8",
      ),
    ]);

    const planChapter = vi.spyOn(PlannerAgent.prototype, "planChapter");
    const writeChapter = vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Governed draft body.",
        wordCount: "Governed draft body.".length,
      }),
    );

    try {
      await runner.writeDraft(bookId);

      expect(planChapter).toHaveBeenCalledTimes(0);
      const writeInput = writeChapter.mock.calls[0]?.[0];
      expect(writeInput?.chapterIntent).toBeDefined();
      expect(writeInput?.chapterIntent).toContain("Bring the focus back to the mentor conflict.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  sqliteIt("syncs current-state facts into memory.db after drafting a chapter", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const chapterOneState = createStateCard({
      chapter: 1,
      location: "Ashen ferry crossing",
      protagonistState: "Lin Yue hides the broken oath token.",
      goal: "Find the vanished mentor before dawn.",
      conflict: "Mentor debt blocks every choice.",
    });

    await Promise.all([
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(
        join(state.bookDir(bookId), "story", "current_state.md"),
        createStateCard({
          chapter: 0,
          location: "Shrine outskirts",
          protagonistState: "Lin Yue begins with the oath token hidden.",
          goal: "Reach the trial city.",
          conflict: "The trial deadline is closing in.",
        }),
        "utf-8",
      ),
    ]);
    await state.snapshotState(bookId, 0);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Draft body.",
        wordCount: "Draft body.".length,
        updatedState: chapterOneState,
        updatedHooks: [
          "# Pending Hooks",
          "",
          "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| mentor-debt | 1 | relationship | open | 1 | 6 | The mentor debt remains unresolved |",
          "",
        ].join("\n"),
        chapterSummary: [
          "| 1 | Ferry Debt | Lin Yue | Lin Yue crosses the ferry and recommits to the mentor trail | The debt hardens into the core conflict | mentor-debt advanced | tense | mainline |",
        ].join("\n"),
        runtimeStateDelta: {
          chapter: 1,
          hookOps: { upsert: [], mention: [], resolve: [], defer: [] },
          newHookCandidates: [],
          subplotOps: [],
          emotionalArcOps: [],
          characterMatrixOps: [],
          notes: [],
        },
        runtimeStateSnapshot: {
          manifest: {
            schemaVersion: 2,
            language: "zh",
            lastAppliedChapter: 1,
            projectionVersion: 1,
            migrationWarnings: [],
          },
          currentState: {
            chapter: 1,
            facts: [{
              subject: "protagonist",
              predicate: "Current Conflict",
              object: "Mentor debt blocks every choice.",
              validFromChapter: 1,
              validUntilChapter: null,
              sourceChapter: 1,
            }],
          },
          hooks: {
            hooks: [{
              hookId: "mentor-debt",
              startChapter: 1,
              type: "relationship",
              status: "open",
              lastAdvancedChapter: 1,
              expectedPayoff: "6",
              notes: "The mentor debt remains unresolved",
            }],
          },
          chapterSummaries: {
            rows: [{
              chapter: 1,
              title: "Ferry Debt",
              characters: "Lin Yue",
              events: "Lin Yue crosses the ferry and recommits to the mentor trail",
              stateChanges: "The debt hardens into the core conflict",
              hookActivity: "mentor-debt advanced",
              mood: "tense",
              chapterType: "mainline",
            }],
          },
        },
      }),
    );

    try {
      await runner.writeDraft(bookId);

      const memoryDb = new MemoryDB(state.bookDir(bookId));
      try {
        expect(memoryDb.getCurrentFacts()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              predicate: "Current Conflict",
              object: "Mentor debt blocks every choice.",
              validFromChapter: 1,
              sourceChapter: 1,
            }),
          ]),
        );
        expect(memoryDb.getChapterCount()).toBe(1);
        expect(memoryDb.getActiveHooks()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              hookId: "mentor-debt",
              status: "open",
            }),
          ]),
        );
      } finally {
        memoryDb.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  sqliteIt("syncs narrative memory from structured runtime state instead of stale markdown projections", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const stateDir = join(storyDir, "state");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(chaptersDir, "index.json"),
      JSON.stringify([
        { number: 1, title: "Ch1", status: "approved" },
        { number: 2, title: "Ch2", status: "approved" },
        { number: 3, title: "Ch3", status: "approved" },
      ]),
      "utf-8",
    );

    await Promise.all([
      writeFile(
        join(storyDir, "chapter_summaries.md"),
        [
          "| chapter | title | characters | events | stateChanges | hookActivity | mood | chapterType |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          "| 1 | Markdown Summary | Lin Yue | Old markdown event | Old markdown state | markdown-hook advanced | tense | fallback |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        [
          "| hook_id | start_chapter | type | status | last_advanced | expected_payoff | notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| markdown-hook | 1 | mystery | open | 1 | 4 | Old markdown hook |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(join(stateDir, "manifest.json"), JSON.stringify({
        schemaVersion: 2,
        language: "en",
        lastAppliedChapter: 3,
        projectionVersion: 1,
        migrationWarnings: [],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "current_state.json"), JSON.stringify({
        chapter: 3,
        facts: [],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "hooks.json"), JSON.stringify({
        hooks: [
          {
            hookId: "structured-hook",
            startChapter: 2,
            type: "relationship",
            status: "progressing",
            lastAdvancedChapter: 3,
            expectedPayoff: "Reveal the mentor ledger.",
            notes: "Structured hook should win.",
          },
        ],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "chapter_summaries.json"), JSON.stringify({
        rows: [
          {
            chapter: 3,
            title: "Structured Summary",
            characters: "Lin Yue",
            events: "Structured runtime state event.",
            stateChanges: "Structured runtime state shift.",
            hookActivity: "structured-hook advanced",
            mood: "grim",
            chapterType: "mainline",
          },
        ],
      }, null, 2), "utf-8"),
    ]);

    try {
      await (runner as unknown as {
        syncNarrativeMemoryIndex: (targetBookId: string) => Promise<void>;
      }).syncNarrativeMemoryIndex(bookId);

      const memoryDb = new MemoryDB(state.bookDir(bookId));
      try {
        expect(memoryDb.getSummaries(1, 10)).toEqual([
          expect.objectContaining({
            chapter: 3,
            title: "Structured Summary",
            events: "Structured runtime state event.",
          }),
        ]);
        expect(memoryDb.getActiveHooks()).toEqual([
          expect.objectContaining({
            hookId: "structured-hook",
            status: "progressing",
          }),
        ]);
      } finally {
        memoryDb.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  sqliteIt("retries transient sqlite busy errors during narrative memory sync", async () => {
    const { logger, warnings } = createCaptureLogger();
    const { root, runner, state, bookId } = await createRunnerFixture({
      logger,
    });

    await Promise.all([
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(
        join(state.bookDir(bookId), "story", "current_state.md"),
        createStateCard({
          chapter: 0,
          location: "Shrine outskirts",
          protagonistState: "Lin Yue begins with the oath token hidden.",
          goal: "Reach the trial city.",
          conflict: "The trial deadline is closing in.",
        }),
        "utf-8",
      ),
    ]);

    const RealMemoryDB = memoryDbModule.MemoryDB;
    let constructorCalls = 0;
    vi.spyOn(memoryDbModule, "MemoryDB").mockImplementation((...args: ConstructorParameters<typeof memoryDbModule.MemoryDB>) => {
      if (constructorCalls === 1) {
        constructorCalls += 1;
        const error = new Error("database is locked");
        (error as Error & { code?: string }).code = "SQLITE_BUSY";
        throw error;
      }
      constructorCalls += 1;
      return new RealMemoryDB(...args);
    });
    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Draft body.",
        wordCount: "Draft body.".length,
        chapterSummary: "| 1 | Draft summary | Lin Yue | Draft event | Draft shift | hook advanced | tense | transition |",
        updatedHooks: [
          "# Pending Hooks",
          "",
          "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| mentor-debt | 1 | relationship | open | 1 | 3 | Draft hook |",
        ].join("\n"),
        runtimeStateDelta: {
          chapter: 1,
          hookOps: { upsert: [], mention: [], resolve: [], defer: [] },
          newHookCandidates: [],
          subplotOps: [],
          emotionalArcOps: [],
          characterMatrixOps: [],
          notes: [],
        },
        runtimeStateSnapshot: {
          manifest: {
            schemaVersion: 2,
            language: "zh",
            lastAppliedChapter: 1,
            projectionVersion: 1,
            migrationWarnings: [],
          },
          currentState: { chapter: 1, facts: [] },
          hooks: {
            hooks: [{
              hookId: "mentor-debt",
              startChapter: 1,
              type: "relationship",
              status: "open",
              lastAdvancedChapter: 1,
              expectedPayoff: "3",
              notes: "Draft hook",
            }],
          },
          chapterSummaries: {
            rows: [{
              chapter: 1,
              title: "Draft summary",
              characters: "Lin Yue",
              events: "Draft event",
              stateChanges: "Draft shift",
              hookActivity: "hook advanced",
              mood: "tense",
              chapterType: "transition",
            }],
          },
        },
      }),
    );

    try {
      const result = await runner.writeDraft(bookId);

      expect(result.chapterNumber).toBe(1);
      expect(warnings.join("\n")).not.toContain("当前 Node 运行时不支持 SQLite 记忆索引");
      expect(warnings.join("\n")).not.toContain("叙事记忆同步已跳过");

      const memoryDb = new MemoryDB(state.bookDir(bookId));
      try {
        expect(memoryDb.getChapterCount()).toBe(1);
        expect(memoryDb.getActiveHooks()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              hookId: "mentor-debt",
              status: "open",
            }),
          ]),
        );
      } finally {
        memoryDb.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("logs explicit stage messages during book initialization", async () => {
    const { logger, infos } = createCaptureLogger();
    const { root, runner, state, bookId } = await createRunnerFixture({ logger });
    const book = await state.loadBookConfig(bookId);

    vi.spyOn(ArchitectAgent.prototype, "generateFoundation").mockResolvedValue({
      storyBible: "# Story Bible\n",
      volumeOutline: "# Volume Outline\n",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n",
      currentState: createStateCard({
        chapter: 0,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The mentor debt is still personal.",
      }),
      pendingHooks: "# Pending Hooks\n",
    });

    try {
      await runner.initBook(book);

      expect(infos).toEqual(expect.arrayContaining([
        "阶段：保存书籍配置",
        "阶段：生成基础设定",
        "阶段：写入基础设定文件",
        "阶段：初始化控制文档",
        "阶段：创建初始快照",
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks an outlining book as active after drafting the first chapter", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const book = await state.loadBookConfig(bookId);
    await state.saveBookConfig(bookId, { ...book, status: "outlining" });

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Draft body.",
        wordCount: "Draft body.".length,
      }),
    );

    try {
      await runner.writeDraft(bookId);

      const book = await state.loadBookConfig(bookId);
      expect(book.status).toBe("active");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes writeNextChapter through planner and composer on the governed path", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });

    await Promise.all([
      writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), "# Current Focus\n\nBring focus back to the mentor conflict.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n\n- Why the mentor vanished after the trial.\n", "utf-8"),
    ]);

    const originalPlanChapter = PlannerAgent.prototype.planChapter;
    const planChapter = vi.spyOn(PlannerAgent.prototype, "planChapter").mockImplementation(async function (this: PlannerAgent, input) {
      const result = await originalPlanChapter.call(this, input);
      return {
        ...result,
        memo: {
          chapter: input.chapterNumber,
          goal: result.intent.goal,
          isGoldenOpening: true,
          body: "",
          threadRefs: [],
        },
      };
    });
    const composeChapter = vi.spyOn(ComposerModule, "composeGovernedChapter");
    const writeChapter = vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Governed pipeline draft.",
        wordCount: "Governed pipeline draft.".length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(planChapter).toHaveBeenCalledTimes(1);
      expect(composeChapter).toHaveBeenCalledTimes(1);
      const writeInput = writeChapter.mock.calls[0]?.[0];
      expect(writeInput?.chapterIntent).toContain("# Chapter Intent");
      expect(writeInput?.externalContext).toBeUndefined();
      expect(writeInput?.chapterMemo).toEqual(expect.objectContaining({
        chapter: 1,
      }));
      expect(writeInput?.contextPackage?.selectedContext.length).toBeGreaterThan(0);
      const run = JSON.parse(await readFile(
        join(state.bookDir(bookId), "story", "runtime", "chapter-0001.run.json"),
        "utf-8",
      ));
      expect(run).toMatchObject({
        kind: "long-fiction",
        status: "needs-review",
        stage: "chapter-1",
        skillIds: ["inkos-long-writing"],
      });
      expect(run.artifacts).toEqual(expect.arrayContaining([
        expect.stringMatching(/^chapters\/0001_/),
        "chapters/index.json",
        "story/current_state.md",
        "story/pending_hooks.md",
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resumes a terminal canonical chapter by rebuilding projections without model calls or chapter rewrites", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    await state.saveBookConfig(bookId, { ...await state.loadBookConfig(bookId), language: "zh" });
    const bookDir = state.bookDir(bookId);
    const chapterContent = `# 第1章 终局证据\n\n${"稳".repeat(220)}`;
    const contentHash = computeChapterContentHash(chapterContent);
    const operationId = randomUUID();
    const attemptId = randomUUID();
    const chapterPath = join(bookDir, "chapters", "0001_终局证据.md");
    await writeFile(chapterPath, chapterContent, "utf-8");
    const auditRun = productionAuditRun({
      bookId,
      chapterNumber: 1,
      contentHash,
      operationId,
      attemptId,
    });
    const auditPath = await writeProductionAuditRun(bookDir, auditRun);
    const runPath = await writeProductionResumeSnapshot({
      bookDir,
      chapterNumber: 1,
      operationId,
      attemptId,
      contentHash,
    });
    const chapterBefore = await stat(chapterPath);
    const auditBefore = await readFile(join(bookDir, auditPath), "utf-8");
    const planner = vi.spyOn(PlannerAgent.prototype, "planChapter");
    const writer = vi.spyOn(WriterAgent.prototype, "writeChapter");
    const auditor = vi.spyOn(ContinuityAuditor.prototype, "auditChapter");

    try {
      const result = await runner.writeNextChapter(bookId, 220);

      expect(result).toMatchObject({
        chapterNumber: 1,
        title: "终局证据",
        status: "ready-for-review",
        revised: false,
        auditResult: {
          decision: "pass",
          passed: true,
          contentHash,
        },
      });
      expect(result.auditResult).not.toHaveProperty("parseFailed");
      expect(planner).not.toHaveBeenCalled();
      expect(writer).not.toHaveBeenCalled();
      expect(auditor).not.toHaveBeenCalled();
      expect(await readFile(chapterPath, "utf-8")).toBe(chapterContent);
      expect((await stat(chapterPath)).mtimeMs).toBe(chapterBefore.mtimeMs);
      expect(await readFile(join(bookDir, auditPath), "utf-8")).toBe(auditBefore);

      const rebuiltIndex = JSON.parse(await readFile(join(bookDir, "chapters", "index.json"), "utf-8"));
      expect(rebuiltIndex[0]).toMatchObject({
        number: 1,
        status: "ready-for-review",
        auditDecision: "pass",
        auditAttemptId: attemptId,
        auditRunPaths: [auditPath],
      });
      const completedRun = JSON.parse(await readFile(runPath, "utf-8"));
      expect(completedRun).toMatchObject({
        status: "complete",
        operationId,
        attemptId,
        phase: "initial",
        contentHash,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves parse-failure provenance when resuming canonical audit evidence", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    await state.saveBookConfig(bookId, { ...await state.loadBookConfig(bookId), language: "zh" });
    const bookDir = state.bookDir(bookId);
    const chapterContent = `# 第1章 解析失败\n\n${"证".repeat(220)}`;
    const contentHash = computeChapterContentHash(chapterContent);
    const operationId = randomUUID();
    const attemptId = randomUUID();
    await writeFile(join(bookDir, "chapters", "0001_解析失败.md"), chapterContent, "utf-8");
    const auditRun = {
      ...productionAuditRun({
        bookId,
        chapterNumber: 1,
        contentHash,
        operationId,
        attemptId,
        decision: "inconclusive",
      }),
      parseFailed: true,
    };
    const auditPath = auditRunRelativePath(auditRun);
    await mkdir(dirname(join(bookDir, auditPath)), { recursive: true });
    await writeFile(join(bookDir, auditPath), JSON.stringify(auditRun, null, 2), "utf-8");
    await writeProductionResumeSnapshot({
      bookDir,
      chapterNumber: 1,
      operationId,
      attemptId,
      contentHash,
    });
    const writer = vi.spyOn(WriterAgent.prototype, "writeChapter");

    try {
      const result = await runner.writeNextChapter(bookId, 220);

      expect(result.auditResult).toMatchObject({
        decision: "inconclusive",
        passed: false,
        parseFailed: true,
        contentHash,
      });
      expect(writer).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses production audit identity when resuming before canonical commit", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const bookDir = state.bookDir(bookId);
    const operationId = randomUUID();
    const attemptId = randomUUID();
    const runPath = await writeProductionResumeSnapshot({
      bookDir,
      chapterNumber: 1,
      operationId,
      attemptId,
      status: "failed",
    });
    const content = "续".repeat(220);
    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(createWriterOutput({
      content,
      wordCount: content.length,
    }));
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(createAuditResult({
      passed: true,
      decision: "pass",
      issues: [],
      overallScore: 95,
    }));

    try {
      const result = await runner.writeNextChapter(bookId, 220);
      const contentHash = computeChapterContentHash(content);
      const auditPath = join(
        bookDir,
        "story",
        "audit",
        "runs",
        "chapter-0001",
        `${attemptId}.initial.audit-run-v1.json`,
      );
      const auditRun = JSON.parse(await readFile(auditPath, "utf-8"));
      const completedRun = JSON.parse(await readFile(runPath, "utf-8"));

      expect(result.chapterNumber).toBe(1);
      expect(auditRun).toMatchObject({ operationId, attemptId, phase: "initial", contentHash });
      expect(completedRun).toMatchObject({ operationId, attemptId, phase: "initial", contentHash });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails preflight when a resumed attempt and phase point at a different audit hash", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const bookDir = state.bookDir(bookId);
    const operationId = randomUUID();
    const attemptId = randomUUID();
    await writeProductionResumeSnapshot({
      bookDir,
      chapterNumber: 1,
      operationId,
      attemptId,
      contentHash: "a".repeat(64),
    });
    await writeProductionAuditRun(bookDir, productionAuditRun({
      bookId,
      chapterNumber: 1,
      operationId,
      attemptId,
      contentHash: "b".repeat(64),
    }));
    const writer = vi.spyOn(WriterAgent.prototype, "writeChapter");

    try {
      await expect(runner.writeNextChapter(bookId, 220)).rejects.toMatchObject({
        code: "STATE_PREFLIGHT_FAILED",
      });
      expect(writer).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["missing-audit-artifact", "audit-without-canonical-chapter"])(
    "fails before model work when a hashed resume has %s",
    async (scenario) => {
      const { root, runner, state, bookId } = await createRunnerFixture();
      const bookDir = state.bookDir(bookId);
      const operationId = randomUUID();
      const attemptId = randomUUID();
      const contentHash = "a".repeat(64);
      const runPath = await writeProductionResumeSnapshot({
        bookDir,
        chapterNumber: 1,
        operationId,
        attemptId,
        contentHash,
      });
      if (scenario === "audit-without-canonical-chapter") {
        await writeProductionAuditRun(bookDir, productionAuditRun({
          bookId,
          chapterNumber: 1,
          operationId,
          attemptId,
          contentHash,
        }));
      }
      const snapshotBefore = await readFile(runPath, "utf-8");
      const planner = vi.spyOn(PlannerAgent.prototype, "planChapter");
      const writer = vi.spyOn(WriterAgent.prototype, "writeChapter");
      const auditor = vi.spyOn(ContinuityAuditor.prototype, "auditChapter");

      try {
        await expect(runner.writeNextChapter(bookId, 220)).rejects.toMatchObject({
          code: "STATE_PREFLIGHT_FAILED",
        });
        expect(planner).not.toHaveBeenCalled();
        expect(writer).not.toHaveBeenCalled();
        expect(auditor).not.toHaveBeenCalled();
        expect(await readFile(runPath, "utf-8")).toBe(snapshotBefore);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["book", (run: AuditRunV1) => ({ ...run, bookId: "copied-book" })],
    ["chapter", (run: AuditRunV1) => ({ ...run, chapterNumber: 2 })],
    ["operation", (run: AuditRunV1) => ({ ...run, operationId: randomUUID() })],
    ["attempt", (run: AuditRunV1) => ({ ...run, attemptId: randomUUID() })],
    ["phase/path", (run: AuditRunV1) => ({ ...run, phase: "manual" as const })],
  ])("binds resumed %s identity to the canonical audit path before model work", async (_label, mutate) => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const bookDir = state.bookDir(bookId);
    const operationId = randomUUID();
    const attemptId = randomUUID();
    const contentHash = "a".repeat(64);
    const runPath = await writeProductionResumeSnapshot({
      bookDir,
      chapterNumber: 1,
      operationId,
      attemptId,
      contentHash,
    });
    const expectedAuditPath = auditRunRelativePath({ chapterNumber: 1, attemptId, phase: "initial" });
    await mkdir(dirname(join(bookDir, expectedAuditPath)), { recursive: true });
    const conflicting = mutate(productionAuditRun({
      bookId,
      chapterNumber: 1,
      operationId,
      attemptId,
      contentHash,
    }));
    await writeFile(join(bookDir, expectedAuditPath), serializeAuditRun(conflicting), "utf-8");
    const snapshotBefore = await readFile(runPath, "utf-8");
    const planner = vi.spyOn(PlannerAgent.prototype, "planChapter");
    const writer = vi.spyOn(WriterAgent.prototype, "writeChapter");
    const auditor = vi.spyOn(ContinuityAuditor.prototype, "auditChapter");

    try {
      await expect(runner.writeNextChapter(bookId, 220)).rejects.toMatchObject({
        code: "STATE_PREFLIGHT_FAILED",
      });
      expect(planner).not.toHaveBeenCalled();
      expect(writer).not.toHaveBeenCalled();
      expect(auditor).not.toHaveBeenCalled();
      expect(await readFile(runPath, "utf-8")).toBe(snapshotBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a linked accepted post-revision run from an initial resumable identity", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    await state.saveBookConfig(bookId, { ...await state.loadBookConfig(bookId), language: "zh" });
    const bookDir = state.bookDir(bookId);
    const chapterContent = `# 第1章 修订终局\n\n${"新".repeat(220)}`;
    const canonicalHash = computeChapterContentHash(chapterContent);
    const initialHash = "a".repeat(64);
    const operationId = randomUUID();
    const attemptId = randomUUID();
    await writeFile(join(bookDir, "chapters", "0001_修订终局.md"), chapterContent, "utf-8");
    const initialRun = {
      ...productionAuditRun({
        bookId,
        chapterNumber: 1,
        contentHash: initialHash,
        operationId,
        attemptId,
      }),
      canonicalCommitOutcome: "superseded" as const,
      revision: {
        attempted: true,
        candidateProduced: true,
        candidateContentHash: canonicalHash,
        candidateWordCount: 220,
        accepted: true,
      },
    };
    const postRun = {
      ...productionAuditRun({
        bookId,
        chapterNumber: 1,
        contentHash: canonicalHash,
        operationId,
        attemptId,
        phase: "post-revision",
      }),
      canonicalCommitOutcome: "terminal-commit" as const,
      revision: {
        attempted: true,
        candidateProduced: true,
        candidateContentHash: canonicalHash,
        candidateWordCount: 220,
        accepted: true,
      },
    };
    await writeProductionAuditRun(bookDir, initialRun);
    await writeProductionAuditRun(bookDir, postRun);
    await writeProductionResumeSnapshot({
      bookDir,
      chapterNumber: 1,
      operationId,
      attemptId,
      phase: "initial",
      contentHash: initialHash,
    });
    const writer = vi.spyOn(WriterAgent.prototype, "writeChapter");

    try {
      await expect(runner.writeNextChapter(bookId, 220)).resolves.toMatchObject({
        chapterNumber: 1,
        revised: true,
        auditResult: { decision: "pass", contentHash: canonicalHash },
      });
      expect(writer).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails safe instead of accepting resume identity from a copied production snapshot", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const bookDir = state.bookDir(bookId);
    const chapterContent = `# 第1章 复制快照\n\n${"稳".repeat(220)}`;
    const contentHash = computeChapterContentHash(chapterContent);
    const operationId = randomUUID();
    const attemptId = randomUUID();
    await writeFile(join(bookDir, "chapters", "0001_复制快照.md"), chapterContent, "utf-8");
    await writeProductionAuditRun(bookDir, productionAuditRun({
      bookId,
      chapterNumber: 1,
      contentHash,
      operationId,
      attemptId,
    }));
    await writeProductionResumeSnapshot({
      bookDir,
      chapterNumber: 1,
      operationId,
      attemptId,
      contentHash,
      snapshotId: "copied-book:chapter-0001",
    });
    const writer = vi.spyOn(WriterAgent.prototype, "writeChapter");

    try {
      await expect(runner.writeNextChapter(bookId, 220)).rejects.toMatchObject({
        code: "STATE_PREFLIGHT_FAILED",
      });
      expect(writer).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["malformed JSON", "{not-json"],
    ["invalid version", JSON.stringify({
      version: 2,
      kind: "long-fiction",
      id: "test-book:chapter-0001",
      status: "running",
      stage: "chapter-1",
      resumeCursor: "1",
      operationId: randomUUID(),
      attemptId: randomUUID(),
      phase: "initial",
    })],
    ["invalid kind", JSON.stringify({
      version: 1,
      kind: "short-fiction",
      id: "test-book:chapter-0001",
      status: "running",
      stage: "chapter-1",
      resumeCursor: "1",
      operationId: randomUUID(),
      attemptId: randomUUID(),
      phase: "initial",
    })],
    ["invalid resumable status", JSON.stringify({
      version: 1,
      kind: "long-fiction",
      id: "test-book:chapter-0001",
      status: "paused",
      stage: "chapter-1",
      resumeCursor: "1",
      operationId: randomUUID(),
      attemptId: randomUUID(),
      phase: "initial",
    })],
    ["invalid terminal identity", JSON.stringify({
      version: 1,
      kind: "long-fiction",
      id: "test-book:chapter-0001",
      status: "complete",
      stage: "chapter-1",
      resumeCursor: "1",
      operationId: "invalid",
      attemptId: randomUUID(),
      phase: "initial",
      contentHash: "not-a-hash",
    })],
    ["invalid UUID", JSON.stringify({
      version: 1,
      kind: "long-fiction",
      id: "test-book:chapter-0001",
      status: "running",
      stage: "chapter-1",
      artifacts: [],
      observations: [],
      resumeCursor: "1",
      operationId: "not-a-uuid",
      attemptId: randomUUID(),
      phase: "initial",
    })],
    ["invalid phase and hash", JSON.stringify({
      version: 1,
      kind: "long-fiction",
      id: "test-book:chapter-0001",
      status: "failed",
      stage: "chapter-1",
      artifacts: [],
      observations: [],
      resumeCursor: "1",
      operationId: randomUUID(),
      attemptId: randomUUID(),
      phase: "afterwards",
      contentHash: "not-a-hash",
    })],
    ["stage/cursor conflict", JSON.stringify({
      version: 1,
      kind: "long-fiction",
      id: "test-book:chapter-0001",
      status: "running",
      stage: "chapter-2",
      artifacts: [],
      observations: [],
      resumeCursor: "2",
      operationId: randomUUID(),
      attemptId: randomUUID(),
      phase: "initial",
    })],
    ["wrong book plus invalid identity", JSON.stringify({
      version: 1,
      kind: "long-fiction",
      id: "copied-book:chapter-0001",
      status: "failed",
      stage: "chapter-1",
      artifacts: [],
      observations: [],
      resumeCursor: "1",
      operationId: "invalid",
      attemptId: "invalid",
      phase: "initial",
    })],
  ])("fails closed before model work and preserves a potentially resumable snapshot with %s", async (_label, raw) => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const runPath = await writeRawProductionSnapshot(state.bookDir(bookId), 1, raw);
    const snapshotBefore = await readFile(runPath, "utf-8");
    const planner = vi.spyOn(PlannerAgent.prototype, "planChapter");
    const writer = vi.spyOn(WriterAgent.prototype, "writeChapter");
    const auditor = vi.spyOn(ContinuityAuditor.prototype, "auditChapter");

    try {
      await expect(runner.writeNextChapter(bookId, 220)).rejects.toMatchObject({
        code: "STATE_PREFLIGHT_FAILED",
      });
      expect(planner).not.toHaveBeenCalled();
      expect(writer).not.toHaveBeenCalled();
      expect(auditor).not.toHaveBeenCalled();
      expect(await readFile(runPath, "utf-8")).toBe(snapshotBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["complete", "needs-review", "cancelled"] as const)(
    "treats a valid %s production snapshot as terminal rather than resumable",
    async (status) => {
      const { root, runner, state, bookId } = await createRunnerFixture();
      const bookDir = state.bookDir(bookId);
      await writeProductionResumeSnapshot({
        bookDir,
        chapterNumber: 1,
        operationId: randomUUID(),
        attemptId: randomUUID(),
        status,
      });

      try {
        const loaded = await (runner as unknown as {
          loadResumableProductionRun(path: string, expectedBookId: string): Promise<unknown>;
        }).loadResumableProductionRun(bookDir, bookId);
        expect(loaded).toBeUndefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects semantic audit-run conflicts before index commit and allows an exact duplicate", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const bookDir = state.bookDir(bookId);
    const existing = productionAuditRun({
      bookId,
      chapterNumber: 1,
      contentHash: "a".repeat(64),
    });
    const auditPath = await writeProductionAuditRun(bookDir, existing);
    const indexPath = join(bookDir, "chapters", "index.json");
    await writeFile(indexPath, "[]", "utf-8");
    const indexBefore = await readFile(indexPath, "utf-8");
    const commit = (runner as unknown as {
      commitCanonicalChapterFileSet(
        path: string,
        fileSet: { writes: ReadonlyArray<AtomicFileWrite>; deletes: ReadonlyArray<string> },
        index: ReadonlyArray<ChapterMeta>,
      ): Promise<void>;
    }).commitCanonicalChapterFileSet.bind(runner);
    const updatedIndex: ChapterMeta[] = [{
      number: 1,
      title: "Conflict",
      status: "audit-failed",
      wordCount: 220,
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }];

    try {
      const conflict = { ...existing, decision: "fail" as const, passed: false };
      await expect(commit(bookDir, { writes: [createAuditRunWrite(conflict)], deletes: [] }, updatedIndex))
        .rejects.toMatchObject({ code: "STATE_PREFLIGHT_FAILED" });
      expect(await readFile(indexPath, "utf-8")).toBe(indexBefore);
      expect(await readFile(join(bookDir, auditPath), "utf-8")).toBe(serializeAuditRun(existing));

      await expect(commit(bookDir, { writes: [createAuditRunWrite(existing)], deletes: [] }, updatedIndex))
        .resolves.toBeUndefined();
      expect(JSON.parse(await readFile(indexPath, "utf-8"))).toEqual(updatedIndex);
      expect(await readFile(join(bookDir, auditPath), "utf-8")).toBe(serializeAuditRun(existing));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("warns when resume projection persistence fails after canonical commit", async () => {
    const { logger, warnings } = createCaptureLogger();
    const { root, runner, state, bookId } = await createRunnerFixture({ logger });
    await state.saveBookConfig(bookId, { ...await state.loadBookConfig(bookId), language: "zh" });
    const bookDir = state.bookDir(bookId);
    const chapterContent = `# 第1章 已提交\n\n${"真".repeat(220)}`;
    const contentHash = computeChapterContentHash(chapterContent);
    const operationId = randomUUID();
    const attemptId = randomUUID();
    const chapterPath = join(bookDir, "chapters", "0001_已提交.md");
    await writeFile(chapterPath, chapterContent, "utf-8");
    await writeProductionAuditRun(bookDir, productionAuditRun({
      bookId,
      chapterNumber: 1,
      contentHash,
      operationId,
      attemptId,
    }));
    await writeProductionResumeSnapshot({
      bookDir,
      chapterNumber: 1,
      operationId,
      attemptId,
      contentHash,
    });
    const originalCommit = atomicFileSetModule.commitAtomicFileSet;
    vi.spyOn(atomicFileSetModule, "commitAtomicFileSet").mockImplementation(async (input) => {
      if (input.writes.length === 1 && input.writes[0]?.relativePath === join("chapters", "index.json")) {
        throw new Error("projection disk unavailable");
      }
      await originalCommit(input);
    });

    try {
      await expect(runner.writeNextChapter(bookId, 220)).resolves.toMatchObject({ chapterNumber: 1 });
      expect(await readFile(chapterPath, "utf-8")).toBe(chapterContent);
      await expect(stat(join(bookDir, "chapters", "index.json"))).rejects.toThrow();
      expect(warnings.join("\n")).toMatch(/projection disk unavailable/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an incomplete canonical transaction and stops before model work", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const transactionName = ".inkos-file-txn-preserve";
    await mkdir(join(state.bookDir(bookId), transactionName, "backup"), { recursive: true });
    const writer = vi.spyOn(WriterAgent.prototype, "writeChapter");

    try {
      await expect(runner.writeNextChapter(bookId, 220)).rejects.toMatchObject({
        code: "CANONICAL_TRANSACTION_INCOMPLETE",
      });
      expect(writer).not.toHaveBeenCalled();
      expect(await readdir(state.bookDir(bookId))).toContain(transactionName);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes configured writeNextChapter context through planner and governed writer input", async () => {
    const chapterContext = "本章标题：雨夜账本\n必须围绕账本失窃后的当面对质展开。";
    const { root, runner, state, bookId } = await createRunnerFixture({
      externalContext: chapterContext,
    });

    await Promise.all([
      writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), "# Current Focus\n\nBring focus back to the mentor conflict.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n\n- Why the mentor vanished after the trial.\n", "utf-8"),
    ]);

    const planChapter = vi.spyOn(PlannerAgent.prototype, "planChapter");
    vi.spyOn(ComposerModule, "composeGovernedChapter");
    const writeChapter = vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        title: "雨夜账本",
        content: "Governed pipeline draft.",
        wordCount: "Governed pipeline draft.".length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(planChapter.mock.calls[0]?.[0].externalContext).toBe(chapterContext);
      const writeInput = writeChapter.mock.calls[0]?.[0];
      expect(writeInput?.externalContext).toBe(chapterContext);
      expect(writeInput?.chapterMemo?.goal).toBe(chapterContext);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-plans instead of reusing a persisted invalid intent artifact on the governed path", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const storyDir = join(state.bookDir(bookId), "story");
    const runtimeDir = join(storyDir, "runtime");
    await mkdir(runtimeDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "current_focus.md"), "# Current Focus\n\nBring focus back to the mentor conflict.\n", "utf-8"),
      writeFile(
        join(storyDir, "volume_outline.md"),
        [
          "# Volume Outline",
          "",
          "### Golden First Three Chapters Rule",
          "",
          "**Chapter 1:**",
          "Track the merchant guild trail.",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(join(storyDir, "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n\n- Why the mentor vanished after the trial.\n", "utf-8"),
      writeFile(
        join(runtimeDir, "chapter-0001.intent.md"),
        [
          "# Chapter Intent",
          "",
          "## Goal",
          "**",
          "",
          "## Outline Node",
          "**",
          "",
          "## Must Keep",
          "- none",
          "",
          "## Must Avoid",
          "- none",
          "",
          "## Style Emphasis",
          "- none",
          "",
          "## Conflicts",
          "- none",
          "",
        ].join("\n"),
        "utf-8",
      ),
    ]);

    const planChapter = vi.spyOn(PlannerAgent.prototype, "planChapter").mockImplementation(async (input) => {
      const rDir = join(input.bookDir, "story", "runtime");
      await mkdir(rDir, { recursive: true });
      const goal = "Track the merchant guild trail.";
      const intentMd = [
        "# Chapter Intent",
        "",
        "## Goal",
        goal,
        "",
        "## Outline Node",
        "(not found)",
        "",
        "## Must Keep",
        "- none",
        "",
        "## Must Avoid",
        "- none",
        "",
        "## Style Emphasis",
        "- none",
        "",
        "## Conflicts",
        "- none",
        "",
        "## Chapter Brief",
        "- chapterType: 推进",
        "- isGoldenOpening: false",
        "",
        "### Beat Outline",
        "- opening: test",
        "",
        "### Hook Plan",
        "- none",
        "",
        "### Props And Setting",
        "- none",
        "",
      ].join("\n");
      const runtimePath = join(rDir, `chapter-${String(input.chapterNumber).padStart(4, "0")}.intent.md`);
      await writeFile(runtimePath, intentMd, "utf-8");
      return {
        intent: {
          chapter: input.chapterNumber,
          goal,
          mustKeep: [],
          mustAvoid: [],
          styleEmphasis: [],
          acceptanceCriteria: [],
          pacingCode: "unknown" as const,
          expectedHookOps: { upsert: [], mention: [], resolve: [], defer: [] },
        },
        memo: {
          chapter: input.chapterNumber,
          goal,
          isGoldenOpening: false,
          body: "",
          threadRefs: [],
        },
        intentMarkdown: intentMd,
        plannerInputs: [runtimePath],
        runtimePath,
      };
    });
    const writeChapter = vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Governed pipeline draft.",
        wordCount: "Governed pipeline draft.".length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(planChapter).toHaveBeenCalledTimes(1);
      const writeInput = writeChapter.mock.calls[0]?.[0];
      expect(writeInput?.chapterIntent).toContain("Track the merchant guild trail.");
      expect(writeInput?.chapterIntent).not.toContain("\n**\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("logs explicit stage messages during writeNextChapter", async () => {
    const { logger, infos } = createCaptureLogger();
    const { root, runner, state, bookId } = await createRunnerFixture({
      logger,
    });

    await Promise.all([
      writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), "# Current Focus\n\nBring focus back to the mentor conflict.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n\n- Why the mentor vanished after the trial.\n", "utf-8"),
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Governed pipeline draft.",
        wordCount: "Governed pipeline draft.".length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(infos).toEqual(expect.arrayContaining([
        "阶段：准备章节输入",
        "阶段：撰写章节草稿",
        "阶段：审计草稿",
        "阶段：落盘最终章节",
        "阶段：生成最终真相文件",
        "阶段：校验真相文件变更",
        "阶段：同步记忆索引",
        "阶段：更新章节索引与快照",
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates initial typed truth before the first continuity audit", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const restoreVi = await enableViWriting(root);
    const storedBook = await state.loadBookConfig(bookId);
    const vietnameseBook: BookConfig = {
      ...storedBook,
      language: "vi",
      chapterWordCount: 1150,
    };
    await state.saveBookConfig(bookId, vietnameseBook);
    const initialContent = "từ ".repeat(1150).trim();
    const initialOutput = createSettledRevisionOutput({
      book: vietnameseBook,
      bookDir: state.bookDir(bookId),
      chapterNumber: 1,
      title: "Chương kiểm thử",
      content: initialContent,
    });
    const events: string[] = [];
    vi.spyOn(WriterAgent.prototype, "writeChapter").mockImplementation(async () => {
      events.push("writer-draft");
      return initialOutput;
    });
    vi.spyOn(StateValidatorAgent.prototype, "validate").mockImplementation(async () => {
      events.push("initial-truth-validation");
      return { passed: true, repairRequired: false, warnings: [] };
    });
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockImplementation(async () => {
      events.push("initial-audit");
      return createAuditResult({ passed: true, decision: "pass", overallScore: 95 });
    });

    try {
      const result = await runner.writeNextChapter(bookId, 1150);

      expect(result.status).toBe("ready-for-review");
      expect(events.slice(0, 3)).toEqual([
        "writer-draft",
        "initial-truth-validation",
        "initial-audit",
      ]);
      expect(events.filter((event) => event === "initial-truth-validation")).toHaveLength(1);
    } finally {
      restoreVi();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses initial typed settlement for an exact Vietnamese spelling patch", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const restoreVi = await enableViWriting(root);
    const storedBook = await state.loadBookConfig(bookId);
    const vietnameseBook: BookConfig = {
      ...storedBook,
      language: "vi",
      chapterWordCount: 1150,
    };
    await state.saveBookConfig(bookId, vietnameseBook);
    const originalContent = `${"từ ".repeat(1148)}lầy bơi`;
    const patchedContent = `${"từ ".repeat(1148)}bãi bùn đất lầy lội`;
    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createSettledRevisionOutput({
        book: vietnameseBook,
        bookDir: state.bookDir(bookId),
        chapterNumber: 1,
        title: "Bãi bùn",
        content: originalContent,
      }),
    );
    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        overallScore: 95,
        issues: [{
          severity: "info",
          category: "Lỗi chính tả",
          description: "Cụm lầy bơi bị sai.",
          suggestion: "Thay bằng bãi bùn đất lầy lội.",
          repairScope: "local",
          repairHint: {
            kind: "exact-replacement",
            targetText: "lầy bơi",
            replacementText: "bãi bùn đất lầy lội",
            occurrenceIndexes: [1],
            context: "lầy bơi",
          },
        }],
      }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, overallScore: 96, issues: [] }));
    const settleChapterState = vi.mocked(WriterAgent.prototype.settleChapterState);
    const reviseChapter = vi.mocked(ReviserAgent.prototype.reviseChapter);
    settleChapterState.mockClear();
    reviseChapter.mockClear();

    try {
      const result = await runner.writeNextChapter(bookId, 1150);
      const chapterPath = join(state.bookDir(bookId), "chapters", "0001_Bãi_bùn.md");

      expect(result.status).toBe("ready-for-review");
      expect(result.localRepair).toMatchObject({ applied: true, patchCount: 1 });
      expect(result.providerCallTelemetry).toEqual({
        total: 0,
        byStage: {},
        transportRetries: 0,
        outputRetries: 0,
      });
      expect(settleChapterState).not.toHaveBeenCalled();
      expect(reviseChapter).not.toHaveBeenCalled();
      expect(auditChapter).toHaveBeenCalledTimes(2);
      await expect(readFile(chapterPath, "utf-8")).resolves.toContain(patchedContent);
    } finally {
      restoreVi();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("logs English stage messages during writeNextChapter for English books", async () => {
    const { logger, infos } = createCaptureLogger();
    const { root, runner, state, bookId } = await createRunnerFixture({
      logger,
    });
    const englishBook = {
      ...(await state.loadBookConfig(bookId)),
      genre: "other",
      language: "en" as const,
      chapterWordCount: 220,
    };

    await state.saveBookConfig(bookId, englishBook);
    await Promise.all([
      writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), "# Current Focus\n\nBring focus back to the mentor conflict.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n\n- Why the mentor vanished after the trial.\n", "utf-8"),
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Governed pipeline draft.",
        wordCount: countChapterLength("Governed pipeline draft.", "en_words"),
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(infos).toEqual(expect.arrayContaining([
        "Stage: preparing chapter inputs",
        "Stage: writing chapter draft",
        "Stage: auditing draft",
        "Stage: persisting final chapter",
        "Stage: rebuilding final truth files",
        "Stage: validating truth file updates",
        "Stage: syncing memory indexes",
        "Stage: updating chapter index and snapshots",
      ]));
      expect(infos.join("\n")).not.toContain("阶段：");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes English audit drift guidance into a dedicated file without polluting current_state", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const englishBook = {
      ...(await state.loadBookConfig(bookId)),
      genre: "other",
      language: "en" as const,
      chapterWordCount: 220,
    };

    await state.saveBookConfig(bookId, englishBook);
    await Promise.all([
      writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), "# Current Focus\n\nKeep the pressure on the harbor debt.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "current_state.md"), createStateCard({
        chapter: 0,
        location: "Harbor gate",
        protagonistState: "Lin Yue is tracking the vanished mentor.",
        goal: "Reach the sealed berth.",
        conflict: "The harbor debt keeps pulling him sideways.",
      }), "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "story_bible.md"), "# Story Bible\n\n- The harbor seal cannot be forged.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n\n- The vanished mentor still owes a debt.\n", "utf-8"),
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Lin Yue reached the sealed berth before dawn.",
        wordCount: countChapterLength("Lin Yue reached the sealed berth before dawn.", "en_words"),
        updatedState: createStateCard({
          chapter: 1,
          location: "Sealed berth",
          protagonistState: "Lin Yue is winded but focused.",
          goal: "Inspect the berth before the guild arrives.",
          conflict: "The harbor debt is still active.",
        }),
        updatedHooks: "# Pending Hooks\n\n- The vanished mentor still owes a debt.\n",
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [{
          severity: "warning",
          category: "continuity",
          description: "Keep the berth timing precise in the next chapter.",
          suggestion: "Avoid skipping the dawn transition.",
        }],
        summary: "warning only",
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      const driftFile = await readFile(join(state.bookDir(bookId), "story", "audit_drift.md"), "utf-8");
      const currentState = await readFile(join(state.bookDir(bookId), "story", "current_state.md"), "utf-8");
      expect(driftFile).toContain("## Audit Drift Correction");
      expect(driftFile).toContain("> Chapter 1 audit found the following issues");
      expect(driftFile).not.toContain("## 审计纠偏");
      expect(driftFile).not.toContain("下一章写作前参照");
      expect(currentState).not.toContain("Audit Drift Correction");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes reduced control inputs into auditor and reviser on the governed path", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });

    await Promise.all([
      writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), "# Current Focus\n\nBring focus back to the mentor conflict.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n\n- Why the mentor vanished after the trial.\n", "utf-8"),
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Needs governed revision.",
        wordCount: "Needs governed revision.".length,
      }),
    );
    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: false,
        issues: [CRITICAL_ISSUE],
        summary: "needs revision",
      }),
    );
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: "Governed revised content.",
        wordCount: "Governed revised content.".length,
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: "Governed revised content.",
        wordCount: "Governed revised content.".length,
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(auditChapter.mock.calls[0]?.[4]).toMatchObject({
        chapterIntent: expect.stringContaining("# Chapter Intent"),
        contextPackage: expect.objectContaining({
          selectedContext: expect.any(Array),
        }),
        ruleStack: expect.objectContaining({
          activeOverrides: expect.any(Array),
        }),
      });
      expect(reviseChapter.mock.calls[0]?.[6]).toMatchObject({
        chapterIntent: expect.stringContaining("# Chapter Intent"),
        contextPackage: expect.objectContaining({
          selectedContext: expect.any(Array),
        }),
        ruleStack: expect.objectContaining({
          activeOverrides: expect.any(Array),
        }),
        lengthSpec: expect.objectContaining({
          target: 220,
          softMin: 190,
          softMax: 250,
        }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes governed control inputs into final truth rebuild on the governed path", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });

    await Promise.all([
      writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), "# Current Focus\n\nBring focus back to the mentor conflict.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n\n- Why the mentor vanished after the trial.\n", "utf-8"),
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Original draft body.",
        wordCount: "Original draft body.".length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [CRITICAL_ISSUE],
          summary: "needs revision",
          overallScore: 40,
        }),
      )
      .mockResolvedValueOnce(
        createAuditResult({
          passed: true,
          issues: [],
          summary: "clean",
          overallScore: 95,
        }),
      );
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: "治理后的修订正文。".repeat(24),
        wordCount: "治理后的修订正文。".repeat(24).length,
      }),
    );
    const analyzeChapter = vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: "治理后的修订正文。".repeat(24),
        wordCount: "治理后的修订正文。".repeat(24).length,
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(analyzeChapter.mock.calls[0]?.[0]).toMatchObject({
        chapterIntent: expect.stringContaining("# Chapter Intent"),
        contextPackage: expect.objectContaining({
          selectedContext: expect.any(Array),
        }),
        ruleStack: expect.objectContaining({
          activeOverrides: expect.any(Array),
        }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs hard-range drift through the reviser instead of a second whole-chapter normalizer", async () => {
    const { root, runner, bookId } = await createRunnerFixture();
    const overlongDraft = "修订后正文。".repeat(60);
    const normalizedDraft = "归一正文。".repeat(40);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: overlongDraft,
        wordCount: overlongDraft.length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: normalizedDraft,
        wordCount: normalizedDraft.length,
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: normalizedDraft,
        wordCount: normalizedDraft.length,
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(reviseChapter).toHaveBeenCalled();
      expect(reviseChapter.mock.calls[0]?.[3]).toEqual(expect.arrayContaining([
        expect.objectContaining({ category: "length", ruleId: "length.hard-range" }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("audits overlong writer output without silently rewriting it first", async () => {
    const { root, runner, bookId } = await createRunnerFixture();
    const overlongDraft = "冗余句子。".repeat(60);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: overlongDraft,
        wordCount: overlongDraft.length,
      }),
    );
    const auditChapter = vi.spyOn(
      ContinuityAuditor.prototype,
      "auditChapter",
    ).mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: overlongDraft,
        wordCount: overlongDraft.length,
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(auditChapter.mock.calls[0]?.[1]).toBe(overlongDraft);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves minor soft-range drift to the normal audit path", async () => {
    const { root, runner, bookId } = await createRunnerFixture();
    const nearTargetDraft = "近".repeat(260);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: nearTargetDraft,
        wordCount: nearTargetDraft.length,
      }),
    );
    const auditChapter = vi.spyOn(
      ContinuityAuditor.prototype,
      "auditChapter",
    ).mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(auditChapter.mock.calls[0]?.[1]).toBe(nearTargetDraft);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs an undersized draft through a measured length-budget issue", async () => {
    const { root, runner, bookId } = await createRunnerFixture();
    const shortDraft = "短句。".repeat(20);
    const normalizedDraft = "补足后的正文。".repeat(30);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: shortDraft,
        wordCount: shortDraft.length,
      }),
    );
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: normalizedDraft,
        wordCount: normalizedDraft.length,
      }),
    );
    const auditChapter = vi.spyOn(
      ContinuityAuditor.prototype,
      "auditChapter",
    ).mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: normalizedDraft,
        wordCount: normalizedDraft.length,
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(reviseChapter.mock.calls[0]?.[3]).toEqual(expect.arrayContaining([
        expect.objectContaining({ category: "length", ruleId: "length.hard-range" }),
      ]));
      expect(auditChapter.mock.calls[1]?.[1]).toBe(normalizedDraft);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records a length warning when repair still misses the hard range", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const overlongDraft = "冗余句子。".repeat(60);
    const stillOverHard = "仍然过长。".repeat(70);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: overlongDraft,
        wordCount: overlongDraft.length,
      }),
    );
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: stillOverHard,
        wordCount: stillOverHard.length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: stillOverHard,
        wordCount: stillOverHard.length,
      }),
    );

    try {
      const result = await runner.writeNextChapter(bookId, 220);
      const chapterIndex = await state.loadChapterIndex(bookId);
      const chapterMeta = chapterIndex.find((entry) => entry.number === 1);

      expect((result as { lengthWarnings?: ReadonlyArray<string> }).lengthWarnings?.[0]).toContain(
        "未达到篇幅预算",
      );
      expect((result as { lengthTelemetry?: { finalCount: number } }).lengthTelemetry?.finalCount).toBe(
        overlongDraft.length,
      );
      expect(chapterMeta?.lengthWarnings?.[0]).toContain("未达到篇幅预算");
      expect(chapterMeta?.lengthTelemetry?.lengthWarning).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the preferred Vietnamese range for overflow warnings", async () => {
    const { root, runner } = await createRunnerFixture();
    const spec = buildLengthSpec(1150, "vi");

    try {
      const warnings = (runner as unknown as {
        buildLengthWarnings: (
          chapterNumber: number,
          finalCount: number,
          lengthSpec: typeof spec,
          language: "en",
        ) => string[];
      }).buildLengthWarnings(1, 1350, spec, "en");

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("preferred length range");
      expect(warnings[0]).toContain("1100-1300");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the last actionable audit issues when re-audit returns failed with no issues", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const storyDir = join(state.bookDir(bookId), "story");
    const draftBody = "甲".repeat(210);
    const revisedBody = "乙".repeat(215);

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 0,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The mentor debt is still personal.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: draftBody,
        wordCount: draftBody.length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [CRITICAL_ISSUE],
          summary: "needs revision",
          overallScore: 40,
        }),
      )
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [],
          summary: "",
          overallScore: 40,
        }),
      );
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: revisedBody,
        wordCount: revisedBody.length,
        fixedIssues: ["- tightened continuity."],
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: revisedBody,
        wordCount: revisedBody.length,
      }),
    );

    try {
      const result = await runner.writeNextChapter(bookId, 220);
      const savedIndex = await state.loadChapterIndex(bookId);

      expect(result.status).toBe("audit-failed");
      expect(result.auditResult.summary).toBe("needs revision");
      expect(result.auditResult.issues).toEqual([
        expect.objectContaining(CRITICAL_ISSUE),
      ]);
      expect(savedIndex[0]?.auditIssues).toEqual([
        `[critical] ${CRITICAL_ISSUE.description}`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("feeds postWriteErrors into the scoring loop as extra issues", async () => {
    const { root, runner, bookId } = await createRunnerFixture();

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: "Original draft body.",
        wordCount: "Original draft body.".length,
        postWriteErrors: [
          {
            severity: "error",
            rule: "post-write",
            description: "Needs a deterministic fix",
            suggestion: "Repair the line",
          },
        ],
      }),
    );
    // First audit: postWriteErrors make it fail even though LLM says passed
    // Second audit (after repair): clean
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        overallScore: 88,
        issues: [],
        summary: "LLM thinks clean but postWriteErrors will override",
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        overallScore: 92,
        issues: [],
        summary: "clean after fix",
      }));
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter")
      .mockResolvedValueOnce(createReviseOutput({
        revisedContent: "After auto fix.",
        wordCount: "After auto fix.".length,
      }));
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: "After auto fix.",
        wordCount: "After auto fix.".length,
      }),
    );

    await runner.writeNextChapter(bookId);

    // Reviser called via scoring loop (auto mode), not pre-audit spot-fix
    expect(reviseChapter).toHaveBeenCalled();
    expect(reviseChapter.mock.calls[0]?.[4]).toBe("auto");

    await rm(root, { recursive: true, force: true });
  });

  it("runs at most one automatic repair iteration during writeNextChapter", async () => {
    const { root, runner, bookId } = await createRunnerFixture();
    const draftBody = "甲".repeat(300);
    const revisedBody = "乙".repeat(300);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: draftBody,
        wordCount: draftBody.length,
      }),
    );
    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 40,
        issues: [CRITICAL_ISSUE],
        summary: "needs repair",
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 50,
        issues: [CRITICAL_ISSUE],
        summary: "still weak",
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 60,
        issues: [CRITICAL_ISSUE],
        summary: "should not be reached",
      }));
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: revisedBody,
        wordCount: revisedBody.length,
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: revisedBody,
        wordCount: revisedBody.length,
      }),
    );

    try {
      const result = await runner.writeNextChapter(bookId, 220);

      expect(result.status).toBe("audit-failed");
      expect(auditChapter).toHaveBeenCalledTimes(2);
      expect(reviseChapter).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs two automatic repair iterations when writingReviewRetries is 2", async () => {
    const { root, runner, bookId } = await createRunnerFixture({
      writingReviewRetries: 2,
    });
    const draftBody = "甲".repeat(300);
    const revisedBody1 = "乙".repeat(300);
    const revisedBody2 = "丙".repeat(300);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: draftBody,
        wordCount: draftBody.length,
      }),
    );
    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 40,
        issues: [CRITICAL_ISSUE],
        summary: "needs repair",
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 50,
        issues: [CRITICAL_ISSUE],
        summary: "still weak",
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 60,
        issues: [CRITICAL_ISSUE],
        summary: "better but weak",
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 70,
        issues: [CRITICAL_ISSUE],
        summary: "should not be reached",
      }));
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter")
      .mockResolvedValueOnce(
        createReviseOutput({
          revisedContent: revisedBody1,
          wordCount: revisedBody1.length,
        }),
      )
      .mockResolvedValueOnce(
        createReviseOutput({
          revisedContent: revisedBody2,
          wordCount: revisedBody2.length,
        }),
      );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: revisedBody2,
        wordCount: revisedBody2.length,
      }),
    );

    try {
      const result = await runner.writeNextChapter(bookId, 220);

      expect(result.status).toBe("audit-failed");
      expect(auditChapter).toHaveBeenCalledTimes(3);
      expect(reviseChapter).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an auto-revision when candidate state validation fails and records the attempt", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const originalDraft = "原".repeat(80);
    const revisedDraft = "修".repeat(220);
    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({ content: originalDraft, wordCount: originalDraft.length }),
    );
    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({ passed: true, issues: [], summary: "clean", overallScore: 95 }),
    );
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({ revisedContent: revisedDraft, wordCount: revisedDraft.length }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({ content: revisedDraft, wordCount: revisedDraft.length }),
    );
    vi.spyOn(StateValidatorAgent.prototype, "validate")
      .mockResolvedValueOnce({
        passed: false,
        repairRequired: true,
        warnings: [{ category: "state-conflict", description: "candidate state contradicts its body" }],
      })
      .mockResolvedValueOnce({
        passed: false,
        repairRequired: true,
        warnings: [{ category: "state-conflict", description: "candidate recovery still contradicts its body" }],
      })
      .mockResolvedValueOnce({ passed: true, warnings: [] });

    try {
      const result = await runner.writeNextChapter(bookId, 220);
      const chapterPath = join(state.bookDir(bookId), "chapters", "0001_Test_Chapter.md");
      const savedIndex = await state.loadChapterIndex(bookId);

      expect(auditChapter).toHaveBeenCalledTimes(1);
      await expect(readFile(chapterPath, "utf-8")).resolves.toContain(originalDraft);
      await expect(readFile(chapterPath, "utf-8")).resolves.not.toContain(revisedDraft);
      expect(result.status).toBe("audit-failed");
      expect(savedIndex[0]).toMatchObject({
        revisionAttempts: 1,
        revisionOutcome: "rejected",
        revisionRejectionReason: "candidate recovery still contradicts its body",
      });
      const auditRun = JSON.parse(await readFile(
        join(state.bookDir(bookId), savedIndex[0]!.auditRunPaths![0]!),
        "utf-8",
      ));
      expect(auditRun.revision).toMatchObject({
        attempted: true,
        candidateProduced: true,
        candidateContentHash: computeChapterContentHash(revisedDraft),
        candidateWordCount: countChapterLength(revisedDraft, "zh_chars"),
        accepted: false,
        rejectionReason: "candidate recovery still contradicts its body",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs normal final truth validation after a state-valid candidate fails the post-audit gate", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const originalDraft = "原".repeat(80);
    const rejectedCandidate = "修".repeat(220);
    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({ content: originalDraft, wordCount: originalDraft.length }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({ passed: true, issues: [], summary: "initial", overallScore: 95 }))
      .mockResolvedValueOnce(createAuditResult({ passed: false, issues: [], summary: "candidate rejected", overallScore: 80 }));
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({ revisedContent: rejectedCandidate, wordCount: rejectedCandidate.length }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({ content: rejectedCandidate, wordCount: rejectedCandidate.length }),
    );
    const validate = vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({ passed: true, warnings: [] });
    const rerunPromotionPass = vi.spyOn(hookPromotionModule, "rerunPromotionPass");

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(validate).toHaveBeenCalledTimes(2);
      expect(validate.mock.calls[0]?.[0]).toBe(rejectedCandidate);
      expect(validate.mock.calls[1]?.[0]).toBe(originalDraft);
      expect(rerunPromotionPass).toHaveBeenCalledTimes(2);
      await expect(readFile(join(state.bookDir(bookId), "chapters", "0001_Test_Chapter.md"), "utf-8"))
        .resolves.toContain(originalDraft);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("promotes candidate hooks before validation and re-audits the accepted promoted truth", async () => {
    const { root, runner, bookId } = await createRunnerFixture();
    const originalDraft = "原".repeat(80);
    const acceptedCandidate = "修".repeat(220);
    let promotionCompleted = false;
    const actualPromotion = hookPromotionModule.rerunPromotionPass;
    vi.spyOn(hookPromotionModule, "rerunPromotionPass").mockImplementation((...args) => {
      promotionCompleted = true;
      return actualPromotion(...args);
    });
    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({ content: originalDraft, wordCount: originalDraft.length }),
    );
    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({ passed: true, issues: [], summary: "initial", overallScore: 95 }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, issues: [], summary: "accepted", overallScore: 95 }));
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({ revisedContent: acceptedCandidate, wordCount: acceptedCandidate.length }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({ content: acceptedCandidate, wordCount: acceptedCandidate.length }),
    );
    const validate = vi.spyOn(StateValidatorAgent.prototype, "validate").mockImplementation(async () => {
      expect(promotionCompleted).toBe(true);
      return { passed: true, warnings: [] };
    });

    try {
      const result = await runner.writeNextChapter(bookId, 220);

      expect(result.status).toBe("ready-for-review");
      expect(validate).toHaveBeenCalledTimes(1);
      expect(auditChapter.mock.calls[1]?.[4]?.truthFileOverrides).toMatchObject({
        currentState: expect.any(String),
        hooks: expect.any(String),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("promotes an auto recovery output before retry validation, post-audit, and persistence", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const originalDraft = "原".repeat(80);
    const acceptedCandidate = "修".repeat(220);
    const promotedHook = {
      hookId: "H-AUTO",
      startChapter: 1,
      type: "clue",
      status: "open",
      lastAdvancedChapter: 1,
      expectedPayoff: "later",
      notes: "promoted recovery hook",
      promoted: true,
    };
    const promotion = vi.spyOn(hookPromotionModule, "rerunPromotionPass").mockReturnValue({
      updated: true,
      hooks: [promotedHook],
      flippedCount: 1,
    });
    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({ content: originalDraft, wordCount: originalDraft.length }),
    );
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({ revisedContent: acceptedCandidate, wordCount: acceptedCandidate.length }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: acceptedCandidate,
        wordCount: acceptedCandidate.length,
        updatedHooks: "# Pending Hooks\n\n- raw candidate hook",
      }),
    );
    vi.spyOn(WriterAgent.prototype, "settleChapterState").mockImplementation(async (input) =>
      createSettledRevisionOutput(input, {
        content: acceptedCandidate,
        wordCount: acceptedCandidate.length,
        updatedHooks: "# Pending Hooks\n\n- raw recovery hook",
      }));
    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({ passed: true, issues: [], summary: "initial", overallScore: 95 }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, issues: [], summary: "accepted", overallScore: 95 }));
    const validate = vi.spyOn(StateValidatorAgent.prototype, "validate")
      .mockResolvedValueOnce({
        passed: false,
        repairRequired: true,
        warnings: [{ category: "state", description: "retry settlement" }],
      })
      .mockResolvedValueOnce({ passed: true, repairRequired: false, warnings: [] });

    try {
      const result = await runner.writeNextChapter(bookId, 220);
      const retriedPromotedHooks = String(validate.mock.calls[1]?.[5]);

      expect(result.status).toBe("ready-for-review");
      expect(promotion).toHaveBeenCalledTimes(2);
      expect(String(validate.mock.calls[0]?.[5])).toContain("H-AUTO");
      expect(retriedPromotedHooks).toContain("H-AUTO");
      expect(auditChapter.mock.calls[1]?.[4]?.truthFileOverrides?.hooks).toBe(retriedPromotedHooks);
      await expect(readFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "utf-8"))
        .resolves.toBe(retriedPromotedHooks);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still performs the initial audit in manual chapter mode without auto revision", async () => {
    const { root, runner, bookId } = await createRunnerFixture({ chapterReviewMode: "manual" });
    const draftBody = "手动模式仍需先审计。".repeat(24);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({ content: draftBody, wordCount: draftBody.length }),
    );
    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({ passed: false, overallScore: 40, issues: [CRITICAL_ISSUE] }),
    );
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter");

    try {
      const result = await runner.writeNextChapter(bookId, 220);

      expect(auditChapter).toHaveBeenCalledTimes(1);
      expect(reviseChapter).not.toHaveBeenCalled();
      expect(result.status).toBe("audit-failed");
      expect(result.auditResult.decision).toBe("fail");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not run the prose polisher automatically after a passing write", async () => {
    const { root, runner, bookId } = await createRunnerFixture();
    const draftBody = "林".repeat(220);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: draftBody,
        wordCount: draftBody.length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
        overallScore: 90,
      }),
    );
    const polishChapter = vi.spyOn(PolisherAgent.prototype, "polishChapter");

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(polishChapter).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists truth files derived from the final revised chapter", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: "Original draft body.",
        wordCount: "Original draft body.".length,
        updatedState: "original state",
        updatedLedger: "original ledger",
        updatedHooks: "original hooks",
        chapterSummary: "| 1 | Original summary |",
        updatedSubplots: "original subplots",
        updatedEmotionalArcs: "original emotions",
        updatedCharacterMatrix: "original matrix",
        postWriteErrors: [
          {
            severity: "error",
            rule: "post-write",
            description: "Needs a deterministic fix",
            suggestion: "Repair the line",
          },
        ],
      }),
    );
    // First audit: postWriteErrors force passed=false, score 40 triggers loop
    // Second audit: after repair, passes
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        overallScore: 40,
        issues: [],
        summary: "postWriteErrors will override passed",
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        overallScore: 95,
        issues: [],
        summary: "clean after fix",
      }));
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: "最终修订正文。".repeat(24),
        wordCount: "最终修订正文。".repeat(24).length,
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: "最终修订正文。".repeat(24),
        wordCount: "最终修订正文。".repeat(24).length,
        updatedState: "final analyzed state",
        updatedLedger: "final analyzed ledger",
        updatedHooks: "final analyzed hooks",
        chapterSummary: "| 1 | Final analyzed summary |",
        updatedSubplots: "final analyzed subplots",
        updatedEmotionalArcs: "final analyzed emotions",
        updatedCharacterMatrix: "final analyzed matrix",
      }),
    );

    await runner.writeNextChapter(bookId, 220);

    const storyDir = join(state.bookDir(bookId), "story");
    await expect(readFile(join(storyDir, "current_state.md"), "utf-8"))
      .resolves.toContain("final analyzed state");
    await expect(readFile(join(storyDir, "pending_hooks.md"), "utf-8"))
      .resolves.toContain("final analyzed hooks");
    await expect(readFile(join(storyDir, "particle_ledger.md"), "utf-8"))
      .resolves.toContain("final analyzed ledger");
    await expect(readFile(join(storyDir, "chapter_summaries.md"), "utf-8"))
      .resolves.toContain("Final analyzed summary");
    await expect(readFile(join(storyDir, "subplot_board.md"), "utf-8"))
      .resolves.toContain("final analyzed subplots");
    await expect(readFile(join(storyDir, "emotional_arcs.md"), "utf-8"))
      .resolves.toContain("final analyzed emotions");
    await expect(readFile(join(storyDir, "character_matrix.md"), "utf-8"))
      .resolves.toContain("final analyzed matrix");

    await rm(root, { recursive: true, force: true });
  });

  it("persists structured runtime state and rendered projections from writer delta output", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: "Lin Yue follows the debt into the river-port ledger.",
        wordCount: countChapterLength("Lin Yue follows the debt into the river-port ledger.", "en_words"),
        postWriteErrors: [],
        postWriteWarnings: [],
        updatedState: createStateCard({
          chapter: 1,
          location: "River port",
          protagonistState: "Lin Yue studies the guild ledger.",
          goal: "Follow the debt through the river-port ledger.",
          conflict: "Guild pressure keeps pulling against the debt trail.",
        }),
        updatedHooks: [
          "# Pending Hooks",
          "",
          "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| mentor-debt | 1 | relationship | open | 1 | Reveal why the mentor vanished. | The river-port ledger sharpens the debt line. |",
          "",
        ].join("\n"),
        updatedChapterSummaries: [
          "# Chapter Summaries",
          "",
          "| Chapter | Title | Characters | Key Events | State Changes | Hook Activity | Mood | Chapter Type |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          "| 1 | River Ledger | Lin Yue | Lin Yue follows the debt into the river-port ledger. | The debt line sharpens. | mentor-debt advanced | tense | investigation |",
          "",
        ].join("\n"),
        runtimeStateDelta: {
          chapter: 1,
          currentStatePatch: {
            currentGoal: "Follow the debt through the river-port ledger.",
            currentConflict: "Guild pressure keeps pulling against the debt trail.",
          },
          hookOps: {
            upsert: [
              {
                hookId: "mentor-debt",
                startChapter: 1,
                type: "relationship",
                status: "open",
                lastAdvancedChapter: 1,
                expectedPayoff: "Reveal why the mentor vanished.",
                notes: "The river-port ledger sharpens the debt line.",
              },
            ],
            mention: [],
            resolve: [],
            defer: [],
          },
          newHookCandidates: [],
          chapterSummary: {
            chapter: 1,
            title: "River Ledger",
            characters: "Lin Yue",
            events: "Lin Yue follows the debt into the river-port ledger.",
            stateChanges: "The debt line sharpens.",
            hookActivity: "mentor-debt advanced",
            mood: "tense",
            chapterType: "investigation",
          },
          subplotOps: [],
          emotionalArcOps: [],
          characterMatrixOps: [],
          notes: [],
        },
        runtimeStateSnapshot: {
          manifest: {
            schemaVersion: 2,
            language: "zh",
            lastAppliedChapter: 1,
            projectionVersion: 1,
            migrationWarnings: [],
          },
          currentState: {
            chapter: 1,
            facts: [
              {
                subject: "protagonist",
                predicate: "Current Goal",
                object: "Follow the debt through the river-port ledger.",
                validFromChapter: 1,
                validUntilChapter: null,
                sourceChapter: 1,
              },
              {
                subject: "protagonist",
                predicate: "Current Conflict",
                object: "Guild pressure keeps pulling against the debt trail.",
                validFromChapter: 1,
                validUntilChapter: null,
                sourceChapter: 1,
              },
            ],
          },
          hooks: {
            hooks: [{
              hookId: "mentor-debt",
              startChapter: 1,
              type: "relationship",
              status: "open",
              lastAdvancedChapter: 1,
              expectedPayoff: "Reveal why the mentor vanished.",
              notes: "The river-port ledger sharpens the debt line.",
            }],
          },
          chapterSummaries: {
            rows: [{
              chapter: 1,
              title: "River Ledger",
              characters: "Lin Yue",
              events: "Lin Yue follows the debt into the river-port ledger.",
              stateChanges: "The debt line sharpens.",
              hookActivity: "mentor-debt advanced",
              mood: "tense",
              chapterType: "investigation",
            }],
          },
        },
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    await runner.writeNextChapter(bookId);

    const storyDir = join(state.bookDir(bookId), "story");
    const currentState = await readFile(join(storyDir, "current_state.md"), "utf-8");
    const hooks = await readFile(join(storyDir, "pending_hooks.md"), "utf-8");
    const summaries = await readFile(join(storyDir, "chapter_summaries.md"), "utf-8");
    const manifest = JSON.parse(await readFile(join(storyDir, "state", "manifest.json"), "utf-8"));
    const stateCurrent = JSON.parse(await readFile(join(storyDir, "state", "current_state.json"), "utf-8"));
    const stateHooks = JSON.parse(await readFile(join(storyDir, "state", "hooks.json"), "utf-8"));
    const stateSummaries = JSON.parse(await readFile(join(storyDir, "state", "chapter_summaries.json"), "utf-8"));

    expect(currentState).toContain("Follow the debt through the river-port ledger.");
    expect(hooks).toContain("mentor-debt");
    expect(summaries).toContain("River Ledger");
    expect(manifest.lastAppliedChapter).toBe(1);
    expect(stateCurrent.chapter).toBe(1);
    expect(stateHooks.hooks[0]?.hookId).toBe("mentor-debt");
    expect(stateSummaries.rows[0]?.title).toBe("River Ledger");

    await rm(root, { recursive: true, force: true });
  });

  it("persists the chapter number normalized by the writer before canonical commit", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const storyDir = join(state.bookDir(bookId), "story");
    await mkdir(join(storyDir, "state"), { recursive: true });
    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 0,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The mentor debt is still personal.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
      writeFile(join(storyDir, "state", "manifest.json"), JSON.stringify({
        schemaVersion: 2,
        language: "en",
        lastAppliedChapter: 0,
        projectionVersion: 1,
        migrationWarnings: [],
      }, null, 2), "utf-8"),
      writeFile(join(storyDir, "state", "current_state.json"), JSON.stringify({
        chapter: 0,
        facts: [],
      }, null, 2), "utf-8"),
      writeFile(join(storyDir, "state", "hooks.json"), JSON.stringify({
        hooks: [],
      }, null, 2), "utf-8"),
      writeFile(join(storyDir, "state", "chapter_summaries.json"), JSON.stringify({
        rows: [],
      }, null, 2), "utf-8"),
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: "Broken chapter body.",
        wordCount: countChapterLength("Broken chapter body.", "en_words"),
        postWriteErrors: [],
        postWriteWarnings: [],
        runtimeStateDelta: {
          chapter: 1,
          hookOps: {
            upsert: [],
            mention: [],
            resolve: [],
            defer: [],
          },
          newHookCandidates: [],
          subplotOps: [],
          emotionalArcOps: [],
          characterMatrixOps: [],
          notes: [],
        },
        runtimeStateSnapshot: {
          manifest: {
            schemaVersion: 2,
            language: "en",
            lastAppliedChapter: 1,
            projectionVersion: 1,
            migrationWarnings: [],
          },
          currentState: { chapter: 1, facts: [] },
          hooks: { hooks: [] },
          chapterSummaries: { rows: [] },
        },
        updatedState: createStateCard({
          chapter: 1,
          location: "Ashen ferry crossing",
          protagonistState: "Lin Yue still hides the oath token.",
          goal: "Find the vanished mentor.",
          conflict: "The mentor debt is still personal.",
        }),
        updatedHooks: "# Pending Hooks\n",
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    const result = await runner.writeNextChapter(bookId, "Broken chapter body.".length);

    expect(result.status).toBe("ready-for-review");
    await expect(readFile(join(storyDir, "current_state.md"), "utf-8"))
      .resolves.toMatch(/\|\s*(Current Chapter|当前章节)\s*\|\s*1\s*\|/);
    await expect(readFile(join(storyDir, "state", "manifest.json"), "utf-8"))
      .resolves.toContain("\"lastAppliedChapter\": 1");

    await rm(root, { recursive: true, force: true });
  });

  it("keeps canonical runtime state unchanged when writer state preparation rejects", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const storyDir = join(state.bookDir(bookId), "story");
    await mkdir(join(storyDir, "state"), { recursive: true });
    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 0,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The mentor debt is still personal.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
      writeFile(join(storyDir, "state", "manifest.json"), JSON.stringify({
        schemaVersion: 2,
        language: "en",
        lastAppliedChapter: 0,
        projectionVersion: 1,
        migrationWarnings: [],
      }, null, 2), "utf-8"),
      writeFile(join(storyDir, "state", "current_state.json"), JSON.stringify({
        chapter: 0,
        facts: [],
      }, null, 2), "utf-8"),
      writeFile(join(storyDir, "state", "hooks.json"), JSON.stringify({
        hooks: [],
      }, null, 2), "utf-8"),
      writeFile(join(storyDir, "state", "chapter_summaries.json"), JSON.stringify({
        rows: [],
      }, null, 2), "utf-8"),
    ]);

    const beforeState = await readFile(join(storyDir, "current_state.md"), "utf-8");
    const beforeManifest = await readFile(join(storyDir, "state", "manifest.json"), "utf-8");

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: "Broken chapter body.",
        wordCount: countChapterLength("Broken chapter body.", "en_words"),
        postWriteErrors: [],
        postWriteWarnings: [],
      }),
    );
    vi.spyOn(WriterAgent.prototype, "prepareChapterFileSet").mockRejectedValue(
      new Error("Invalid runtime state delta: lastAdvancedChapter must be a number"),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    await expect(runner.writeNextChapter(bookId)).rejects.toThrow("Invalid runtime state delta");

    await expect(readFile(join(storyDir, "current_state.md"), "utf-8")).resolves.toBe(beforeState);
    await expect(readFile(join(storyDir, "state", "manifest.json"), "utf-8")).resolves.toBe(beforeManifest);

    await rm(root, { recursive: true, force: true });
  });

  it("uses typed Vietnamese settlement for an accepted revised chapter", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({});
    const restoreVi = await enableViWriting(root);
    try {
      const storedBook = await state.loadBookConfig(bookId);
      const book: BookConfig = { ...storedBook, language: "vi", chapterWordCount: 1150 };
      await state.saveBookConfig(bookId, book);
      const settled = createSettledRevisionOutput({
        book,
        bookDir: state.bookDir(bookId),
        chapterNumber: 1,
        title: "Revised Vietnamese Chapter",
        content: "Nội dung đã sửa.",
      });
      const settleSpy = vi.spyOn(WriterAgent.prototype, "settleChapterState")
        .mockResolvedValue(settled);
      const analyzerSpy = vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter");

      const persistence = await (runner as unknown as {
        buildPersistenceOutput: (
          bookId: string,
          book: BookConfig,
          bookDir: string,
          chapterNumber: number,
          output: WriteChapterOutput,
          finalContent: string,
          countingMode: "vi_wordlike_tokens_v1",
        ) => Promise<WriteChapterOutput>;
      }).buildPersistenceOutput(
        bookId,
        book,
        state.bookDir(bookId),
        1,
        createWriterOutput({ content: "Nội dung cũ.", wordCount: 13 }),
        "Nội dung đã sửa.",
        "vi_wordlike_tokens_v1",
      );

      expect(settleSpy).toHaveBeenCalledWith(expect.objectContaining({
        book,
        chapterNumber: 1,
        content: "Nội dung đã sửa.",
      }));
      expect(analyzerSpy).not.toHaveBeenCalled();
      expect(persistence.runtimeStateDelta).toBeDefined();
      expect(persistence.runtimeStateSnapshot).toBeDefined();
    } finally {
      restoreVi();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("degrades to state-degraded when state validation errors instead of aborting", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: "Healthy chapter body.",
        wordCount: "Healthy chapter body.".length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );
    vi.spyOn(StateValidatorAgent.prototype, "validate").mockRejectedValue(
      new Error("LLM returned empty response"),
    );

    const result = await runner.writeNextChapter(bookId);
    expect(result.status).toBe("state-degraded");

    // Chapter should be saved (content is fine, only truth files are degraded)
    const index = await state.loadChapterIndex(bookId);
    expect(index).toHaveLength(1);
    expect(index[0]!.status).toBe("state-degraded");
    expect(index[0]!.auditDecision).toBe("inconclusive");
    const auditRun = JSON.parse(await readFile(
      join(state.bookDir(bookId), index[0]!.auditRunPaths![0]!),
      "utf-8",
    ));
    expect(auditRun).toMatchObject({ decision: "inconclusive", passed: false });
    expect(auditRun.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "state",
        verification: "unverified",
        evidence: expect.objectContaining({ contentHash: auditRun.contentHash }),
      }),
    ]));

    await rm(root, { recursive: true, force: true });
  });

  it("retries settlement after state contradictions without rewriting the chapter body", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const storyDir = join(state.bookDir(bookId), "story");

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "stable state", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "stable hooks", "utf-8"),
      writeFile(join(storyDir, "particle_ledger.md"), "stable ledger", "utf-8"),
    ]);

    const writeSpy = vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: "Healthy chapter body with the copper token in his coat.",
        wordCount: "Healthy chapter body with the copper token in his coat.".length,
        updatedState: "broken state",
        updatedHooks: "broken hooks",
        updatedLedger: "broken ledger",
      }),
    );
    const settleSpy = vi.spyOn(
      WriterAgent.prototype as unknown as {
        settleChapterState: (input: Record<string, unknown>) => Promise<WriteChapterOutput>;
      },
      "settleChapterState",
    ).mockResolvedValue(
      createWriterOutput({
        content: "Healthy chapter body with the copper token in his coat.",
        wordCount: "Healthy chapter body with the copper token in his coat.".length,
        updatedState: "fixed state",
        updatedHooks: "fixed hooks",
        updatedLedger: "fixed ledger",
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );
    vi.spyOn(StateValidatorAgent.prototype, "validate")
      .mockResolvedValueOnce({
        passed: false,
        warnings: [{
          category: "unsupported_change",
          description: "状态写成铜牌未带在身上，但正文明确写了怀里的铜牌。",
        }],
      })
      .mockResolvedValueOnce({
        passed: true,
        warnings: [],
      });

    const result = await runner.writeNextChapter(
      bookId,
      countChapterLength("Healthy chapter body with the copper token in his coat.", "zh_chars"),
    );

    expect(result.status).toBe("ready-for-review");
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(settleSpy).toHaveBeenCalledTimes(1);
    expect(settleSpy).toHaveBeenCalledWith(expect.objectContaining({
      chapterNumber: 1,
      title: "Test Chapter",
      content: "Healthy chapter body with the copper token in his coat.",
      validationFeedback: expect.stringContaining("怀里的铜牌"),
    }));
    await expect(readFile(join(storyDir, "current_state.md"), "utf-8")).resolves.toBe("fixed state");
    await expect(readFile(join(storyDir, "pending_hooks.md"), "utf-8")).resolves.toBe("fixed hooks");

    await rm(root, { recursive: true, force: true });
  });

  it("persists a state-degraded chapter without advancing truth files when settlement retry still contradicts the body", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const chaptersDir = join(bookDir, "chapters");

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "stable state", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "stable hooks", "utf-8"),
      writeFile(join(storyDir, "particle_ledger.md"), "stable ledger", "utf-8"),
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: "Healthy chapter body with the copper token in his coat.",
        wordCount: "Healthy chapter body with the copper token in his coat.".length,
        updatedState: "broken state",
        updatedHooks: "broken hooks",
        updatedLedger: "broken ledger",
      }),
    );
    vi.spyOn(
      WriterAgent.prototype as unknown as {
        settleChapterState: (input: Record<string, unknown>) => Promise<WriteChapterOutput>;
      },
      "settleChapterState",
    ).mockResolvedValue(
      createWriterOutput({
        content: "Healthy chapter body with the copper token in his coat.",
        wordCount: "Healthy chapter body with the copper token in his coat.".length,
        updatedState: "still broken state",
        updatedHooks: "still broken hooks",
        updatedLedger: "still broken ledger",
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );
    vi.spyOn(StateValidatorAgent.prototype, "validate")
      .mockResolvedValueOnce({
        passed: false,
        warnings: [{
          category: "unsupported_change",
          description: "settler 把铜牌写没了，但正文仍然明确带在身上。",
        }],
      })
      .mockResolvedValueOnce({
        passed: false,
        warnings: [{
          category: "unsupported_change",
          description: "重试后仍然把铜牌写没了。",
        }],
      });

    const result = await runner.writeNextChapter(bookId);
    const savedIndex = await state.loadChapterIndex(bookId);

    expect(result.status).toBe("state-degraded");
    expect(savedIndex[0]?.status).toBe("state-degraded");
    expect(savedIndex[0]?.auditIssues).toContain("[warning] 重试后仍然把铜牌写没了。");
    expect(savedIndex[0]?.auditDecision).toBe("fail");
    const auditRunPath = savedIndex[0]?.auditRunPaths?.find((path) => path.includes(".initial.audit-run-v1.json"));
    expect(auditRunPath).toBeDefined();
    const auditRun = JSON.parse(await readFile(join(bookDir, auditRunPath!), "utf-8"));
    expect(auditRun).toMatchObject({ decision: "fail", passed: false });
    expect(auditRun.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "state",
        verification: "verified",
        evidence: expect.objectContaining({ contentHash: auditRun.contentHash }),
      }),
    ]));
    await expect(readFile(join(storyDir, "current_state.md"), "utf-8")).resolves.toBe("stable state");
    await expect(readFile(join(storyDir, "pending_hooks.md"), "utf-8")).resolves.toBe("stable hooks");
    await expect(readFile(join(storyDir, "particle_ledger.md"), "utf-8")).resolves.toBe("stable ledger");
    await expect(readdir(chaptersDir)).resolves.toContain("0001_Test_Chapter.md");
    await expect(stat(join(storyDir, "snapshots", "1"))).rejects.toThrow();

    await rm(root, { recursive: true, force: true });
  });

  it("blocks writing a new chapter when the latest persisted chapter is state-degraded", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const now = "2026-03-19T00:00:00.000Z";
    const storyDir = join(state.bookDir(bookId), "story");

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "stable state", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "stable hooks", "utf-8"),
      state.saveChapterIndex(bookId, [{
        number: 1,
        title: "Broken Persistence",
        status: "state-degraded" as ChapterMeta["status"],
        wordCount: 1234,
        createdAt: now,
        updatedAt: now,
        auditIssues: ["[warning] state validation degraded"],
        lengthWarnings: [],
      }]),
      writeFile(join(state.bookDir(bookId), "chapters", "0001_Broken_Persistence.md"), "# 第1章 Broken Persistence\n\nbody", "utf-8"),
    ]);

    await expect(runner.writeNextChapter(bookId)).rejects.toThrow(/state-degraded/i);

    await rm(root, { recursive: true, force: true });
  });

  it("repairs the latest state-degraded chapter from persisted body without rewriting it", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const now = "2026-03-19T00:00:00.000Z";
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const baselineDir = join(storyDir, "snapshots", "0");
    await mkdir(baselineDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "stable state", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "stable hooks", "utf-8"),
      writeFile(join(storyDir, "particle_ledger.md"), "stable ledger", "utf-8"),
      writeFile(join(baselineDir, "current_state.md"), "baseline state", "utf-8"),
      writeFile(join(baselineDir, "pending_hooks.md"), "baseline hooks", "utf-8"),
      writeFile(
        join(bookDir, "chapters", "0001_Broken_Persistence.md"),
        "# 第1章 Broken Persistence\n\nHealthy chapter body with the copper token in his coat.",
        "utf-8",
      ),
      state.saveChapterIndex(bookId, [{
        number: 1,
        title: "Broken Persistence",
        status: "state-degraded" as ChapterMeta["status"],
        wordCount: 55,
        createdAt: now,
        updatedAt: now,
        auditIssues: ["[warning] 重试后仍然把铜牌写没了。"],
        lengthWarnings: [],
        reviewNote: JSON.stringify({
          kind: "state-degraded",
          baseStatus: "ready-for-review",
          injectedIssues: ["[warning] 重试后仍然把铜牌写没了。"],
        }),
      }]),
    ]);

    const settleSpy = vi.spyOn(
      WriterAgent.prototype as unknown as {
        settleChapterState: (input: Record<string, unknown>) => Promise<WriteChapterOutput>;
      },
      "settleChapterState",
    ).mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        title: "Broken Persistence",
        content: "Healthy chapter body with the copper token in his coat.",
        wordCount: "Healthy chapter body with the copper token in his coat.".length,
        updatedState: "fixed state",
        updatedHooks: "fixed hooks",
        updatedLedger: "fixed ledger",
      }),
    );
    vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({
      passed: true,
      warnings: [],
    });

    const result = await (
      runner as unknown as {
        repairChapterState: (bookId: string, chapterNumber?: number) => Promise<{
          status: string;
          chapterNumber: number;
        }>;
      }
    ).repairChapterState(bookId, 1);
    const savedIndex = await state.loadChapterIndex(bookId);

    expect(result.status).toBe("ready-for-review");
    expect(result.chapterNumber).toBe(1);
    expect(settleSpy).toHaveBeenCalledWith(expect.objectContaining({
      allowReapply: true,
      baselineChapter: 0,
    }));
    await expect(readFile(join(storyDir, "current_state.md"), "utf-8")).resolves.toBe("fixed state");
    await expect(readFile(join(storyDir, "pending_hooks.md"), "utf-8")).resolves.toBe("fixed hooks");
    expect(savedIndex[0]?.status).toBe("ready-for-review");
    expect(savedIndex[0]?.auditIssues).toEqual([]);
    expect(savedIndex[0]?.reviewNote).toBeUndefined();

    await rm(root, { recursive: true, force: true });
  });

  it("syncs the latest edited chapter body back into truth files without requiring state-degraded status", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
      externalContext: "把注意力收回师债主线。",
    });
    const now = "2026-03-19T00:00:00.000Z";
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const baselineDir = join(storyDir, "snapshots", "0");
    await mkdir(baselineDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "current_focus.md"), "# 当前聚焦\n\n## 当前重点\n\n商会路线优先。\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# 卷纲\n\n## 第1章\n先处理商会路线噪音。\n", "utf-8"),
      writeFile(join(storyDir, "story_bible.md"), "# 世界观设定\n\n- 誓令碎片不可伪造。\n", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), "stable state", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "stable hooks", "utf-8"),
      writeFile(join(storyDir, "particle_ledger.md"), "stable ledger", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), [
        "# 章节摘要",
        "",
        "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| 1 | 夜灯 | 林越 | 林越继续追查师债 | 追查意图更强 | 师债推进 | 压抑 | 主线推进 |",
        "",
      ].join("\n"), "utf-8"),
      writeFile(join(baselineDir, "current_state.md"), "baseline state", "utf-8"),
      writeFile(join(baselineDir, "pending_hooks.md"), "baseline hooks", "utf-8"),
      writeFile(
        join(bookDir, "chapters", "0001_夜灯.md"),
        "# 第1章 夜灯\n\n林越推门进去，先停在门槛外听了一息，再去看柜台后那盏没关的灯。",
        "utf-8",
      ),
      state.saveChapterIndex(bookId, [{
        number: 1,
        title: "夜灯",
        status: "approved" as ChapterMeta["status"],
        wordCount: 55,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings: [],
      }]),
    ]);

    const settleSpy = vi.spyOn(
      WriterAgent.prototype as unknown as {
        settleChapterState: (input: Record<string, unknown>) => Promise<WriteChapterOutput>;
      },
      "settleChapterState",
    ).mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        title: "夜灯",
        content: "林越推门进去，先停在门槛外听了一息，再去看柜台后那盏没关的灯。",
        wordCount: "林越推门进去，先停在门槛外听了一息，再去看柜台后那盏没关的灯。".length,
        updatedState: "synced state",
        updatedHooks: "synced hooks",
        updatedLedger: "synced ledger",
      }),
    );
    vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({
      passed: true,
      warnings: [],
    });

    const result = await (
      runner as unknown as {
        resyncChapterArtifacts: (bookId: string, chapterNumber?: number) => Promise<{
          status: string;
          chapterNumber: number;
        }>;
      }
    ).resyncChapterArtifacts(bookId, 1);
    const savedIndex = await state.loadChapterIndex(bookId);

    expect(result.status).toBe("ready-for-review");
    expect(result.chapterNumber).toBe(1);
    expect(settleSpy).toHaveBeenCalledWith(expect.objectContaining({
      allowReapply: true,
      baselineChapter: 0,
      chapterIntent: expect.stringContaining("把注意力收回师债主线"),
    }));
    await expect(readFile(join(storyDir, "current_state.md"), "utf-8")).resolves.toBe("synced state");
    await expect(readFile(join(storyDir, "pending_hooks.md"), "utf-8")).resolves.toBe("synced hooks");
    expect(savedIndex[0]?.status).toBe("ready-for-review");

    await rm(root, { recursive: true, force: true });
  });

  it("still persists the chapter when the state validator appends markdown after a valid JSON verdict", async () => {
    vi.mocked(StateValidatorAgent.prototype.validate).mockRestore();
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockImplementation(
      async (_bookDir, chapterContent) =>
        createReviseOutput({
          revisedContent: chapterContent,
          wordCount: chapterContent.length,
        }),
    );

    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const finalBody = "Validated chapter body that should still persist.";

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: finalBody,
        wordCount: finalBody.length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: finalBody,
        wordCount: finalBody.length,
      }),
    );
    vi.spyOn(
      StateValidatorAgent.prototype as unknown as {
        chat: (...args: unknown[]) => Promise<{ content: string; usage: typeof ZERO_USAGE }>;
      },
      "chat",
    ).mockResolvedValue({
      content: [
        "{\"warnings\":[],\"passed\":true}",
        "",
        "## Notes",
        "Trailing markdown can include } braces and should not abort persistence.",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    const result = await runner.writeNextChapter(bookId);

    expect(result.chapterNumber).toBe(1);
    await expect(readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8"))
      .resolves.toContain(finalBody);
    await expect(state.loadChapterIndex(bookId)).resolves.toEqual([
      expect.objectContaining({
        number: 1,
        title: "Test Chapter",
      }),
    ]);

    await rm(root, { recursive: true, force: true });
  });

  it("preserves the revised chapter content when final truth rebuild omits CHAPTER_CONTENT", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const revisedBody = "Final revised body that should never be replaced by an empty chapter.";

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: "Original draft body.",
        wordCount: "Original draft body.".length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [CRITICAL_ISSUE],
          summary: "needs revision",
          overallScore: 40,
        }),
      )
      .mockResolvedValueOnce(
        createAuditResult({
          passed: true,
          issues: [],
          summary: "clean",
          overallScore: 95,
        }),
      );
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: revisedBody,
        wordCount: revisedBody.length,
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: "",
        wordCount: 0,
      }),
    );

    const result = await runner.writeNextChapter(bookId, revisedBody.length);
    const savedChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");
    const savedIndex = await state.loadChapterIndex(bookId);
    const expectedCount = countChapterLength(revisedBody, "zh_chars");

    expect(result.wordCount).toBe(expectedCount);
    expect(savedChapter).toContain(revisedBody);
    expect(savedIndex[0]?.wordCount).toBe(expectedCount);
    expect(savedIndex[0]?.status).toBe("ready-for-review");

    await rm(root, { recursive: true, force: true });
  });

  it("reports only resumed chapters in import results", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const now = "2026-03-19T00:00:00.000Z";
    const existingIndex: ChapterMeta[] = [
      {
        number: 1,
        title: "One",
        status: "imported",
        wordCount: 10,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings: [],
      },
      {
        number: 2,
        title: "Two",
        status: "imported",
        wordCount: 20,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings: [],
      },
    ];
    await state.saveChapterIndex(bookId, existingIndex);

    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockImplementation(async (input) =>
      createAnalyzedOutput({
        chapterNumber: input.chapterNumber,
        title: input.chapterTitle ?? `Chapter ${input.chapterNumber}`,
        content: input.chapterContent,
        wordCount: input.chapterContent.length,
      }),
    );
    vi.spyOn(WriterAgent.prototype, "saveChapter").mockResolvedValue(undefined);

    const result = await runner.importChapters({
      bookId,
      resumeFrom: 3,
      chapters: [
        { title: "One", content: "1111111111" },
        { title: "Two", content: "22222222222222222222" },
        { title: "Three", content: "333333333333333" },
        { title: "Four", content: "4444444444444444444444444" },
      ],
    });

    expect(result.importedCount).toBe(2);
    expect(result.totalWords).toBe("333333333333333".length + "4444444444444444444444444".length);
    expect(result.nextChapter).toBe(5);

    await rm(root, { recursive: true, force: true });
  });

  it("preserves imported chapter body when the analyzer only returns truth-file updates", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "前文",
      status: "imported",
      wordCount: 12,
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }]);
    await writeFile(
      join(chaptersDir, "0002_旧标题.md"),
      "# 第2章 旧标题\n\n旧正文不应该在重导入后继续留在目录里。",
      "utf-8",
    );
    const importedBody = [
      "老丁守了三十年桥，第一次在河灯节后半夜离开值班室。",
      "",
      "江面涨水，灯火贴着桥墩漂过去，他在第三个桥洞口捞起一盏湿透的河灯。",
      "灯芯没有烧完，里面却夹着半张旧照片。",
    ].join("\n");

    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        chapterNumber: 2,
        title: "河灯还亮着",
        content: "",
        wordCount: 0,
        updatedState: "imported state",
        updatedLedger: "imported ledger",
        updatedHooks: "imported hooks",
      }),
    );

    const result = await runner.importChapters({
      bookId,
      resumeFrom: 2,
      chapters: [
        { title: "前文", content: "已导入的前文。" },
        { title: "河灯还亮着", content: importedBody },
      ],
    });

    const savedChapter = await readFile(join(chaptersDir, "0002_河灯还亮着.md"), "utf-8");
    const chapterFiles = await readdir(chaptersDir);
    const savedIndex = await state.loadChapterIndex(bookId);
    const expectedCount = countChapterLength(importedBody, "zh_chars");

    expect(result.importedCount).toBe(1);
    expect(result.totalWords).toBe(expectedCount);
    expect(savedChapter).toContain(importedBody);
    expect(chapterFiles).not.toContain("0002_旧标题.md");
    expect(savedIndex[1]?.wordCount).toBe(expectedCount);
    expect(savedIndex[1]?.title).toBe("河灯还亮着");

    await rm(root, { recursive: true, force: true });
  });

  it("keeps fanfic initialization running when style guide extraction fails", async () => {
    const { root, runner, state } = await createRunnerFixture();
    const bookId = "fanfic-style-fallback";
    const now = "2026-03-19T00:00:00.000Z";
    const book: BookConfig = {
      id: bookId,
      title: "Fanfic Fallback",
      platform: "tomato",
      genre: "xuanhuan",
      status: "active",
      targetChapters: 10,
      chapterWordCount: 3000,
      createdAt: now,
      updatedAt: now,
    };

    vi.spyOn(runner, "importFanficCanon").mockImplementation(async (targetBookId) => {
      const storyDir = join(state.bookDir(targetBookId), "story");
      await mkdir(storyDir, { recursive: true });
      await writeFile(join(storyDir, "fanfic_canon.md"), "# Fanfic Canon\n", "utf-8");
      return "# Fanfic Canon\n";
    });
    vi.spyOn(ArchitectAgent.prototype, "generateFanficFoundation").mockResolvedValue({
      storyBible: "# Story Bible\n",
      volumeOutline: "# Volume Outline\n",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n",
      currentState: createStateCard({
        chapter: 0,
        location: "Lantern quay",
        protagonistState: "Lin Yue enters the fanfic timeline with a hidden debt.",
        goal: "Find the canon fissure.",
        conflict: "The old faction watches every move.",
      }),
      pendingHooks: "# Pending Hooks\n",
    });
    vi.spyOn(runner, "generateStyleGuide").mockRejectedValue(new Error("style failed"));

    try {
      await expect(runner.initFanficBook(book, "A".repeat(600), "canon.txt", "canon")).resolves.toBeUndefined();

      expect(await state.loadChapterIndex(bookId)).toEqual([]);
      await expect(readFile(join(state.bookDir(bookId), "story", "fanfic_canon.md"), "utf-8")).resolves.toContain("Fanfic Canon");
      await expect(stat(join(state.bookDir(bookId), "story", "snapshots", "0"))).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("imports short style samples with a deterministic guide instead of failing", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockRejectedValue(new Error("should not call llm for short samples"));
    const sample = "夜雨落在窗台。她没回头，只把那封信压进抽屉。楼下车灯一闪，像有人终于找到了这里。";

    try {
      const guide = await runner.generateStyleGuide(bookId, sample, "short-snippet");

      expect(chatSpy).not.toHaveBeenCalled();
      expect(guide).toContain("样本文本较短");
      await expect(readFile(join(state.bookDir(bookId), "story", "style_profile.json"), "utf-8")).resolves.toContain("short-snippet");
      await expect(readFile(join(state.bookDir(bookId), "story", "style_guide.md"), "utf-8")).resolves.toContain("样本文本较短");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("generates a Vietnamese style guide for Vietnamese books", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockRejectedValue(new Error("should not call llm for short samples"));
    const book = await state.loadBookConfig(bookId);
    await state.saveBookConfig(bookId, { ...book, language: "vi" });
    const sample = "Chạng vạng, mưa rơi đầy hiên. Nàng không quay đầu, chỉ gấp lá thư giấu vào ngăn kéo. Dưới đường, ánh đèn xe loé lên như một kẻ đã tìm thấy nơi này. Cánh cửa gỗ rít lên, khe hở phả hơi lạnh tràn vào nền nhà, và chiếc đèn dầu run rẩy cháy tới sáng.";

    try {
      const guide = await runner.generateStyleGuide(bookId, sample, "vi-snippet");

      expect(chatSpy).not.toHaveBeenCalled();
      expect(guide).toContain("Mẫu văn ngắn");
      expect(guide).toContain("Phương pháp viết");
      expect(guide).not.toContain("去AI味");
      await expect(readFile(join(state.bookDir(bookId), "story", "style_profile.json"), "utf-8")).resolves.toContain("vi-snippet");
      await expect(readFile(join(state.bookDir(bookId), "story", "style_guide.md"), "utf-8")).resolves.toContain("Phương pháp viết");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps canon import running when style guide extraction fails", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const parentBookId = "parent-book";
    const now = "2026-03-19T00:00:00.000Z";
    const parentBook: BookConfig = {
      id: parentBookId,
      title: "Parent Book",
      platform: "tomato",
      genre: "xuanhuan",
      status: "active",
      targetChapters: 10,
      chapterWordCount: 3000,
      createdAt: now,
      updatedAt: now,
    };
    const parentStoryDir = join(state.bookDir(parentBookId), "story");
    const parentChaptersDir = join(state.bookDir(parentBookId), "chapters");

    await state.saveBookConfig(parentBookId, parentBook);
    await mkdir(parentStoryDir, { recursive: true });
    await mkdir(parentChaptersDir, { recursive: true });
    await Promise.all([
      writeFile(join(parentStoryDir, "story_bible.md"), "# Story Bible\n", "utf-8"),
      writeFile(join(parentStoryDir, "current_state.md"), createStateCard({
        chapter: 3,
        location: "North watchtower",
        protagonistState: "The mentor debt is no longer secret.",
        goal: "Protect the watchtower archive.",
        conflict: "Guild spies are already inside the archive.",
      }), "utf-8"),
      writeFile(join(parentStoryDir, "particle_ledger.md"), "# Ledger\n", "utf-8"),
      writeFile(join(parentStoryDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(parentStoryDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
      writeFile(join(parentChaptersDir, "0001_Parent.md"), `# Chapter 1\n\n${"Parent text. ".repeat(60)}`, "utf-8"),
    ]);

    vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: "# Parent Canon\n\nImported canon body.",
    } as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);
    vi.spyOn(runner, "generateStyleGuide").mockRejectedValue(new Error("style failed"));

    try {
      const canon = await runner.importCanon(bookId, parentBookId);

      expect(canon).toContain("# Parent Canon");
      await expect(readFile(join(state.bookDir(bookId), "story", "parent_canon.md"), "utf-8")).resolves.toContain("Imported canon body.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps chapter import running when style guide extraction fails", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const chapterContent = "章节正文。".repeat(120);

    vi.spyOn(ArchitectAgent.prototype, "generateFoundationFromImport").mockResolvedValue({
      storyBible: "# Story Bible\n",
      volumeOutline: "# Volume Outline\n",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n",
      currentState: createStateCard({
        chapter: 0,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The mentor debt is still personal.",
      }),
      pendingHooks: "# Pending Hooks\n",
    });
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        chapterNumber: 1,
        title: "Prelude",
        content: chapterContent,
        wordCount: chapterContent.length,
      }),
    );
    vi.spyOn(WriterAgent.prototype, "saveChapter").mockResolvedValue(undefined);
    vi.spyOn(runner, "generateStyleGuide").mockRejectedValue(new Error("style failed"));

    try {
      const result = await runner.importChapters({
        bookId,
        chapters: [
          { title: "Prelude", content: chapterContent },
        ],
      });

      expect(result.importedCount).toBe(1);
      expect((await state.loadChapterIndex(bookId))[0]?.status).toBe("imported");
      await expect(readFile(join(state.bookDir(bookId), "story", "story_bible.md"), "utf-8")).resolves.toContain("# Story Bible");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  sqliteIt("rebuilds fact history from imported chapter snapshots", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();

    vi.spyOn(ArchitectAgent.prototype, "generateFoundationFromImport").mockResolvedValue({
      storyBible: "# Story Bible\n",
      volumeOutline: "# Volume Outline\n",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n",
      currentState: createStateCard({
        chapter: 0,
        location: "Shrine outskirts",
        protagonistState: "Lin Yue begins with the oath token hidden.",
        goal: "Reach the trial city.",
        conflict: "The trial deadline is closing in.",
      }),
      pendingHooks: "# Pending Hooks\n",
    });

    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter")
      .mockResolvedValueOnce(createAnalyzedOutput({
        chapterNumber: 1,
        title: "One",
        content: "One body.",
        wordCount: "One body.".length,
        updatedState: createStateCard({
          chapter: 1,
          location: "Ashen ferry crossing",
          protagonistState: "Lin Yue still hides the oath token.",
          goal: "Find the vanished mentor.",
          conflict: "The mentor debt is still personal.",
        }),
        updatedHooks: "# Pending Hooks\n",
      }))
      .mockResolvedValueOnce(createAnalyzedOutput({
        chapterNumber: 2,
        title: "Two",
        content: "Two body.",
        wordCount: "Two body.".length,
        updatedState: createStateCard({
          chapter: 2,
          location: "North watchtower",
          protagonistState: "Lin Yue finally shows the oath token.",
          goal: "Reach the watchtower before the guild.",
          conflict: "The merchant guild now contests the mentor trail.",
        }),
        updatedHooks: "# Pending Hooks\n",
      }));

    try {
      await runner.importChapters({
        bookId,
        chapters: [
          { title: "One", content: "One body." },
          { title: "Two", content: "Two body." },
        ],
      });

      const memoryDb = new MemoryDB(state.bookDir(bookId));
      try {
        const chapterOneFacts = memoryDb.getFactsAt("protagonist", 1);
        const currentFacts = memoryDb.getCurrentFacts();

        expect(chapterOneFacts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              predicate: "Current Conflict",
              object: "The mentor debt is still personal.",
            }),
          ]),
        );
        expect(currentFacts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              predicate: "Current Conflict",
              object: "The merchant guild now contests the mentor trail.",
              validFromChapter: 2,
              sourceChapter: 2,
            }),
          ]),
        );
      } finally {
        memoryDb.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  sqliteIt("rebuilds fact history from structured snapshot state instead of stale markdown snapshots", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const snapshotOneDir = join(storyDir, "snapshots", "1");
    const snapshotOneStateDir = join(snapshotOneDir, "state");
    await mkdir(snapshotOneStateDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(snapshotOneDir, "current_state.md"),
        createStateCard({
          chapter: 1,
          location: "Old markdown ferry crossing",
          protagonistState: "Markdown state still hides the oath token.",
          goal: "Follow the markdown trail.",
          conflict: "Old markdown conflict.",
        }),
        "utf-8",
      ),
      writeFile(join(snapshotOneStateDir, "current_state.json"), JSON.stringify({
        chapter: 1,
        facts: [
          {
            subject: "current",
            predicate: "Current Location",
            object: "Structured watchtower",
            validFromChapter: 1,
            validUntilChapter: null,
            sourceChapter: 1,
          },
          {
            subject: "protagonist",
            predicate: "Current Conflict",
            object: "Structured conflict replaces markdown drift.",
            validFromChapter: 1,
            validUntilChapter: null,
            sourceChapter: 1,
          },
        ],
      }, null, 2), "utf-8"),
    ]);

    try {
      await (runner as unknown as {
        syncCurrentStateFactHistory: (targetBookId: string, uptoChapter: number) => Promise<void>;
      }).syncCurrentStateFactHistory(bookId, 1);

      const memoryDb = new MemoryDB(state.bookDir(bookId));
      try {
        expect(memoryDb.getCurrentFacts()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              predicate: "Current Location",
              object: "Structured watchtower",
              validFromChapter: 1,
            }),
            expect.objectContaining({
              predicate: "Current Conflict",
              object: "Structured conflict replaces markdown drift.",
              validFromChapter: 1,
            }),
          ]),
        );
        expect(memoryDb.getCurrentFacts()).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              object: "Old markdown ferry crossing",
            }),
            expect.objectContaining({
              object: "Old markdown conflict.",
            }),
          ]),
        );
      } finally {
        memoryDb.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tracks imported English chapters using word counts instead of characters", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const englishBook = {
      ...(await state.loadBookConfig(bookId)),
      genre: "other",
      language: "en" as const,
    };
    const now = "2026-03-19T00:00:00.000Z";

    await state.saveBookConfig(bookId, englishBook);
    await state.saveChapterIndex(bookId, [
      {
        number: 1,
        title: "Prelude",
        status: "imported",
        wordCount: 3,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings: [],
      },
      {
        number: 2,
        title: "Crossroads",
        status: "imported",
        wordCount: 2,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings: [],
      },
    ]);

    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockImplementation(async (input) =>
      createAnalyzedOutput({
        chapterNumber: input.chapterNumber,
        title: input.chapterTitle ?? `Chapter ${input.chapterNumber}`,
        content: input.chapterContent,
        wordCount: countChapterLength(input.chapterContent, "en_words"),
      }),
    );
    vi.spyOn(WriterAgent.prototype, "saveChapter").mockResolvedValue(undefined);

    const result = await runner.importChapters({
      bookId,
      resumeFrom: 3,
      chapters: [
        { title: "Prelude", content: "One two three" },
        { title: "Crossroads", content: "Four five" },
        { title: "The Watchtower", content: "The storm kept rolling west" },
        { title: "Aftermath", content: "Lanterns dimmed before dawn broke" },
      ],
    });

    const chapterIndex = await state.loadChapterIndex(bookId);
    const chapterThree = chapterIndex.find((entry) => entry.number === 3);
    const chapterFour = chapterIndex.find((entry) => entry.number === 4);

    expect(result.importedCount).toBe(2);
    expect(result.totalWords).toBe(10);
    expect(chapterThree?.wordCount).toBe(5);
    expect(chapterFour?.wordCount).toBe(5);

    await rm(root, { recursive: true, force: true });
  });

  it("imports English chapters with English foundation seeds and persistence files", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const englishBook = {
      ...(await state.loadBookConfig(bookId)),
      genre: "other",
      language: "en" as const,
      chapterWordCount: 2200,
    };

    await state.saveBookConfig(bookId, englishBook);

    const foundation = vi.spyOn(ArchitectAgent.prototype, "generateFoundationFromImport").mockResolvedValue({
      storyBible: "# Story Bible\n",
      volumeOutline: "# Volume Outline\n",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n",
      currentState: createStateCard({
        chapter: 0,
        location: "Harbor gate",
        protagonistState: "Mara arrives with a sealed letter.",
        goal: "Find the missing captain before sunrise.",
        conflict: "The harbor watch is searching every ship.",
      }),
      pendingHooks: "# Pending Hooks\n\n| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |\n| --- | --- | --- | --- | --- | --- | --- |\n",
    });
    const saveChapter = vi.spyOn(WriterAgent.prototype, "saveChapter");

    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        chapterNumber: 1,
        title: "Prelude",
        content: "A cold wind crossed the harbor.",
        wordCount: countChapterLength("A cold wind crossed the harbor.", "en_words"),
        updatedState: createStateCard({
          chapter: 1,
          location: "Harbor gate",
          protagonistState: "Mara hides the sealed letter under her coat.",
          goal: "Slip past the harbor watch.",
          conflict: "The watch now searches for the missing captain's courier.",
        }),
        updatedHooks: "# Pending Hooks\n\n| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |\n| --- | --- | --- | --- | --- | --- | --- |\n| captain-letter | 1 | mystery | open | 1 | The captain's disappearance is explained. | The sealed letter points to the vanished captain. |\n",
        chapterSummary: "| 1 | Prelude | Mara | Mara reaches the harbor with a sealed letter. | Mara hides the letter and studies the watch patrol. | The captain-letter mystery opens. | tense | setup |",
        updatedSubplots: [
          "# Subplot Board",
          "",
          "| Subplot | Status | Note |",
          "| --- | --- | --- |",
          "| Harbor search | Active | Mara begins the search for the missing captain. |",
          "",
        ].join("\n"),
        updatedEmotionalArcs: "",
        updatedCharacterMatrix: "",
      }),
    );

    try {
      await runner.importChapters({
        bookId,
        chapters: [
          { title: "Prelude", content: "A cold wind crossed the harbor." },
        ],
      });

      const storyDir = join(state.bookDir(bookId), "story");
      const chapterPath = join(state.bookDir(bookId), "chapters", "0001_Prelude.md");
      const chapterFile = await readFile(chapterPath, "utf-8");
      const chapterSummaries = await readFile(join(storyDir, "chapter_summaries.md"), "utf-8");
      const subplotBoard = await readFile(join(storyDir, "subplot_board.md"), "utf-8");

      expect(foundation.mock.calls[0]?.[1]).toContain("Chapter 1: Prelude");
      expect(foundation.mock.calls[0]?.[1]).not.toContain("第1章");
      expect(saveChapter.mock.calls[0]?.[3]).toBe("en");
      expect(chapterFile).toContain("# Chapter 1: Prelude");
      expect(chapterSummaries).toContain("# Chapter Summaries");
      expect(chapterSummaries).not.toContain("# 章节摘要");
      expect(subplotBoard).toContain("# Subplot Board");
      expect(subplotBoard).not.toContain("# 支线进度板");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("logs localized replay progress during chapter import", async () => {
    const { logger, infos } = createCaptureLogger();
    const { root, runner, bookId } = await createRunnerFixture({ logger });

    vi.spyOn(ArchitectAgent.prototype, "generateFoundationFromImport").mockResolvedValue({
      storyBible: "# Story Bible\n",
      volumeOutline: "# Volume Outline\n",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n",
      currentState: createStateCard({
        chapter: 0,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The mentor debt is still personal.",
      }),
      pendingHooks: "# Pending Hooks\n",
    });
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        chapterNumber: 1,
        title: "Prelude",
        content: "章节正文。",
        wordCount: "章节正文。".length,
      }),
    );
    vi.spyOn(WriterAgent.prototype, "saveChapter").mockResolvedValue(undefined);

    try {
      await runner.importChapters({
        bookId,
        chapters: [
          { title: "第一章", content: "章节正文。" },
        ],
      });

      expect(infos).toEqual(expect.arrayContaining([
        "步骤 1：从 1 章生成基础设定...",
        "基础设定已生成。",
        "步骤 2：从第 1 章开始顺序回放...",
        "分析章节 1/1：第一章...",
        "完成。已导入 1 章，共 5字。下一章：2",
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes governed control inputs into import replay analyzer on the governed path", async () => {
    const { root, runner, bookId } = await createRunnerFixture();

    vi.spyOn(ArchitectAgent.prototype, "generateFoundationFromImport").mockResolvedValue({
      storyBible: "# Story Bible\n\n- Keep the harbor search grounded in the missing captain thread.\n",
      volumeOutline: "# Volume Outline\n\n## Volume 1\n- Chapter 1: Mara arrives at the harbor with the sealed letter.\n",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n\n- Stay close to Mara's viewpoint.\n",
      currentState: createStateCard({
        chapter: 0,
        location: "Harbor gate",
        protagonistState: "Mara arrives carrying a sealed letter.",
        goal: "Enter the harbor unnoticed.",
        conflict: "The harbor watch is hunting the captain's courier.",
      }),
      pendingHooks: [
        "# Pending Hooks",
        "",
        "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| captain-letter | 1 | mystery | open | 0 | The captain's disappearance is explained. | The sealed letter points to the missing captain. |",
        "",
      ].join("\n"),
    });

    const analyzeChapter = vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        chapterNumber: 1,
        title: "Prelude",
        content: "A cold wind crossed the harbor.",
        wordCount: countChapterLength("A cold wind crossed the harbor.", "en_words"),
      }),
    );
    vi.spyOn(WriterAgent.prototype, "saveChapter").mockResolvedValue(undefined);

    try {
      await runner.importChapters({
        bookId,
        chapters: [
          { title: "Prelude", content: "A cold wind crossed the harbor." },
        ],
      });

      expect(analyzeChapter.mock.calls[0]?.[0]).toMatchObject({
        chapterIntent: expect.stringContaining("# Chapter Intent"),
        contextPackage: expect.objectContaining({
          selectedContext: expect.any(Array),
        }),
        ruleStack: expect.objectContaining({
          activeOverrides: expect.any(Array),
        }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not leak imported future state into early replay chapters", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const englishBook = {
      ...(await state.loadBookConfig(bookId)),
      genre: "other",
      language: "en" as const,
      chapterWordCount: 2200,
    };

    await state.saveBookConfig(bookId, englishBook);
    await mkdir(join(storyDir, "snapshots", "0"), { recursive: true });
    await Promise.all([
      writeFile(join(storyDir, "subplot_board.md"), "# Subplot Board\n\nFUTURE LEAK subplot\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# Emotional Arcs\n\nFUTURE LEAK emotion\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# Character Matrix\n\nFUTURE LEAK matrix\n", "utf-8"),
      writeFile(
        join(storyDir, "chapter_summaries.md"),
        [
          "# Chapter Summaries",
          "",
          "| Chapter | Title | Characters | Key Events | State Changes | Hook Activity | Mood | Chapter Type |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          "| 99 | Future | Future Cast | FUTURE LEAK event | FUTURE LEAK state | FUTURE LEAK hook | grim | finale |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "snapshots", "0", "current_state.md"),
        createStateCard({
          chapter: 60,
          location: "Chengdu court",
          protagonistState: "FUTURE LEAK snapshot",
          goal: "Secure the western kingdom.",
          conflict: "Late-book imperial rivalry is now fully active.",
        }),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "snapshots", "0", "pending_hooks.md"),
        [
          "# Pending Hooks",
          "",
          "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| future-hook | 60 | mystery | open | 60 | Future payoff | FUTURE LEAK |",
          "",
        ].join("\n"),
        "utf-8",
      ),
    ]);

    vi.spyOn(ArchitectAgent.prototype, "generateFoundationFromImport").mockResolvedValue({
      storyBible: "# Story Bible\n",
      volumeOutline: "# Volume Outline\n",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n",
      currentState: createStateCard({
        chapter: 60,
        location: "Chengdu court",
        protagonistState: "FUTURE LEAK: Liu Bei already holds Yizhou.",
        goal: "Secure the western kingdom.",
        conflict: "Late-book imperial rivalry is now fully active.",
      }),
      pendingHooks: [
        "# Pending Hooks",
        "",
        "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| future-hook | 60 | mystery | open | 60 | Future payoff | FUTURE LEAK |",
        "",
      ].join("\n"),
    });

    let stateSeenByFirstReplay = "";
    let hooksSeenByFirstReplay = "";
    let subplotSeenByFirstReplay = "";
    let emotionalSeenByFirstReplay = "";
    let matrixSeenByFirstReplay = "";
    let summariesSeenByFirstReplay = "";

    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockImplementationOnce(async (input) => {
      stateSeenByFirstReplay = await readFile(join(input.bookDir, "story", "current_state.md"), "utf-8");
      hooksSeenByFirstReplay = await readFile(join(input.bookDir, "story", "pending_hooks.md"), "utf-8");
      subplotSeenByFirstReplay = await readFile(join(input.bookDir, "story", "subplot_board.md"), "utf-8").catch(() => "");
      emotionalSeenByFirstReplay = await readFile(join(input.bookDir, "story", "emotional_arcs.md"), "utf-8").catch(() => "");
      matrixSeenByFirstReplay = await readFile(join(input.bookDir, "story", "character_matrix.md"), "utf-8").catch(() => "");
      summariesSeenByFirstReplay = await readFile(join(input.bookDir, "story", "chapter_summaries.md"), "utf-8").catch(() => "");

      return createAnalyzedOutput({
        chapterNumber: 1,
        title: "Prelude",
        content: "A cold wind crossed the harbor.",
        wordCount: countChapterLength("A cold wind crossed the harbor.", "en_words"),
        updatedState: createStateCard({
          chapter: 1,
          location: "Harbor gate",
          protagonistState: "Mara hides the sealed letter under her coat.",
          goal: "Slip past the harbor watch.",
          conflict: "The watch now searches for the missing captain's courier.",
        }),
        updatedHooks: [
          "# Pending Hooks",
          "",
          "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| captain-letter | 1 | mystery | open | 1 | The captain's disappearance is explained. | The sealed letter points to the vanished captain. |",
          "",
        ].join("\n"),
      });
    });

    try {
      await runner.importChapters({
        bookId,
        chapters: [
          { title: "Prelude", content: "A cold wind crossed the harbor." },
        ],
      });

      expect(stateSeenByFirstReplay).toContain("| Current Chapter | 0 |");
      expect(stateSeenByFirstReplay).not.toContain("FUTURE LEAK");
      expect(hooksSeenByFirstReplay).toContain("# Pending Hooks");
      expect(hooksSeenByFirstReplay).not.toContain("future-hook");
      expect(hooksSeenByFirstReplay).not.toContain("FUTURE LEAK");
      expect(subplotSeenByFirstReplay).not.toContain("FUTURE LEAK");
      expect(emotionalSeenByFirstReplay).not.toContain("FUTURE LEAK");
      expect(matrixSeenByFirstReplay).not.toContain("FUTURE LEAK");
      expect(summariesSeenByFirstReplay).not.toContain("FUTURE LEAK");

      const snapshotZeroState = await readFile(join(storyDir, "snapshots", "0", "current_state.md"), "utf-8");
      const snapshotZeroHooks = await readFile(join(storyDir, "snapshots", "0", "pending_hooks.md"), "utf-8");
      expect(snapshotZeroState).toContain("| Current Chapter | 0 |");
      expect(snapshotZeroState).not.toContain("FUTURE LEAK");
      expect(snapshotZeroHooks).toContain("# Pending Hooks");
      expect(snapshotZeroHooks).not.toContain("future-hook");
      expect(snapshotZeroHooks).not.toContain("FUTURE LEAK");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  sqliteIt("rebuilds current facts from the revised chapter snapshot", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const oldState = createStateCard({
      chapter: 1,
      location: "Ashen ferry crossing",
      protagonistState: "Lin Yue still hides the oath token.",
      goal: "Find the vanished mentor.",
      conflict: "The mentor debt is still personal.",
    });
    const revisedState = createStateCard({
      chapter: 1,
      location: "Ashen ferry crossing",
      protagonistState: "Lin Yue no longer hides the oath token.",
      goal: "Confront the vanished mentor.",
      conflict: "The oath token is public now, forcing the confrontation.",
    });
    await state.saveBookConfig(bookId, {
      ...(await state.loadBookConfig(bookId)),
      chapterWordCount: 15,
    });

    await Promise.all([
      writeFile(join(chaptersDir, "0001_Test_Chapter.md"), "# 第1章 Test Chapter\n\nOriginal body.", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), oldState, "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "Test Chapter",
      status: "audit-failed",
      wordCount: "Original body.".length,
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }]);
    await snapshotRevisionBaseline(state, bookId, 0);
    await state.snapshotState(bookId, 1);

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [CRITICAL_ISSUE],
          summary: "needs revision",
        }),
      )
      .mockResolvedValueOnce(
        createAuditResult({
          passed: true,
          issues: [],
          summary: "clean",
        }),
      );
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: "Revised body.",
        wordCount: "Revised body.".length,
      }),
    );
    vi.spyOn(WriterAgent.prototype, "settleChapterState").mockImplementation(
      async (input) => {
        const output = createSettledRevisionOutput(input, { updatedState: revisedState });
        return {
          ...output,
          runtimeStateSnapshot: {
            ...output.runtimeStateSnapshot!,
            currentState: {
              chapter: 1,
              facts: [{
                subject: "protagonist",
                predicate: "Current Conflict",
                object: "The oath token is public now, forcing the confrontation.",
                validFromChapter: 1,
                validUntilChapter: null,
                sourceChapter: 1,
              }],
            },
          },
        };
      },
    );

    try {
      await snapshotRevisionBaseline(state, bookId, 0);
      await runner.reviseDraft(bookId, 1);

      const memoryDb = new MemoryDB(state.bookDir(bookId));
      try {
        expect(memoryDb.getCurrentFacts()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              predicate: "Current Conflict",
              object: "The oath token is public now, forcing the confrontation.",
              validFromChapter: 1,
              sourceChapter: 1,
            }),
          ]),
        );
      } finally {
        memoryDb.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("feeds long-span fatigue warnings back into pipeline audit and dedicated drift guidance", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const now = "2026-03-19T00:00:00.000Z";

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 3,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The debt trail keeps narrowing.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(
        join(storyDir, "chapter_summaries.md"),
        [
          "# 章节摘要",
          "",
          "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
          "|------|------|----------|----------|----------|----------|----------|----------|",
          "| 1 | 旧路 | 林越 | 进城 | 潜伏开始 | 债印未解 | 克制 | 布局 |",
          "| 2 | 暗巷 | 林越 | 试探 | 目标未变 | 债印未解 | 克制 | 布局 |",
          "| 3 | 灰门 | 林越 | 逼近 | 风险升级 | 债印未解 | 克制 | 推进章 |",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(join(state.bookDir(bookId), "chapters", "0001_旧路.md"), "# 第1章 旧路\n\n城门在晨雾里半开。林越顺着石阶慢慢往里走。巷口那盏灯一直没有灭。", "utf-8"),
      writeFile(join(state.bookDir(bookId), "chapters", "0002_暗巷.md"), "# 第2章 暗巷\n\n午后的风掠过墙头。林越没有回头，只是沿着阴影继续向前。墙后的铃声很轻。", "utf-8"),
      writeFile(join(state.bookDir(bookId), "chapters", "0003_灰门.md"), "# 第3章 灰门\n\n暮色落在门楣上。林越贴着墙继续逼近，门后的脚步声突然停了。", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [
      {
        number: 1,
        title: "旧路",
        status: "ready-for-review",
        wordCount: 36,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings: [],
      },
      {
        number: 2,
        title: "暗巷",
        status: "ready-for-review",
        wordCount: 36,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings: [],
      },
      {
        number: 3,
        title: "灰门",
        status: "ready-for-review",
        wordCount: 31,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings: [],
      },
    ]);

    await Promise.all([
      savePacingPlan(state.bookDir(bookId), 1, "escalation"),
      savePacingPlan(state.bookDir(bookId), 2, "escalation"),
      savePacingPlan(state.bookDir(bookId), 3, "escalation"),
    ]);
    await expect(loadPersistedPlan(state.bookDir(bookId), 1)).resolves.toEqual(
      expect.objectContaining({ intent: expect.objectContaining({ pacingCode: "escalation" }) }),
    );
    vi.spyOn(PlannerAgent.prototype, "planChapter").mockResolvedValueOnce({
      intent: {
        chapter: 4,
        goal: "Escalate the debt trail.",
        mustKeep: [],
        mustAvoid: [],
        styleEmphasis: [],
        acceptanceCriteria: [],
        pacingCode: "escalation",
        expectedHookOps: { upsert: [], mention: [], resolve: [], defer: [] },
      },
      memo: {
        chapter: 4,
        goal: "Escalate the debt trail.",
        isGoldenOpening: false,
        body: PACING_TEST_MEMO_BODY,
        threadRefs: [],
      },
      intentMarkdown: "# Chapter Intent\n",
      plannerInputs: [],
      runtimePath: join(storyDir, "runtime", "chapter-0004.intent.md"),
    });

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 4,
        title: "回声",
        content: "夜色慢慢压低了屋檐。林越先停在门外，随后才抬手去碰那道旧债印。风从更深的巷子里吹了出来。",
        wordCount: "夜色慢慢压低了屋檐。林越先停在门外，随后才抬手去碰那道旧债印。风从更深的巷子里吹了出来。".length,
        updatedState: createStateCard({
          chapter: 4,
          location: "Ashen ferry crossing",
          protagonistState: "Lin Yue still hides the oath token.",
          goal: "Find the vanished mentor.",
          conflict: "The debt trail keeps narrowing.",
        }),
        updatedLedger: "",
        updatedHooks: "# Pending Hooks\n",
        chapterSummary: "| 4 | 回声 | 林越 | 继续潜伏 | 目标未变 | 债印未解 | 克制 | 推进章 |",
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "ok",
      }),
    );

    try {
      const result = await runner.writeNextChapter(bookId);
      const driftFile = await readFile(join(storyDir, "audit_drift.md"), "utf-8");
      const currentState = await readFile(join(storyDir, "current_state.md"), "utf-8");

      expect(result.auditResult.issues.some((issue) => issue.category === "节奏单调")).toBe(true);
      expect(driftFile).toContain("节奏单调");
      expect(currentState).not.toContain("节奏单调");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("feeds hook health warnings back into pipeline audit and dedicated drift guidance", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const now = "2026-03-19T00:00:00.000Z";

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 2,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The debt trail keeps narrowing.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "chapters", "0001_旧路.md"), "# 第1章 旧路\n\n城门在晨雾里半开。林越顺着石阶慢慢往里走。", "utf-8"),
      writeFile(join(state.bookDir(bookId), "chapters", "0002_暗巷.md"), "# 第2章 暗巷\n\n午后的风掠过墙头。林越没有回头，只是沿着阴影继续向前。", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [
      {
        number: 1,
        title: "旧路",
        status: "ready-for-review",
        wordCount: 27,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings: [],
      },
      {
        number: 2,
        title: "暗巷",
        status: "ready-for-review",
        wordCount: 29,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings: [],
      },
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 3,
        title: "回声",
        content: "夜色慢慢压低了屋檐。林越先停在门外，随后才抬手去碰那道旧债印。",
        wordCount: "夜色慢慢压低了屋檐。林越先停在门外，随后才抬手去碰那道旧债印。".length,
        updatedState: createStateCard({
          chapter: 3,
          location: "Ashen ferry crossing",
          protagonistState: "Lin Yue still hides the oath token.",
          goal: "Find the vanished mentor.",
          conflict: "The debt trail keeps narrowing.",
        }),
        updatedLedger: "",
        updatedHooks: "# Pending Hooks\n",
        chapterSummary: "| 3 | 回声 | 林越 | 继续潜伏 | 目标未变 | 债印未解 | 克制 | 布局 |",
        hookHealthIssues: [{
          severity: "warning",
          category: "伏笔债务",
          description: "活跃伏笔过多，且本章没有处理陈旧债务。",
          suggestion: "下一章优先推进或延后至少一个僵死伏笔。",
        }],
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "ok",
      }),
    );

    try {
      const result = await runner.writeNextChapter(bookId);
      const driftFile = await readFile(join(storyDir, "audit_drift.md"), "utf-8");
      const currentState = await readFile(join(storyDir, "current_state.md"), "utf-8");
      const savedIndex = await state.loadChapterIndex(bookId);
      const persistedChapter = savedIndex.find((chapter) => chapter.number === result.chapterNumber);

      expect(result.auditResult.issues.some((issue) => issue.category === "伏笔债务")).toBe(true);
      expect(driftFile).toContain("伏笔债务");
      expect(currentState).not.toContain("伏笔债务");
      expect(persistedChapter?.auditIssues).toEqual(
        expect.arrayContaining([
          expect.stringContaining("活跃伏笔过多"),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("warns without rolling back canonical files when audit drift projection fails", async () => {
    const capture = createCaptureLogger();
    const { root, runner, state, bookId } = await createRunnerFixture({ logger: capture.logger });
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 0,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The debt trail keeps narrowing.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      mkdir(join(storyDir, "audit_drift.md"), { recursive: true }),
    ]);
    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(createWriterOutput({
      content: "A bounded chapter body carries the conflict forward safely.",
      wordCount: 9,
      updatedState: createStateCard({
        chapter: 1,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The debt trail keeps narrowing.",
      }),
      hookHealthIssues: [{
        severity: "warning",
        category: "hook-health",
        description: "A useful next-chapter correction must be projected.",
        suggestion: "Advance the oldest active hook.",
      }],
    }));
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(createAuditResult({
      passed: true,
      issues: [],
      overallScore: 95,
    }));

    try {
      const result = await runner.writeNextChapter(bookId, 9);
      const index = await state.loadChapterIndex(bookId);
      const chapterFiles = await readdir(join(bookDir, "chapters"));

      expect(index.some((chapter) => chapter.number === result.chapterNumber)).toBe(true);
      expect(chapterFiles.some((file) => file.startsWith("0001_") && file.endsWith(".md"))).toBe(true);
      expect(capture.warnings.some((warning) =>
        warning.includes("persist audit drift guidance")
        && (warning.includes("canonical files were preserved") || warning.includes("已保留权威文件"))
      )).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("adds final paragraph fragmentation warnings from revised content before persist", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const draftBody = "林越先把门推开一条缝，再侧耳去听墙后的动静。屋里的灯没有亮，但桌角还有没散的热气，说明人刚离开不久。";
    const revisedBody = [
      "门开了，冷风从缝隙里钻进来，吹得门轴发出细响。",
      "他没进去，只把手掌贴在门框上确认灰尘没有被人擦过。",
      "先听了一下，墙后传来水滴落在铜盆里的回声。",
      "里面没有声响，可桌角的热气说明离开的人还没走远。",
      "他这才抬脚，鞋底避开地上的碎瓷片，慢慢跨过门槛。",
      "屋里很冷，窗纸后压着一枚新鲜的脚印和半截蓝线。",
    ].join("\n\n");

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 0,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The debt trail keeps narrowing.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        title: "雾线",
        content: draftBody,
        wordCount: draftBody.length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [CRITICAL_ISSUE],
          summary: "needs revision",
          overallScore: 40,
        }),
      )
      .mockResolvedValueOnce(
        createAuditResult({
          passed: true,
          issues: [],
          summary: "clean",
          overallScore: 95,
        }),
      );
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: revisedBody,
        wordCount: revisedBody.length,
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        title: "雾线",
        content: revisedBody,
        wordCount: revisedBody.length,
        chapterSummary: "| 1 | 雾线 | 林越 | 进入空屋 | 状态推进 | 无 | 紧绷 | 过渡 |",
      }),
    );

    try {
      const result = await runner.writeNextChapter(bookId, 120);

      expect(result.auditResult.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "paragraph-shape",
            description: expect.stringContaining("段落被切得过碎"),
          }),
          expect.objectContaining({
            category: "paragraph-shape",
            description: expect.stringContaining("连续出现"),
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves duplicate chapter titles before persist", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const now = "2026-03-19T00:00:00.000Z";

    await Promise.all([
      writeFile(join(chaptersDir, "0001_回声.md"), "# 第1章 回声\n\n旧章节。", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 1,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The debt trail keeps narrowing.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "回声",
      status: "ready-for-review",
      wordCount: 12,
      createdAt: now,
      updatedAt: now,
      auditIssues: [],
      lengthWarnings: [],
    }]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 2,
        title: "回声",
        content: "啊。",
        wordCount: "啊。".length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    try {
      const result = await runner.writeNextChapter(bookId, 120);
      const index = await state.loadChapterIndex(bookId);

      expect(result.title).toBe("回声（2）");
      expect(index.at(-1)?.title).toBe("回声（2）");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("regenerates duplicate chapter titles before falling back to numeric suffixes", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const now = "2026-03-19T00:00:00.000Z";

    await Promise.all([
      writeFile(join(chaptersDir, "0001_回声.md"), "# 第1章 回声\n\n旧章节。", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 1,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The debt trail keeps narrowing.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "回声",
      status: "ready-for-review",
      wordCount: 12,
      createdAt: now,
      updatedAt: now,
      auditIssues: [],
      lengthWarnings: [],
    }]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 2,
        title: "回声",
        content: "塔楼里的铜铃只响了一声，风从缺口灌进来，守夜人没有回头。",
        wordCount: "塔楼里的铜铃只响了一声，风从缺口灌进来，守夜人没有回头。".length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    try {
      const result = await runner.writeNextChapter(bookId, 120);
      const index = await state.loadChapterIndex(bookId);

      expect(result.title).toContain("塔楼");
      expect(result.title).not.toBe("回声（2）");
      expect(index.at(-1)?.title).toBe(result.title);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defaults manual reviseDraft to auto when mode is omitted", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");

    await Promise.all([
      writeFile(join(chaptersDir, "0001_Test_Chapter.md"), "# 第1章 Test Chapter\n\nOriginal body.", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 1,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The mentor debt is still personal.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "Test Chapter",
      status: "audit-failed",
      wordCount: "Original body.".length,
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }]);

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: false,
        issues: [CRITICAL_ISSUE],
        summary: "needs revision",
      }),
    );
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: "Spot-fixed body.",
        wordCount: "Spot-fixed body.".length,
      }),
    );

    try {
      await snapshotRevisionBaseline(state, bookId, 0);
      await runner.reviseDraft(bookId, 1);

      expect(reviseChapter).toHaveBeenCalledTimes(1);
      expect(reviseChapter.mock.calls[0]?.[4]).toBe("auto");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes governed control inputs into manual revise on the governed path", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const originalBody = "林越推门进去，先看见柜台后那盏没关的灯。";

    await Promise.all([
      writeFile(join(storyDir, "current_focus.md"), "# 当前聚焦\n\n## 当前重点\n\n把注意力收回师债主线。\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# 卷纲\n\n## 第1章\n先处理商会路线噪音。\n", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 1,
        location: "旧港便利店",
        protagonistState: "林越仍在追查师债。",
        goal: "把注意力拉回师债线索。",
        conflict: "商会路线仍在分散注意力。",
      }), "utf-8"),
      writeFile(join(storyDir, "story_bible.md"), "# 世界观设定\n\n- 誓令碎片不可伪造。\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# 伏笔池\n\n- 师债线索仍未回收。\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), [
        "# 章节摘要",
        "",
        "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| 1 | 夜灯 | 林越 | 林越继续追查师债 | 追查意图更强 | 师债推进 | 压抑 | 主线推进 |",
        "",
      ].join("\n"), "utf-8"),
      writeFile(join(chaptersDir, "0001_夜灯.md"), `# 第1章 夜灯\n\n${originalBody}`, "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "夜灯",
      status: "audit-failed",
      wordCount: originalBody.length,
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }]);

    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [CRITICAL_ISSUE],
          summary: "needs revision",
        }),
      )
      .mockResolvedValueOnce(
        createAuditResult({
          passed: true,
          issues: [],
          summary: "clean",
        }),
      );
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: "林越推门进去，先停在门槛外听了一息，再去看柜台后那盏没关的灯。",
        wordCount: "林越推门进去，先停在门槛外听了一息，再去看柜台后那盏没关的灯。".length,
        fixedIssues: ["- 收紧了主线焦点。"],
      }),
    );

    try {
      await snapshotRevisionBaseline(state, bookId, 0);
      await runner.reviseDraft(bookId, 1);

      expect(auditChapter.mock.calls[0]?.[4]).toMatchObject({
        chapterIntent: expect.stringContaining("# Chapter Intent"),
        contextPackage: expect.objectContaining({
          selectedContext: expect.any(Array),
        }),
        ruleStack: expect.objectContaining({
          activeOverrides: expect.any(Array),
        }),
      });
      expect(reviseChapter.mock.calls[0]?.[6]).toMatchObject({
        chapterIntent: expect.stringContaining("# Chapter Intent"),
        contextPackage: expect.objectContaining({
          selectedContext: expect.any(Array),
        }),
        ruleStack: expect.objectContaining({
          activeOverrides: expect.any(Array),
        }),
        lengthSpec: expect.objectContaining({
          target: 3000,
        }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes one-off external brief into manual revise on the governed path", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
      externalContext: "把注意力收回师债主线，并强调柜台后的异常灯光。",
    });
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const originalBody = "林越推门进去，先看见柜台后那盏没关的灯。";

    await Promise.all([
      writeFile(join(storyDir, "current_focus.md"), "# 当前聚焦\n\n## 当前重点\n\n商会路线优先。\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# 卷纲\n\n## 第1章\n先处理商会路线噪音。\n", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 1,
        location: "旧港便利店",
        protagonistState: "林越仍在追查师债。",
        goal: "把注意力拉回师债线索。",
        conflict: "商会路线仍在分散注意力。",
      }), "utf-8"),
      writeFile(join(storyDir, "story_bible.md"), "# 世界观设定\n\n- 誓令碎片不可伪造。\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# 伏笔池\n\n- 师债线索仍未回收。\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), [
        "# 章节摘要",
        "",
        "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| 1 | 夜灯 | 林越 | 林越继续追查师债 | 追查意图更强 | 师债推进 | 压抑 | 主线推进 |",
        "",
      ].join("\n"), "utf-8"),
      writeFile(join(chaptersDir, "0001_夜灯.md"), `# 第1章 夜灯\n\n${originalBody}`, "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "夜灯",
      status: "audit-failed",
      wordCount: originalBody.length,
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }]);
    await saveChapterUserBrief(
      state.bookDir(bookId),
      1,
      "保留证人关于雨夜账本的原话。",
    );

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [CRITICAL_ISSUE],
          summary: "needs revision",
        }),
      )
      .mockResolvedValueOnce(
        createAuditResult({
          passed: true,
          issues: [],
          summary: "clean",
        }),
      );
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: "林越推门进去，先停在门槛外听了一息，再去看柜台后那盏没关的灯。",
        wordCount: "林越推门进去，先停在门槛外听了一息，再去看柜台后那盏没关的灯。".length,
        fixedIssues: ["- 收紧了主线焦点。"],
      }),
    );

    try {
      await snapshotRevisionBaseline(state, bookId, 0);
      await runner.reviseDraft(bookId, 1);

      expect(reviseChapter.mock.calls[0]?.[6]).toMatchObject({
        chapterIntent: expect.stringContaining("把注意力收回师债主线"),
      });
      expect(reviseChapter.mock.calls[0]?.[6]).toMatchObject({
        chapterIntent: expect.stringContaining("保留证人关于雨夜账本的原话"),
      });
      expect(reviseChapter.mock.calls[0]?.[6]).not.toMatchObject({
        chapterIntent: expect.stringContaining("商会路线优先"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes merged AI-tell issues into manual revise and rejects no-improvement revisions", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const originalBody = "林越抬手。林越停步。林越转身。林越侧耳。";

    await Promise.all([
      writeFile(join(chaptersDir, "0001_Test_Chapter.md"), `# 第1章 Test Chapter\n\n${originalBody}`, "utf-8"),
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 1,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The mentor debt is still personal.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "Test Chapter",
      status: "audit-failed",
      wordCount: originalBody.length,
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }]);

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [{
            severity: "warning",
            category: "节奏",
            description: "结尾解释略多。",
            suggestion: "压缩一行解释。",
          }],
          summary: "needs revision",
        }),
      )
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [{
            severity: "warning",
            category: "节奏",
            description: "结尾解释略多。",
            suggestion: "压缩一行解释。",
          }],
          summary: "still weak",
          overallScore: 80,
        }),
      );
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: `${originalBody}\n\n修订后收束更利落。`,
        wordCount: `${originalBody}\n\n修订后收束更利落。`.length,
        fixedIssues: ["- 压缩了结尾解释。"],
      }),
    );

    try {
      await snapshotRevisionBaseline(state, bookId, 0);
      const result = await runner.reviseDraft(bookId, 1);
      const savedChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");
      const savedIndex = await state.loadChapterIndex(bookId);

      expect(reviseChapter).toHaveBeenCalledTimes(1);
      expect(reviseChapter.mock.calls[0]?.[3]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: "节奏" }),
          expect.objectContaining({ category: "列表式结构" }),
        ]),
      );
      expect(result.applied).toBe(false);
      expect(result.status).toBe("unchanged");
      expect(result.skippedReason).toContain("Manual revision kept original chapter");
      expect(savedChapter).toContain(originalBody);
      expect(savedChapter).not.toContain("修订后收束更利落");
      expect(savedIndex[0]?.status).toBe("audit-failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("persists manual revisions only when merged audit improves", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const originalBody = "林越抬手。林越停步。林越转身。林越侧耳。";
    const revisedBody = "门被风顶开，林越先停在门槛前。\n\n他侧过身，听见墙后那道更轻的呼吸。";
    await state.saveBookConfig(bookId, {
      ...(await state.loadBookConfig(bookId)),
      chapterWordCount: 40,
    });

    await Promise.all([
      writeFile(join(chaptersDir, "0001_Test_Chapter.md"), `# 第1章 Test Chapter\n\n${originalBody}`, "utf-8"),
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 1,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The mentor debt is still personal.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "Test Chapter",
      status: "audit-failed",
      wordCount: originalBody.length,
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
      auditRunPaths: ["story/audit/legacy.manual.json"],
    }]);

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [{
            severity: "warning",
            category: "节奏",
            description: "结尾解释略多。",
            suggestion: "压缩一行解释。",
          }],
          summary: "needs revision",
        }),
      )
      .mockResolvedValueOnce(
        createAuditResult({
          passed: true,
          issues: [],
          summary: "clean",
        }),
      );
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: revisedBody,
        wordCount: revisedBody.length,
        fixedIssues: ["- 收紧了结尾节奏。"],
      }),
    );

    try {
      await snapshotRevisionBaseline(state, bookId, 0);
      const result = await runner.reviseDraft(bookId, 1);
      const savedChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");
      const savedIndex = await state.loadChapterIndex(bookId);

      expect(result.applied).toBe(true);
      expect(result.status).toBe("ready-for-review");
      expect(result.fixedIssues).toEqual(["- 收紧了结尾节奏。"]);
      expect(savedChapter).toContain(revisedBody);
      expect(savedIndex[0]?.status).toBe("ready-for-review");
      expect(savedIndex[0]?.auditIssues).toEqual([]);
      expect(savedIndex[0]?.auditRunPaths).toEqual(expect.arrayContaining([
        "story/audit/legacy.manual.json",
      ]));
      expect(savedIndex[0]?.auditRunPaths).toHaveLength(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("promotes latest manual revision hooks before validation, post-audit, and persistence", async () => {
    const { root, runner, state, bookId, chaptersDir } = await createRevisionGateFixture("strict");
    const storyDir = join(state.bookDir(bookId), "story");
    const promotedHook = {
      hookId: "H-MANUAL",
      startChapter: 1,
      type: "clue",
      status: "open",
      lastAdvancedChapter: 1,
      expectedPayoff: "later",
      notes: "promoted manual hook",
      promoted: true,
    };
    vi.spyOn(hookPromotionModule, "rerunPromotionPass").mockReturnValue({
      updated: true,
      hooks: [promotedHook],
      flippedCount: 1,
    });
    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({ passed: false, issues: [CRITICAL_ISSUE], summary: "needs revision" }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, issues: [], summary: "clean" }));
    const validate = vi.spyOn(StateValidatorAgent.prototype, "validate")
      .mockResolvedValue({ passed: true, repairRequired: false, warnings: [] });

    try {
      const result = await runner.reviseDraft(bookId, 1, "rework");
      const promotedHooks = String(validate.mock.calls[0]?.[5]);

      expect(result.applied).toBe(true);
      expect(promotedHooks).toContain("H-MANUAL");
      expect(auditChapter.mock.calls[1]?.[4]?.truthFileOverrides?.hooks).toBe(promotedHooks);
      await expect(readFile(join(storyDir, "pending_hooks.md"), "utf-8"))
        .resolves.toBe(promotedHooks);
      await expect(readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8"))
        .resolves.toContain("门被风顶开");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  async function createRevisionGateFixture(revisionGate?: "strict" | "lenient" | "always") {
    const fixture = await createRunnerFixture(revisionGate ? { revisionGate } : {});
    const storyDir = join(fixture.state.bookDir(fixture.bookId), "story");
    const chaptersDir = join(fixture.state.bookDir(fixture.bookId), "chapters");
    // Single paragraph, varied sentence openings, no hedge/transition words →
    // zero structural AI tells, so audit counts come only from the LLM audit mocks.
    const originalBody = "林越推门进去，先看见柜台后那盏没关的灯，他放轻脚步绕过货架。";
    const revisedBody = "门被风顶开，林越先停在门槛前，听见柜台后那盏灯轻轻晃动。";
    await fixture.state.saveBookConfig(fixture.bookId, {
      ...(await fixture.state.loadBookConfig(fixture.bookId)),
      chapterWordCount: 36,
    });

    await Promise.all([
      writeFile(join(chaptersDir, "0001_Test_Chapter.md"), `# 第1章 Test Chapter\n\n${originalBody}`, "utf-8"),
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 1,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The mentor debt is still personal.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);
    await fixture.state.saveChapterIndex(fixture.bookId, [{
      number: 1,
      title: "Test Chapter",
      status: "audit-failed",
      wordCount: originalBody.length,
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }]);

    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: revisedBody,
        wordCount: revisedBody.length,
        fixedIssues: ["- 调整了开场镜头。"],
      }),
    );

    await snapshotRevisionBaseline(fixture.state, fixture.bookId, 0);

    return { ...fixture, chaptersDir, revisedBody };
  }

  it("commits a latest revision and its updated index through one canonical file set", async () => {
    const { root, runner, state, bookId, revisedBody } = await createRevisionGateFixture("always");
    const bookDir = state.bookDir(bookId);
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({ passed: false, issues: [CRITICAL_ISSUE] }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, issues: [] }));
    const prepareChapterFileSet = vi.spyOn(WriterAgent.prototype, "prepareChapterFileSet")
      .mockResolvedValue({
        chapterFileName: "0001_Test_Chapter.md",
        writes: [
          {
            relativePath: join("chapters", "0001_Test_Chapter.md"),
            content: `# 第1章 Test Chapter\n\n${revisedBody}`,
          },
          { relativePath: join("story", "current_state.md"), content: "revised truth" },
          { relativePath: join("story", "pending_hooks.md"), content: "revised hooks" },
          { relativePath: join("story", "state", "manifest.json"), content: "revised manifest" },
        ],
        deletes: [],
      });
    const saveChapter = vi.spyOn(WriterAgent.prototype, "saveChapter");
    const saveChapterIndex = vi.spyOn(StateManager.prototype, "saveChapterIndex");
    const originalCommitAtomicFileSet = atomicFileSetModule.commitAtomicFileSet;
    let canonicalCommitCompleted = false;
    const commitAtomicFileSet = vi.spyOn(atomicFileSetModule, "commitAtomicFileSet")
      .mockImplementation(async (input) => {
        await originalCommitAtomicFileSet(input);
        canonicalCommitCompleted = true;
      });
    const snapshotState = vi.spyOn(StateManager.prototype, "snapshotState")
      .mockImplementation(async () => {
        expect(canonicalCommitCompleted).toBe(true);
      });
    Object.assign(runner as object, {
      persistAuditDriftGuidance: vi.fn(async () => {
        expect(canonicalCommitCompleted).toBe(true);
      }),
      syncNarrativeMemoryIndex: vi.fn(async () => {
        expect(canonicalCommitCompleted).toBe(true);
      }),
      syncCurrentStateFactHistory: vi.fn(async () => {
        expect(canonicalCommitCompleted).toBe(true);
      }),
      emitWebhook: vi.fn(async () => {
        expect(canonicalCommitCompleted).toBe(true);
      }),
    });

    try {
      const result = await runner.reviseDraft(bookId, 1, "rework");
      const committedPaths = commitAtomicFileSet.mock.calls[0]?.[0].writes
        .map((write) => write.relativePath);

      expect(result.applied).toBe(true);
      expect(prepareChapterFileSet).toHaveBeenCalledTimes(1);
      expect(commitAtomicFileSet).toHaveBeenCalledTimes(1);
      expect(committedPaths).toEqual(expect.arrayContaining([
        join("chapters", "0001_Test_Chapter.md"),
        join("story", "current_state.md"),
        join("story", "pending_hooks.md"),
        join("story", "state", "manifest.json"),
        join("chapters", "index.json"),
      ]));
      expect(saveChapter).not.toHaveBeenCalled();
      expect(saveChapterIndex).not.toHaveBeenCalled();
      expect(snapshotState).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("commits an older Vietnamese revision with its index and a Vietnamese heading", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-runner-vi-older-revision-"));
    const state = new StateManager(root);
    const bookId = "vi-older-revision";
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const chaptersDir = join(bookDir, "chapters");
    const restoreVi = await enableViWriting(root);
    await state.saveBookConfig(bookId, {
      id: bookId,
      title: "Sửa chương cũ",
      platform: "other",
      genre: "other",
      language: "vi",
      status: "active",
      targetChapters: 10,
      chapterWordCount: 2000,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    await mkdir(chaptersDir, { recursive: true });
    await mkdir(storyDir, { recursive: true });
    await state.ensureControlDocuments(bookId);
    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 0,
        location: "Hiên mưa",
        protagonistState: "Lan đang chờ tin.",
        goal: "Tìm cuốn sổ cũ.",
        conflict: "Dấu vết đã bị xóa.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Tình tiết cài cắm\n", "utf-8"),
      writeFile(join(chaptersDir, "0001_Mưa.md"), "# Chương 1: Mưa\n\nLan đứng dưới hiên.", "utf-8"),
      writeFile(join(chaptersDir, "0002_Gió.md"), "# Chương 2: Gió\n\nGió lùa qua cửa.", "utf-8"),
    ]);
    await state.snapshotState(bookId, 0);
    const telemetry = {
      language: "vi" as const,
      target: 2000,
      softMin: 1728,
      softMax: 2272,
      hardMin: 5,
      hardMax: 20,
      countingMode: "vi_wordlike_tokens_v1" as const,
      writerCount: 5,
      postReviseCount: 0,
      finalCount: 5,
      repairApplied: false,
      lengthWarning: true,
    };
    await state.saveChapterIndex(bookId, [
      {
        number: 1,
        title: "Mưa",
        status: "audit-failed",
        wordCount: 5,
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
        auditIssues: [],
        lengthWarnings: [],
        lengthTelemetry: telemetry,
      },
      {
        number: 2,
        title: "Gió",
        status: "ready-for-review",
        wordCount: 5,
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
        auditIssues: [],
        lengthWarnings: [],
        lengthTelemetry: telemetry,
      },
    ]);
    const runner = new PipelineRunner({
      client: {} as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
    });
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({ passed: false, issues: [CRITICAL_ISSUE] }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, issues: [] }));
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(createReviseOutput({
      revisedContent: "Lan khép ô rồi bước khỏi hiên.",
      wordCount: 7,
    }));
    const prepareChapterFileSet = vi.spyOn(WriterAgent.prototype, "prepareChapterFileSet");
    const saveChapter = vi.spyOn(WriterAgent.prototype, "saveChapter");
    const saveChapterIndex = vi.spyOn(StateManager.prototype, "saveChapterIndex");
    const originalCommitAtomicFileSet = atomicFileSetModule.commitAtomicFileSet;
    const commitAtomicFileSet = vi.spyOn(atomicFileSetModule, "commitAtomicFileSet")
      .mockImplementation((input) => originalCommitAtomicFileSet(input));
    Object.assign(runner as object, {
      syncNarrativeMemoryIndex: vi.fn(async () => undefined),
      emitWebhook: vi.fn(async () => undefined),
    });

    try {
      const result = await runner.reviseDraft(bookId, 1, "rework");
      const committedWrites = commitAtomicFileSet.mock.calls[0]?.[0].writes;
      const savedChapter = await readFile(join(chaptersDir, "0001_Mưa.md"), "utf-8");

      expect(result.applied).toBe(true);
      expect(commitAtomicFileSet).toHaveBeenCalledTimes(1);
      expect(committedWrites.map((write) => write.relativePath)).toEqual(expect.arrayContaining([
        join("chapters", "0001_Mưa.md"),
        join("chapters", "index.json"),
        expect.stringContaining(".initial.audit-run-v1.json"),
        expect.stringContaining(".post-revision.audit-run-v1.json"),
      ]));
      expect(savedChapter.startsWith("# Chương 1: Mưa\n\n")).toBe(true);
      expect(prepareChapterFileSet).not.toHaveBeenCalled();
      expect(saveChapter).not.toHaveBeenCalled();
      expect(saveChapterIndex).not.toHaveBeenCalled();
    } finally {
      restoreVi();
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  const GATE_WARNING_ISSUE: AuditIssue = {
    severity: "warning",
    category: "节奏",
    description: "结尾解释略多。",
    suggestion: "压缩一行解释。",
  };

  it("applies the revised chapter with a state-degraded baseline when settlement cannot validate", async () => {
    const { root, runner, state, bookId, chaptersDir, revisedBody } = await createRevisionGateFixture("always");
    const storyDir = join(state.bookDir(bookId), "story");
    const originalState = await readFile(join(storyDir, "current_state.md"), "utf-8");
    const originalHooks = await readFile(join(storyDir, "pending_hooks.md"), "utf-8");
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({ passed: false, issues: [CRITICAL_ISSUE], summary: "needs revision" }),
      )
      .mockResolvedValue(
        createAuditResult({ passed: true, summary: "revised body passes" }),
      );
    vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({
      passed: false,
      repairRequired: true,
      warnings: [{
        category: "state-conflict",
        description: "The derived hook board contradicts the revised body.",
      }],
    });

    try {
      const result = await runner.reviseDraft(bookId, 1, "rework", "Rewrite the chapter and sync state.");

      expect(result.applied).toBe(true);
      const savedChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");
      expect(savedChapter).toContain(revisedBody);
      // The prose is applied; its unrepairable state delta is dropped back
      // to the pre-revision baseline instead of polluting truth files.
      const savedState = await readFile(join(storyDir, "current_state.md"), "utf-8");
      expect(savedState.replace(/\s+$/u, "")).toBe(originalState.replace(/\s+$/u, ""));
      const savedHooks = await readFile(join(storyDir, "pending_hooks.md"), "utf-8");
      expect(savedHooks.replace(/\s+$/u, "")).toBe(originalHooks.replace(/\s+$/u, ""));
      expect(result.auditIssues).toEqual([
        expect.objectContaining({ category: "state-validation" }),
        expect.objectContaining({
          category: "state-validation",
          severity: "warning",
          description: expect.stringContaining("state-degraded"),
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it.each(["strict", "lenient", "always"] as const)(
    "does not let legacy %s revisionGate accept a candidate below the shared gate",
    async (revisionGate) => {
    const { root, runner, bookId, chaptersDir, revisedBody } = await createRevisionGateFixture(revisionGate);

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({ passed: false, issues: [GATE_WARNING_ISSUE], summary: "needs revision", overallScore: 80 }))
      .mockResolvedValueOnce(createAuditResult({ passed: false, issues: [GATE_WARNING_ISSUE], summary: "still weak", overallScore: 80 }));

    try {
      const result = await runner.reviseDraft(bookId, 1);
      const savedChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");

      expect(result.applied).toBe(false);
      expect(result.skippedReason).toContain("acceptance gate");
      expect(result.revisionDiagnostics?.standard).toContain("compatibility");
      expect(result.revisionDiagnostics?.standard).not.toMatch(/no improvement|lenient gate/u);
      expect(savedChapter).not.toContain(revisedBody);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("records an immutable rejection run when manual reviser returns no candidate", async () => {
    const { root, runner, state, bookId, chaptersDir } = await createRevisionGateFixture("strict");
    const originalChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({ passed: false, issues: [CRITICAL_ISSUE], summary: "needs revision" }),
    );
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({ revisedContent: "", wordCount: 0 }),
    );

    try {
      const result = await runner.reviseDraft(bookId, 1, "rework");
      const auditRunDir = join(state.bookDir(bookId), "story", "audit", "runs", "chapter-0001");
      const [auditRunFile] = await readdir(auditRunDir);
      const auditRun = JSON.parse(await readFile(join(auditRunDir, auditRunFile!), "utf-8"));

      expect(result).toMatchObject({ applied: false, status: "unchanged" });
      expect(result.skippedReason).toContain("empty");
      await expect(readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8")).resolves.toBe(originalChapter);
      expect(auditRun).toMatchObject({
        phase: "initial",
        canonicalCommitOutcome: "unchanged",
        revision: {
          attempted: true,
          candidateProduced: false,
          accepted: false,
          rejectionReason: expect.stringContaining("empty"),
        },
      });
      expect(auditRun.revision).not.toHaveProperty("candidateContentHash");
      expect(auditRun.revision).not.toHaveProperty("candidateWordCount");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("omits candidate identity from an unchanged manual revision rejection run", async () => {
    const { root, runner, state, bookId, chaptersDir } = await createRevisionGateFixture("strict");
    const originalChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");
    const originalBody = originalChapter.split("\n\n").slice(1).join("\n\n");
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({ passed: false, issues: [CRITICAL_ISSUE], summary: "needs revision" }),
    );
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({ revisedContent: originalBody, wordCount: originalBody.length }),
    );

    try {
      const result = await runner.reviseDraft(bookId, 1, "rework");
      const auditRunDir = join(state.bookDir(bookId), "story", "audit", "runs", "chapter-0001");
      const [auditRunFile] = await readdir(auditRunDir);
      const auditRun = JSON.parse(await readFile(join(auditRunDir, auditRunFile!), "utf-8"));

      expect(result).toMatchObject({ applied: false, status: "unchanged" });
      expect(auditRun).toMatchObject({
        phase: "initial",
        canonicalCommitOutcome: "unchanged",
        revision: {
          attempted: true,
          candidateProduced: false,
          accepted: false,
          rejectionReason: expect.stringContaining("unchanged"),
        },
      });
      expect(auditRun.revision).not.toHaveProperty("candidateContentHash");
      expect(auditRun.revision).not.toHaveProperty("candidateWordCount");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("records an immutable initial rejection run before a manual reviser error escapes", async () => {
    const { root, runner, state, bookId, chaptersDir } = await createRevisionGateFixture("strict");
    const originalChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({ passed: false, issues: [CRITICAL_ISSUE], summary: "needs revision" }),
    );
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockRejectedValue(
      new Error("provider output failed"),
    );

    try {
      await expect(runner.reviseDraft(bookId, 1, "rework"))
        .rejects.toThrow("provider output failed");
      const auditRunDir = join(state.bookDir(bookId), "story", "audit", "runs", "chapter-0001");
      const [auditRunFile] = await readdir(auditRunDir);
      const auditRun = JSON.parse(await readFile(join(auditRunDir, auditRunFile!), "utf-8"));

      await expect(readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8")).resolves.toBe(originalChapter);
      expect(auditRun).toMatchObject({
        phase: "initial",
        canonicalCommitOutcome: "unchanged",
        revision: {
          attempted: true,
          candidateProduced: false,
          accepted: false,
          rejectionReason: expect.stringContaining("provider output failed"),
        },
      });
      expect(auditRun.revision).not.toHaveProperty("candidateContentHash");
      expect(auditRun.revision).not.toHaveProperty("candidateWordCount");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("records a rejection run before returning from unavailable manual state validation", async () => {
    const { root, runner, state, bookId, chaptersDir } = await createRevisionGateFixture("strict");
    const originalChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValueOnce(
      createAuditResult({ passed: false, issues: [CRITICAL_ISSUE], summary: "needs revision" }),
    );
    vi.spyOn(StateValidatorAgent.prototype, "validate").mockRejectedValue(new Error("validator unavailable"));

    try {
      const result = await runner.reviseDraft(bookId, 1, "rework");
      const auditRunDir = join(state.bookDir(bookId), "story", "audit", "runs", "chapter-0001");
      const [auditRunFile] = await readdir(auditRunDir);
      const auditRun = JSON.parse(await readFile(join(auditRunDir, auditRunFile!), "utf-8"));

      expect(result).toMatchObject({ applied: false, status: "unchanged" });
      expect(result.skippedReason).toContain("state validation unavailable");
      await expect(readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8")).resolves.toBe(originalChapter);
      expect(auditRun.revision).toMatchObject({
        attempted: true,
        candidateProduced: true,
        candidateContentHash: expect.any(String),
        candidateWordCount: expect.any(Number),
        accepted: false,
        rejectionReason: expect.stringContaining("state validation unavailable"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("uses one authority context for initial and retried manual state validation", async () => {
    const { root, runner, state, bookId } = await createRevisionGateFixture("strict");
    const storyDir = join(state.bookDir(bookId), "story");
    const authorityContext = {
      storyFrame: "# Story Frame\n\nThe bronze token never changes ownership.",
      bookRules: "# Book Rules\n\nThe oath token is immutable.",
      chapterSummaries: "# Chapter Summaries\n\nChapter 0: Lin Yue carries the token.",
    };
    await mkdir(join(storyDir, "outline"), { recursive: true });
    await Promise.all([
      writeFile(join(storyDir, "outline", "story_frame.md"), authorityContext.storyFrame, "utf-8"),
      writeFile(join(storyDir, "book_rules.md"), authorityContext.bookRules, "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), authorityContext.chapterSummaries, "utf-8"),
    ]);
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({ passed: false, issues: [CRITICAL_ISSUE], summary: "needs revision" }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, issues: [], summary: "clean" }));
    const validate = vi.spyOn(StateValidatorAgent.prototype, "validate")
      .mockResolvedValueOnce({
        passed: false,
        repairRequired: true,
        warnings: [{ category: "authority", description: "settlement needs retry" }],
      })
      .mockResolvedValueOnce({ passed: true, repairRequired: false, warnings: [] });

    try {
      await runner.reviseDraft(bookId, 1, "rework");

      expect(validate).toHaveBeenCalledTimes(2);
      expect(validate.mock.calls[0]?.[7]).toEqual(authorityContext);
      expect(validate.mock.calls[1]?.[7]).toEqual(authorityContext);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("rejects a worsening manual revision under the lenient compatibility value", async () => {
    const { root, runner, bookId, chaptersDir, revisedBody } = await createRevisionGateFixture("lenient");

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({ passed: false, issues: [GATE_WARNING_ISSUE], summary: "needs revision" }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        issues: [GATE_WARNING_ISSUE, CRITICAL_ISSUE],
        summary: "worse",
        overallScore: 80,
      }));

    try {
      const result = await runner.reviseDraft(bookId, 1);
      const savedChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");

      expect(result.applied).toBe(false);
      expect(result.skippedReason).toContain("Manual revision kept original chapter");
      expect(result.revisionDiagnostics?.standard).toContain("compatibility");
      expect(result.revisionDiagnostics?.standard).not.toMatch(/no improvement|lenient gate/u);
      expect(result.revisionDiagnostics?.after.criticalCount).toBe(1);
      expect(savedChapter).not.toContain(revisedBody);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("does not let legacy always revisionGate bypass shared acceptance", async () => {
    const { root, runner, state, bookId, chaptersDir, revisedBody } = await createRevisionGateFixture("always");

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({ passed: false, issues: [GATE_WARNING_ISSUE], summary: "needs revision" }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        issues: [GATE_WARNING_ISSUE, CRITICAL_ISSUE],
        summary: "worse",
        overallScore: 80,
      }));

    try {
      const result = await runner.reviseDraft(bookId, 1);
      const savedChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");
      const savedIndex = await state.loadChapterIndex(bookId);

      expect(result.applied).toBe(false);
      expect(savedChapter).not.toContain(revisedBody);
      const versions = await listChapterVersions(state.bookDir(bookId), 1);
      expect(versions).toHaveLength(0);
      const auditRunFiles = await readdir(join(state.bookDir(bookId), "story", "audit", "runs", "chapter-0001"));
      expect(auditRunFiles).toEqual(expect.arrayContaining([
        expect.stringContaining(".initial.audit-run-v1.json"),
        expect.stringContaining(".post-revision.audit-run-v1.json"),
      ]));
      expect(savedIndex[0]?.status).toBe("audit-failed");
      expect(savedIndex[0]?.auditIssues).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("runs an explicit rework even when the current chapter already passes audit", async () => {
    const { root, runner, bookId, chaptersDir, revisedBody } = await createRevisionGateFixture("always");

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({ passed: true, issues: [], summary: "clean" }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, issues: [], summary: "clean alternative" }));

    try {
      const result = await runner.reviseDraft(
        bookId,
        1,
        "rework",
        "保留事实，但重新组织整章冲突。",
      );
      const savedChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");

      expect(result.applied).toBe(true);
      expect(savedChapter).toContain(revisedBody);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("keeps current truth intact and marks downstream chapters when reworking an older chapter", async () => {
    const { root, runner, state, bookId, chaptersDir, revisedBody } = await createRevisionGateFixture("always");
    const storyDir = join(state.bookDir(bookId), "story");
    const latestState = "# Current State\n\nThe second chapter is already complete.";
    const latestHooks = "# Pending Hooks\n\n- H2 remains active after chapter 2.";
    await Promise.all([
      writeFile(
        join(chaptersDir, "0002_Later_Chapter.md"),
        "# 第2章 Later Chapter\n\n第二章已经发生。",
        "utf-8",
      ),
      writeFile(join(storyDir, "current_state.md"), latestState, "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), latestHooks, "utf-8"),
    ]);
    const index = await state.loadChapterIndex(bookId);
    await state.saveChapterIndex(bookId, [
      ...index,
      {
        number: 2,
        title: "Later Chapter",
        status: "ready-for-review",
        wordCount: 8,
        createdAt: "2026-03-20T00:00:00.000Z",
        updatedAt: "2026-03-20T00:00:00.000Z",
        auditIssues: [],
        lengthWarnings: [],
      },
    ]);
    const snapshotState = vi.spyOn(state, "snapshotState");

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({ passed: true, issues: [], summary: "clean" }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, issues: [], summary: "clean alternative" }));

    try {
      const result = await runner.reviseDraft(
        bookId,
        1,
        "rework",
        "重写第一章，但不要假装第二章尚未发生。",
      );
      const savedChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");
      const savedIndex = await state.loadChapterIndex(bookId);

      expect(result.applied).toBe(true);
      expect(savedChapter).toContain(revisedBody);
      await expect(readFile(join(storyDir, "current_state.md"), "utf-8")).resolves.toBe(latestState);
      await expect(readFile(join(storyDir, "pending_hooks.md"), "utf-8")).resolves.toBe(latestHooks);
      expect(savedIndex[0]?.status).toBe("ready-for-review");
      expect(savedIndex[1]?.status).toBe("needs-revision");
      expect(ChapterMetaSchema.array().safeParse(savedIndex).success).toBe(true);
      expect(snapshotState).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("re-audits revisions against updated state overrides instead of stale on-disk truth files", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const originalBody = "Taryn kept one hand on the annexe key and listened at the door.";
    const revisedBody = `${originalBody}\n\nHe checked the seal again before he moved.`;

    await state.saveBookConfig(bookId, {
      ...(await state.loadBookConfig(bookId)),
      platform: "other",
      genre: "progression",
      language: "en",
      chapterWordCount: 22,
    });

    await Promise.all([
      writeFile(join(chaptersDir, "0001_First.md"), `# Chapter 1: First\n\nOpening chapter.`, "utf-8"),
      writeFile(join(chaptersDir, "0002_Test_Chapter.md"), `# Chapter 2: Test Chapter\n\n${originalBody}`, "utf-8"),
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 1,
        location: "Orsden archive lower hall",
        protagonistState: "Taryn is still moving under Renn's first warning.",
        goal: "Reach the annexe.",
        conflict: "The archive is already compromised.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [
      {
        number: 1,
        title: "First",
        status: "ready-for-review",
        wordCount: countChapterLength("Opening chapter.", "en_words"),
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z",
        auditIssues: [],
        lengthWarnings: [],
      },
      {
        number: 2,
        title: "Test Chapter",
        status: "audit-failed",
        wordCount: countChapterLength(originalBody, "en_words"),
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z",
        auditIssues: [],
        lengthWarnings: [],
      },
    ]);

    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [{
            severity: "warning",
            category: "Pacing Check",
            description: "The beat needs a firmer end stop.",
            suggestion: "Tighten the closing move.",
          }],
          summary: "needs revision",
        }),
      )
      .mockImplementationOnce(async (_bookDir, _chapterContent, chapterNumber, _genre, options) => {
        const overrideState = (options as { truthFileOverrides?: { currentState?: string } } | undefined)
          ?.truthFileOverrides?.currentState;
        if (chapterNumber === 2 && overrideState?.includes("| Current Chapter | 2 |")) {
          return createAuditResult({
            passed: true,
            issues: [],
            summary: "clean",
          });
        }

        return createAuditResult({
          passed: false,
          issues: [{
            severity: "critical",
            category: "Chronicle Drift Check",
            description: "The chapter is presented as 'chapter 2', but the supplied Current State Card still lists 'Current Chapter | 1'.",
            suggestion: "Sync the state card before re-audit.",
          }],
          summary: "stale state card",
        });
      });

    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: revisedBody,
        wordCount: countChapterLength(revisedBody, "en_words"),
        fixedIssues: ["- Synced the annexe beat and tightened the ending."],
      }),
    );

    try {
      await snapshotRevisionBaseline(state, bookId, 1);
      const result = await runner.reviseDraft(bookId, 2);
      const savedIndex = await state.loadChapterIndex(bookId);

      expect(auditChapter).toHaveBeenCalledTimes(2);
      expect(result.applied).toBe(true);
      expect(result.status).toBe("ready-for-review");
      expect(savedIndex[1]?.status).toBe("ready-for-review");
      expect(savedIndex[1]?.auditIssues).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("excludes pure sequence-level fatigue from revision blocker counts", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const book = await state.loadBookConfig(bookId);

    await writeFile(join(storyDir, "chapter_summaries.md"), [
      "# 章节摘要",
      "",
      "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| 1 | 旧门 | 林越 | 进入旧门 | 压力升高 | none | 冷峻 | 调查 |",
      "| 2 | 灰灯 | 林越 | 检查灰灯 | 压力升高 | none | 冷峻 | 调查 |",
      "| 3 | 纸页 | 林越 | 对照纸页 | 压力升高 | none | 冷峻 | 调查 |",
      "",
    ].join("\n"), "utf-8");
    await Promise.all([1, 2, 3, 4].map((chapter) =>
      savePacingPlan(bookDir, chapter, "escalation")));

    const result = await (
      runner as unknown as {
        evaluateMergedAudit: (params: {
          auditor: Pick<ContinuityAuditor, "auditChapter">;
          book: BookConfig;
          bookDir: string;
          chapterContent: string;
          chapterNumber: number;
          language: "zh" | "en";
        }) => Promise<{
          auditResult: AuditResult;
          aiTellCount: number;
          blockingCount: number;
          criticalCount: number;
        }>;
      }
    ).evaluateMergedAudit({
      auditor: {
        auditChapter: vi.fn().mockResolvedValue(
          createAuditResult({
            passed: true,
            issues: [],
            summary: "clean",
          }),
        ),
      },
      book,
      bookDir,
      chapterContent: "林越把纸页摊平，先看角上的水痕，再看最末那道被抹掉的签名。",
      chapterNumber: 4,
      language: "zh",
    });

    expect(result.auditResult.issues.some((issue) => issue.category === "节奏单调")).toBe(true);
    expect(result.blockingCount).toBe(0);
    expect(result.criticalCount).toBe(0);

    await rm(root, { recursive: true, force: true });
  });

  it("merges host-bound transition findings into manual audit and revision blockers", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const bookDir = state.bookDir(bookId);
    const book = await state.loadBookConfig(bookId);
    const transitionFinding: AuditIssue = {
      severity: "critical",
      category: "Transition Continuity",
      description: "The current state reverses the previous chapter without a cause.",
      suggestion: "Keep the prior state or depict the causal change.",
      ruleId: "continuity.transition",
      source: "deterministic",
      verification: "verified",
      repairScope: "structural",
      repairTarget: "prose",
    };

    const result = await (
      runner as unknown as {
        evaluateMergedAudit: (params: {
          auditor: Pick<ContinuityAuditor, "auditChapter">;
          book: BookConfig;
          bookDir: string;
          chapterContent: string;
          chapterNumber: number;
          language: "zh" | "en";
        }) => Promise<{
          auditResult: AuditResult;
          blockingCount: number;
          criticalCount: number;
          revisionBlockingIssues: ReadonlyArray<AuditIssue>;
        }>;
      }
    ).evaluateMergedAudit({
      auditor: {
        auditChapter: vi.fn().mockResolvedValue(
          createAuditResult({
            passed: false,
            issues: [],
            hostFindings: [transitionFinding],
            summary: "transition contradiction",
            overallScore: 92,
          }),
        ),
      },
      book,
      bookDir,
      chapterContent: "The next scene silently restores the old measurement.",
      chapterNumber: 4,
      language: "en",
    });

    expect(result.auditResult.decision).toBe("fail");
    expect(result.auditResult.passed).toBe(false);
    expect(result.auditResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "continuity.transition", verification: "verified" }),
    ]));
    expect(result.revisionBlockingIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "continuity.transition" }),
    ]));
    expect(result.blockingCount).toBe(1);
    expect(result.criticalCount).toBe(1);

    await rm(root, { recursive: true, force: true });
  });

  it("keeps chapter-level blockers even when sequence-level fatigue shares the same category label", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const book = await state.loadBookConfig(bookId);

    await writeFile(join(storyDir, "chapter_summaries.md"), [
      "# 章节摘要",
      "",
      "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| 1 | 旧门 | 林越 | 进入旧门 | 压力升高 | none | 冷峻 | 调查 |",
      "| 2 | 灰灯 | 林越 | 检查灰灯 | 压力升高 | none | 冷峻 | 调查 |",
      "| 3 | 纸页 | 林越 | 对照纸页 | 压力升高 | none | 冷峻 | 调查 |",
      "",
    ].join("\n"), "utf-8");
    await Promise.all([1, 2, 3, 4].map((chapter) =>
      savePacingPlan(bookDir, chapter, "escalation")));

    const result = await (
      runner as unknown as {
        evaluateMergedAudit: (params: {
          auditor: Pick<ContinuityAuditor, "auditChapter">;
          book: BookConfig;
          bookDir: string;
          chapterContent: string;
          chapterNumber: number;
          language: "zh" | "en";
        }) => Promise<{
          auditResult: AuditResult;
          aiTellCount: number;
          blockingCount: number;
          criticalCount: number;
        }>;
      }
    ).evaluateMergedAudit({
      auditor: {
        auditChapter: vi.fn().mockResolvedValue(
          createAuditResult({
            passed: false,
            issues: [{
              severity: "warning",
              category: "节奏单调",
              description: "这一章的推进依然原地打转，没有完成当前场景应有的落点。",
              suggestion: "让当前章把既定动作落下，不要继续停在同一观察节拍。",
            }],
            summary: "needs revision",
          }),
        ),
      },
      book,
      bookDir,
      chapterContent: "林越把纸页摊平，先看角上的水痕，再看最末那道被抹掉的签名。",
      chapterNumber: 4,
      language: "zh",
    });

    expect(result.auditResult.issues.filter((issue) => issue.category === "节奏单调")).toHaveLength(2);
    expect(result.blockingCount).toBe(1);
    expect(result.criticalCount).toBe(0);

    await rm(root, { recursive: true, force: true });
  });

  it("uses persisted telemetry counting mode for a no-issues manual return", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const originalBody = "Tarin waited by the berth marker until the second bell rang.";
    await state.saveBookConfig(bookId, {
      ...(await state.loadBookConfig(bookId)),
      language: "zh",
      chapterWordCount: 1800,
    });
    await writeFile(join(chaptersDir, "0001_Test_Chapter.md"), `# Chapter 1\n\n${originalBody}`, "utf-8");
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "Test Chapter",
      status: "audit-failed",
      wordCount: countChapterLength(originalBody, "en_words"),
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
      lengthTelemetry: {
        target: 10,
        softMin: 8,
        softMax: 12,
        hardMin: 6,
        hardMax: 15,
        countingMode: "en_words",
        writerCount: countChapterLength(originalBody, "en_words"),
        postReviseCount: 0,
        finalCount: countChapterLength(originalBody, "en_words"),
        repairApplied: false,
        lengthWarning: false,
      },
    }]);
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter");
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({ passed: true, issues: [], summary: "clean", overallScore: 95 }),
    );

    try {
      const result = await runner.reviseDraft(bookId, 1);

      expect(result).toMatchObject({ applied: false, status: "unchanged" });
      expect(result.wordCount).toBe(countChapterLength(originalBody, "en_words"));
      expect(reviseChapter).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("degrades state when governed hook evidence still contradicts intent after settlement retry", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const hook = {
      hookId: "mentor-debt",
      startChapter: 0,
      type: "mystery",
      status: "deferred" as const,
      lastAdvancedChapter: 1,
      expectedPayoff: "Reveal the mentor's debt.",
      notes: "Runtime explicitly deferred this hook.",
    };
    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 0,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The debt trail keeps narrowing.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);
    vi.spyOn(PlannerAgent.prototype, "planChapter").mockResolvedValueOnce({
      intent: {
        chapter: 1,
        goal: "Resolve the mentor debt.",
        mustKeep: [],
        mustAvoid: [],
        styleEmphasis: [],
        acceptanceCriteria: ["Hook mentor-debt must be resolved in typed runtime state."],
        pacingCode: "payoff",
        expectedHookOps: { upsert: [], mention: [], resolve: ["mentor-debt"], defer: [] },
      },
      memo: {
        chapter: 1,
        goal: "Resolve the mentor debt.",
        isGoldenOpening: false,
        body: "",
        threadRefs: [],
      },
      intentMarkdown: "# Chapter Intent\n",
      plannerInputs: [],
      runtimePath: join(storyDir, "runtime", "chapter-0001.intent.md"),
    });
    const contradictoryOutput = createWriterOutput({
      runtimeStateDelta: {
        chapter: 1,
        hookOps: { upsert: [], mention: [], resolve: [], defer: ["mentor-debt"] },
        newHookCandidates: [],
        chapterSummary: {
          chapter: 1,
          title: "Test Chapter",
          characters: "Lin Yue",
          events: "The debt is delayed.",
          stateChanges: "None",
          hookActivity: "mentor-debt deferred",
          mood: "tense",
          chapterType: "mainline",
        },
        subplotOps: [],
        emotionalArcOps: [],
        characterMatrixOps: [],
        notes: [],
      },
      runtimeStateSnapshot: {
        manifest: {
          schemaVersion: 2,
          language: "zh",
          lastAppliedChapter: 1,
          projectionVersion: 1,
          migrationWarnings: [],
        },
        currentState: { chapter: 1, facts: [] },
        hooks: { hooks: [hook] },
        chapterSummaries: { rows: [] },
      },
      updatedHooks: "# Pending Hooks\n",
    });
    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(contradictoryOutput);
    const settleChapterState = vi.mocked(WriterAgent.prototype.settleChapterState);
    settleChapterState.mockResolvedValue(contradictoryOutput);
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(createAuditResult({
      passed: true,
      issues: [],
      summary: "LLM found no issue.",
      overallScore: 95,
    }));

    try {
      const result = await runner.writeNextChapter(bookId, 25);
      const contradiction = result.auditResult.issues.find(
        (issue) => issue.category === "hook-runtime-contradiction",
      );

      expect(result.status).toBe("state-degraded");
      expect(contradiction).toEqual(expect.objectContaining({
        severity: "critical",
        verification: "verified",
        acceptanceCriteria: ["Hook mentor-debt must be resolved in typed runtime state."],
        evidence: expect.objectContaining({ stateRef: "runtime:hook:mentor-debt" }),
      }));
      expect(settleChapterState).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses persisted hard length to revise despite an LLM pass and counts unchanged output by telemetry", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const originalBody = "Tarin waited by the crooked berth marker and counted the missing lines twice.";
    const revisedBody = `${originalBody}\n\nHe did not move until the second bell rang across the water.`;

    await state.saveBookConfig(bookId, {
      ...(await state.loadBookConfig(bookId)),
      platform: "other",
      genre: "progression",
      language: "zh",
      chapterWordCount: 1800,
    });

    await Promise.all([
      writeFile(join(chaptersDir, "0001_Test_Chapter.md"), `# Chapter 1: Test Chapter\n\n${originalBody}`, "utf-8"),
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 1,
        location: "Dock Nine",
        protagonistState: "Tarin still carries the sealed packet.",
        goal: "Find Captain Voss.",
        conflict: "The berth is wrong and the crew is missing.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "Test Chapter",
      status: "audit-failed",
      wordCount: countChapterLength(originalBody, "en_words"),
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
      lengthTelemetry: {
        target: 900,
        softMin: 778,
        softMax: 1022,
        hardMin: 655,
        hardMax: 1145,
        countingMode: "en_words",
        writerCount: countChapterLength(originalBody, "en_words"),
        postReviseCount: 0,
        finalCount: countChapterLength(originalBody, "en_words"),
        repairApplied: false,
        lengthWarning: false,
      },
    }]);

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: true,
          issues: [],
          summary: "LLM clean",
        }),
      )
      .mockResolvedValueOnce(
        createAuditResult({
          passed: true,
          issues: [],
          summary: "clean",
        }),
      );

    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: revisedBody,
        wordCount: countChapterLength(revisedBody, "en_words"),
        fixedIssues: ["- Tightened the berth discovery beat."],
      }),
    );

    try {
      await snapshotRevisionBaseline(state, bookId, 0);
      const result = await runner.reviseDraft(bookId, 1);

      expect(reviseChapter).toHaveBeenCalledTimes(1);
      expect(reviseChapter.mock.calls[0]?.[6]?.lengthSpec).toMatchObject({
        target: 900,
        countingMode: "en_words",
      });
      expect(result.applied).toBe(false);
      expect(result.skippedReason).toContain("acceptance gate");
      expect(result.wordCount).toBe(countChapterLength(originalBody, "en_words"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
