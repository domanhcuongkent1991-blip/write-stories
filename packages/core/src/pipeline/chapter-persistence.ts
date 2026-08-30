import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { PreparedChapterFileSet } from "../agents/writer.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { LengthTelemetry } from "../models/length-governance.js";
import type { AtomicFileWrite } from "../utils/atomic-file-set.js";
import type { AuditRunV1 } from "../audit/audit-run.js";
import type { TokenUsage } from "../models/input-governance.js";
import { auditRunRelativePath } from "../audit/audit-run.js";
import { buildStateDegradedReviewNote } from "./chapter-state-recovery.js";

export interface ChapterPersistenceUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export type ChapterPersistenceStatus = "ready-for-review" | "audit-failed" | "state-degraded";

export async function persistChapterArtifacts(params: {
  readonly chapterNumber: number;
  readonly chapterTitle: string;
  readonly status: ChapterPersistenceStatus;
  readonly auditResult: AuditResult;
  readonly auditRunWrites?: ReadonlyArray<AtomicFileWrite>;
  readonly auditRuns?: ReadonlyArray<AuditRunV1>;
  readonly finalWordCount: number;
  readonly lengthWarnings: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly degradedIssues: ReadonlyArray<AuditIssue>;
  readonly tokenUsage?: ChapterPersistenceUsage;
  readonly tokenUsageByAgent?: Partial<Record<"planner" | "writer" | "auditor" | "reviser", TokenUsage>>;
  readonly tokenUsageBySource?: Readonly<Record<string, number>>;
  readonly loadChapterIndex: () => Promise<ReadonlyArray<ChapterMeta>>;
  readonly prepareCanonicalFiles: (
    updatedIndex: ReadonlyArray<ChapterMeta>,
  ) => Promise<PreparedChapterFileSet>;
  readonly commitCanonicalFiles: (
    fileSet: PreparedChapterFileSet,
    updatedIndex: ReadonlyArray<ChapterMeta>,
  ) => Promise<void>;
  readonly markBookActiveIfNeeded: () => Promise<void>;
  readonly persistAuditDriftGuidance: (issues: ReadonlyArray<AuditIssue>) => Promise<void>;
  readonly snapshotState: () => Promise<void>;
  readonly syncCurrentStateFactHistory: () => Promise<void>;
  readonly logSnapshotStage: () => void;
  readonly now?: () => string;
}): Promise<{ readonly entry: ChapterMeta }> {
  const existingIndex = await params.loadChapterIndex();
  const now = params.now?.() ?? new Date().toISOString();
  const initialAuditRun = params.auditRuns?.find((run) => run.phase === "initial");
  const postRevisionRun = params.auditRuns?.find((run) => run.phase === "post-revision");
  const revisionOutcome = postRevisionRun
    ? postRevisionRun.revision.accepted
      ? "accepted"
      : postRevisionRun.decision === "inconclusive" ? "inconclusive" : "rejected"
    : initialAuditRun?.revision.attempted
      ? initialAuditRun.decision === "inconclusive" ? "inconclusive" : "rejected"
      : params.auditResult.decision === "inconclusive" ? "inconclusive" : "not-needed";
  const revisionEvidence = postRevisionRun?.revision ?? initialAuditRun?.revision;
  const entry: ChapterMeta = {
    number: params.chapterNumber,
    title: params.chapterTitle,
    status: params.status,
    wordCount: params.finalWordCount,
    createdAt: now,
    updatedAt: now,
    auditIssues: params.auditResult.issues.map((issue) => `[${issue.severity}] ${issue.description}`),
    lengthWarnings: [...params.lengthWarnings],
    reviewNote: params.status === "state-degraded"
      ? buildStateDegradedReviewNote(
          params.auditResult.passed ? "ready-for-review" : "audit-failed",
          params.degradedIssues,
        )
      : undefined,
    lengthTelemetry: params.lengthTelemetry,
    auditDecision: params.auditResult.decision,
    auditAttemptId: initialAuditRun?.attemptId,
    auditRunPaths: params.auditRuns?.map(auditRunRelativePath),
    verifiedBlockerCount: params.auditResult.issues.filter(
      (issue) => issue.severity === "critical" && issue.verification === "verified",
    ).length,
    revisionAttempts: revisionEvidence?.attempted ? 1 : 0,
    revisionOutcome,
    revisionRejectionReason: revisionEvidence?.rejectionReason,
    auditProvenance: params.auditResult.provenance,
    tokenUsage: params.tokenUsage,
    tokenUsageByAgent: params.tokenUsageByAgent,
    tokenUsageBySource: params.tokenUsageBySource,
  };
  const existingIdx = existingIndex.findIndex((e) => e.number === params.chapterNumber);
  const persistedEntry = existingIdx >= 0
    ? { ...entry, createdAt: existingIndex[existingIdx].createdAt }
    : entry;
  const updatedIndex = existingIdx >= 0
    ? existingIndex.map((e, i) => i === existingIdx ? persistedEntry : e)
    : [...existingIndex, persistedEntry];
  const fileSet = await params.prepareCanonicalFiles(updatedIndex);
  await params.commitCanonicalFiles({
    ...fileSet,
    writes: [...fileSet.writes, ...(params.auditRunWrites ?? [])],
  }, updatedIndex);
  await params.markBookActiveIfNeeded();

  const driftIssues = params.auditResult.issues.filter(
    (issue) => issue.severity === "critical" || issue.severity === "warning",
  );
  await params.persistAuditDriftGuidance(params.status === "state-degraded" ? [] : driftIssues);

  if (params.status !== "state-degraded") {
    params.logSnapshotStage();
    await params.snapshotState();
    await params.syncCurrentStateFactHistory();
  }

  return { entry: persistedEntry };
}
