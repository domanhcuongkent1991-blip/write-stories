import type { AuditIssue } from "../agents/continuity.js";
import { computeChapterContentHash } from "../audit/chapter-audit-evaluator.js";
import { applySpotFixPatches, type SpotFixPatch } from "./spot-fix-patches.js";
import { z } from "zod";

export const LocalRepairTelemetrySchema = z.object({
  attempted: z.boolean(),
  applied: z.boolean(),
  patchCount: z.number().int().nonnegative(),
  inputContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  outputContentHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();

export interface LocalRepairTelemetry {
  readonly attempted: boolean;
  readonly applied: boolean;
  readonly patchCount: number;
  readonly inputContentHash: string;
  readonly outputContentHash?: string;
}

export type VietnameseLocalRepairResult =
  | {
      readonly kind: "not-applicable";
      readonly content: string;
      readonly telemetry: LocalRepairTelemetry;
    }
  | {
      readonly kind: "applied";
      readonly content: string;
      readonly fixedFindingIds: ReadonlyArray<string>;
      readonly telemetry: LocalRepairTelemetry;
    }
  | {
      readonly kind: "rejected";
      readonly content: string;
      readonly code: "stale-hash" | "unsafe-patch" | "partial-patch";
      readonly telemetry: LocalRepairTelemetry;
    };

function isEligibleSpellingFinding(issue: AuditIssue): boolean {
  return issue.severity === "critical"
    && issue.category === "vi-known-spelling"
    && issue.verification === "verified"
    && issue.repairScope === "local"
    && issue.repairTarget === "prose"
    && issue.repairHint?.kind === "exact-replacement";
}

function countExactOccurrences(content: string, target: string): number {
  if (target.length === 0) return 0;
  let count = 0;
  let cursor = 0;
  while (true) {
    const index = content.indexOf(target, cursor);
    if (index < 0) return count;
    count += 1;
    cursor = index + target.length;
  }
}

function rejected(
  content: string,
  inputContentHash: string,
  code: "stale-hash" | "unsafe-patch" | "partial-patch",
): VietnameseLocalRepairResult {
  return {
    kind: "rejected",
    content,
    code,
    telemetry: {
      attempted: true,
      applied: false,
      patchCount: 0,
      inputContentHash,
    },
  };
}

/**
 * Apply only host-bound, occurrence-aware Vietnamese spelling patches.
 * No fuzzy matching or model call is permitted on this path.
 */
export function applyVietnameseLocalRepair(
  content: string,
  findings: ReadonlyArray<AuditIssue>,
): VietnameseLocalRepairResult {
  const inputContentHash = computeChapterContentHash(content);
  const eligible = findings.filter(isEligibleSpellingFinding);
  if (eligible.length === 0) {
    return {
      kind: "not-applicable",
      content,
      telemetry: {
        attempted: false,
        applied: false,
        patchCount: 0,
        inputContentHash,
      },
    };
  }

  if (eligible.some((issue) => issue.evidence?.contentHash !== inputContentHash)) {
    return rejected(content, inputContentHash, "stale-hash");
  }

  const patches = new Map<string, SpotFixPatch>();
  const replacementByOccurrence = new Map<string, string>();
  for (const issue of eligible) {
    const hint = issue.repairHint!;
    const occurrenceIndexes = [...new Set(hint.occurrenceIndexes)];
    const occurrenceCount = countExactOccurrences(content, hint.targetText);
    if (
      hint.targetText.length === 0
      || hint.replacementText.length === 0
      || hint.targetText === hint.replacementText
      || occurrenceIndexes.length === 0
      || occurrenceIndexes.length !== hint.occurrenceIndexes.length
      || occurrenceIndexes.some((index) => !Number.isInteger(index) || index < 1 || index > occurrenceCount)
    ) {
      return rejected(content, inputContentHash, "unsafe-patch");
    }

    for (const occurrenceIndex of occurrenceIndexes) {
      const occurrenceKey = `${hint.targetText}\u0000${occurrenceIndex}`;
      const priorReplacement = replacementByOccurrence.get(occurrenceKey);
      if (priorReplacement !== undefined && priorReplacement !== hint.replacementText) {
        return rejected(content, inputContentHash, "unsafe-patch");
      }
      replacementByOccurrence.set(occurrenceKey, hint.replacementText);
      patches.set(`${occurrenceKey}\u0000${hint.replacementText}`, {
        targetText: hint.targetText,
        replacementText: hint.replacementText,
        occurrenceIndex,
      });
    }
  }

  const patchResult = applySpotFixPatches(content, [...patches.values()], {
    exactOnly: true,
    requireAll: true,
  });
  if (!patchResult.applied || patchResult.appliedPatchCount !== patches.size) {
    return rejected(content, inputContentHash, patchResult.appliedPatchCount > 0
      ? "partial-patch"
      : "unsafe-patch");
  }

  return {
    kind: "applied",
    content: patchResult.revisedContent,
    fixedFindingIds: [...new Set(eligible.map(
      (issue) => issue.findingId ?? issue.ruleId ?? issue.description,
    ))],
    telemetry: {
      attempted: true,
      applied: true,
      patchCount: patches.size,
      inputContentHash,
      outputContentHash: computeChapterContentHash(patchResult.revisedContent),
    },
  };
}
