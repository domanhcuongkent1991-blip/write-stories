const RUN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,31})$/u;

export function resolveQualificationRunScope({
  candidateSha,
  evidenceDate,
  probeVariant,
  runLabel,
}) {
  if (typeof runLabel !== "string" || !RUN_LABEL_PATTERN.test(runLabel)) {
    throw new Error("qualification run label must be 1-32 lowercase letters, digits, or hyphens");
  }

  const suffix = `${evidenceDate}-${candidateSha}-${probeVariant}-${runLabel}`;
  return Object.freeze({
    scratchRoot: `C:/Users/Admin/Documents/Codex/InkOS/promotion-evidence/${suffix}`,
    bookId: `promotion-vi-${evidenceDate.replaceAll("-", "")}-${candidateSha}-${probeVariant}-${runLabel}`,
  });
}
