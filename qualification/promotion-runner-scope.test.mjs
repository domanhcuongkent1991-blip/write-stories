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
