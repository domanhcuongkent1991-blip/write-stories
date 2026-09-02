import assert from "node:assert/strict";
import test from "node:test";

test("creates an isolated qualification namespace for an explicit run label", async () => {
  const scopeModule = await import("./promotion-runner-scope.mjs").catch(() => null);
  assert.ok(scopeModule, "promotion runner scope module must exist");

  const scope = scopeModule.resolveQualificationRunScope({
    candidateSha: "a620db09",
    evidenceDate: "2026-09-02",
    probeVariant: "stream",
    runLabel: "claude-canary-01",
  });

  assert.equal(
    scope.scratchRoot,
    "C:/Users/Admin/Documents/Codex/InkOS/promotion-evidence/2026-09-02-a620db09-stream-claude-canary-01",
  );
  assert.equal(
    scope.bookId,
    "promotion-vi-20260902-a620db09-stream-claude-canary-01",
  );
});

test("uses a bounded candidate id in Windows paths while preserving run identity", async () => {
  const { resolveQualificationRunScope } = await import("./promotion-runner-scope.mjs");
  const candidateSha = "cd40d0ba33fb1f03e08e58421c71d1b083ca5b5e";
  const scope = resolveQualificationRunScope({
    candidateSha,
    evidenceDate: "2026-09-02",
    probeVariant: "nonstream",
    runLabel: "a".repeat(32),
  });

  assert.match(scope.scratchRoot, /cd40d0ba33fb1f03/u);
  assert.match(scope.bookId, /cd40d0ba33fb1f03/u);
  assert.doesNotMatch(scope.scratchRoot, new RegExp(candidateSha, "u"));
  assert.doesNotMatch(scope.bookId, new RegExp(candidateSha, "u"));

  const transactionTemplate = `${scope.scratchRoot}/books/${scope.bookId}/.inkos-file-txn-XXXXXX`;
  assert.ok(transactionTemplate.length < 248, `transaction path is ${transactionTemplate.length} characters`);
});

test("rejects run labels that could escape or blur the evidence namespace", async () => {
  const scopeModule = await import("./promotion-runner-scope.mjs").catch(() => null);
  assert.ok(scopeModule, "promotion runner scope module must exist");

  for (const runLabel of ["../outside", "Claude Canary", "", "a".repeat(33)]) {
    assert.throws(
      () => scopeModule.resolveQualificationRunScope({
        candidateSha: "a620db09",
        evidenceDate: "2026-09-02",
        probeVariant: "stream",
        runLabel,
      }),
      /run label/i,
    );
  }
});

test("maps only pass results to a successful process exit code", async () => {
  const scopeModule = await import("./promotion-runner-scope.mjs");
  assert.equal(typeof scopeModule.resolveQualificationExitCode, "function");
  if (typeof scopeModule.resolveQualificationExitCode !== "function") return;

  assert.equal(scopeModule.resolveQualificationExitCode("PASS"), 0);
  assert.equal(scopeModule.resolveQualificationExitCode("PASS_CHECKPOINT_CHAPTER_3"), 0);
  assert.equal(scopeModule.resolveQualificationExitCode("FAIL_QUALITY_CHAPTER_1"), 1);
  assert.equal(scopeModule.resolveQualificationExitCode("BLOCKED_PROVIDER_HEALTH"), 1);
});

test("keeps budget-guard rejections separate from actual provider requests", async () => {
  const { recordProviderBudgetRejection } = await import("./promotion-runner-scope.mjs");
  const safe = { providerRequests: [] };
  recordProviderBudgetRejection(safe, {
    stage: "writer-draft",
    method: "POST",
    endpoint: "https://ecoapi.net/v1/chat/completions",
  });

  assert.equal(safe.providerRequests.length, 0);
  assert.equal(safe.providerBudgetRejections, 1);
  assert.equal(safe.providerBudgetRejectionObservations.length, 1);
  assert.equal(safe.providerBudgetRejectionObservations[0].errorName, "ProviderCallBudgetExceeded");
});

test("builds a bounded canary rollout config and stable safe evidence hash", async () => {
  const { createQualificationRolloutConfig } = await import("./promotion-runner-scope.mjs");
  const first = createQualificationRolloutConfig("qualification-book-1");
  const same = createQualificationRolloutConfig("qualification-book-1");
  const other = createQualificationRolloutConfig("qualification-book-2");

  assert.deepEqual(first.pipeline, {
    viPipelineMode: "canary",
    viPipelineCanaryBookIds: ["qualification-book-1"],
    viPipelinePromotionApproved: false,
    viPipelineDefaultOn: false,
  });
  assert.equal(first.evidence.resolvedMode, "canary");
  assert.equal(first.evidence.flagSource, "qualification-runner-explicit");
  assert.match(first.evidence.featureConfigurationHash, /^[a-f0-9]{64}$/u);
  assert.equal(first.evidence.featureConfigurationHash, same.evidence.featureConfigurationHash);
  assert.notEqual(first.evidence.featureConfigurationHash, other.evidence.featureConfigurationHash);
});

test("accepts only a pristine manifest-less checkpoint zero for resume", async () => {
  const scopeModule = await import("./promotion-runner-scope.mjs");
  assert.equal(typeof scopeModule.assessQualificationResumeCheckpoint, "function");
  if (typeof scopeModule.assessQualificationResumeCheckpoint !== "function") return;

  assert.deepEqual(scopeModule.assessQualificationResumeCheckpoint({
    startChapter: 1,
    manifestPresent: false,
    manifestLastAppliedChapter: null,
    indexNumbers: [],
    chapterFileNumbers: [],
    retryChapterPresent: false,
  }), {
    expectedChapter: 0,
    mode: "pristine-clone",
    aligned: true,
  });

  assert.deepEqual(scopeModule.assessQualificationResumeCheckpoint({
    startChapter: 2,
    manifestPresent: true,
    manifestLastAppliedChapter: 1,
    indexNumbers: [1],
    chapterFileNumbers: [1],
    retryChapterPresent: false,
  }), {
    expectedChapter: 1,
    mode: "state-manifest",
    aligned: true,
  });

  for (const input of [
    { startChapter: 2, manifestPresent: false, manifestLastAppliedChapter: null, indexNumbers: [], chapterFileNumbers: [], retryChapterPresent: false },
    { startChapter: 1, manifestPresent: false, manifestLastAppliedChapter: null, indexNumbers: [1], chapterFileNumbers: [], retryChapterPresent: true },
    { startChapter: 1, manifestPresent: false, manifestLastAppliedChapter: null, indexNumbers: [], chapterFileNumbers: [1], retryChapterPresent: false },
  ]) {
    assert.equal(scopeModule.assessQualificationResumeCheckpoint(input).aligned, false);
  }
});

test("rejects non-canonical index and chapter file sets at a resume checkpoint", async () => {
  const { assessQualificationResumeCheckpoint } = await import("./promotion-runner-scope.mjs");
  const checkpoint = {
    startChapter: 3,
    manifestPresent: true,
    manifestLastAppliedChapter: 2,
    indexNumbers: [1, 2, 3],
    retryChapterPresent: true,
  };

  assert.equal(assessQualificationResumeCheckpoint({
    ...checkpoint,
    chapterFileNumbers: [1, 2, 3],
  }).aligned, true);
  assert.equal(assessQualificationResumeCheckpoint({
    ...checkpoint,
    chapterFileNumbers: [1, 2, 4],
  }).aligned, false);
  assert.equal(assessQualificationResumeCheckpoint({
    ...checkpoint,
    indexNumbers: [1, 2, 2],
    chapterFileNumbers: [1, 2, 3],
  }).aligned, false);
});
