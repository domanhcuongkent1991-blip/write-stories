import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCandidateRejectionEvidence,
  loadLatestCandidateRejectionEvidence,
  renderCandidateRecoveryGuidance,
  serializeRetainedCandidateMetadata,
} from "../pipeline/candidate-rejection-evidence.js";

describe("candidate rejection evidence", () => {
  it("allowlists bounded findings and redacts credential-shaped text", () => {
    const evidence = buildCandidateRejectionEvidence({
      rejectionCode: "hook-contract-failed",
      ownerClass: "STATE_SETTLEMENT",
      findings: [{
        severity: "critical",
        category: "hook-runtime-contradiction",
        description: `Hook payoff mismatched. Authorization: Bearer top-secret ${"x".repeat(600)}`,
        suggestion: "repair",
        evidence: { contentHash: "a".repeat(64), stateRef: "runtime:hook:H006" },
      }],
      fallbackDescription: "fallback",
    });
    const serialized = serializeRetainedCandidateMetadata({
      operationId: "11111111-1111-4111-8111-111111111111",
      attemptId: "22222222-2222-4222-8222-222222222222",
      chapterNumber: 2,
      contentHash: "a".repeat(64),
      wordCount: 1150,
      reason: "hook mismatch",
      rejectionEvidence: evidence,
    });

    expect(evidence.findings[0]?.description).toContain("[redacted]");
    expect(evidence.findings[0]?.description.length).toBeLessThanOrEqual(500);
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("response");
  });

  it("loads only the latest valid same-chapter metadata and renders bounded guidance", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-rejection-evidence-"));
    const candidateDir = join(root, "story", "audit-candidates", "chapter-0002");
    await mkdir(candidateDir, { recursive: true });
    await writeFile(join(candidateDir, "z-invalid.json"), "{bad json", "utf-8");
    const evidence = buildCandidateRejectionEvidence({
      rejectionCode: "state-validation-failed",
      ownerClass: "STATE_SETTLEMENT",
      findings: [],
      fallbackDescription: "Typed state contradicted the chapter.",
    });
    await writeFile(join(candidateDir, "a-valid.json"), serializeRetainedCandidateMetadata({
      operationId: "11111111-1111-4111-8111-111111111111",
      attemptId: "22222222-2222-4222-8222-222222222222",
      chapterNumber: 2,
      contentHash: "b".repeat(64),
      wordCount: 1150,
      reason: "state mismatch",
      rejectionEvidence: evidence,
    }), "utf-8");

    const loaded = await loadLatestCandidateRejectionEvidence(root, 2);
    const guidance = renderCandidateRecoveryGuidance(loaded!);

    expect(loaded).toEqual(evidence);
    expect(guidance).toContain("STATE_SETTLEMENT");
    expect(guidance).toContain("Typed state contradicted the chapter.");
  });
});
