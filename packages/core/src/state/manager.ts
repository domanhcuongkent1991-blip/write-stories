import { readFile, writeFile, mkdir, readdir, rm, stat, unlink, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { BookConfigSchema, type BookConfig } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import { computeChapterContentHash } from "../audit/chapter-audit-evaluator.js";
import {
  AuditRunV1Schema,
  auditRunRelativePath,
  type AuditRunV1,
} from "../audit/audit-run.js";
import { bootstrapStructuredStateFromMarkdown, resolveDurableStoryProgress } from "./state-bootstrap.js";
import {
  WritingLanguageSchema,
  type ScaffoldLanguage,
  type WritingLanguage,
} from "../models/writing-language.js";
import { resolveWritingLanguageProfile } from "../utils/language.js";
import { countChapterLength, resolveLengthCountingMode } from "../utils/length-metrics.js";

const BOOK_LOCK_HEARTBEAT_MS = 30_000;
const BOOK_LOCK_LEASE_MS = 3 * 60_000;
const BOOK_LOCK_RELEASE_RETRIES = 4;
const AUDIT_RECOVERY_NOTE = "Canonical audit evidence is unavailable or does not match this chapter. Re-audit is required before review.";

export interface CanonicalChapterProjection {
  readonly chapterRelativePath: string;
  readonly contentHash: string;
  readonly meta: ChapterMeta;
  readonly auditRun?: AuditRunV1;
}

interface BookLockMetadata {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
  readonly startedAt: number;
  heartbeatAt: number;
}

interface ProcessBookLock {
  readonly metadata: BookLockMetadata;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  heartbeatTask?: Promise<void>;
}

// Studio creates a PipelineRunner per request. Lock ownership therefore has to
// be shared by every StateManager in this process, not stored on one instance.
const processBookLocks = new Map<string, ProcessBookLock>();

export class BookWriteLockError extends Error {
  readonly code = "BOOK_BUSY";

  constructor(
    readonly bookId: string,
    readonly lockPath: string,
    lockData?: string,
  ) {
    super(
      `Book "${bookId}" is locked by an active InkOS write${lockData ? ` (${lockData})` : ""}. ` +
      "Wait for it to finish or stop the running task, then retry. Stale locks are recovered automatically.",
    );
    this.name = "BookWriteLockError";
  }
}

export class StateManager {
  constructor(private readonly projectRoot: string) {}

  private static defaultAuthorIntent(language: ScaffoldLanguage): string {
    return language === "zh"
      ? "# 作者意图\n\n（在这里描述这本书的长期创作方向。）\n"
      : "# Author Intent\n\n(Describe the long-horizon vision for this book here.)\n";
  }

  private static defaultCurrentFocus(language: ScaffoldLanguage): string {
    return language === "zh"
      ? "# 当前聚焦\n\n## 当前重点\n\n（描述接下来 1-3 章最需要优先推进的内容。）\n"
      : "# Current Focus\n\n## Active Focus\n\n(Describe what the next 1-3 chapters should prioritize.)\n";
  }

  async ensureControlDocuments(bookId: string, authorIntent?: string): Promise<void> {
    const language = await this.resolveControlDocumentLanguage(bookId);
    await this.ensureControlDocumentsAt(this.bookDir(bookId), language, authorIntent);
  }

  async ensureControlDocumentsAt(
    bookDir: string,
    writingLanguage: WritingLanguage,
    authorIntent?: string,
  ): Promise<void> {
    const language = WritingLanguageSchema.parse(writingLanguage);
    const scaffoldLanguage = resolveWritingLanguageProfile(language).scaffoldLanguage;
    const storyDir = join(bookDir, "story");
    const runtimeDir = join(storyDir, "runtime");
    const outlineDir = join(storyDir, "outline");
    const rolesMajorDir = join(storyDir, "roles", "主要角色");
    const rolesMinorDir = join(storyDir, "roles", "次要角色");

    await mkdir(storyDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await mkdir(outlineDir, { recursive: true });
    await mkdir(rolesMajorDir, { recursive: true });
    await mkdir(rolesMinorDir, { recursive: true });

    await this.writeIfMissing(
      join(storyDir, "author_intent.md"),
      authorIntent?.trim()
        ? authorIntent.trimEnd() + "\n"
        : StateManager.defaultAuthorIntent(scaffoldLanguage),
    );

    await this.writeIfMissing(
      join(storyDir, "current_focus.md"),
      StateManager.defaultCurrentFocus(scaffoldLanguage),
    );

    // Ensure style_guide includes writing methodology even without reference text
    const styleGuidePath = join(storyDir, "style_guide.md");
    try {
      const existing = await readFile(styleGuidePath, "utf-8");
      if (!existing.includes("写作方法论") && !existing.includes("Writing Methodology")) {
        const { buildWritingMethodologySection } = await import("../utils/writing-methodology.js");
        await writeFile(styleGuidePath, `${existing}\n\n${buildWritingMethodologySection(scaffoldLanguage)}`, "utf-8");
      }
    } catch {
      const { buildWritingMethodologySection } = await import("../utils/writing-methodology.js");
      await writeFile(styleGuidePath, buildWritingMethodologySection(scaffoldLanguage), "utf-8");
    }
  }

  async loadControlDocuments(bookId: string): Promise<{
    authorIntent: string;
    currentFocus: string;
    runtimeDir: string;
  }> {
    await this.ensureControlDocuments(bookId);

    const storyDir = join(this.bookDir(bookId), "story");
    const runtimeDir = join(storyDir, "runtime");
    const [authorIntent, currentFocus] = await Promise.all([
      readFile(join(storyDir, "author_intent.md"), "utf-8"),
      readFile(join(storyDir, "current_focus.md"), "utf-8"),
    ]);

    return { authorIntent, currentFocus, runtimeDir };
  }

  private async resolveControlDocumentLanguage(bookId: string): Promise<WritingLanguage> {
    let raw: string;
    try {
      raw = await readFile(join(this.bookDir(bookId), "book.json"), "utf-8");
    } catch {
      return "en";
    }

    let parsed: { language?: unknown };
    try {
      parsed = JSON.parse(raw) as { language?: unknown };
    } catch {
      return "en";
    }

    if (parsed.language === undefined) return "en";
    return WritingLanguageSchema.parse(parsed.language);
  }

  async acquireBookLock(bookId: string): Promise<() => Promise<void>> {
    await mkdir(this.bookDir(bookId), { recursive: true });
    const lockPath = join(this.bookDir(bookId), ".write.lock");
    const lockKey = this.normalizeLockKey(lockPath);
    const existingOwner = processBookLocks.get(lockKey);
    if (existingOwner) {
      throw new BookWriteLockError(bookId, lockPath, this.describeLock(existingOwner.metadata));
    }

    const now = Date.now();
    const owner: ProcessBookLock = {
      metadata: {
        version: 1,
        pid: process.pid,
        token: randomUUID(),
        startedAt: now,
        heartbeatAt: now,
      },
    };
    // Reserve synchronously before the first filesystem await so two
    // StateManager instances in this process cannot race through EEXIST and
    // mistake the other one's live file for a stale same-process lock.
    processBookLocks.set(lockKey, owner);

    try {
      let acquired = false;
      for (let attempt = 0; attempt < 4 && !acquired; attempt++) {
        try {
          await this.createLockFile(lockPath, owner.metadata);
          acquired = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
            throw error;
          }

          let snapshot: Awaited<ReturnType<StateManager["readLockSnapshot"]>>;
          try {
            snapshot = await this.readLockSnapshot(lockPath);
          } catch (snapshotError) {
            if ((snapshotError as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
              continue;
            }
            throw snapshotError;
          }
          if (!this.isStaleLock(snapshot.metadata, snapshot.mtimeMs)) {
            throw new BookWriteLockError(bookId, lockPath, snapshot.raw);
          }
          await this.removeStaleLock(lockPath, snapshot.raw);
        }
      }

      if (!acquired) {
        throw new BookWriteLockError(bookId, lockPath);
      }

      this.startLockHeartbeat(lockPath, lockKey, owner);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        if (owner.heartbeatTimer) clearInterval(owner.heartbeatTimer);
        await owner.heartbeatTask;
        if (processBookLocks.get(lockKey)?.metadata.token === owner.metadata.token) {
          processBookLocks.delete(lockKey);
        }
        try {
          const snapshot = await this.readLockSnapshot(lockPath);
          if (snapshot.metadata?.token !== owner.metadata.token) {
            return;
          }
          await this.unlinkWithRetry(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
            console.warn(`[inkos] Failed to release book lock ${lockPath}: ${String(error)}`);
          }
        }
      };
    } catch (error) {
      if (processBookLocks.get(lockKey)?.metadata.token === owner.metadata.token) {
        processBookLocks.delete(lockKey);
      }
      throw error;
    }
  }

  private normalizeLockKey(lockPath: string): string {
    const absolute = resolve(lockPath);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  }

  private serializeLock(metadata: BookLockMetadata): string {
    return JSON.stringify(metadata);
  }

  private describeLock(metadata: BookLockMetadata): string {
    return `pid:${metadata.pid} started:${new Date(metadata.startedAt).toISOString()}`;
  }

  private async createLockFile(lockPath: string, metadata: BookLockMetadata): Promise<void> {
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(this.serializeLock(metadata), "utf-8");
    } catch (error) {
      await handle.close().catch(() => undefined);
      await this.unlinkWithRetry(lockPath).catch(() => undefined);
      throw error;
    }
    await handle.close();
  }

  private parseLockMetadata(lockData: string): Partial<BookLockMetadata> | undefined {
    try {
      const parsed = JSON.parse(lockData) as Record<string, unknown>;
      const pid = typeof parsed.pid === "number" ? parsed.pid : undefined;
      const startedAt = typeof parsed.startedAt === "number" ? parsed.startedAt : undefined;
      const heartbeatAt = typeof parsed.heartbeatAt === "number" ? parsed.heartbeatAt : startedAt;
      return {
        ...(parsed.version === 1 ? { version: 1 as const } : {}),
        ...(pid !== undefined ? { pid } : {}),
        ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(heartbeatAt !== undefined ? { heartbeatAt } : {}),
      };
    } catch {
      const pid = this.extractLockPid(lockData);
      const timestampMatch = lockData.match(/ts:(\d+)/);
      const startedAt = timestampMatch ? Number.parseInt(timestampMatch[1] ?? "", 10) : undefined;
      if (pid === undefined && startedAt === undefined) return undefined;
      return {
        ...(pid !== undefined ? { pid } : {}),
        ...(Number.isFinite(startedAt) ? { startedAt, heartbeatAt: startedAt } : {}),
      };
    }
  }

  private async readLockSnapshot(lockPath: string): Promise<{
    readonly raw: string;
    readonly metadata?: Partial<BookLockMetadata>;
    readonly mtimeMs: number;
  }> {
    const [raw, lockStat] = await Promise.all([
      readFile(lockPath, "utf-8"),
      stat(lockPath),
    ]);
    return { raw, metadata: this.parseLockMetadata(raw), mtimeMs: lockStat.mtimeMs };
  }

  private isStaleLock(metadata: Partial<BookLockMetadata> | undefined, mtimeMs: number): boolean {
    if (metadata?.pid === process.pid) {
      // No processBookLocks owner existed before this acquisition reserved its
      // slot, so a same-pid file here can only be orphaned from an older task.
      return true;
    }
    if (metadata?.pid !== undefined && !this.isProcessAlive(metadata.pid)) {
      return true;
    }
    const heartbeatAt = metadata?.heartbeatAt ?? mtimeMs;
    const hasLeaseMetadata = metadata?.version === 1 && typeof metadata.token === "string";
    return hasLeaseMetadata && Date.now() - heartbeatAt > BOOK_LOCK_LEASE_MS;
  }

  private async removeStaleLock(lockPath: string, expectedRaw: string): Promise<void> {
    const currentRaw = await readFile(lockPath, "utf-8").catch(() => undefined);
    if (currentRaw === undefined) return;
    if (currentRaw !== expectedRaw) {
      return;
    }
    await this.unlinkWithRetry(lockPath);
  }

  private startLockHeartbeat(lockPath: string, lockKey: string, owner: ProcessBookLock): void {
    const refresh = async () => {
      if (processBookLocks.get(lockKey)?.metadata.token !== owner.metadata.token) return;
      const handle = await open(lockPath, "r+");
      try {
        const currentRaw = await handle.readFile("utf-8");
        if (this.parseLockMetadata(currentRaw)?.token !== owner.metadata.token) return;
        owner.metadata.heartbeatAt = Date.now();
        const serialized = Buffer.from(this.serializeLock(owner.metadata), "utf-8");
        await handle.write(serialized, 0, serialized.length, 0);
        await handle.truncate(serialized.length);
      } finally {
        await handle.close();
      }
    };
    owner.heartbeatTimer = setInterval(() => {
      if (owner.heartbeatTask) return;
      const task = refresh()
        .catch((error) => {
          console.warn(`[inkos] Failed to refresh book lock ${lockPath}: ${String(error)}`);
        })
        .finally(() => {
          if (owner.heartbeatTask === task) owner.heartbeatTask = undefined;
        });
      owner.heartbeatTask = task;
    }, BOOK_LOCK_HEARTBEAT_MS);
    owner.heartbeatTimer.unref?.();
  }

  private async unlinkWithRetry(lockPath: string): Promise<void> {
    for (let attempt = 0; attempt < BOOK_LOCK_RELEASE_RETRIES; attempt++) {
      try {
        await unlink(lockPath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT") return;
        const retryable = code === "EPERM" || code === "EACCES" || code === "EBUSY";
        if (!retryable || attempt === BOOK_LOCK_RELEASE_RETRIES - 1) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25 * (attempt + 1)));
      }
    }
  }

  private extractLockPid(lockData: string): number | undefined {
    const match = lockData.match(/pid:(\d+)/);
    if (!match) return undefined;
    const pid = Number.parseInt(match[1] ?? "", 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ESRCH") {
        return false;
      }
      return true;
    }
  }

  get booksDir(): string {
    return join(this.projectRoot, "books");
  }

  bookDir(bookId: string): string {
    return join(this.booksDir, bookId);
  }

  stateDir(bookId: string): string {
    return join(this.bookDir(bookId), "story", "state");
  }

  async loadProjectConfig(): Promise<Record<string, unknown>> {
    const configPath = join(this.projectRoot, "inkos.json");
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw);
  }

  async saveProjectConfig(config: Record<string, unknown>): Promise<void> {
    const configPath = join(this.projectRoot, "inkos.json");
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  }

  async loadBookConfig(bookId: string): Promise<BookConfig> {
    const configPath = join(this.bookDir(bookId), "book.json");
    const raw = await readFile(configPath, "utf-8");
    if (!raw.trim()) {
      throw new Error(`book.json is empty for book "${bookId}"`);
    }
    return JSON.parse(raw) as BookConfig;
  }

  async saveBookConfig(bookId: string, config: BookConfig): Promise<void> {
    await this.saveBookConfigAt(this.bookDir(bookId), config);
  }

  async saveBookConfigAt(bookDir: string, config: BookConfig): Promise<void> {
    await mkdir(bookDir, { recursive: true });
    await writeFile(
      join(bookDir, "book.json"),
      JSON.stringify(config, null, 2),
      "utf-8",
    );
  }

  async ensureRuntimeState(bookId: string, fallbackChapter = 0): Promise<void> {
    await bootstrapStructuredStateFromMarkdown({
      bookDir: this.bookDir(bookId),
      fallbackChapter,
    });
  }

  async listBooks(): Promise<ReadonlyArray<string>> {
    try {
      const entries = await readdir(this.booksDir);
      const bookIds: string[] = [];
      for (const entry of entries) {
        const bookJsonPath = join(this.booksDir, entry, "book.json");
        try {
          await stat(bookJsonPath);
          bookIds.push(entry);
        } catch {
          // not a book directory
        }
      }
      return bookIds;
    } catch {
      return [];
    }
  }

  async getNextChapterNumber(bookId: string): Promise<number> {
    const durableChapter = await resolveDurableStoryProgress({
      bookDir: this.bookDir(bookId),
    });
    // Ensure structured state is bootstrapped (side-effect: creates missing
    // JSON files), but do NOT trust its chapter number for progress — only
    // the contiguous durable artifact chain is authoritative.
    await bootstrapStructuredStateFromMarkdown({
      bookDir: this.bookDir(bookId),
      fallbackChapter: durableChapter,
    });
    return durableChapter + 1;
  }

  async getPersistedChapterCount(bookId: string): Promise<number> {
    const chaptersDir = join(this.bookDir(bookId), "chapters");
    const chapterNumbers = new Set<number>();

    try {
      const files = await readdir(chaptersDir);
      for (const file of files) {
        const match = file.match(/^(\d+)_.*\.md$/);
        if (!match) continue;
        chapterNumbers.add(parseInt(match[1]!, 10));
      }
    } catch {
      return 0;
    }

    return chapterNumbers.size;
  }

  async loadChapterIndex(bookId: string): Promise<ReadonlyArray<ChapterMeta>> {
    const indexPath = join(this.bookDir(bookId), "chapters", "index.json");
    try {
      const raw = await readFile(indexPath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as ReadonlyArray<ChapterMeta>;
      if (Array.isArray(parsed)) {
        const rebuilt = await this.rebuildChapterIndexFromFiles(bookId);
        return rebuilt.length > 0 ? rebuilt : parsed as ReadonlyArray<ChapterMeta>;
      }
    } catch {
      const rebuilt = await this.rebuildChapterIndexFromFiles(bookId);
      if (rebuilt.length > 0) return rebuilt;
    }
    return [];
  }

  private async rebuildChapterIndexFromFiles(bookId: string): Promise<ReadonlyArray<ChapterMeta>> {
    return this.rebuildChapterIndexFromFilesAt(this.bookDir(bookId), bookId);
  }

  async loadCanonicalChapterProjection(
    bookId: string,
    chapterNumber: number,
  ): Promise<CanonicalChapterProjection | null> {
    if (!Number.isInteger(chapterNumber) || chapterNumber < 1) return null;
    const projections = await this.loadCanonicalChapterProjectionsAt(this.bookDir(bookId), bookId);
    return projections.find((projection) => projection.meta.number === chapterNumber) ?? null;
  }

  private async rebuildChapterIndexFromFilesAt(
    bookDir: string,
    expectedBookId?: string,
  ): Promise<ReadonlyArray<ChapterMeta>> {
    const projections = await this.loadCanonicalChapterProjectionsAt(bookDir, expectedBookId);
    return projections.map((projection) => projection.meta);
  }

  private async loadCanonicalChapterProjectionsAt(
    bookDir: string,
    expectedBookId?: string,
  ): Promise<ReadonlyArray<CanonicalChapterProjection>> {
    const chaptersDir = join(bookDir, "chapters");
    let files: string[];
    try {
      files = await readdir(chaptersDir);
    } catch {
      return [];
    }
    const canonicalBook = await this.loadCanonicalBookAt(bookDir, expectedBookId);
    const recoveryBookId = expectedBookId ?? canonicalBook?.id;
    const bookLanguage = canonicalBook?.language;

    const rows = await Promise.all(files.sort().flatMap(async (file) => {
      const match = file.match(/^(\d+)[_-]?(.*?)\.md$/);
      if (!match) return [];
      const number = parseInt(match[1]!, 10);
      if (!Number.isFinite(number) || number <= 0) return [];
      const filePath = join(chaptersDir, file);
      const [metadata, content] = await Promise.all([
        stat(filePath).catch(() => null),
        readFile(filePath, "utf-8").catch(() => ""),
      ]);
      const timestamp = (metadata?.mtime ?? new Date()).toISOString();
      const rawTitle = match[2]?.replace(/^_+/, "").replace(/_/g, " ").trim();
      const contentHash = computeChapterContentHash(content);
      const canonicalRun = recoveryBookId
        ? await this.loadLatestCanonicalAuditRun({
            bookDir,
            bookId: recoveryBookId,
            chapterNumber: number,
            contentHash,
            bookLanguage,
          })
        : undefined;
      const meta = canonicalRun
        ? this.rebuildChapterMetaFromAuditRun({
            number,
            title: rawTitle || this.recoveredChapterTitle(number, bookLanguage),
            timestamp,
            run: canonicalRun.run,
            runPath: canonicalRun.relativePath,
            bookLanguage,
          })
        : ({
            number,
            title: rawTitle || this.recoveredChapterTitle(number, bookLanguage),
            status: "audit-failed" as const,
            wordCount: bookLanguage
              ? countChapterLength(content, resolveLengthCountingMode(bookLanguage))
              : content.replace(/\s+/g, "").length,
            createdAt: timestamp,
            updatedAt: timestamp,
            auditIssues: [`[warning] ${AUDIT_RECOVERY_NOTE}`],
            lengthWarnings: [],
            reviewNote: AUDIT_RECOVERY_NOTE,
            auditDecision: "inconclusive" as const,
            verifiedBlockerCount: 0,
            revisionAttempts: 0,
            revisionOutcome: "inconclusive" as const,
          });
      return [{
        chapterRelativePath: join("chapters", file),
        contentHash,
        meta,
        ...(canonicalRun ? { auditRun: canonicalRun.run } : {}),
      }];
    }));

    return rows
      .flat()
      .sort((a, b) => a.meta.number - b.meta.number);
  }

  private rebuildChapterMetaFromAuditRun(input: {
    readonly number: number;
    readonly title: string;
    readonly timestamp: string;
    readonly run: AuditRunV1;
    readonly runPath: string;
    readonly bookLanguage?: WritingLanguage;
  }): ChapterMeta {
    const { run } = input;
    const verifiedBlockerCount = run.findings.filter(
      (finding) => finding.severity === "critical" && finding.verification === "verified",
    ).length;
    const lengthWarning = run.length.count < run.length.softMin || run.length.count > run.length.softMax;
    const revisionOutcome = run.revision.attempted
      ? run.revision.accepted
        ? "accepted" as const
        : run.decision === "inconclusive" ? "inconclusive" as const : "rejected" as const
      : run.decision === "inconclusive" ? "inconclusive" as const : "not-needed" as const;

    return {
      number: input.number,
      title: input.title,
      status: run.decision === "pass" ? "ready-for-review" : "audit-failed",
      wordCount: run.length.count,
      createdAt: input.timestamp,
      updatedAt: run.completedAt,
      auditIssues: run.findings.map((finding) => `[${finding.severity}] ${finding.description}`),
      lengthWarnings: lengthWarning
        ? [`Recovered audit length ${run.length.count} is outside the soft range ${run.length.softMin}-${run.length.softMax}.`]
        : [],
      lengthTelemetry: {
        ...(input.bookLanguage ? { language: input.bookLanguage } : {}),
        target: run.length.target,
        softMin: run.length.softMin,
        softMax: run.length.softMax,
        hardMin: run.length.hardMin,
        hardMax: run.length.hardMax,
        countingMode: run.length.countingMode,
        writerCount: run.length.count,
        postReviseCount: run.length.count,
        finalCount: run.length.count,
        repairApplied: run.revision.accepted,
        lengthWarning,
      },
      auditDecision: run.decision,
      auditAttemptId: run.attemptId,
      auditRunPaths: [input.runPath],
      verifiedBlockerCount,
      revisionAttempts: run.revision.attempted ? 1 : 0,
      revisionOutcome,
      revisionRejectionReason: run.revision.rejectionReason,
      auditProvenance: {
        ...run.provenance,
        operationId: run.operationId,
        attemptId: run.attemptId,
        phase: run.phase,
      },
      tokenUsage: run.tokenUsage,
    };
  }

  private async loadLatestCanonicalAuditRun(input: {
    readonly bookDir: string;
    readonly bookId: string;
    readonly chapterNumber: number;
    readonly contentHash: string;
    readonly bookLanguage?: WritingLanguage;
  }): Promise<{ readonly run: AuditRunV1; readonly relativePath: string } | undefined> {
    const chapter = String(input.chapterNumber).padStart(4, "0");
    const runsDir = join(input.bookDir, "story", "audit", "runs", `chapter-${chapter}`);
    const files = await readdir(runsDir).catch(() => [] as string[]);
    const candidates = (await Promise.all(files.sort().map(async (file) => {
      if (!/^[0-9a-f-]+\.(initial|post-revision|manual)\.audit-run-v1\.json$/u.test(file)) return undefined;
      const raw = await readFile(join(runsDir, file), "utf-8").catch(() => undefined);
      if (raw === undefined) return undefined;
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        return undefined;
      }
      const parsed = AuditRunV1Schema.safeParse(parsedJson);
      if (!parsed.success) return undefined;
      const run = parsed.data;
      if (
        run.bookId !== input.bookId
        || run.chapterNumber !== input.chapterNumber
        || run.contentHash !== input.contentHash
        || (input.bookLanguage !== undefined && run.length.countingMode !== resolveLengthCountingMode(input.bookLanguage))
        || (run.canonicalCommitOutcome !== "terminal-commit" && run.canonicalCommitOutcome !== "unchanged")
      ) {
        return undefined;
      }
      const relativePath = auditRunRelativePath(run);
      if (relativePath !== `story/audit/runs/chapter-${chapter}/${file}`) return undefined;
      return { run, relativePath };
    }))).filter((candidate): candidate is { readonly run: AuditRunV1; readonly relativePath: string } => candidate !== undefined);

    candidates.sort((left, right) =>
      left.run.completedAt.localeCompare(right.run.completedAt)
      || left.relativePath.localeCompare(right.relativePath));
    return candidates.at(-1);
  }

  private async loadCanonicalBookAt(
    bookDir: string,
    expectedBookId?: string,
  ): Promise<Pick<BookConfig, "id" | "language"> | undefined> {
    const raw = await readFile(join(bookDir, "book.json"), "utf-8").catch(() => undefined);
    if (raw === undefined) return undefined;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const parsed = BookConfigSchema.safeParse(parsedJson);
    if (!parsed.success || (expectedBookId !== undefined && parsed.data.id !== expectedBookId)) return undefined;
    return { id: parsed.data.id, language: parsed.data.language };
  }

  private recoveredChapterTitle(
    chapterNumber: number,
    bookLanguage?: WritingLanguage,
  ): string {
    if (bookLanguage === "vi") return `Chương ${chapterNumber}`;
    if (bookLanguage === "en") return `Chapter ${chapterNumber}`;
    return `第${chapterNumber}章`;
  }

  async saveChapterIndex(
    bookId: string,
    index: ReadonlyArray<ChapterMeta>,
    options: { readonly allowEmptyWithChapterFiles?: boolean } = {},
  ): Promise<void> {
    await this.saveChapterIndexAt(this.bookDir(bookId), index, options);
  }

  async saveChapterIndexAt(
    bookDir: string,
    index: ReadonlyArray<ChapterMeta>,
    options: { readonly allowEmptyWithChapterFiles?: boolean } = {},
  ): Promise<void> {
    const chaptersDir = join(bookDir, "chapters");
    await mkdir(chaptersDir, { recursive: true });
    const safeIndex = index.length === 0 && !options.allowEmptyWithChapterFiles
      ? await this.rebuildChapterIndexFromFilesAt(bookDir).then((rebuilt) => rebuilt.length > 0 ? rebuilt : index)
      : index;
    await writeFile(
      join(chaptersDir, "index.json"),
      JSON.stringify(safeIndex, null, 2),
      "utf-8",
    );
  }

  async snapshotState(bookId: string, chapterNumber: number): Promise<void> {
    await this.snapshotStateAt(this.bookDir(bookId), chapterNumber);
  }

  async snapshotStateAt(bookDir: string, chapterNumber: number): Promise<void> {
    const storyDir = join(bookDir, "story");
    const snapshotDir = join(storyDir, "snapshots", String(chapterNumber));
    await mkdir(snapshotDir, { recursive: true });

    const files = [
      "current_state.md", "particle_ledger.md", "pending_hooks.md",
      "chapter_summaries.md", "subplot_board.md", "emotional_arcs.md", "character_matrix.md",
    ];
    await Promise.all(
      files.map(async (f) => {
        try {
          const content = await readFile(join(storyDir, f), "utf-8");
          await writeFile(join(snapshotDir, f), content, "utf-8");
        } catch {
          // file doesn't exist yet
        }
      }),
    );

    const stateDir = join(bookDir, "story", "state");
    const snapshotStateDir = join(snapshotDir, "state");
    try {
      const stateFiles = await readdir(stateDir);
      if (stateFiles.length > 0) {
        await mkdir(snapshotStateDir, { recursive: true });
        await Promise.all(
          stateFiles.map(async (fileName) => {
            const content = await readFile(join(stateDir, fileName), "utf-8");
            await writeFile(join(snapshotStateDir, fileName), content, "utf-8");
          }),
        );
      }
    } catch {
      // state directory missing — skip
    }
  }

  async isCompleteBookDirectory(bookDir: string): Promise<boolean> {
    // Phase 5 cleanup: prefer outline/* paths, fall back to legacy flat files
    // so older books on disk still resolve as complete.
    const requiredSingle = [
      join(bookDir, "book.json"),
      join(bookDir, "story", "book_rules.md"),
      join(bookDir, "story", "current_state.md"),
      join(bookDir, "story", "pending_hooks.md"),
      join(bookDir, "chapters", "index.json"),
    ];

    const eitherOr: Array<ReadonlyArray<string>> = [
      // story_frame (new) OR story_bible (legacy)
      [
        join(bookDir, "story", "outline", "story_frame.md"),
        join(bookDir, "story", "story_bible.md"),
      ],
      // volume_map (new) OR volume_outline (legacy)
      [
        join(bookDir, "story", "outline", "volume_map.md"),
        join(bookDir, "story", "volume_outline.md"),
      ],
    ];

    for (const requiredPath of requiredSingle) {
      try {
        await stat(requiredPath);
      } catch {
        return false;
      }
    }

    for (const alternatives of eitherOr) {
      let found = false;
      for (const candidate of alternatives) {
        try {
          await stat(candidate);
          found = true;
          break;
        } catch {
          // try next alternative
        }
      }
      if (!found) return false;
    }

    return true;
  }

  async restoreState(bookId: string, chapterNumber: number): Promise<boolean> {
    const storyDir = join(this.bookDir(bookId), "story");
    const snapshotDir = join(storyDir, "snapshots", String(chapterNumber));

    const files = [
      "current_state.md", "particle_ledger.md", "pending_hooks.md",
      "chapter_summaries.md", "subplot_board.md", "emotional_arcs.md", "character_matrix.md",
    ];
    try {
      // current_state.md and pending_hooks.md are required;
      // particle_ledger.md is optional (numericalSystem=false genres don't have it)
      // the rest are optional (may not exist in older snapshots)
      const requiredFiles = ["current_state.md", "pending_hooks.md"];
      const optionalFiles = files.filter((f) => !requiredFiles.includes(f));

      await Promise.all(
        requiredFiles.map(async (f) => {
          const content = await readFile(join(snapshotDir, f), "utf-8");
          await writeFile(join(storyDir, f), content, "utf-8");
        }),
      );

      await Promise.all(
        optionalFiles.map(async (f) => {
          const targetPath = join(storyDir, f);
          try {
            const content = await readFile(join(snapshotDir, f), "utf-8");
            await writeFile(targetPath, content, "utf-8");
          } catch {
            await rm(targetPath, { force: true });
          }
        }),
      );

      const stateDir = this.stateDir(bookId);
      let restoredStructuredState = false;
      try {
        const snapshotStateDir = join(snapshotDir, "state");
        const stateFiles = await readdir(snapshotStateDir);
        if (stateFiles.length > 0) {
          restoredStructuredState = true;
          await mkdir(stateDir, { recursive: true });
          await Promise.all(
            stateFiles.map(async (fileName) => {
              const content = await readFile(join(snapshotStateDir, fileName), "utf-8");
              await writeFile(join(stateDir, fileName), content, "utf-8");
            }),
          );
        }
      } catch {
        // snapshot structured state missing — skip
      }
      if (!restoredStructuredState) {
        await rm(stateDir, { recursive: true, force: true });
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Roll back state to the snapshot at `targetChapter`, removing all chapters
   * after it and their associated files (chapter markdown, snapshots, runtime).
   * Used by review reject to undo a bad chapter and everything that followed.
   *
   * Returns the list of chapter numbers that were discarded.
   */
  async rollbackToChapter(
    bookId: string,
    targetChapter: number,
  ): Promise<ReadonlyArray<number>> {
    const restored = await this.restoreState(bookId, targetChapter);
    if (!restored) {
      throw new Error(`Cannot restore snapshot for chapter ${targetChapter} in "${bookId}"`);
    }

    const bookDir = this.bookDir(bookId);
    const chaptersDir = join(bookDir, "chapters");
    const index = await this.loadChapterIndex(bookId);

    const kept: ChapterMeta[] = [];
    const discarded: number[] = [];

    for (const entry of index) {
      if (entry.number <= targetChapter) {
        kept.push(entry);
      } else {
        discarded.push(entry.number);
      }
    }

    // Delete chapter markdown files for discarded chapters
    try {
      const files = await readdir(chaptersDir);
      for (const file of files) {
        const match = file.match(/^(\d+)_.*\.md$/);
        if (!match) continue;
        const num = parseInt(match[1]!, 10);
        if (num > targetChapter) {
          await unlink(join(chaptersDir, file)).catch(() => {});
        }
      }
    } catch {
      // chapters directory missing
    }

    // Delete snapshots for discarded chapters
    const snapshotsDir = join(bookDir, "story", "snapshots");
    try {
      const snapshots = await readdir(snapshotsDir);
      for (const snap of snapshots) {
        const num = parseInt(snap, 10);
        if (Number.isFinite(num) && num > targetChapter) {
          await rm(join(snapshotsDir, snap), { recursive: true, force: true });
        }
      }
    } catch {
      // snapshots directory missing
    }

    // Delete runtime artifacts for discarded chapters
    const runtimeDir = join(bookDir, "story", "runtime");
    try {
      const runtimeFiles = await readdir(runtimeDir);
      for (const file of runtimeFiles) {
        const match = file.match(/^chapter-(\d+)\./);
        if (!match) continue;
        const num = parseInt(match[1]!, 10);
        if (num > targetChapter) {
          await unlink(join(runtimeDir, file)).catch(() => {});
        }
      }
    } catch {
      // runtime directory missing
    }

    // Also check story/drafts/ for discarded chapter files
    const draftsDir = join(bookDir, "story", "drafts");
    try {
      const draftFiles = await readdir(draftsDir);
      for (const file of draftFiles) {
        const match = file.match(/^(\d+)_.*\.md$/);
        if (!match) continue;
        const num = parseInt(match[1]!, 10);
        if (num > targetChapter) {
          await unlink(join(draftsDir, file)).catch(() => {});
        }
      }
    } catch {
      // drafts directory missing
    }

    // Drop any persisted sqlite acceleration index so discarded chapters
    // cannot leak back into retrieval after the markdown/state rollback.
    await Promise.all([
      rm(join(bookDir, "story", "memory.db"), { force: true }),
      rm(join(bookDir, "story", "memory.db-shm"), { force: true }),
      rm(join(bookDir, "story", "memory.db-wal"), { force: true }),
    ]);

    await this.saveChapterIndex(bookId, kept);
    return discarded;
  }

  private async writeIfMissing(path: string, content: string): Promise<void> {
    try {
      await stat(path);
    } catch {
      await writeFile(path, content, "utf-8");
    }
  }
}
