import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WriterAgent,
  type PreparedChapterFileSet,
  type WriteChapterOutput,
} from "../agents/writer.js";
import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { ChapterMeta } from "../models/chapter.js";
import { WritingLanguagePreflightError } from "../state/writing-language-preflight.js";
import { persistChapterArtifacts } from "../pipeline/chapter-persistence.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createIssue(overrides?: Partial<AuditIssue>): AuditIssue {
  return {
    severity: "warning",
    category: "continuity",
    description: "issue",
    suggestion: "fix",
    ...overrides,
  };
}

function createAuditResult(overrides?: Partial<AuditResult>): AuditResult {
  return {
    passed: true,
    issues: [],
    summary: "clean",
    ...overrides,
  };
}

function createWriter(projectRoot: string): WriterAgent {
  return new WriterAgent({
    client: {
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
    },
    model: "test-model",
    projectRoot,
  });
}

function createVietnameseOutput(): WriteChapterOutput {
  return {
    chapterNumber: 3,
    title: "Mưa đêm",
    content: "Mưa rơi trên mái ngói cũ.",
    wordCount: 7,
    preWriteCheck: "",
    postSettlement: "",
    runtimeStateDelta: { chapter: 3 } as never,
    runtimeStateSnapshot: {
      manifest: {
        schemaVersion: 2,
        language: "vi",
        lastAppliedChapter: 3,
        projectionVersion: 1,
        migrationWarnings: [],
      },
      currentState: { chapter: 3, facts: [] },
      hooks: { hooks: [] },
      chapterSummaries: { rows: [] },
    },
    updatedState: "# Trạng thái hiện tại\n",
    updatedLedger: "# Sổ theo dõi\n",
    updatedHooks: "# Tình tiết cài cắm\n",
    chapterSummary: "| 3 | Mưa đêm | Lan | Trú mưa | Chờ đợi | H01 tiến triển | Lặng lẽ | Chuyển tiếp |",
    updatedChapterSummaries: "# Tóm tắt chương\n",
    updatedSubplots: "# Tuyến phụ\n",
    updatedEmotionalArcs: "# Cung cảm xúc\n",
    updatedCharacterMatrix: "# Ma trận nhân vật\n",
    postWriteErrors: [],
    postWriteWarnings: [],
  };
}

const EMPTY_FILE_SET: PreparedChapterFileSet = {
  writes: [],
  deletes: [],
  chapterFileName: "0003_Chapter_Title.md",
};

describe("WriterAgent.prepareChapterFileSet", () => {
  it("allows a state-degraded vi chapter without delta/snapshot, persisting the old baseline with no runtime state writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-chapter-degraded-"));
    roots.push(root);
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    const degraded: WriteChapterOutput = {
      ...createVietnameseOutput(),
      runtimeStateDelta: undefined,
      runtimeStateSnapshot: undefined,
    };

    const fileSet = await createWriter(root).prepareChapterFileSet(
      bookDir,
      degraded,
      true,
      "vi",
      true,
    );

    expect(fileSet.chapterFileName.startsWith("0003_")).toBe(true);
    const paths = fileSet.writes.map((write) => write.relativePath);
    expect(paths).toContain(join("chapters", fileSet.chapterFileName));
    expect(paths).toContain(join("story", "current_state.md"));
    expect(paths).toContain(join("story", "pending_hooks.md"));
    expect(paths).not.toContain(join("story", "state", "current_state.json"));
    expect(paths).not.toContain(join("story", "state", "manifest.json"));
    const stateWrite = fileSet.writes.find(
      (write) => write.relativePath === join("story", "current_state.md"),
    );
    expect(stateWrite?.content).toBe("# Trạng thái hiện tại\n");
  });

  it("still rejects a vi chapter without delta/snapshot when not state-degraded", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-chapter-degraded-"));
    roots.push(root);
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    const degraded: WriteChapterOutput = {
      ...createVietnameseOutput(),
      runtimeStateDelta: undefined,
      runtimeStateSnapshot: undefined,
    };

    await expect(
      createWriter(root).prepareChapterFileSet(bookDir, degraded, true, "vi"),
    ).rejects.toThrow(WritingLanguagePreflightError);
  });

  it("prepares chapter, truth, runtime writes and old chapter deletes without writing the filesystem", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-chapter-prepare-"));
    roots.push(root);
    const bookDir = join(root, "book");
    const chaptersDir = join(bookDir, "chapters");
    await mkdir(chaptersDir, { recursive: true });
    await writeFile(join(chaptersDir, "0003_Old_title.md"), "old chapter", "utf-8");
    const entriesBefore = (await readdir(bookDir, { recursive: true })).sort();

    const fileSet = await createWriter(root).prepareChapterFileSet(
      bookDir,
      createVietnameseOutput(),
      true,
      "vi",
    );

    expect(fileSet.chapterFileName).toBe("0003_Mưa_đêm.md");
    expect(fileSet.deletes).toEqual([join("chapters", "0003_Old_title.md")]);
    expect(fileSet.writes.map((write) => write.relativePath)).toEqual(expect.arrayContaining([
      join("chapters", "0003_Mưa_đêm.md"),
      join("story", "current_state.md"),
      join("story", "pending_hooks.md"),
      join("story", "chapter_summaries.md"),
      join("story", "subplot_board.md"),
      join("story", "emotional_arcs.md"),
      join("story", "character_matrix.md"),
      join("story", "particle_ledger.md"),
      join("story", "state", "manifest.json"),
      join("story", "state", "current_state.json"),
      join("story", "state", "hooks.json"),
      join("story", "state", "chapter_summaries.json"),
    ]));
    expect((await readdir(bookDir, { recursive: true })).sort()).toEqual(entriesBefore);
  });

  it("keeps delta-only legacy preparation pure without bootstrapping runtime state", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-chapter-prepare-legacy-"));
    roots.push(root);
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    const entriesBefore = (await readdir(bookDir, { recursive: true })).sort();
    const output: WriteChapterOutput = {
      ...createVietnameseOutput(),
      runtimeStateDelta: {
        chapter: 3,
        hookOps: { upsert: [], mention: [], resolve: [], defer: [] },
        newHookCandidates: [],
        subplotOps: [],
        emotionalArcOps: [],
        characterMatrixOps: [],
        notes: [],
      },
      runtimeStateSnapshot: undefined,
      updatedChapterSummaries: undefined,
    };

    const fileSet = await createWriter(root).prepareChapterFileSet(
      bookDir,
      output,
      false,
      "en",
    );

    expect(fileSet.writes.map((write) => write.relativePath)).not.toContain(
      join("story", "state", "manifest.json"),
    );
    expect(fileSet.writes).toContainEqual(expect.objectContaining({
      relativePath: join("story", "chapter_summaries.md"),
      content: expect.stringContaining(output.chapterSummary),
    }));
    expect((await readdir(bookDir, { recursive: true })).sort()).toEqual(entriesBefore);
  });

  it("purely renders missing markdown projections from a provided snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-chapter-prepare-snapshot-"));
    roots.push(root);
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    const entriesBefore = (await readdir(bookDir, { recursive: true })).sort();
    const output: WriteChapterOutput = {
      ...createVietnameseOutput(),
      updatedState: "",
      updatedHooks: "",
      updatedChapterSummaries: "",
    };

    const fileSet = await createWriter(root).prepareChapterFileSet(
      bookDir,
      output,
      false,
      "vi",
    );

    expect(fileSet.writes).toContainEqual(expect.objectContaining({
      relativePath: join("story", "current_state.md"),
      content: expect.stringContaining("#"),
    }));
    expect(fileSet.writes).toContainEqual(expect.objectContaining({
      relativePath: join("story", "pending_hooks.md"),
      content: expect.stringContaining("#"),
    }));
    expect(fileSet.writes).toContainEqual(expect.objectContaining({
      relativePath: join("story", "chapter_summaries.md"),
      content: expect.stringContaining("#"),
    }));
    expect((await readdir(bookDir, { recursive: true })).sort()).toEqual(entriesBefore);
  });
});

describe("persistChapterArtifacts", () => {
  it("includes audit-run writes in the same canonical file set", async () => {
    const prepareCanonicalFiles = vi.fn().mockResolvedValue({
      ...EMPTY_FILE_SET,
      writes: [{ relativePath: join("chapters", "0003_Chapter_Title.md"), content: "chapter" }],
    });
    const commitCanonicalFiles = vi.fn().mockResolvedValue(undefined);
    const auditRunWrite = {
      relativePath: join("story", "audit", "runs", "chapter-0003", "run.initial.audit-run-v1.json"),
      content: "{\"kind\":\"audit-run-v1\"}\n",
    };

    const result = await persistChapterArtifacts({
      chapterNumber: 3,
      chapterTitle: "Chapter Title",
      status: "audit-failed",
      auditResult: createAuditResult({ passed: false }),
      auditRunWrites: [auditRunWrite],
      finalWordCount: 888,
      lengthWarnings: [],
      degradedIssues: [],
      localRepair: {
        attempted: true,
        applied: true,
        patchCount: 1,
        inputContentHash: "a".repeat(64),
        outputContentHash: "b".repeat(64),
      },
      providerCallTelemetry: {
        total: 2,
        byStage: { "initial-auditor": 1, "post-candidate-auditor": 1 },
        transportRetries: 0,
        outputRetries: 0,
      },
      loadChapterIndex: async () => [],
      prepareCanonicalFiles,
      commitCanonicalFiles,
      markBookActiveIfNeeded: vi.fn().mockResolvedValue(undefined),
      persistAuditDriftGuidance: vi.fn().mockResolvedValue(undefined),
      snapshotState: vi.fn().mockResolvedValue(undefined),
      syncCurrentStateFactHistory: vi.fn().mockResolvedValue(undefined),
      logSnapshotStage: vi.fn(),
    });

    expect(commitCanonicalFiles.mock.calls[0]?.[0].writes).toEqual([
      expect.objectContaining({ relativePath: join("chapters", "0003_Chapter_Title.md") }),
      auditRunWrite,
    ]);
    expect(result.entry.localRepair).toMatchObject({ applied: true, patchCount: 1 });
    expect(result.entry.providerCallTelemetry).toMatchObject({
      total: 2,
      byStage: { "initial-auditor": 1, "post-candidate-auditor": 1 },
    });
  });

  it("derives rejected attempt metadata from an initial-only audit run", async () => {
    const result = await persistChapterArtifacts({
      chapterNumber: 3,
      chapterTitle: "Rejected candidate",
      status: "audit-failed",
      auditResult: createAuditResult({ passed: false, decision: "fail" }),
      auditRuns: [{
        chapterNumber: 3,
        phase: "initial",
        attemptId: "11111111-1111-4111-8111-111111111111",
        revision: {
          attempted: true,
          candidateProduced: true,
          accepted: false,
          rejectionReason: "state settlement is invalid",
        },
      } as never],
      finalWordCount: 888,
      lengthWarnings: [],
      degradedIssues: [],
      loadChapterIndex: async () => [],
      prepareCanonicalFiles: vi.fn().mockResolvedValue(EMPTY_FILE_SET),
      commitCanonicalFiles: vi.fn().mockResolvedValue(undefined),
      markBookActiveIfNeeded: vi.fn().mockResolvedValue(undefined),
      persistAuditDriftGuidance: vi.fn().mockResolvedValue(undefined),
      snapshotState: vi.fn().mockResolvedValue(undefined),
      syncCurrentStateFactHistory: vi.fn().mockResolvedValue(undefined),
      logSnapshotStage: vi.fn(),
    });

    expect(result.entry).toMatchObject({
      revisionAttempts: 1,
      revisionOutcome: "rejected",
      revisionRejectionReason: "state settlement is invalid",
    });
  });

  it("prepares and commits the canonical file set exactly once with the updated index", async () => {
    const prepareCanonicalFiles = vi.fn().mockResolvedValue(EMPTY_FILE_SET);
    const commitCanonicalFiles = vi.fn().mockResolvedValue(undefined);
    const legacy = {
      saveChapter: vi.fn().mockResolvedValue(undefined),
      saveTruthFiles: vi.fn().mockResolvedValue(undefined),
      saveChapterIndex: vi.fn().mockResolvedValue(undefined),
    };
    const markBookActiveIfNeeded = vi.fn().mockResolvedValue(undefined);
    const persistAuditDriftGuidance = vi.fn().mockResolvedValue(undefined);
    const snapshotState = vi.fn().mockResolvedValue(undefined);
    const syncCurrentStateFactHistory = vi.fn().mockResolvedValue(undefined);
    const logSnapshotStage = vi.fn();
    const loadChapterIndex = vi.fn().mockResolvedValue([] satisfies ReadonlyArray<ChapterMeta>);

    await persistChapterArtifacts({
      chapterNumber: 3,
      chapterTitle: "Chapter Title",
      status: "ready-for-review",
      auditResult: createAuditResult({
        issues: [
          createIssue({ severity: "info", description: "ignore me" }),
          createIssue({ severity: "warning", description: "keep me" }),
          createIssue({ severity: "critical", description: "keep me too" }),
        ],
      }),
      finalWordCount: 888,
      lengthWarnings: ["warn"],
      degradedIssues: [],
      tokenUsage: ZERO_USAGE,
      loadChapterIndex,
      prepareCanonicalFiles,
      commitCanonicalFiles,
      markBookActiveIfNeeded,
      persistAuditDriftGuidance,
      snapshotState,
      syncCurrentStateFactHistory,
      logSnapshotStage,
      now: () => "2026-04-01T00:00:00.000Z",
      ...legacy,
    });

    expect(loadChapterIndex).toHaveBeenCalledTimes(1);
    expect(prepareCanonicalFiles).toHaveBeenCalledTimes(1);
    const updatedIndex = prepareCanonicalFiles.mock.calls[0][0] as ReadonlyArray<ChapterMeta>;
    expect(updatedIndex).toEqual([
      expect.objectContaining({
        number: 3,
        title: "Chapter Title",
        status: "ready-for-review",
        wordCount: 888,
        auditIssues: [
          "[info] ignore me",
          "[warning] keep me",
          "[critical] keep me too",
        ],
        reviewNote: undefined,
        tokenUsage: ZERO_USAGE,
      }),
    ]);
    expect(commitCanonicalFiles).toHaveBeenCalledTimes(1);
    expect(commitCanonicalFiles).toHaveBeenCalledWith(EMPTY_FILE_SET, updatedIndex);
    expect(loadChapterIndex.mock.invocationCallOrder[0])
      .toBeLessThan(prepareCanonicalFiles.mock.invocationCallOrder[0]);
    expect(prepareCanonicalFiles.mock.invocationCallOrder[0])
      .toBeLessThan(commitCanonicalFiles.mock.invocationCallOrder[0]);
    expect(legacy.saveChapter).not.toHaveBeenCalled();
    expect(legacy.saveTruthFiles).not.toHaveBeenCalled();
    expect(legacy.saveChapterIndex).not.toHaveBeenCalled();
    expect(markBookActiveIfNeeded).toHaveBeenCalledTimes(1);
    expect(persistAuditDriftGuidance).toHaveBeenCalledWith([
      expect.objectContaining({ severity: "warning", description: "keep me" }),
      expect.objectContaining({ severity: "critical", description: "keep me too" }),
    ]);
    expect(logSnapshotStage).toHaveBeenCalledTimes(1);
    expect(snapshotState).toHaveBeenCalledTimes(1);
    expect(syncCurrentStateFactHistory).toHaveBeenCalledTimes(1);
  });

  it("does not run derived persistence when the canonical commit rejects", async () => {
    const commitError = new Error("canonical commit failed");
    const markBookActiveIfNeeded = vi.fn().mockResolvedValue(undefined);
    const persistAuditDriftGuidance = vi.fn().mockResolvedValue(undefined);
    const snapshotState = vi.fn().mockResolvedValue(undefined);
    const syncCurrentStateFactHistory = vi.fn().mockResolvedValue(undefined);
    const logSnapshotStage = vi.fn();

    await expect(persistChapterArtifacts({
      chapterNumber: 3,
      chapterTitle: "Chapter Title",
      status: "ready-for-review",
      auditResult: createAuditResult(),
      finalWordCount: 888,
      lengthWarnings: [],
      degradedIssues: [],
      loadChapterIndex: async () => [],
      prepareCanonicalFiles: vi.fn().mockResolvedValue(EMPTY_FILE_SET),
      commitCanonicalFiles: vi.fn().mockRejectedValue(commitError),
      markBookActiveIfNeeded,
      persistAuditDriftGuidance,
      snapshotState,
      syncCurrentStateFactHistory,
      logSnapshotStage,
    })).rejects.toBe(commitError);

    expect(markBookActiveIfNeeded).not.toHaveBeenCalled();
    expect(persistAuditDriftGuidance).not.toHaveBeenCalled();
    expect(logSnapshotStage).not.toHaveBeenCalled();
    expect(snapshotState).not.toHaveBeenCalled();
    expect(syncCurrentStateFactHistory).not.toHaveBeenCalled();
  });

  it("keeps state-degraded review and derived-state semantics", async () => {
    const prepareCanonicalFiles = vi.fn().mockResolvedValue(EMPTY_FILE_SET);
    const commitCanonicalFiles = vi.fn().mockResolvedValue(undefined);
    const persistAuditDriftGuidance = vi.fn().mockResolvedValue(undefined);
    const snapshotState = vi.fn().mockResolvedValue(undefined);
    const syncCurrentStateFactHistory = vi.fn().mockResolvedValue(undefined);
    const logSnapshotStage = vi.fn();

    const result = await persistChapterArtifacts({
      chapterNumber: 4,
      chapterTitle: "Degraded Chapter",
      status: "state-degraded",
      auditResult: createAuditResult({
        passed: false,
        issues: [createIssue({ description: "audit issue" })],
        summary: "needs review",
      }),
      finalWordCount: 512,
      lengthWarnings: [],
      degradedIssues: [createIssue({ description: "state mismatch" })],
      tokenUsage: ZERO_USAGE,
      loadChapterIndex: async () => [],
      prepareCanonicalFiles,
      commitCanonicalFiles,
      markBookActiveIfNeeded: vi.fn().mockResolvedValue(undefined),
      persistAuditDriftGuidance,
      snapshotState,
      syncCurrentStateFactHistory,
      logSnapshotStage,
      now: () => "2026-04-01T00:00:00.000Z",
    });

    expect(prepareCanonicalFiles).toHaveBeenCalledTimes(1);
    expect(commitCanonicalFiles).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.entry.reviewNote ?? "")).toMatchObject({
      kind: "state-degraded",
      baseStatus: "audit-failed",
      injectedIssues: ["[warning] state mismatch"],
    });
    expect(persistAuditDriftGuidance).toHaveBeenCalledWith([]);
    expect(logSnapshotStage).not.toHaveBeenCalled();
    expect(snapshotState).not.toHaveBeenCalled();
    expect(syncCurrentStateFactHistory).not.toHaveBeenCalled();
  });

  it("replaces an existing entry while preserving createdAt and explicit telemetry", async () => {
    const existingEntry: ChapterMeta = {
      number: 1,
      title: "Old Title",
      status: "drafted",
      wordCount: 500,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    };
    const lengthTelemetry = {
      language: "vi" as const,
      target: 2000,
      softMin: 1800,
      softMax: 2200,
      hardMin: 1600,
      hardMax: 2400,
      countingMode: "vi_wordlike_tokens_v1" as const,
      writerCount: 1990,
      postReviseCount: 2001,
      finalCount: 2001,
      repairApplied: true,
      lengthWarning: false,
    };
    const prepareCanonicalFiles = vi.fn().mockResolvedValue(EMPTY_FILE_SET);
    const commitCanonicalFiles = vi.fn().mockResolvedValue(undefined);

    await persistChapterArtifacts({
      chapterNumber: 1,
      chapterTitle: "New Title",
      status: "ready-for-review",
      auditResult: createAuditResult(),
      finalWordCount: 2001,
      lengthWarnings: [],
      lengthTelemetry,
      degradedIssues: [],
      tokenUsage: ZERO_USAGE,
      loadChapterIndex: async () => [existingEntry],
      prepareCanonicalFiles,
      commitCanonicalFiles,
      markBookActiveIfNeeded: vi.fn().mockResolvedValue(undefined),
      persistAuditDriftGuidance: vi.fn().mockResolvedValue(undefined),
      snapshotState: vi.fn().mockResolvedValue(undefined),
      syncCurrentStateFactHistory: vi.fn().mockResolvedValue(undefined),
      logSnapshotStage: vi.fn(),
      now: () => "2026-04-01T00:00:00.000Z",
    });

    const updatedIndex = prepareCanonicalFiles.mock.calls[0][0] as ChapterMeta[];
    expect(updatedIndex).toHaveLength(1);
    expect(updatedIndex[0]).toMatchObject({
      number: 1,
      title: "New Title",
      wordCount: 2001,
      status: "ready-for-review",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      lengthTelemetry,
    });
    expect(commitCanonicalFiles).toHaveBeenCalledWith(EMPTY_FILE_SET, updatedIndex);
  });
});
