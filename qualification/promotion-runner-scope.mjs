const RUN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,31})$/u;

export function resolveQualificationExitCode(exitReason) {
  return exitReason === "PASS"
    || (typeof exitReason === "string" && /^PASS_CHECKPOINT_CHAPTER_[1-9]\d*$/u.test(exitReason))
    ? 0
    : 1;
}

export function assessQualificationResumeCheckpoint({
  startChapter,
  manifestPresent,
  manifestLastAppliedChapter,
  indexCount,
  chapterFileCount,
}) {
  const expectedChapter = startChapter - 1;
  const pristineClone = expectedChapter === 0
    && manifestPresent === false
    && indexCount === 0
    && chapterFileCount === 0;
  return Object.freeze({
    expectedChapter,
    mode: pristineClone ? "pristine-clone" : "state-manifest",
    aligned: pristineClone
      || (manifestPresent === true && manifestLastAppliedChapter === expectedChapter),
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
