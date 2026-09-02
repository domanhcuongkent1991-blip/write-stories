import { describe, expect, it } from "vitest";
import {
  assertChapterTransition,
  describePipelineError,
  resolveViPipelineMode,
  assertViPipelineOperationAllowed,
  evaluateThreeGateDecision,
} from "../pipeline/three-gate-contracts.js";
import { VI_PIPELINE_MODES as exportedViPipelineModes } from "../index.js";
import { PipelineRunner } from "../pipeline/runner.js";
import type { LLMClient } from "../llm/provider.js";
import type { BookConfig } from "../models/book.js";

describe("three-gate contracts", () => {
  it("exports the contracts through the core package entrypoint", () => {
    expect(exportedViPipelineModes).toEqual(["legacy", "preview", "canary", "default"]);
  });

  it("defaults missing and invalid modes to legacy with a safe diagnostic", () => {
    expect(resolveViPipelineMode(undefined)).toEqual({
      mode: "legacy",
      source: "default",
    });
    expect(resolveViPipelineMode("future-mode")).toEqual({
      mode: "legacy",
      source: "invalid",
      diagnostic: "CONFIG_INVALID",
    });
  });

  it("accepts every explicitly supported rollout mode", () => {
    expect(resolveViPipelineMode(" legacy ")).toEqual({ mode: "legacy", source: "explicit" });
    expect(resolveViPipelineMode("preview")).toEqual({ mode: "preview", source: "explicit" });
    expect(resolveViPipelineMode("canary")).toEqual({ mode: "canary", source: "explicit" });
    expect(resolveViPipelineMode("default")).toEqual({ mode: "default", source: "explicit" });
  });

  it("allows only read-only inspection in preview and rejects every persistent entrypoint", () => {
    expect(() => assertViPipelineOperationAllowed({
      mode: resolveViPipelineMode("preview"),
      operation: "read",
    })).not.toThrow();
    for (const operation of ["plan", "audit", "write"] as const) {
      expect(() => assertViPipelineOperationAllowed({
        mode: resolveViPipelineMode("preview"),
        operation,
        bookId: "book-1",
      })).toThrow(/PREVIEW_NO_WRITE/);
    }
  });

  it("requires an explicit allowlist for canary mutations", () => {
    expect(() => assertViPipelineOperationAllowed({
      mode: resolveViPipelineMode("canary"),
      operation: "write",
      bookId: "book-1",
      canaryBookIds: ["book-2"],
    })).toThrow(/CANARY_BOOK_NOT_ALLOWED/);
    expect(() => assertViPipelineOperationAllowed({
      mode: resolveViPipelineMode("canary"),
      operation: "write",
      bookId: "book-1",
      canaryBookIds: ["book-1"],
    })).not.toThrow();
  });

  it("requires separate promotion and default-on approvals", () => {
    expect(() => assertViPipelineOperationAllowed({
      mode: resolveViPipelineMode("default"),
      operation: "write",
      bookId: "book-1",
      promotionApproved: true,
      defaultOn: false,
    })).toThrow(/DEFAULT_NOT_APPROVED/);
    expect(() => assertViPipelineOperationAllowed({
      mode: resolveViPipelineMode("default"),
      operation: "write",
      bookId: "book-1",
      promotionApproved: true,
      defaultOn: true,
    })).not.toThrow();
  });

  it("reports the three gate decisions independently", () => {
    expect(evaluateThreeGateDecision({
      integration: {
        requiredChecksPassed: true,
        legacyDefaultVerified: true,
        boundaryOffVerified: true,
        securityPassed: true,
      },
      activation: {
        deterministicSuitePassed: false,
        providerCanary: "not-required",
      },
      promotion: {
        exactShaVerified: false,
        liveQualificationPassed: false,
        chapterResultsComplete: false,
        unresolvedBlockers: 0,
        stateAligned: false,
        recoveryPassed: false,
        evidenceSafe: false,
      },
    })).toEqual({
      integration: "MERGEABLE_OFF",
      activation: "HOLD_ACTIVATION",
      provider: "NOT_REQUIRED",
      promotion: "HOLD_PROMOTION",
    });
  });

  it("keeps provider-inconclusive evidence out of Promotion", () => {
    expect(evaluateThreeGateDecision({
      integration: {
        requiredChecksPassed: true,
        legacyDefaultVerified: true,
        boundaryOffVerified: true,
        securityPassed: true,
      },
      activation: {
        deterministicSuitePassed: true,
        providerCanary: "inconclusive",
      },
      promotion: {
        exactShaVerified: true,
        liveQualificationPassed: true,
        chapterResultsComplete: true,
        unresolvedBlockers: 0,
        stateAligned: true,
        recoveryPassed: true,
        evidenceSafe: true,
      },
    })).toEqual({
      integration: "MERGEABLE_OFF",
      activation: "ACTIVATABLE_DETERMINISTIC",
      provider: "PROVIDER_INCONCLUSIVE",
      promotion: "HOLD_PROMOTION",
    });
  });

  it("emits PROMOTABLE_DEFAULT only after every prerequisite passes", () => {
    const base = {
      integration: {
        requiredChecksPassed: true,
        legacyDefaultVerified: true,
        boundaryOffVerified: true,
        securityPassed: true,
      },
      activation: {
        deterministicSuitePassed: true,
        providerCanary: "passed" as const,
      },
      promotion: {
        exactShaVerified: true,
        liveQualificationPassed: true,
        chapterResultsComplete: true,
        unresolvedBlockers: 0,
        stateAligned: true,
        recoveryPassed: true,
        evidenceSafe: true,
      },
    };

    expect(evaluateThreeGateDecision(base).promotion).toBe("PROMOTABLE_DEFAULT");
    expect(evaluateThreeGateDecision({
      ...base,
      promotion: { ...base.promotion, unresolvedBlockers: 1 },
    }).promotion).toBe("HOLD_PROMOTION");
  });

  it("resolves the runner mode once and scopes preview enforcement to Vietnamese books", async () => {
    const runner = new PipelineRunner({
      client: {} as LLMClient,
      model: "test-model",
      projectRoot: "C:/nonexistent-inkos-project",
      viPipelineMode: "preview",
    });
    const viBook = { id: "book-vi", genre: "test", language: "vi" } as BookConfig;
    const enBook = { id: "book-en", genre: "test", language: "en" } as BookConfig;

    expect(runner.getViPipelineMode()).toEqual({ mode: "preview", source: "explicit" });
    await expect(runner.initBook(viBook)).rejects.toMatchObject({
      code: "PREVIEW_NO_WRITE",
    });
    await expect(runner.initBook(enBook)).rejects.not.toMatchObject({ code: "PREVIEW_NO_WRITE" });
  });

  it("only exposes the preview API when preview mode is explicitly enabled", async () => {
    const runner = new PipelineRunner({
      client: {} as LLMClient,
      model: "test-model",
      projectRoot: "C:/nonexistent-inkos-project",
      viPipelineMode: "legacy",
    });

    await expect(runner.previewNextChapter("book-1")).rejects.toThrow(/PREVIEW_MODE_REQUIRED/);
  });

  it("keeps provider contract failures out of canonical commit", () => {
    expect(describePipelineError("PROVIDER_REASONING_ONLY", "writer")).toMatchObject({
      code: "PROVIDER_REASONING_ONLY",
      family: "provider-contract",
      retryable: true,
      repairable: false,
      canonicalCommitAllowed: false,
      userDisposition: "retry",
    });
  });

  it("allows only repair-required findings to enter user repair", () => {
    expect(describePipelineError("QUALITY_REPAIR_REQUIRED", "audit")).toMatchObject({
      family: "quality-repair",
      retryable: false,
      repairable: true,
      canonicalCommitAllowed: false,
      userDisposition: "repair",
    });
    expect(describePipelineError("QUALITY_BLOCKED", "audit")).toMatchObject({
      family: "quality-blocker",
      repairable: false,
      canonicalCommitAllowed: false,
      userDisposition: "review",
    });
  });

  it("does not allow warnings to bypass the first-slice commit policy", () => {
    expect(describePipelineError("QUALITY_WARNING", "audit")).toMatchObject({
      family: "warning",
      repairable: false,
      canonicalCommitAllowed: false,
      userDisposition: "review",
    });
  });

  it("accepts the normal chapter progression", () => {
    expect(() => assertChapterTransition("CREATED", "PROVIDER_READY")).not.toThrow();
    expect(() => assertChapterTransition("PROVIDER_READY", "DRAFT_CREATED")).not.toThrow();
    expect(() => assertChapterTransition("DRAFT_CREATED", "VALIDATED")).not.toThrow();
    expect(() => assertChapterTransition("VALIDATED", "AUDITED")).not.toThrow();
    expect(() => assertChapterTransition("AUDITED", "READY_FOR_COMMIT")).not.toThrow();
    expect(() => assertChapterTransition("READY_FOR_COMMIT", "COMMITTED")).not.toThrow();
  });

  it.each([
    ["PROVIDER_BLOCKED", "COMMITTED"],
    ["PARSE_BLOCKED", "COMMITTED"],
    ["SAFETY_BLOCKED", "COMMITTED"],
    ["QUALITY_BLOCKED", "COMMITTED"],
    ["REPAIR_REQUIRED", "COMMITTED"],
    ["PREVIEW_WITH_WARNINGS", "COMMITTED"],
  ] as const)("rejects forbidden transition %s -> %s", (from, to) => {
    expect(() => assertChapterTransition(from, to)).toThrow(/forbidden/i);
  });
});
