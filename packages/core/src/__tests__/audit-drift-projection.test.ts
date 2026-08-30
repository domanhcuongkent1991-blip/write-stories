import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditRunRelativePath,
  serializeAuditRun,
  type AuditRunV1,
} from "../audit/audit-run.js";
import {
  loadAuditDriftProjection,
  selectAuditDriftFindings,
} from "../audit/audit-drift-projection.js";

const HASH = "a".repeat(64);

type StoredAuditIssue = AuditRunV1["findings"][number];

function issue(overrides: Partial<StoredAuditIssue>): StoredAuditIssue {
  return {
    severity: "warning",
    category: "pacing",
    description: "Vary the next chapter beat.",
    suggestion: "Use a different explicit pacing code.",
    source: "deterministic",
    verification: "verified",
    lifecycle: "open",
    ...overrides,
  };
}

function run(params: {
  chapter: number;
  findings: StoredAuditIssue[];
  completedAt?: string;
  outcome?: AuditRunV1["canonicalCommitOutcome"];
}): AuditRunV1 {
  const operationId = randomUUID();
  const attemptId = randomUUID();
  return {
    schemaVersion: 1,
    kind: "audit-run-v1",
    operationId,
    attemptId,
    operation: "write",
    phase: "initial",
    bookId: "book-1",
    chapterNumber: params.chapter,
    startedAt: params.completedAt ?? "2026-08-30T00:00:00.000Z",
    completedAt: params.completedAt ?? "2026-08-30T00:00:01.000Z",
    durationMs: 1_000,
    contentHash: HASH,
    length: {
      count: 100,
      countingMode: "en_words",
      target: 100,
      softMin: 90,
      softMax: 110,
      hardMin: 80,
      hardMax: 120,
    },
    decision: "pass",
    passed: true,
    findings: params.findings,
    revision: { attempted: false, candidateProduced: false, accepted: false },
    canonicalCommitOutcome: params.outcome ?? "terminal-commit",
    retryCounts: { transport: 0, output: 0, quality: 0 },
  };
}

describe("audit drift projection", () => {
  it("prioritizes critical then verified warnings, excludes non-actionable evidence, and caps at three", () => {
    const findings = selectAuditDriftFindings({
      runs: [run({
        chapter: 10,
        findings: [
          issue({ findingId: "u1", verification: "unverified", description: "Unverified actionable" }),
          issue({ findingId: "w2", description: "Verified warning two" }),
          issue({ findingId: "c1", severity: "critical", description: "Critical contradiction" }),
          issue({ findingId: "w1", description: "Verified warning one" }),
          issue({ findingId: "empty", verification: "unverified", description: "No repair", suggestion: "" }),
          issue({ findingId: "info", severity: "info", description: "Informational only" }),
        ],
      })],
      currentChapter: 10,
    });

    expect(findings).toHaveLength(3);
    expect(findings.map((finding) => finding.description)).toEqual([
      "Critical contradiction",
      "Verified warning one",
      "Verified warning two",
    ]);
  });

  it("honors terminal lifecycle records and chapter TTL", () => {
    const open = issue({ findingId: "same", description: "Old open finding", ttlChapters: 3 });
    const resolved = issue({ findingId: "same", description: "Resolved finding", lifecycle: "resolved", ttlChapters: 3 });
    const shortLived = issue({ findingId: "short", description: "Short-lived finding" });
    const explicitExpired = issue({ findingId: "expired", lifecycle: "expired", description: "Already expired", ttlChapters: 5 });
    const runs = [
      run({ chapter: 8, findings: [open, shortLived, explicitExpired], completedAt: "2026-08-30T00:00:01.000Z" }),
      run({ chapter: 9, findings: [resolved], completedAt: "2026-08-30T00:00:02.000Z" }),
    ];

    expect(selectAuditDriftFindings({ runs, currentChapter: 9 })).toEqual([]);
    expect(selectAuditDriftFindings({
      runs: [run({ chapter: 8, findings: [open] })],
      currentChapter: 10,
    })).toEqual([open]);
    expect(selectAuditDriftFindings({
      runs: [run({ chapter: 8, findings: [open] })],
      currentChapter: 11,
    })).toEqual([]);
  });

  it("uses fingerprints as the lifecycle identity before occurrence finding IDs", () => {
    const critical = issue({
      findingId: "duplicate-occurrence",
      fingerprint: "critical-fingerprint",
      severity: "critical",
      description: "Critical runtime contradiction",
    });
    const warning = issue({
      findingId: "duplicate-occurrence",
      fingerprint: "warning-fingerprint",
      description: "Minor pacing warning",
    });

    const findings = selectAuditDriftFindings({
      runs: [run({ chapter: 10, findings: [warning, critical] })],
      currentChapter: 10,
    });

    expect(findings.map((finding) => finding.description)).toEqual([
      "Critical runtime contradiction",
      "Minor pacing warning",
    ]);
  });

  it("retains a critical occurrence when a later warning shares its semantic fingerprint", () => {
    const critical = issue({
      findingId: "critical-occurrence",
      fingerprint: "shared-fingerprint",
      severity: "critical",
      description: "Critical contradiction",
    });
    const warning = issue({
      findingId: "warning-occurrence",
      fingerprint: "shared-fingerprint",
      description: "Warning reminder",
    });

    const findings = selectAuditDriftFindings({
      runs: [
        run({ chapter: 8, findings: [critical], completedAt: "2026-08-30T00:00:01.000Z" }),
        run({ chapter: 9, findings: [warning], completedAt: "2026-08-30T00:00:02.000Z" }),
      ],
      currentChapter: 9,
      defaultTtlChapters: 2,
    });

    expect(findings).toEqual([expect.objectContaining({
      severity: "critical",
      description: "Critical contradiction",
    })]);
  });

  it("does not collide blank finding IDs when fingerprints are absent", () => {
    const findings = selectAuditDriftFindings({
      runs: [run({
        chapter: 10,
        findings: [
          issue({ findingId: "", description: "First semantic warning" }),
          issue({ findingId: "", description: "Second semantic warning" }),
        ],
      })],
      currentChapter: 10,
    });

    expect(findings.map((finding) => finding.description)).toEqual([
      "First semantic warning",
      "Second semantic warning",
    ]);
  });

  it("does not let a reused non-empty occurrence ID hide a different critical finding", () => {
    const findings = selectAuditDriftFindings({
      runs: [run({
        chapter: 10,
        findings: [
          issue({ findingId: "reused", description: "Warning with one meaning" }),
          issue({ findingId: "reused", severity: "critical", description: "Critical with another meaning" }),
        ],
      })],
      currentChapter: 10,
    });

    expect(findings.map((finding) => finding.description)).toEqual([
      "Critical with another meaning",
      "Warning with one meaning",
    ]);
  });

  it("closes an older open finding when a later chapter resolves the same fingerprint", () => {
    const open = issue({ findingId: "old-occurrence", fingerprint: "same-fingerprint", ttlChapters: 5 });
    const resolved = issue({
      findingId: "new-occurrence",
      fingerprint: "same-fingerprint",
      lifecycle: "resolved",
      ttlChapters: 5,
    });

    expect(selectAuditDriftFindings({
      runs: [
        run({ chapter: 8, findings: [open] }),
        run({ chapter: 9, findings: [resolved] }),
      ],
      currentChapter: 9,
    })).toEqual([]);
  });

  it("does not project a legacy finding with missing verification and blank suggestion", () => {
    expect(selectAuditDriftFindings({
      runs: [run({
        chapter: 10,
        findings: [issue({ verification: undefined, suggestion: "" })],
      })],
      currentChapter: 10,
    })).toEqual([]);
  });

  it("uses the latest terminal evidence for a chapter so repaired findings do not linger", () => {
    const oldRun = run({
      chapter: 6,
      findings: [issue({ findingId: "repaired", description: "Old open problem", ttlChapters: 3 })],
      completedAt: "2026-08-30T00:00:01.000Z",
    });
    const cleanRun = run({
      chapter: 6,
      findings: [],
      completedAt: "2026-08-30T00:00:02.000Z",
    });

    expect(selectAuditDriftFindings({
      runs: [oldRun, cleanRun],
      currentChapter: 6,
    })).toEqual([]);
  });

  it("rebuilds deterministically from valid immutable audit runs only", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-audit-drift-"));
    const valid = run({
      chapter: 4,
      findings: [issue({ findingId: "valid", description: "Rebuilt from immutable evidence" })],
      completedAt: "2026-08-30T00:00:03.000Z",
    });
    const superseded = run({
      chapter: 4,
      findings: [issue({ findingId: "ignored", severity: "critical", description: "Superseded evidence" })],
      completedAt: "2026-08-30T00:00:04.000Z",
      outcome: "superseded",
    });
    try {
      for (const auditRun of [valid, superseded]) {
        const path = join(root, auditRunRelativePath(auditRun));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, serializeAuditRun(auditRun), "utf-8");
      }
      await writeFile(
        join(root, "story", "audit", "runs", "chapter-0004", `${randomUUID()}.manual.audit-run-v1.json`),
        "{ malformed",
        "utf-8",
      );

      const projection = await loadAuditDriftProjection({
        bookDir: root,
        bookId: "book-1",
        currentChapter: 4,
      });

      expect(projection.map((finding) => finding.findingId)).toEqual(["valid"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
