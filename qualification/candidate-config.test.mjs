import assert from "node:assert/strict";
import test from "node:test";
import { resolveCandidateSha } from "./candidate-config.mjs";

test("accepts a full candidate SHA when it matches the worktree HEAD", () => {
  const sha = "02d7313e2f5829f0fc3f9538cebcb536e1a21961";
  assert.equal(resolveCandidateSha(sha, sha), sha);
});

test("normalizes surrounding whitespace and uppercase hexadecimal characters", () => {
  const sha = "02d7313e2f5829f0fc3f9538cebcb536e1a21961";
  assert.equal(resolveCandidateSha(` ${sha.toUpperCase()} `, sha), sha);
});

test("rejects a missing candidate SHA", () => {
  assert.throws(() => resolveCandidateSha(undefined, "a".repeat(40)), /candidate SHA/i);
});

test("rejects a short or malformed candidate SHA", () => {
  assert.throws(() => resolveCandidateSha("a620db09", "a".repeat(40)), /40 hexadecimal/i);
  assert.throws(() => resolveCandidateSha("g".repeat(40), "g".repeat(40)), /40 hexadecimal/i);
});

test("rejects a candidate SHA that differs from the worktree HEAD", () => {
  assert.throws(
    () => resolveCandidateSha("a".repeat(40), "b".repeat(40)),
    /does not match worktree HEAD/i,
  );
});

test("rejects an invalid worktree HEAD", () => {
  assert.throws(
    () => resolveCandidateSha("a".repeat(40), "not-a-commit"),
    /worktree HEAD.*40 hexadecimal/i,
  );
});
