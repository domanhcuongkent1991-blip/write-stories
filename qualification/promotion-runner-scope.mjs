import { createHash } from "node:crypto";

const RUN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,31})$/u;
const SERVICE_KEY_PATTERN = /^custom:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const DEFAULT_PROVIDER = Object.freeze({
  baseUrl: "https://ecoapi.net/v1",
  serviceKey: "custom:Ecoapi",
  model: "claude-sonnet-4-6",
});
const QUALIFICATION_DIAGNOSTIC_MARKERS = Object.freeze([
  "PRE_WRITE_CHECK",
  "CHAPTER_TITLE",
  "CHAPTER_CONTENT",
  "RUNTIME_STATE_DELTA",
  "POST_SETTLEMENT",
]);

export function createQualificationHealthProbeOptions(stream) {
  return Object.freeze({
    stream: Boolean(stream),
    reasoningEffort: "none",
    maxTokens: 256,
    temperature: 0,
    timeoutMs: 30_000,
  });
}

const PROVIDER_STAGE_CONTEXT = Object.freeze({
  planner: Object.freeze({ agent: "planner", substage: "memo-generation" }),
  "resolve-preflight": Object.freeze({ agent: "planner", substage: "resolve-preflight" }),
  "writer-draft": Object.freeze({ agent: "writer", substage: "creative-generation" }),
  "writer-format-repair": Object.freeze({ agent: "writer", substage: "format-repair" }),
  "writer-observer": Object.freeze({ agent: "writer", substage: "observation" }),
  "initial-settlement": Object.freeze({ agent: "writer", substage: "settlement" }),
  "settlement-recovery": Object.freeze({ agent: "writer", substage: "settlement-repair" }),
  "initial-state-validation": Object.freeze({ agent: "state-validator", substage: "initial" }),
  "local-repair": Object.freeze({ agent: "repairer", substage: "local" }),
  "structural-revision": Object.freeze({ agent: "reviser", substage: "structural" }),
  "candidate-settlement": Object.freeze({ agent: "writer", substage: "candidate-settlement" }),
  "initial-auditor": Object.freeze({ agent: "auditor", substage: "initial" }),
  "post-candidate-auditor": Object.freeze({ agent: "auditor", substage: "post-candidate" }),
  "auditor-verdict-repair": Object.freeze({ agent: "auditor", substage: "verdict-repair" }),
});

const QUALITY_FAILURE_DIMENSIONS = new Set([
  "audit-decision",
  "audit-passed",
  "hard-range",
  "counting-mode",
  "verified-blocker",
  "surface-blocker",
  "spelling",
  "cjk",
  "planner-hook-contract",
  "planner-hook-transition",
]);

export function collectChapterFailureDimensions(operationRecord) {
  const dimensions = [];
  if (operationRecord?.status !== "completed") {
    dimensions.push("operation-not-completed");
  }

  const errorName = operationRecord?.error?.name;
  const errorCode = operationRecord?.error?.code;
  if (errorName === "WriterOutputContractError") {
    dimensions.push("writer-format-contract");
  } else if (errorName === "PlannerParseError") {
    dimensions.push("planner-format-contract");
  } else if (errorName === "HookResolvePreflightError" && errorCode === "PLANNER_CONTRACT_INVALID") {
    dimensions.push("planner-hook-contract");
  } else if (errorName === "HookResolvePreflightError" && errorCode === "INCONCLUSIVE_PROVIDER") {
    dimensions.push("planner-preflight-inconclusive");
  } else if (errorName === "HookOperationContractError") {
    dimensions.push("planner-hook-transition");
  }

  if (operationRecord?.status === "completed") {
    const chapter = operationRecord.chapter ?? {};
    const minorAccepted = chapter.minorAccepted === true;
    if (chapter.auditDecision !== "pass" && !minorAccepted) dimensions.push("audit-decision");
    if (chapter.auditPassed !== true && !minorAccepted) dimensions.push("audit-passed");
    if (typeof chapter.parseFailedReason === "string" && chapter.parseFailedReason.length > 0) {
      dimensions.push(`binder-branch:${chapter.parseFailedReason}`);
    }
    if (chapter.hardInRange !== true) dimensions.push("hard-range");
    if (chapter.countingMode !== "vi_wordlike_tokens_v1") dimensions.push("counting-mode");
    if (chapter.verifiedBlockerCount !== 0 && !minorAccepted) dimensions.push("verified-blocker");
    if (chapter.surfaceBlockerCount !== 0) dimensions.push("surface-blocker");
    if (chapter.spellingIssueCount !== 0) dimensions.push("spelling");
    if (chapter.cjkCharacterCount !== 0) dimensions.push("cjk");
  }

  if (operationRecord?.invariants && operationRecord.invariants.aligned !== true) {
    dimensions.push("state-alignment");
  }
  return Object.freeze(dimensions);
}

export function classifyOperationFailure(operationRecord, options = {}) {
  const dimensions = collectChapterFailureDimensions(operationRecord);
  if (dimensions.length === 0) return null;
  if (options.providerFailure === true || dimensions.includes("planner-preflight-inconclusive")) return "PROVIDER";
  if (dimensions.includes("state-alignment")) return "STATE";
  if (dimensions.includes("writer-format-contract") || dimensions.includes("planner-format-contract")) {
    return "FORMAT_CONTRACT";
  }
  if (dimensions.some((dimension) => QUALITY_FAILURE_DIMENSIONS.has(dimension))) {
    return "QUALITY";
  }
  return "HARNESS";
}

export function createQualificationProviderDiagnosticObserver(target, readStage) {
  if (!Array.isArray(target)) {
    throw new TypeError("provider diagnostic target must be an array");
  }
  if (typeof readStage !== "function") {
    throw new TypeError("provider diagnostic stage reader must be a function");
  }
  return Object.freeze({
    markers: QUALIFICATION_DIAGNOSTIC_MARKERS,
    observe(observation) {
      const context = PROVIDER_STAGE_CONTEXT[observation?.providerStage] ?? null;
      target.push(Object.freeze({
        ...observation,
        stage: readStage(),
        agent: context?.agent ?? null,
        substage: context?.substage ?? null,
      }));
    },
  });
}

export function resolveQualificationProviderConfig(environment = {}) {
  const configuredBaseUrl = environment.INKOS_QUALIFICATION_BASE_URL?.trim()
    || DEFAULT_PROVIDER.baseUrl;
  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(configuredBaseUrl);
  } catch {
    throw new Error("qualification base URL must be an absolute HTTPS URL");
  }
  const isLoopbackHttp = parsedBaseUrl.protocol === "http:"
    && new Set(["localhost", "127.0.0.1", "::1"]).has(parsedBaseUrl.hostname);
  if (
    (parsedBaseUrl.protocol !== "https:" && !isLoopbackHttp)
    || parsedBaseUrl.username.length > 0
    || parsedBaseUrl.password.length > 0
    || parsedBaseUrl.search.length > 0
    || parsedBaseUrl.hash.length > 0
  ) {
    throw new Error("qualification base URL must use HTTPS, or HTTP on localhost/loopback, without credentials, query, or fragment");
  }

  const serviceKey = environment.INKOS_QUALIFICATION_SERVICE_KEY?.trim()
    || DEFAULT_PROVIDER.serviceKey;
  if (!SERVICE_KEY_PATTERN.test(serviceKey)) {
    throw new Error("qualification service key must use the custom:<name> format");
  }
  const model = environment.INKOS_QUALIFICATION_MODEL?.trim()
    || DEFAULT_PROVIDER.model;
  if (!MODEL_ID_PATTERN.test(model)) {
    throw new Error("qualification model id contains unsupported characters");
  }

  const basePath = parsedBaseUrl.pathname.replace(/\/+$/u, "") || "/";
  return Object.freeze({
    baseUrl: `${parsedBaseUrl.origin}${basePath}`,
    baseHost: parsedBaseUrl.hostname,
    basePath,
    serviceKey,
    model,
  });
}

export function isQualificationProviderRequest(requestUrl, configuredBaseUrl) {
  try {
    const request = requestUrl instanceof URL ? requestUrl : new URL(String(requestUrl));
    const configured = new URL(configuredBaseUrl);
    const basePath = configured.pathname.replace(/\/+$/u, "") || "/";
    const pathMatches = basePath === "/"
      || request.pathname === basePath
      || request.pathname.startsWith(`${basePath}/`);
    return request.origin === configured.origin && pathMatches;
  } catch {
    return false;
  }
}

export function resolveQualificationCredential({ environmentApiKey, services, serviceKey }) {
  const ephemeralKey = typeof environmentApiKey === "string" ? environmentApiKey.trim() : "";
  if (ephemeralKey.length > 0) {
    return Object.freeze({ apiKey: ephemeralKey, source: "environment" });
  }
  const storedKey = services?.[serviceKey]?.apiKey;
  if (typeof storedKey === "string" && storedKey.trim().length > 0) {
    return Object.freeze({ apiKey: storedKey.trim(), source: "project-secret" });
  }
  throw new Error(`qualification credential is not configured for ${serviceKey}`);
}

export function summarizeQualificationCampaignHistory(records, expectedLineage) {
  if (!Array.isArray(records)) {
    throw new Error("qualification campaign history must be an array");
  }
  const lineageEntries = Object.entries(expectedLineage ?? {});
  let providerRequestCount = 0;
  for (const record of records) {
    if (!record || typeof record !== "object") {
      throw new Error("qualification campaign history contains an invalid evidence record");
    }
    if (lineageEntries.some(([key, expected]) => !Object.is(record[key], expected))) {
      throw new Error("qualification campaign evidence lineage does not match this run");
    }
    if (!Number.isInteger(record.providerRequestCount) || record.providerRequestCount < 0) {
      throw new Error("qualification campaign evidence has an invalid provider request count");
    }
    providerRequestCount += record.providerRequestCount;
  }
  return Object.freeze({
    evidenceRecordCount: records.length,
    providerRequestCount,
  });
}

export function isQualificationProviderBudgetExhausted({
  priorProviderRequestCount,
  currentProviderRequestCount,
  providerCallBudget,
}) {
  for (const [label, value] of Object.entries({
    priorProviderRequestCount,
    currentProviderRequestCount,
    providerCallBudget,
  })) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${label} must be a non-negative integer`);
    }
  }
  if (providerCallBudget < 1) {
    throw new Error("providerCallBudget must be at least 1");
  }
  return priorProviderRequestCount + currentProviderRequestCount >= providerCallBudget;
}

export function resolveQualificationExitCode(exitReason) {
  return exitReason === "PASS"
    || (typeof exitReason === "string" && /^PASS_CHECKPOINT_CHAPTER_[1-9]\d*$/u.test(exitReason))
    ? 0
    : 1;
}

export function recordProviderBudgetRejection(safe, observation) {
  safe.providerBudgetRejections = (safe.providerBudgetRejections ?? 0) + 1;
  safe.providerBudgetRejectionObservations = [
    ...(safe.providerBudgetRejectionObservations ?? []),
    {
      stage: observation?.stage ?? null,
      method: observation?.method ?? null,
      endpoint: observation?.endpoint ?? null,
      errorName: "ProviderCallBudgetExceeded",
    },
  ];
}

export function createQualificationRolloutConfig(bookId) {
  if (typeof bookId !== "string" || bookId.trim().length === 0) {
    throw new Error("qualification book id must be a non-empty string");
  }

  const normalizedBookId = bookId.trim();
  const featureConfiguration = {
    mode: "canary",
    canaryBookIds: [normalizedBookId],
    promotionApproved: false,
    defaultOn: false,
  };
  const featureConfigurationHash = createHash("sha256")
    .update(JSON.stringify(featureConfiguration), "utf8")
    .digest("hex");

  return Object.freeze({
    pipeline: Object.freeze({
      viPipelineMode: featureConfiguration.mode,
      viPipelineCanaryBookIds: Object.freeze([...featureConfiguration.canaryBookIds]),
      viPipelinePromotionApproved: featureConfiguration.promotionApproved,
      viPipelineDefaultOn: featureConfiguration.defaultOn,
    }),
    evidence: Object.freeze({
      resolvedMode: featureConfiguration.mode,
      flagSource: "qualification-runner-explicit",
      featureConfigurationHash,
    }),
  });
}

export function assessQualificationResumeCheckpoint({
  startChapter,
  manifestPresent,
  manifestLastAppliedChapter,
  indexNumbers,
  chapterFileNumbers,
  retryChapterPresent,
}) {
  const expectedChapter = startChapter - 1;
  const expectedNumbers = Array.from(
    { length: expectedChapter + (retryChapterPresent === true ? 1 : 0) },
    (_, index) => index + 1,
  );
  const hasExactNumbers = (actual) => Array.isArray(actual)
    && actual.length === expectedNumbers.length
    && [...actual].sort((left, right) => left - right)
      .every((number, index) => number === expectedNumbers[index]);
  const canonicalChapterSet = hasExactNumbers(indexNumbers)
    && hasExactNumbers(chapterFileNumbers);
  const pristineClone = expectedChapter === 0
    && manifestPresent === false
    && retryChapterPresent !== true
    && canonicalChapterSet;
  return Object.freeze({
    expectedChapter,
    mode: pristineClone ? "pristine-clone" : "state-manifest",
    aligned: pristineClone
      || (
        manifestPresent === true
        && manifestLastAppliedChapter === expectedChapter
        && canonicalChapterSet
      ),
  });
}

export function resolveQualificationRunScope({
  candidateSha,
  evidenceDate,
  probeVariant,
  runLabel,
}) {
  if (typeof runLabel !== "string" || !RUN_LABEL_PATTERN.test(runLabel)) {
    throw new Error("qualification run label must be 1-32 lowercase letters, digits, or hyphens");
  }

  const candidatePathId = candidateSha.slice(0, 16);
  const suffix = `${evidenceDate}-${candidatePathId}-${probeVariant}-${runLabel}`;
  return Object.freeze({
    scratchRoot: `C:/Users/Admin/Documents/Codex/InkOS/promotion-evidence/${suffix}`,
    bookId: `promotion-vi-${evidenceDate.replaceAll("-", "")}-${candidatePathId}-${probeVariant}-${runLabel}`,
  });
}
