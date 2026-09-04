import assert from "node:assert/strict";
import test from "node:test";

function passingChapterEvidence(overrides = {}) {
  return {
    auditDecision: "pass",
    auditPassed: true,
    hardInRange: true,
    countingMode: "vi_wordlike_tokens_v1",
    verifiedBlockerCount: 0,
    surfaceBlockerCount: 0,
    spellingIssueCount: 0,
    cjkCharacterCount: 0,
    ...overrides,
  };
}

test("classifies Writer envelope failures separately from harness failures", async () => {
  const {
    classifyOperationFailure,
    collectChapterFailureDimensions,
  } = await import("./promotion-runner-scope.mjs");
  const operation = {
    status: "error",
    chapter: null,
    invariants: { aligned: true },
    error: { name: "WriterOutputContractError" },
  };

  assert.deepEqual(collectChapterFailureDimensions(operation), [
    "operation-not-completed",
    "writer-format-contract",
  ]);
  assert.equal(classifyOperationFailure(operation), "FORMAT_CONTRACT");
});

test("reports every failed quality dimension instead of one umbrella boolean", async () => {
  const {
    classifyOperationFailure,
    collectChapterFailureDimensions,
  } = await import("./promotion-runner-scope.mjs");
  const operation = {
    status: "completed",
    chapter: passingChapterEvidence({
      auditDecision: "repair-required",
      auditPassed: false,
      hardInRange: false,
      spellingIssueCount: 2,
      cjkCharacterCount: 1,
    }),
    invariants: { aligned: true },
    error: null,
  };

  assert.deepEqual(collectChapterFailureDimensions(operation), [
    "audit-decision",
    "audit-passed",
    "hard-range",
    "spelling",
    "cjk",
  ]);
  assert.equal(classifyOperationFailure(operation), "QUALITY");
});

test("prioritizes state and provider families while retaining detailed dimensions", async () => {
  const {
    classifyOperationFailure,
    collectChapterFailureDimensions,
  } = await import("./promotion-runner-scope.mjs");
  const stateFailure = {
    status: "completed",
    chapter: passingChapterEvidence(),
    invariants: { aligned: false },
    error: null,
  };
  assert.deepEqual(collectChapterFailureDimensions(stateFailure), ["state-alignment"]);
  assert.equal(classifyOperationFailure(stateFailure), "STATE");

  const providerFailure = {
    status: "error",
    chapter: null,
    invariants: { aligned: true },
    error: { name: "ProviderConnectionError" },
  };
  assert.equal(classifyOperationFailure(providerFailure, { providerFailure: true }), "PROVIDER");
  assert.equal(classifyOperationFailure({
    ...providerFailure,
    error: { name: "UnexpectedInternalError" },
  }), "HARNESS");
});

test("records provider diagnostics with the current qualification stage", async () => {
  const { createQualificationProviderDiagnosticObserver } = await import("./promotion-runner-scope.mjs");
  const target = [];
  let stage = "health-chat-stream";
  const observer = createQualificationProviderDiagnosticObserver(target, () => stage);

  observer.observe(Object.freeze({
    schemaVersion: 1,
    requestedModel: "fixture",
    providerStage: "unscoped",
    markerPresence: Object.freeze({}),
  }));
  stage = "chapter-1";
  observer.observe(Object.freeze({
    schemaVersion: 1,
    requestedModel: "fixture",
    providerStage: "writer-format-repair",
    markerPresence: Object.freeze({ CHAPTER_CONTENT: true }),
  }));

  assert.deepEqual(target, [
    {
      stage: "health-chat-stream",
      agent: null,
      substage: null,
      schemaVersion: 1,
      requestedModel: "fixture",
      providerStage: "unscoped",
      markerPresence: {},
    },
    {
      stage: "chapter-1",
      agent: "writer",
      substage: "format-repair",
      schemaVersion: 1,
      requestedModel: "fixture",
      providerStage: "writer-format-repair",
      markerPresence: { CHAPTER_CONTENT: true },
    },
  ]);
  assert.ok(target.every(Object.isFrozen));
  assert.deepEqual(observer.markers, [
    "PRE_WRITE_CHECK",
    "CHAPTER_TITLE",
    "CHAPTER_CONTENT",
    "RUNTIME_STATE_DELTA",
    "POST_SETTLEMENT",
  ]);
  assert.ok(Object.isFrozen(observer.markers));
});

test("rejects invalid provider diagnostic recorder dependencies", async () => {
  const { createQualificationProviderDiagnosticObserver } = await import("./promotion-runner-scope.mjs");
  assert.throws(
    () => createQualificationProviderDiagnosticObserver({}, () => "stage"),
    /target.*array/i,
  );
  assert.throws(
    () => createQualificationProviderDiagnosticObserver([], null),
    /stage.*function/i,
  );
});

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

test("resolves an explicit HTTPS qualification provider without leaking credentials", async () => {
  const { resolveQualificationProviderConfig } = await import("./promotion-runner-scope.mjs");
  assert.equal(typeof resolveQualificationProviderConfig, "function");
  if (typeof resolveQualificationProviderConfig !== "function") return;

  assert.deepEqual(resolveQualificationProviderConfig({
    INKOS_QUALIFICATION_BASE_URL: "https://api.zpro.io.vn/v1/",
    INKOS_QUALIFICATION_SERVICE_KEY: "custom:Zpro",
    INKOS_QUALIFICATION_MODEL: "gpt-5.5",
  }), {
    baseUrl: "https://api.zpro.io.vn/v1",
    baseHost: "api.zpro.io.vn",
    basePath: "/v1",
    serviceKey: "custom:Zpro",
    model: "gpt-5.5",
  });
});

test("allows HTTP only for the local internal qualification endpoint", async () => {
  const { resolveQualificationProviderConfig } = await import("./promotion-runner-scope.mjs");
  assert.deepEqual(resolveQualificationProviderConfig({
    INKOS_QUALIFICATION_BASE_URL: "http://localhost:56154/v1",
    INKOS_QUALIFICATION_SERVICE_KEY: "custom:Internal",
    INKOS_QUALIFICATION_MODEL: "gpt-5.5",
  }), {
    baseUrl: "http://localhost:56154/v1",
    baseHost: "localhost",
    basePath: "/v1",
    serviceKey: "custom:Internal",
    model: "gpt-5.5",
  });
});

test("rejects unsafe or ambiguous qualification provider URLs", async () => {
  const { resolveQualificationProviderConfig } = await import("./promotion-runner-scope.mjs");

  for (const baseUrl of [
    "http://api.zpro.io.vn/v1",
    "https://user:password@api.zpro.io.vn/v1",
    "https://api.zpro.io.vn/v1?key=secret",
    "https://api.zpro.io.vn/v1#fragment",
  ]) {
    assert.throws(
      () => resolveQualificationProviderConfig({ INKOS_QUALIFICATION_BASE_URL: baseUrl }),
      /base url/i,
    );
  }
});

test("matches provider requests only inside the configured API path", async () => {
  const { isQualificationProviderRequest } = await import("./promotion-runner-scope.mjs");
  const baseUrl = "https://api.zpro.io.vn/v1";

  assert.equal(isQualificationProviderRequest("https://api.zpro.io.vn/v1/models", baseUrl), true);
  assert.equal(isQualificationProviderRequest("https://api.zpro.io.vn/v1/chat/completions", baseUrl), true);
  assert.equal(isQualificationProviderRequest("https://api.zpro.io.vn/v10/chat/completions", baseUrl), false);
  assert.equal(isQualificationProviderRequest("https://ecoapi.net/v1/chat/completions", baseUrl), false);
  assert.equal(isQualificationProviderRequest("not a URL", baseUrl), false);
});

test("uses an ephemeral environment credential before a project secret", async () => {
  const { resolveQualificationCredential } = await import("./promotion-runner-scope.mjs");
  const credential = resolveQualificationCredential({
    environmentApiKey: "temporary-test-key",
    serviceKey: "custom:Zpro",
    services: {
      "custom:Zpro": { apiKey: "persisted-test-key" },
    },
  });

  assert.equal(credential.apiKey, "temporary-test-key");
  assert.equal(credential.source, "environment");
  assert.throws(
    () => resolveQualificationCredential({
      environmentApiKey: "  ",
      serviceKey: "custom:Missing",
      services: {},
    }),
    /credential is not configured/i,
  );
});

test("sums provider requests across a single qualification namespace", async () => {
  const { summarizeQualificationCampaignHistory } = await import("./promotion-runner-scope.mjs");
  const lineage = {
    candidateSha: "candidate-sha",
    bookId: "qualification-book",
    runLabel: "zpro-gpt55-01",
    baseHost: "api.zpro.io.vn",
    basePath: "/v1",
    serviceKey: "custom:Zpro",
    model: "gpt-5.5",
    probeVariant: "stream",
  };
  const result = summarizeQualificationCampaignHistory([
    { ...lineage, providerRequestCount: 17 },
    { ...lineage, providerRequestCount: 22 },
  ], lineage);

  assert.deepEqual(result, {
    evidenceRecordCount: 2,
    providerRequestCount: 39,
  });
});

test("rejects cross-provider evidence and malformed request counts in campaign history", async () => {
  const { summarizeQualificationCampaignHistory } = await import("./promotion-runner-scope.mjs");
  const lineage = {
    candidateSha: "candidate-sha",
    bookId: "qualification-book",
    runLabel: "zpro-gpt55-01",
    baseHost: "api.zpro.io.vn",
    basePath: "/v1",
    serviceKey: "custom:Zpro",
    model: "gpt-5.5",
    probeVariant: "stream",
  };

  assert.throws(
    () => summarizeQualificationCampaignHistory([
      { ...lineage, model: "another-model", providerRequestCount: 5 },
    ], lineage),
    /lineage/i,
  );
  assert.throws(
    () => summarizeQualificationCampaignHistory([
      { ...lineage, providerRequestCount: -1 },
    ], lineage),
    /request count/i,
  );
});

test("enforces the provider budget against prior and current namespace requests", async () => {
  const { isQualificationProviderBudgetExhausted } = await import("./promotion-runner-scope.mjs");

  assert.equal(isQualificationProviderBudgetExhausted({
    priorProviderRequestCount: 17,
    currentProviderRequestCount: 7,
    providerCallBudget: 25,
  }), false);
  assert.equal(isQualificationProviderBudgetExhausted({
    priorProviderRequestCount: 17,
    currentProviderRequestCount: 8,
    providerCallBudget: 25,
  }), true);
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
