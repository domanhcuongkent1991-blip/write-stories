import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AuditIssue } from "../agents/continuity.js";
import {
  AuditRunV1Schema,
  auditRunRelativePath,
  type AuditRunV1,
} from "./audit-run.js";

const DEFAULT_TTL_CHAPTERS = 1;
const TERMINAL_OUTCOMES = new Set<AuditRunV1["canonicalCommitOutcome"]>([
  "terminal-commit",
  "unchanged",
]);

interface FindingRecord {
  readonly issue: AuditIssue;
  readonly chapterNumber: number;
  readonly completedAt: string;
  readonly attemptId: string;
}

export function selectAuditDriftFindings(params: {
  readonly runs: ReadonlyArray<AuditRunV1>;
  readonly currentChapter: number;
  readonly maxFindings?: number;
  readonly defaultTtlChapters?: number;
}): AuditIssue[] {
  const latestByIdentity = new Map<string, FindingRecord>();
  const sortedRuns = [...params.runs]
    .filter((run) => TERMINAL_OUTCOMES.has(run.canonicalCommitOutcome))
    .filter((run) => run.chapterNumber <= params.currentChapter)
    .sort(compareRunsOldestFirst);
  const latestRunByChapter = new Map<number, AuditRunV1>();
  for (const run of sortedRuns) {
    latestRunByChapter.set(run.chapterNumber, run);
  }

  for (const run of [...latestRunByChapter.values()].sort(compareRunsOldestFirst)) {
    for (const finding of run.findings) {
      const findingId = finding.findingId?.trim();
      const terminalLifecycle = finding.lifecycle === "resolved"
        || finding.lifecycle === "superseded"
        || finding.lifecycle === "expired";
      if (terminalLifecycle && findingId && !finding.fingerprint?.trim()) {
        for (const [identity, record] of latestByIdentity) {
          if (!record.issue.fingerprint?.trim() && record.issue.findingId?.trim() === findingId) {
            latestByIdentity.delete(identity);
          }
        }
      }
      const identity = findingIdentity(finding);
      const previous = latestByIdentity.get(identity);
      if (previous === undefined || shouldReplaceFinding(previous.issue, finding)) {
        latestByIdentity.set(identity, {
          issue: finding,
          chapterNumber: run.chapterNumber,
          completedAt: run.completedAt,
          attemptId: run.attemptId,
        });
      }
    }
  }

  const defaultTtl = positiveIntegerOr(params.defaultTtlChapters, DEFAULT_TTL_CHAPTERS);
  const maxFindings = positiveIntegerOr(params.maxFindings, 3);
  return [...latestByIdentity.values()]
    .filter((record) => isProjectable(record, params.currentChapter, defaultTtl))
    .sort(compareFindings)
    .slice(0, maxFindings)
    .map((record) => record.issue);
}

export async function loadAuditDriftProjection(params: {
  readonly bookDir: string;
  readonly bookId: string;
  readonly currentChapter: number;
  readonly maxFindings?: number;
  readonly defaultTtlChapters?: number;
}): Promise<AuditIssue[]> {
  const runsRoot = join(params.bookDir, "story", "audit", "runs");
  const chapterDirectories = await readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  const runs: AuditRunV1[] = [];

  for (const directory of chapterDirectories) {
    if (!directory.isDirectory()) continue;
    const match = /^chapter-(\d{4})$/u.exec(directory.name);
    if (!match) continue;
    const chapterNumber = Number.parseInt(match[1]!, 10);
    if (chapterNumber > params.currentChapter) continue;

    const directoryPath = join(runsRoot, directory.name);
    const files = await readdir(directoryPath, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".audit-run-v1.json")) continue;
      const fullPath = join(directoryPath, file.name);
      const auditRun = await readValidRun(fullPath);
      if (!auditRun) continue;
      if (auditRun.bookId !== params.bookId || auditRun.chapterNumber !== chapterNumber) continue;
      const canonicalPath = join(params.bookDir, ...auditRunRelativePath(auditRun).split("/"));
      if (canonicalPath !== fullPath) continue;
      runs.push(auditRun);
    }
  }

  return selectAuditDriftFindings({
    runs,
    currentChapter: params.currentChapter,
    ...(params.maxFindings === undefined ? {} : { maxFindings: params.maxFindings }),
    ...(params.defaultTtlChapters === undefined
      ? {}
      : { defaultTtlChapters: params.defaultTtlChapters }),
  });
}

async function readValidRun(path: string): Promise<AuditRunV1 | undefined> {
  try {
    const parsed = AuditRunV1Schema.safeParse(JSON.parse(await readFile(path, "utf-8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function isProjectable(
  record: FindingRecord,
  currentChapter: number,
  defaultTtl: number,
): boolean {
  const { issue } = record;
  if (issue.lifecycle === "resolved" || issue.lifecycle === "superseded" || issue.lifecycle === "expired") {
    return false;
  }
  if (issue.verification === "stale" || (issue.severity !== "critical" && issue.severity !== "warning")) {
    return false;
  }
  if ((issue.verification === "unverified" || issue.verification === undefined)
    && issue.suggestion.trim().length === 0) {
    return false;
  }
  const ttl = positiveIntegerOr(issue.ttlChapters, defaultTtl);
  return currentChapter - record.chapterNumber < ttl;
}

function findingIdentity(issue: AuditIssue): string {
  const fingerprint = issue.fingerprint?.trim();
  if (fingerprint) return `fingerprint\u0000${fingerprint}`;

  // Occurrence IDs are not semantic identity: a reused/blank ID must not make
  // one finding overwrite an unrelated finding. Keep enough normalized
  // meaning to dedupe the same legacy issue while preserving distinct issues.
  return [
    issue.category,
    issue.ruleId ?? "",
    issue.repairTarget ?? "",
    issue.severity,
    issue.description.trim(),
    issue.suggestion.trim(),
  ].join("\u0000");
}

function compareRunsOldestFirst(left: AuditRunV1, right: AuditRunV1): number {
  return left.completedAt.localeCompare(right.completedAt)
    || left.chapterNumber - right.chapterNumber
    || left.attemptId.localeCompare(right.attemptId)
    || left.phase.localeCompare(right.phase);
}

function compareFindings(left: FindingRecord, right: FindingRecord): number {
  return findingPriority(left.issue) - findingPriority(right.issue)
    || left.issue.description.localeCompare(right.issue.description)
    || right.completedAt.localeCompare(left.completedAt)
    || left.attemptId.localeCompare(right.attemptId);
}

function findingPriority(issue: AuditIssue): number {
  if (issue.severity === "critical") return 0;
  if (issue.verification === "verified") return 1;
  return 2;
}

function shouldReplaceFinding(previous: AuditIssue, incoming: AuditIssue): boolean {
  const incomingTerminal = incoming.lifecycle === "resolved"
    || incoming.lifecycle === "superseded"
    || incoming.lifecycle === "expired";
  if (incomingTerminal) return true;

  const previousTerminal = previous.lifecycle === "resolved"
    || previous.lifecycle === "superseded"
    || previous.lifecycle === "expired";
  if (previousTerminal) return true;

  // Retain the higher-priority occurrence for a shared semantic fingerprint;
  // equal priority uses the later deterministic evidence.
  return findingPriority(incoming) <= findingPriority(previous);
}

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}
