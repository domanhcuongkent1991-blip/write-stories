import { describe, expect, it } from "vitest";
import type { AuditIssue } from "../agents/continuity.js";
import { computeChapterContentHash } from "../audit/chapter-audit-evaluator.js";
import { applyVietnameseLocalRepair } from "../utils/vietnamese-local-repair.js";

function spellingFinding(content: string, overrides: Partial<AuditIssue> = {}): AuditIssue {
  return {
    severity: "critical",
    category: "vi-known-spelling",
    description: "Cụm từ lầy bơi sai chính tả.",
    suggestion: "Thay bằng bãi bùn đất lầy lội.",
    findingId: "vi-spelling-1",
    repairScope: "local",
    repairTarget: "prose",
    verification: "verified",
    evidence: { contentHash: computeChapterContentHash(content) },
    repairHint: {
      kind: "exact-replacement",
      targetText: "lầy bơi",
      replacementText: "bãi bùn đất lầy lội",
      occurrenceIndexes: [1],
      context: "... lầy bơi ...",
    },
    ...overrides,
  };
}

describe("applyVietnameseLocalRepair", () => {
  it("applies one hash-bound exact replacement and reports bounded telemetry", () => {
    const content = "Cô dừng lại giữa lầy bơi trước cánh cổng.";

    const result = applyVietnameseLocalRepair(content, [spellingFinding(content)]);

    expect(result).toMatchObject({
      kind: "applied",
      content: "Cô dừng lại giữa bãi bùn đất lầy lội trước cánh cổng.",
      fixedFindingIds: ["vi-spelling-1"],
      telemetry: {
        attempted: true,
        applied: true,
        patchCount: 1,
        inputContentHash: computeChapterContentHash(content),
      },
    });
  });

  it("rejects a stale content hash without changing prose", () => {
    const content = "Cô dừng lại giữa lầy bơi.";
    const result = applyVietnameseLocalRepair(content, [spellingFinding(content, {
      evidence: { contentHash: "0".repeat(64) },
    })]);

    expect(result).toMatchObject({
      kind: "rejected",
      code: "stale-hash",
      content,
      telemetry: { attempted: true, applied: false, patchCount: 0 },
    });
  });

  it("rejects an unsafe missing, ambiguous, or no-op replacement", () => {
    const ambiguous = "lầy bơi rồi lầy bơi";
    const ambiguousFinding = spellingFinding(ambiguous);
    const missing = "Không có cụm lỗi.";

    expect(applyVietnameseLocalRepair(ambiguous, [{
      ...ambiguousFinding,
      repairHint: { ...ambiguousFinding.repairHint!, occurrenceIndexes: [] },
    }])).toMatchObject({ kind: "rejected", code: "unsafe-patch" });
    expect(applyVietnameseLocalRepair(missing, [spellingFinding(missing)]))
      .toMatchObject({ kind: "rejected", code: "unsafe-patch" });
    expect(applyVietnameseLocalRepair(ambiguous, [{
      ...ambiguousFinding,
      repairHint: {
        ...ambiguousFinding.repairHint!,
        replacementText: ambiguousFinding.repairHint!.targetText,
      },
    }])).toMatchObject({ kind: "rejected", code: "unsafe-patch" });
  });

  it("is not applicable when no verified Vietnamese local spelling blocker exists", () => {
    const content = "Nội dung hợp lệ.";
    const result = applyVietnameseLocalRepair(content, [{
      ...spellingFinding(content),
      severity: "warning",
    }]);

    expect(result).toMatchObject({
      kind: "not-applicable",
      content,
      telemetry: { attempted: false, applied: false, patchCount: 0 },
    });
  });
});
