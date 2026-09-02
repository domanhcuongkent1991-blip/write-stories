import { createHash } from "node:crypto";

const RUN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,31})$/u;

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
