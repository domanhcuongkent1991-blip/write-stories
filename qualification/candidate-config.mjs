const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

function normalizeCommitSha(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a 40 hexadecimal character commit SHA`);
  }

  const normalized = value.trim().toLowerCase();
  if (!FULL_COMMIT_SHA_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a 40 hexadecimal character commit SHA`);
  }

  return normalized;
}

export function resolveCandidateSha(configuredSha, worktreeHeadSha) {
  const candidateSha = normalizeCommitSha(configuredSha, "candidate SHA");
  const actualHeadSha = normalizeCommitSha(worktreeHeadSha, "worktree HEAD");

  if (candidateSha !== actualHeadSha) {
    throw new Error("candidate SHA does not match worktree HEAD");
  }

  return candidateSha;
}
