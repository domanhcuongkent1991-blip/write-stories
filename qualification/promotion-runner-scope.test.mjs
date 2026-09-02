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
