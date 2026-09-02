import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resolveCandidateSha } from "./candidate-config.mjs";
import { resolveQualificationRunScope } from "./promotion-runner-scope.mjs";

const execFile = promisify(execFileCallback);
const worktreeRoot = "C:/tmp/CodexScratch/2026-09-01-inkos-promotion-hardening";
async function readWorktreeHeadSha() {
  try {
    const { stdout } = await execFile(
      "git",
      ["-c", `safe.directory=${worktreeRoot}`, "-C", worktreeRoot, "rev-parse", "HEAD"],
      { encoding: "utf8", windowsHide: true },
    );
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`unable to determine worktree HEAD for qualification${detail}`);
  }
}

const candidateSha = resolveCandidateSha(
  process.env.INKOS_QUALIFICATION_CANDIDATE_SHA,
  await readWorktreeHeadSha(),
);
const core = await import(pathToFileURL(`${worktreeRoot}/packages/core/dist/index.js`).href);
const { computeChapterContentHash } = await import(pathToFileURL(`${worktreeRoot}/packages/core/dist/audit/chapter-audit-evaluator.js`).href);
const {
  PipelineRunner,
  buildLengthSpec,
  createLLMClient,
  countChapterLength,
  probeChatContract,
  probeModelsFromUpstream,
  validateVietnameseSurface,
} = core;

const baselineRoot = "C:/Users/Admin/Documents/Codex/InkOS/vi-writing-sandbox";
const baselineBookId = "phase-a-ecoapi-1150-20260831-0";
const probeVariant = (process.env.INKOS_QUALIFICATION_PROBE_VARIANT ?? "stream").trim().toLowerCase();
if (!["stream", "nonstream"].includes(probeVariant)) throw new Error("probe variant must be stream or nonstream");
const pipelineStream = probeVariant === "stream";
const evidenceDate = "2026-09-02";
const runLabel = (process.env.INKOS_QUALIFICATION_RUN_LABEL ?? "").trim();
const runScope = resolveQualificationRunScope({ candidateSha, evidenceDate, probeVariant, runLabel });
const scratchRoot = runScope.scratchRoot;
const targetChapters = Number.parseInt(process.argv[2] ?? "3", 10);
if (![3, 8, 15].includes(targetChapters)) throw new Error("target chapter count must be 3, 8, or 15");
const resumeBookId = process.argv[3]?.trim() || null;
const startChapter = Number.parseInt(process.argv[4] ?? "1", 10);
const runThroughChapter = Number.parseInt(process.argv[5] ?? String(targetChapters), 10);
const providerCallBudget = Number.parseInt(process.argv[6] ?? "90", 10);
const externalContext = process.env.INKOS_QUALIFICATION_EXTERNAL_CONTEXT?.trim() || undefined;
if (!Number.isInteger(startChapter) || startChapter < 1 || startChapter > targetChapters) {
  throw new Error("start chapter must be within the target book range");
}
if (!Number.isInteger(runThroughChapter) || runThroughChapter < startChapter || runThroughChapter > targetChapters) {
  throw new Error("run-through chapter must be between start chapter and target chapter count");
}
if (!Number.isInteger(providerCallBudget) || providerCallBudget < 1 || providerCallBudget > 90) {
  throw new Error("provider call budget must be between 1 and 90");
}
if (resumeBookId && resumeBookId !== runScope.bookId) {
  throw new Error("resume book id is outside the qualification namespace");
}
const runId = `${new Date().toISOString().replace(/[-:TZ.]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
const bookId = resumeBookId ?? runScope.bookId;
const bookDir = join(scratchRoot, "books", bookId);
const evidencePath = join(scratchRoot, resumeBookId
  ? `qualification-resume-ch${startChapter}-to-${runThroughChapter}-${runId}.json`
  : `qualification-${runId}.json`);
const startedAt = new Date();
const serviceKey = "custom:Ecoapi";
const model = process.env.INKOS_QUALIFICATION_MODEL?.trim() || "claude-sonnet-4-6";
const baseUrl = "https://ecoapi.net/v1";
const lengthSpec = buildLengthSpec(1150, "vi");

const safe = {
  schemaVersion: 2,
  kind: resumeBookId
    ? "inkos-vi-stable-promotion-resume-v1"
    : "inkos-vi-stable-promotion-v1",
  startedAt: startedAt.toISOString(),
  baselineBookId,
  candidateSha,
  bookId,
  resumeBookId,
  startChapter,
  runThroughChapter,
  scratchRoot,
  evidencePath,
  serviceKey,
  baseHost: "ecoapi.net",
  basePath: "/v1",
  model,
  runLabel,
  apiFormat: "chat",
  stream: pipelineStream,
  reasoningEffort: "none",
  probeVariant,
  providerCallsAuthorized: true,
  keyPresent: false,
  credentialValueEmitted: false,
  rawPromptStored: false,
  rawResponseStored: false,
  rawHeadersStored: false,
  externalContextProvided: Boolean(externalContext),
  lengthPolicy: lengthSpec,
  healthGate: null,
  resumePreflight: null,
  providerRequests: [],
  providerCallBudget,
  checkpoints: [],
  recoveryDrill: null,
  operations: [],
  finalInvariants: null,
  exitReason: null,
  error: null,
};

function safeError(error) {
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === "object" && typeof error.code === "string" ? error.code : null,
    status: error && typeof error === "object" && typeof error.status === "number" ? error.status : null,
    retryable: error && typeof error === "object" && "retryable" in error ? Boolean(error.retryable) : null,
  };
}

function safeIssues(issues) {
  return Array.isArray(issues)
    ? issues.map((issue) => ({
        rule: issue?.rule ?? null,
        severity: issue?.severity ?? null,
        category: issue?.category ?? null,
        description: issue?.description ?? null,
        suggestion: issue?.suggestion ?? null,
        verification: issue?.verification ?? null,
        repairHint: issue?.repairHint
          ? {
              kind: issue.repairHint.kind ?? null,
              targetText: issue.repairHint.targetText ?? null,
              replacementText: issue.repairHint.replacementText ?? null,
              occurrenceIndexes: issue.repairHint.occurrenceIndexes ?? [],
            }
          : null,
      }))
    : [];
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function collectStateInvariants(expectedChapter) {
  const index = await readJson(join(bookDir, "chapters", "index.json"));
  const manifest = await readJson(join(bookDir, "story", "state", "manifest.json"));
  const currentState = await readJson(join(bookDir, "story", "state", "current_state.json"));
  const chapterSummaries = await readJson(join(bookDir, "story", "state", "chapter_summaries.json"));
  const hooks = await readJson(join(bookDir, "story", "state", "hooks.json"));
  const files = await readdir(join(bookDir, "chapters"));
  const chapterFiles = files.filter((name) => /^\d+_.+\.md$/u.test(name));
  const transactionDirs = (await readdir(bookDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(".inkos-file-txn-"))
    .map((entry) => entry.name);
  const book = await readJson(join(bookDir, "book.json"));
  const acceptedStatuses = new Set(["audit-passed", "ready-for-review", "approved", "published", "imported"]);
  const expectedNumbers = Array.from({ length: expectedChapter }, (_, index) => index + 1);
  const acceptedIndex = index.filter((chapter) =>
    expectedNumbers.includes(chapter.number)
    && acceptedStatuses.has(chapter.status)
    && (!chapter.auditDecision || chapter.auditDecision === "pass"),
  );
  const chapterFileNumbers = chapterFiles
    .map((name) => Number.parseInt(name.slice(0, 4), 10))
    .filter((number) => Number.isInteger(number));
  const uniqueChapterFileNumbers = [...new Set(chapterFileNumbers)];
  const aligned =
    manifest.lastAppliedChapter === expectedChapter
    && currentState.chapter === expectedChapter
    && acceptedIndex.length === expectedChapter
    && expectedNumbers.every((number) => acceptedIndex.some((chapter) => chapter.number === number))
    && uniqueChapterFileNumbers.length === expectedChapter
    && expectedNumbers.every((number) => uniqueChapterFileNumbers.includes(number))
    && chapterFiles.length === expectedChapter
    && manifest.language === "vi"
    && transactionDirs.length === 0;
  return {
    bookStatus: book.status ?? null,
    targetChapters: book.targetChapters ?? null,
    indexCount: index.length,
    indexNumbers: index.map((chapter) => chapter.number),
    indexStatuses: index.map((chapter) => ({ number: chapter.number, status: chapter.status, wordCount: chapter.wordCount })),
    manifestLastAppliedChapter: manifest.lastAppliedChapter ?? null,
    manifestLanguage: manifest.language ?? null,
    currentStateChapter: currentState.chapter ?? null,
    summaryCount: Array.isArray(chapterSummaries.rows) ? chapterSummaries.rows.length : null,
    hookCount: Array.isArray(hooks.hooks) ? hooks.hooks.length : null,
    openHookCount: Array.isArray(hooks.hooks)
      ? hooks.hooks.filter((hook) => !["resolved", "deferred"].includes(String(hook.status))).length
      : null,
    expectedChapter,
    chapterFileCount: chapterFiles.length,
    chapterFileNumbers: uniqueChapterFileNumbers,
    transactionDirs,
    aligned,
  };
}

async function collectChapterEvidence(chapterNumber, result) {
  const paddedChapter = String(chapterNumber).padStart(4, "0");
  const files = await readdir(join(bookDir, "chapters"));
  const chapterFiles = files.filter((name) => new RegExp(`^${paddedChapter}_.+\\.md$`, "u").test(name));
  const chapterPath = chapterFiles.length === 1 ? join(bookDir, "chapters", chapterFiles[0]) : null;
  let content = "";
  if (chapterPath) content = await readFile(chapterPath, "utf8");
  const independentCount = content
    ? countChapterLength(content, "vi_wordlike_tokens_v1")
    : null;
  const surfaceIssues = content ? validateVietnameseSurface(content) : [];
  const surfaceBlockerCount = surfaceIssues.filter((issue) => issue.severity === "error").length;
  const spellingIssueCount = surfaceIssues.filter((issue) => issue.rule === "vi-known-spelling").length;
  const auditResult = result?.auditResult ?? {};
  const issueList = safeIssues(auditResult.issues);
  const auditDir = join(bookDir, "story", "audit", "runs", `chapter-${paddedChapter}`);
  let auditRuns = [];
  try {
    const auditFiles = (await readdir(auditDir)).filter((name) => name.endsWith(".audit-run-v1.json"));
    auditRuns = await Promise.all(auditFiles.map(async (file) => {
      const run = await readJson(join(auditDir, file));
      return {
        file,
        phase: run.phase ?? null,
        decision: run.decision ?? null,
        passed: run.passed === true,
        overallScore: typeof run.overallScore === "number" ? run.overallScore : null,
        parseFailed: run.parseFailed === true,
        canonicalCommitOutcome: run.canonicalCommitOutcome ?? null,
        revision: run.revision
          ? { attempted: run.revision.attempted === true, candidateProduced: run.revision.candidateProduced === true, accepted: run.revision.accepted === true }
          : null,
      };
    }));
  } catch {
    auditRuns = [];
  }

  let contextTrace = null;
  if (result?.contextTrace?.tracePath) {
    try {
      const trace = await readJson(join(bookDir, result.contextTrace.tracePath));
      contextTrace = {
        tracePath: result.contextTrace.tracePath,
        tokenBudget: trace.tokenBudget ?? null,
        tokenUsageByAgent: result.contextTrace.tokenUsageByAgent ?? trace.tokenUsageByAgent ?? null,
      };
    } catch {
      contextTrace = { tracePath: result.contextTrace.tracePath, tokenBudget: null, tokenUsageByAgent: null };
    }
  }

  return {
    status: result?.status ?? null,
    title: result?.title ?? null,
    chapterNumber: result?.chapterNumber ?? chapterNumber,
    revised: result?.revised ?? null,
    resultWordCount: result?.wordCount ?? null,
    recomputedWordCount: independentCount,
    countMatches: result?.wordCount === independentCount,
    preferredRange: { min: lengthSpec.softMin, max: lengthSpec.softMax },
    hardRange: { min: lengthSpec.hardMin, max: lengthSpec.hardMax },
    preferredInRange: independentCount !== null && independentCount >= lengthSpec.softMin && independentCount <= lengthSpec.softMax,
    hardInRange: independentCount !== null && independentCount >= lengthSpec.hardMin && independentCount <= lengthSpec.hardMax,
    countingMode: result?.lengthTelemetry?.countingMode ?? "vi_wordlike_tokens_v1",
    lengthTelemetry: result?.lengthTelemetry ?? null,
    lengthWarnings: result?.lengthWarnings ?? [],
    auditDecision: auditResult.decision ?? null,
    auditPassed: auditResult.passed === true,
    overallScore: typeof auditResult.overallScore === "number" ? auditResult.overallScore : null,
    auditIssues: issueList,
    verifiedBlockerCount: issueList.filter((issue) => issue.verification === "verified" && (issue.severity === "critical" || issue.severity === "error")).length,
    surfaceIssues: safeIssues(surfaceIssues),
    surfaceBlockerCount,
    spellingIssueCount,
    cjkCharacterCount: (content.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu) ?? []).length,
    contentHash: content ? computeChapterContentHash(content) : null,
    chapterFileCount: chapterFiles.length,
    auditRunCount: auditRuns.length,
    auditRuns,
    tokenUsage: result?.tokenUsage ?? null,
    tokenUsageByAgent: result?.tokenUsageByAgent ?? null,
    contextTrace,
  };
}

async function bounded(label, timeoutMs, task) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${label}-timeout`)), timeoutMs);
  const started = performance.now();
  try {
    const value = await task(controller.signal);
    return { value, durationMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

function isProviderFailure(operationRecord) {
  const error = operationRecord.error;
  const providerObservation = safe.providerRequests.at(-1);
  return Boolean(
    error?.status
    || (typeof error?.code === "string" && /^(?:LLM_|PROVIDER_|HTTP_)/u.test(error.code))
    || (typeof error?.message === "string" && /(?:provider|ecoapi|reasoning|network|chat completion|llm)/iu.test(error.message))
    || providerObservation?.errorName
    || (typeof providerObservation?.status === "number" && providerObservation.status >= 400)
  );
}

const originalFetch = globalThis.fetch;
let currentStage = "setup";
globalThis.fetch = async (input, init) => {
  const started = performance.now();
  const url = typeof Request !== "undefined" && input instanceof Request ? new URL(input.url) : new URL(String(input));
  const headers = new Headers(init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined));
  let wireModel = null;
  let wireStream = null;
  let maxTokensPresent = false;
  let reasoningEffortPresent = false;
  let rawBody = typeof init?.body === "string" ? init.body : null;
  if (!rawBody && typeof Request !== "undefined" && input instanceof Request) {
    try { rawBody = await input.clone().text(); } catch { rawBody = null; }
  }
  if (rawBody) {
    try {
      const body = JSON.parse(rawBody);
      wireModel = typeof body?.model === "string" ? body.model : null;
      wireStream = typeof body?.stream === "boolean" ? body.stream : null;
      maxTokensPresent = Object.hasOwn(body ?? {}, "max_tokens")
        || Object.hasOwn(body ?? {}, "max_completion_tokens")
        || Object.hasOwn(body ?? {}, "max_output_tokens");
      reasoningEffortPresent = Object.hasOwn(body ?? {}, "reasoning_effort");
    } catch {
      // Deliberately do not retain request bodies.
    }
  }
  const observation = {
    stage: currentStage,
    method: init?.method ?? "GET",
    endpoint: `${url.origin}${url.pathname}`,
    wireModel,
    wireStream,
    maxTokensPresent,
    reasoningEffortPresent,
    authorizationPresent: headers.has("authorization"),
    status: null,
    latencyMs: null,
    errorName: null,
  };
  if (url.hostname === "ecoapi.net" && safe.providerRequests.length >= safe.providerCallBudget) {
    observation.errorName = "ProviderCallBudgetExceeded";
    safe.providerRequests.push(observation);
    const budgetError = new Error(`Qualification provider call budget exceeded (${safe.providerCallBudget})`);
    budgetError.code = "QUALIFICATION_PROVIDER_CALL_BUDGET";
    throw budgetError;
  }
  try {
    const response = await originalFetch(input, init);
    observation.status = response.status;
    observation.latencyMs = Math.round(performance.now() - started);
    safe.providerRequests.push(observation);
    return response;
  } catch (error) {
    observation.latencyMs = Math.round(performance.now() - started);
    observation.errorName = error instanceof Error ? error.name : "UnknownError";
    safe.providerRequests.push(observation);
    throw error;
  }
};

let hardPassCount = 0;
let preferredPassCount = 0;
try {
  if (!resumeBookId) {
    const baselineBookDir = join(baselineRoot, "books", baselineBookId);
    await mkdir(join(scratchRoot, "books"), { recursive: true });
    await cp(baselineBookDir, bookDir, { recursive: true, errorOnExist: true });
    // Start from the same canon/outline but no generated chapters or runtime state.
    // The source book remains untouched; all destructive cleanup is confined to this
    // unique scratch clone.
    const storyDir = join(bookDir, "story");
    const chaptersDir = join(bookDir, "chapters");
    const initialSnapshotDir = join(storyDir, "snapshots", "0");
    for (const file of ["character_matrix.md", "current_state.md", "emotional_arcs.md", "pending_hooks.md"]) {
      await cp(join(initialSnapshotDir, file), join(storyDir, file));
    }
    for (const entry of await readdir(chaptersDir)) {
      if (entry.endsWith(".md")) await rm(join(chaptersDir, entry), { force: true });
    }
    await writeFile(join(chaptersDir, "index.json"), "[]\n", "utf8");
    for (const directory of ["audit", "audit-candidates", "runtime", "snapshots", "state"]) {
      await rm(join(storyDir, directory), { recursive: true, force: true });
    }
    // Resume of a failed first chapter needs the immutable foundation snapshot.
    // Recreate only snapshot 0 from the copied foundation files; no generated
    // chapter/runtime state is carried over from the baseline.
    const retrySnapshotDir = join(storyDir, "snapshots", "0");
    await mkdir(retrySnapshotDir, { recursive: true });
    for (const file of ["character_matrix.md", "current_state.md", "emotional_arcs.md", "pending_hooks.md"]) {
      await cp(join(storyDir, file), join(retrySnapshotDir, file));
    }
    for (const file of ["memory.db", "memory.db-shm", "memory.db-wal"]) {
      await rm(join(storyDir, file), { force: true });
    }
    await writeFile(join(storyDir, "chapter_summaries.md"), `# Tóm tắt chương\n\n| Chương | Tiêu đề | Nhân vật | Sự kiện chính | Thay đổi trạng thái | Diễn biến tình tiết cài cắm | Sắc thái | Loại chương |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n`, "utf8");
    await writeFile(join(storyDir, "audit_drift.md"), "# Audit Drift\n\n## Audit Drift Correction\n\n> Chưa có audit drift ở thời điểm bắt đầu qualification.\n", "utf8");
    const baselineBook = await readJson(join(bookDir, "book.json"));
    await writeFile(join(bookDir, "book.json"), `${JSON.stringify({
      ...baselineBook,
      id: bookId,
      title: `${baselineBook.title} ${targetChapters}-chapter Phase B canary ${runId}`,
      targetChapters,
      chapterWordCount: 1150,
      status: "active",
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, "utf8");
    const projectConfig = await readFile(join(baselineRoot, "inkos.json"), "utf8");
    await writeFile(join(scratchRoot, "inkos.json"), projectConfig, "utf8");
    await mkdir(join(scratchRoot, ".inkos"), { recursive: true });
    await writeFile(join(scratchRoot, ".inkos", "vi-writing-v1.json"), `${JSON.stringify({
      schemaVersion: 1,
      contractVersion: "vi-writing-v1",
      projectRoot: scratchRoot,
    }, null, 2)}\n`, "utf8");
  } else {
    const existingBook = await readJson(join(bookDir, "book.json"));
    const existingIndex = await readJson(join(bookDir, "chapters", "index.json"));
    const manifest = await readJson(join(bookDir, "story", "state", "manifest.json"));
    const acceptedStatuses = new Set(["audit-passed", "ready-for-review", "approved", "published", "imported"]);
    const priorChapters = Array.from({ length: startChapter - 1 }, (_, index) => index + 1);
    const retryEntry = existingIndex.find((chapter) => chapter.number === startChapter);
    const futureEntries = existingIndex.filter((chapter) => chapter.number > startChapter);
    const transactionDirs = (await readdir(bookDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(".inkos-file-txn-"))
      .map((entry) => entry.name);
    safe.resumePreflight = {
      targetChapters: existingBook.targetChapters ?? null,
      manifestLastAppliedChapter: manifest.lastAppliedChapter ?? null,
      priorChaptersAccepted: priorChapters.every((number) => existingIndex.some((chapter) =>
        chapter.number === number
        && acceptedStatuses.has(chapter.status)
        && (!chapter.auditDecision || chapter.auditDecision === "pass"))),
      mode: retryEntry ? "retry-failed-chapter" : "append-next-chapter",
      retryChapter: retryEntry
        ? { number: retryEntry.number, status: retryEntry.status, auditDecision: retryEntry.auditDecision ?? null }
        : null,
      futureEntryCount: futureEntries.length,
      transactionDirs,
    };
    if (
      existingBook.targetChapters !== targetChapters
      || manifest.lastAppliedChapter !== startChapter - 1
      || !safe.resumePreflight.priorChaptersAccepted
      || (retryEntry !== undefined && retryEntry.status !== "audit-failed")
      || futureEntries.length !== 0
      || transactionDirs.length !== 0
    ) {
      throw new Error("Resume preflight refused: qualification book is not at the expected failed-chapter checkpoint");
    }
  }

  const secrets = await readJson(join(baselineRoot, ".inkos", "secrets.json"));
  const apiKey = secrets.services?.[serviceKey]?.apiKey;
  if (typeof apiKey !== "string" || apiKey.length === 0) throw new Error("Ecoapi key is not configured");
  safe.keyPresent = true;

  currentStage = "health-models";
  const probedModels = await probeModelsFromUpstream(baseUrl, apiKey, 15_000);
  currentStage = "health-chat-non-stream";
  const nonStreamProbe = await probeChatContract(baseUrl, apiKey, model, {
    stream: false,
    reasoningEffort: "none",
    maxTokens: 16,
    temperature: 0,
    timeoutMs: 30_000,
  });
  currentStage = "health-chat-stream";
  const streamProbe = await probeChatContract(baseUrl, apiKey, model, {
    stream: true,
    reasoningEffort: "none",
    maxTokens: 16,
    temperature: 0,
    timeoutMs: 30_000,
  });
  safe.healthGate = {
    modelPresent: probedModels.some((entry) => entry.id === model),
    modelCount: probedModels.length,
    nonStream: nonStreamProbe,
    stream: streamProbe,
  };
  if (!safe.healthGate.modelPresent || !nonStreamProbe.ok || !streamProbe.ok) {
    safe.exitReason = "BLOCKED_PROVIDER_HEALTH";
    throw new Error("Ecoapi health gate did not return final answers");
  }

  process.env.INKOS_EXPERIMENTAL_WRITING_VI = "1";
  delete process.env.INKOS_AGENT_LLM_STUB;
  const client = createLLMClient({
    provider: "custom",
    service: serviceKey,
    baseUrl,
    apiKey,
    model,
    temperature: 0.7,
    thinkingBudget: 0,
    apiFormat: "chat",
    stream: pipelineStream,
    extra: { reasoning_effort: "none" },
  });
  const defaultLLMConfig = {
    provider: "custom",
    service: serviceKey,
    baseUrl,
    apiKey,
    model,
    temperature: 0.7,
    thinkingBudget: 0,
    apiFormat: "chat",
    stream: pipelineStream,
    extra: { reasoning_effort: "none" },
  };
  const runner = new PipelineRunner({
    client,
    model,
    projectRoot: scratchRoot,
    defaultLLMConfig,
    foundationReviewRetries: 2,
    writingReviewRetries: 1,
    chapterReviewMode: "auto",
    revisionGate: "strict",
  });

  const abortDrillEnabled = targetChapters === 15
    && startChapter <= 4
    && runThroughChapter >= 4;
  if (abortDrillEnabled) {
    currentStage = "recovery-abort-drill";
    let drillError = null;
    let drillResult = null;
    const drillController = new AbortController();
    const drillTimer = setTimeout(() => {
      drillController.abort(new Error("qualification-abort-drill"));
    }, 750);
    try {
      drillResult = await runner.runWithAbortSignal(
        drillController.signal,
        () => runner.writeNextChapter(bookId, 1150),
      );
    } catch (error) {
      drillError = safeError(error);
    } finally {
      clearTimeout(drillTimer);
    }
    const postAbortState = await collectStateInvariants(3);
    const postAbortChapterFiles = (await readdir(join(bookDir, "chapters")))
      .filter((name) => /^0004_.+\.md$/u.test(name));
    const aborted = drillError !== null;
    const cleanCheckpoint = postAbortState.aligned
      && postAbortChapterFiles.length === 0;
    safe.recoveryDrill = {
      chapterNumber: 4,
      abortRequestedAfterMs: 750,
      aborted,
      error: drillError,
      returnedStatus: drillResult?.status ?? null,
      postAbortState,
      postAbortChapterFileCount: postAbortChapterFiles.length,
      cleanCheckpoint,
    };
    if (!aborted || !cleanCheckpoint) {
      safe.exitReason = "FAIL_RECOVERY_DRILL";
      throw new Error("Abort/restart drill did not preserve the chapter-3 checkpoint");
    }
  }

  for (let chapterNumber = startChapter; chapterNumber <= runThroughChapter; chapterNumber += 1) {
    currentStage = `chapter-${chapterNumber}`;
    const operationRecord = {
      chapterNumber,
      durationMs: null,
      status: "error",
      chapter: null,
      invariants: null,
      error: null,
    };
    try {
      const operation = await bounded(`chapter-${chapterNumber}`, 15 * 60_000, (signal) =>
        runner.runWithAbortSignal(signal, () => runner.writeNextChapter(bookId, 1150, undefined, externalContext))
      );
      operationRecord.durationMs = operation.durationMs;
      operationRecord.status = "completed";
      operationRecord.chapter = await collectChapterEvidence(chapterNumber, operation.value);
      operationRecord.invariants = await collectStateInvariants(chapterNumber);
    } catch (error) {
      operationRecord.error = safeError(error);
      try {
        operationRecord.invariants = await collectStateInvariants(Math.max(0, chapterNumber - 1));
      } catch {
        // Keep the error evidence even if the operation failed before bootstrap.
      }
    }
    safe.operations.push(operationRecord);
    process.stdout.write(`${JSON.stringify({
      chapterNumber,
      status: operationRecord.status,
      wordCount: operationRecord.chapter?.recomputedWordCount ?? null,
      hardInRange: operationRecord.chapter?.hardInRange ?? null,
      auditDecision: operationRecord.chapter?.auditDecision ?? null,
      auditPassed: operationRecord.chapter?.auditPassed ?? null,
      surfaceBlockerCount: operationRecord.chapter?.surfaceBlockerCount ?? null,
      spellingIssueCount: operationRecord.chapter?.spellingIssueCount ?? null,
      cjkCharacterCount: operationRecord.chapter?.cjkCharacterCount ?? null,
      stateAligned: operationRecord.invariants?.aligned ?? null,
      error: operationRecord.error,
    })}\n`);
    const chapterPassed = operationRecord.status === "completed"
      && operationRecord.chapter?.auditDecision === "pass"
      && operationRecord.chapter?.auditPassed === true
      && operationRecord.chapter?.hardInRange === true
      && operationRecord.chapter?.countingMode === "vi_wordlike_tokens_v1"
      && operationRecord.chapter?.verifiedBlockerCount === 0
      && operationRecord.chapter?.surfaceBlockerCount === 0
      && operationRecord.chapter?.spellingIssueCount === 0
      && operationRecord.chapter?.cjkCharacterCount === 0
      && operationRecord.invariants?.aligned === true;
    if (!chapterPassed) {
      if (operationRecord.status !== "completed") {
        safe.exitReason = isProviderFailure(operationRecord)
          ? `BLOCKED_PROVIDER_CHAPTER_${chapterNumber}`
          : `FAIL_HARNESS_CHAPTER_${chapterNumber}`;
      } else if (
        operationRecord.chapter?.auditDecision !== "pass"
        || operationRecord.chapter?.auditPassed !== true
        || operationRecord.chapter?.hardInRange !== true
        || operationRecord.chapter?.countingMode !== "vi_wordlike_tokens_v1"
        || operationRecord.chapter?.verifiedBlockerCount !== 0
        || operationRecord.chapter?.surfaceBlockerCount !== 0
        || operationRecord.chapter?.spellingIssueCount !== 0
        || operationRecord.chapter?.cjkCharacterCount !== 0
      ) {
        safe.exitReason = `FAIL_QUALITY_CHAPTER_${chapterNumber}`;
      } else if (operationRecord.invariants?.aligned !== true) {
        safe.exitReason = `FAIL_STATE_CHAPTER_${chapterNumber}`;
      } else {
        safe.exitReason = `FAIL_HARNESS_CHAPTER_${chapterNumber}`;
      }
      break;
    }
    if (chapterNumber === 3 || chapterNumber === 8) {
      safe.checkpoints.push({
        chapterNumber,
        providerRequestCount: safe.providerRequests.length,
        hardPassCount: safe.operations.filter((operation) =>
          operation.status === "completed"
          && operation.chapter?.auditDecision === "pass"
          && operation.chapter?.auditPassed === true
          && operation.chapter?.hardInRange === true
          && operation.chapter?.verifiedBlockerCount === 0
          && operation.chapter?.surfaceBlockerCount === 0
          && operation.chapter?.spellingIssueCount === 0
          && operation.chapter?.cjkCharacterCount === 0
          && operation.invariants?.aligned === true,
        ).length,
        invariants: operationRecord.invariants,
      });
    }
  }
  safe.finalInvariants = safe.operations.at(-1)?.invariants ?? null;
  hardPassCount = safe.operations.filter((operation) =>
    operation.status === "completed"
    && operation.chapter?.auditDecision === "pass"
    && operation.chapter?.auditPassed === true
    && operation.chapter?.hardInRange === true
    && operation.chapter?.verifiedBlockerCount === 0
    && operation.chapter?.surfaceBlockerCount === 0
    && operation.chapter?.spellingIssueCount === 0
    && operation.chapter?.cjkCharacterCount === 0
    && operation.invariants?.aligned === true,
  ).length;
  preferredPassCount = safe.operations.filter((operation) => operation.chapter?.preferredInRange === true).length;
  const expectedOperationCount = runThroughChapter - startChapter + 1;
  const expansionPass = safe.operations.length === expectedOperationCount && hardPassCount === expectedOperationCount;
  if (expansionPass) {
    safe.exitReason = runThroughChapter === targetChapters
      ? "PASS"
      : `PASS_CHECKPOINT_CHAPTER_${runThroughChapter}`;
  }
} catch (error) {
  safe.exitReason = safe.exitReason ?? "ERROR";
  safe.error = safeError(error);
} finally {
  globalThis.fetch = originalFetch;
  safe.completedAt = new Date().toISOString();
  safe.totalDurationMs = new Date(safe.completedAt).getTime() - startedAt.getTime();
  safe.providerRequestCount = safe.providerRequests.length;
  await mkdir(scratchRoot, { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(safe, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(JSON.stringify({
    exitReason: safe.exitReason,
    bookId,
    evidencePath,
    providerRequestCount: safe.providerRequestCount,
    operationCount: safe.operations.length,
    hardPassCount,
    preferredPassCount,
    chapters: safe.operations.map((operation) => ({
      chapterNumber: operation.chapterNumber,
      status: operation.status,
      chapterStatus: operation.chapter?.status ?? null,
      chapterWordCount: operation.chapter?.recomputedWordCount ?? null,
      preferredInRange: operation.chapter?.preferredInRange ?? null,
      hardInRange: operation.chapter?.hardInRange ?? null,
      auditDecision: operation.chapter?.auditDecision ?? null,
      auditPassed: operation.chapter?.auditPassed ?? null,
      surfaceWarningCount: operation.chapter?.surfaceIssues?.length ?? null,
      surfaceBlockerCount: operation.chapter?.surfaceBlockerCount ?? null,
      spellingIssueCount: operation.chapter?.spellingIssueCount ?? null,
      cjkCharacterCount: operation.chapter?.cjkCharacterCount ?? null,
      stateAligned: operation.invariants?.aligned ?? null,
      selectedContextTokens: operation.chapter?.contextTrace?.tokenBudget?.totalSelectedTokens ?? null,
      error: operation.error,
    })),
    error: safe.error,
  }, null, 2));
}
