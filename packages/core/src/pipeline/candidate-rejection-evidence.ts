import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AuditIssue } from "../agents/continuity.js";

export const CandidateRejectionEvidenceSchema = z.object({
  rejectionCode: z.enum([
    "planner-contract-invalid",
    "state-validation-failed",
    "hook-contract-failed",
    "audit-failed",
    "provider-unavailable",
  ]),
  ownerClass: z.enum(["PLANNER_CONTRACT", "STATE_SETTLEMENT", "AUDIT", "PROVIDER"]),
  findings: z.array(z.object({
    category: z.string().min(1).max(100),
    description: z.string().min(1).max(500),
    stateRef: z.string().min(1).max(200).optional(),
  }).strict()).max(20),
}).strict();

export type CandidateRejectionEvidence = z.infer<typeof CandidateRejectionEvidenceSchema>;

export const RetainedCandidateMetadataSchema = z.object({
  operationId: z.string().uuid(),
  attemptId: z.string().uuid(),
  chapterNumber: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  wordCount: z.number().int().nonnegative(),
  reason: z.string().min(1).max(500),
  rejectionEvidence: CandidateRejectionEvidenceSchema,
}).strict();

export type RetainedCandidateMetadata = z.infer<typeof RetainedCandidateMetadataSchema>;

function sanitizeDiagnosticText(value: string, maxLength: number): string {
  return value
    .replace(/bearer\s+\S+/giu, "[redacted]")
    .replace(/(?:authorization|api[-_ ]?key|access[-_ ]?token|secret)\s*[:=]?\s*\S+/giu, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

export function buildCandidateRejectionEvidence(input: {
  readonly rejectionCode: CandidateRejectionEvidence["rejectionCode"];
  readonly ownerClass: CandidateRejectionEvidence["ownerClass"];
  readonly findings: ReadonlyArray<AuditIssue>;
  readonly fallbackDescription: string;
}): CandidateRejectionEvidence {
  const boundedFindings = input.findings.slice(0, 20).map((finding) => ({
    category: sanitizeDiagnosticText(finding.category, 100) || "unknown",
    description: sanitizeDiagnosticText(finding.description, 500) || "Bounded diagnostic unavailable.",
    ...(finding.evidence?.stateRef
      ? { stateRef: sanitizeDiagnosticText(finding.evidence.stateRef, 200) }
      : {}),
  }));
  return CandidateRejectionEvidenceSchema.parse({
    rejectionCode: input.rejectionCode,
    ownerClass: input.ownerClass,
    findings: boundedFindings.length > 0
      ? boundedFindings
      : [{
          category: "pipeline",
          description: sanitizeDiagnosticText(input.fallbackDescription, 500)
            || "Candidate rejected by the bounded acceptance gate.",
        }],
  });
}

export function serializeRetainedCandidateMetadata(metadata: RetainedCandidateMetadata): string {
  const sanitized = {
    ...metadata,
    reason: sanitizeDiagnosticText(metadata.reason, 500)
      || "Candidate rejected by the bounded acceptance gate.",
  };
  return `${JSON.stringify(RetainedCandidateMetadataSchema.parse(sanitized), null, 2)}\n`;
}

export async function loadLatestCandidateRejectionEvidence(
  bookDir: string,
  chapterNumber: number,
): Promise<CandidateRejectionEvidence | null> {
  const candidateDir = join(
    bookDir,
    "story",
    "audit-candidates",
    `chapter-${String(chapterNumber).padStart(4, "0")}`,
  );
  const names = await readdir(candidateDir).catch(() => [] as string[]);
  const metadataFiles = await Promise.all(names
    .filter((name) => name.endsWith(".json"))
    .map(async (name) => ({
      name,
      modifiedAt: await stat(join(candidateDir, name)).then((value) => value.mtimeMs).catch(() => 0),
    })));
  metadataFiles.sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const { name } of metadataFiles) {
    try {
      const parsed = RetainedCandidateMetadataSchema.parse(
        JSON.parse(await readFile(join(candidateDir, name), "utf-8")),
      );
      if (parsed.chapterNumber === chapterNumber) return parsed.rejectionEvidence;
    } catch {
      // Invalid retained evidence is ignored; it is never trusted as Planner input.
    }
  }
  return null;
}

export function renderCandidateRecoveryGuidance(
  evidence: CandidateRejectionEvidence,
): string {
  const lines = evidence.findings.slice(0, 20).map((finding) =>
    `- [${finding.category}] ${finding.description}${finding.stateRef ? ` (state: ${finding.stateRef})` : ""}`,
  );
  return [
    "Same-chapter recovery evidence (host-validated; do not repeat these failures):",
    `Owner: ${evidence.ownerClass}`,
    `Code: ${evidence.rejectionCode}`,
    ...lines,
  ].join("\n").slice(0, 8_000);
}
