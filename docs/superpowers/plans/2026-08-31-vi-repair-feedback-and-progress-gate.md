# Vietnamese Repair Feedback and Progress Gate Implementation Plan

> **Superseded in part:** Do not execute its former 1,500-word range. The
> current implementation plan is `2026-08-31-inkos-vi-phase-b-safe-canary.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implement the approved Vietnamese spelling-repair contract, deterministic length gate, and non-advancing recovery path without changing provider configuration, the historical baseline book, or zh/en behavior.

**Architecture:** Keep deterministic validation at the edge of the writing pipeline and make the local counter the only numeric authority. A typed `RepairHint` travels from the Vietnamese validator through `AuditIssue`, Reviser input, and the strict audit-run allowlist. Spelling uses exact local patches; hard length violations use one bounded candidate repair and are committed only after local count, state, and audit gates pass. Failed Vietnamese candidates remain recoverable but never advance durable progress.

**Tech Stack:** TypeScript, Zod, Vitest, existing InkOS `PipelineRunner`, `WriterAgent`, `ReviserAgent`, atomic file persistence, and existing LLM client abstraction.

---

## Scope and ownership

All work is in the isolated worktree `D:\InkOS\write-stories-vi-1.8.0`. Agent 1 owns the repair-hint and spelling surface layer. Agent 2 owns length, review-cycle, runner, and durable-progress behavior and starts only after Agent 1's changes are reviewed. The manager performs integration review and all verification. No agent may change the qualification book, baseline book, provider config, secrets, or unrelated language paths.

### Agent 1 ownership — spelling and repair feedback

- Create `packages/core/src/models/repair-hint.ts`.
- Create `packages/core/src/agents/vietnamese-spelling-catalog.ts`.
- Modify `packages/core/src/agents/vietnamese-surface-validator.ts`.
- Modify `packages/core/src/agents/post-write-validator.ts` and `packages/core/src/agents/continuity.ts` only for the typed optional hint.
- Modify `packages/core/src/agents/reviser.ts` and, only if required by the occurrence contract, `packages/core/src/utils/spot-fix-patches.ts` to render hints and force patch-only routing for verified local spelling issues.
- Modify `packages/core/src/audit/audit-run.ts` and `packages/core/src/index.ts` for the optional strict schema/export.
- Add focused validator, Reviser, and audit-run round-trip tests.

Agent 1 must not modify `runner.ts`, `chapter-review-cycle.ts`, `state-bootstrap.ts`, `manager.ts`, length policy files, or the qualification book.

### Agent 2 ownership — length, review cycle, and recovery

- Modify `packages/core/src/audit/chapter-audit-evaluator.ts`, `packages/core/src/audit/audit-policy.ts`, and `packages/core/src/utils/length-metrics.ts` only as required to make local length authoritative.
- Modify `packages/core/src/pipeline/chapter-review-cycle.ts` and `packages/core/src/pipeline/runner.ts` to merge Vietnamese deterministic findings on every assessment, filter contradictory unverified LLM length guidance, bound length repair, and retain rejected candidates.
- Modify `packages/core/src/state/state-bootstrap.ts` and `packages/core/src/state/manager.ts` for Vietnamese status-aware progress resolution.
- Add review-cycle, runner, state-progress, and recovery tests.

Agent 2 must not modify the spelling catalog, repair-hint contract, Reviser prompt, audit-run schema, or baseline book. If a runner change needs a spelling type from Agent 1, use the committed exported type without editing Agent 1's files.

## Shared acceptance invariants

1. For Vietnamese target 1,150, preferred range is 1,000–1,300 and hard range is 1,000–1,500 under `vi_wordlike_tokens_v1`.
2. A count of 1,301–1,500 is warning-only if all other acceptance gates pass.
3. A count below 1,000 or above 1,500 is a verified deterministic critical blocker.
4. LLM length estimates never change numeric decisions and cannot instruct an inverse repair.
5. The three known spelling errors are verified blocking errors and carry exact repair hints.
6. Every candidate is locally re-counted, re-hashed, re-validated, and rejected without canonical mutation when any gate fails.
7. A failed Vietnamese chapter does not advance durable progress; zh/en behavior remains unchanged.

---

## Task 1: Add the typed repair-hint contract

**Owner:** Agent 1
**Files:** Create `packages/core/src/models/repair-hint.ts`; modify `post-write-validator.ts`, `continuity.ts`, `audit-run.ts`, `index.ts`; tests under `packages/core/src/__tests__/`.

- [ ] **Step 1: Add failing contract tests**

Construct a `PostWriteViolation` and `AuditIssue` with:

```ts
repairHint: {
  kind: "exact-replacement",
  targetText: "mười mốn",
  replacementText: "mười bốn",
  occurrenceIndexes: [1],
  context: "... sai lệch mười mốn centimet ...",
}
```

Assert that the typed value survives conversion and that an `AuditRunV1` with the optional field round-trips through `serializeAuditRun`. Also assert that an existing v1 audit run without the field still parses.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```powershell
pnpm exec vitest run packages/core/src/__tests__/audit-run.test.ts packages/core/src/__tests__/vietnamese-surface-validator.test.ts
```

Expected: FAIL because the contract and schema field do not exist.

- [ ] **Step 3: Implement the minimal typed contract**

Define a shared `RepairHint` interface with `kind`, non-empty bounded `targetText`, `replacementText`, one-based `occurrenceIndexes`, and bounded `context`. Add `repairHint?: RepairHint` to both `PostWriteViolation` and `AuditIssue`. Extend the strict `AuditIssueSchema` with the same optional allowlist. Do not change `schemaVersion`; the new field is optional and old files remain valid.

- [ ] **Step 4: Preserve and validate the field**

Update issue normalization helpers only where Agent 1 owns the type conversion. Preserve the content-hash evidence binding. Reject malformed hint values through the existing strict parse path. Truncate context before persistence to the existing evidence-size safety limit.

- [ ] **Step 5: Run focused tests and commit**

Run the command from Step 2 and expect all focused tests to pass. Then commit only Agent 1's owned files:

```powershell
git add packages/core/src/models/repair-hint.ts packages/core/src/agents/post-write-validator.ts packages/core/src/agents/continuity.ts packages/core/src/audit/audit-run.ts packages/core/src/index.ts packages/core/src/__tests__/audit-run.test.ts
git commit -m "feat: preserve structured Vietnamese repair hints"
```

## Task 2: Implement deterministic Vietnamese spelling findings

**Owner:** Agent 1
**Files:** Create `packages/core/src/agents/vietnamese-spelling-catalog.ts`; modify `vietnamese-surface-validator.ts`; tests for validator.

- [ ] **Step 1: Add red tests for the three known errors**

Assert that each wrong phrase produces one `vi-known-spelling` error, `repairScope: "local"`, `repairTarget: "prose"`, a stable catalog entry, exact target/replacement, one-based occurrence, bounded context, and no false positive for the corrected text. Assert that a clean Vietnamese paragraph returns no spelling error.

- [ ] **Step 2: Implement the small catalog and validator**

Create a versioned, immutable catalog with exactly these high-confidence replacements:

```ts
{ wrong: "mười mốn", right: "mười bốn", id: "vi-spelling-muoi-bon" }
{ wrong: "dry khốc", right: "khô khốc", id: "vi-spelling-kho-khoc" }
{ wrong: "Sound tivi", right: "Âm thanh tivi", id: "vi-spelling-am-thanh" }
```

For every occurrence in normalized prose, emit a verified local issue with repair hint. Keep existing CJK, agent-note, delimiter, whitespace, and punctuation checks unchanged. Do not add dictionary heuristics or auto-correct unknown words.

- [ ] **Step 3: Verify validator behavior**

Run:

```powershell
pnpm exec vitest run packages/core/src/__tests__/vietnamese-surface-validator.test.ts
```

Expected: all existing surface tests plus catalog tests pass.

- [ ] **Step 4: Commit the catalog change**

```powershell
git add packages/core/src/agents/vietnamese-spelling-catalog.ts packages/core/src/agents/vietnamese-surface-validator.ts packages/core/src/__tests__/vietnamese-surface-validator.test.ts
git commit -m "feat: block known Vietnamese spelling errors"
```

## Task 3: Route spelling hints through Reviser safely

**Owner:** Agent 1
**Files:** Modify `packages/core/src/agents/reviser.ts` and, only if required for occurrence-aware exact matching, `packages/core/src/utils/spot-fix-patches.ts`; tests under `reviser.test.ts` and a focused repair-routing test.

- [ ] **Step 1: Add failing routing and exact-patch tests**

Use a fake Reviser response and assert that a verified local `vi-known-spelling` issue selects `PATCHES` only. Assert that a patch with the exact target and occurrence produces corrected content, while a missing target, ambiguous duplicate, malformed patch, or full `REVISED_CONTENT` response is rejected.

- [ ] **Step 2: Render structured hints in the prompt**

Extend the deterministic issue block in `buildTieredIssueList` so each hint renders `TARGET_TEXT`, `REPLACEMENT_TEXT`, `OCCURRENCES`, and bounded `CONTEXT`. Set local spelling issues to `repairScope: "local"`; existing routing then selects patch-only mode without guessing from labels.

- [ ] **Step 3: Preserve hash-bound exactness**

Ensure exact patch application validates the original content hash/target occurrence before accepting Reviser output. Keep unrelated text byte-for-byte unchanged. Return the original chapter when no valid patch is applied.

- [ ] **Step 4: Verify and commit**

Run:

```powershell
pnpm exec vitest run packages/core/src/__tests__/reviser.test.ts packages/core/src/__tests__/vietnamese-surface-validator.test.ts
```

Then commit only Agent 1's Reviser files/tests:

```powershell
git add packages/core/src/agents/reviser.ts packages/core/src/__tests__/reviser.test.ts
git commit -m "feat: route Vietnamese spelling fixes through exact patches"
```

## Task 4: Make the review cycle length-authoritative and spelling-aware

**Owner:** Agent 2
**Files:** Modify `chapter-review-cycle.ts`, `runner.ts`, `chapter-audit-evaluator.ts`, `audit-policy.ts`; tests for review cycle and evaluator.

- [ ] **Step 1: Add failing review-cycle tests**

Use fake writer/auditor/reviser/settlement functions to cover:

1. Local count 1,528 plus LLM “~600” yields a deterministic hard blocker and sends only a compress directive to repair.
2. Candidate 1,584 is rejected after one attempt and the original candidate remains canonical.
3. Local count 1,350 emits a warning but does not trigger length repair.
4. A verified spelling error from `output.postWriteErrors` appears in every review assessment, including candidate assessments.
5. A spelling-only issue routes to patch-only behavior and residual spelling errors reject the candidate.

- [ ] **Step 2: Merge all deterministic Vietnamese findings**

Update the runner review callback so it runs `validateVietnameseSurface` on the initial content and each candidate, in addition to existing post-write and hook checks. Preserve `repairHint` while converting violations to `AuditIssue`; do not reduce the issue to category/description/suggestion only.

- [ ] **Step 3: Filter contradictory LLM length guidance**

When a deterministic Vietnamese length issue exists, keep LLM length findings as unverified audit diagnostics but exclude them from the Reviser repair brief. The only repair directive is derived from local `LengthSpec` and count: compress above hard max, expand below hard min.

- [ ] **Step 4: Bound repair and validate before commit**

Use one explicit length/quality repair budget per operation. Before candidate settlement, normalize, assert non-empty/changed content, compute local count and content hash, and reject immediately when unchanged or still outside hard range. Settle against the canonical baseline, validate state, re-audit, and require score ≥85, no verified critical findings, and local hard-range membership before promotion.

- [ ] **Step 5: Run focused tests and commit**

Run:

```powershell
pnpm exec vitest run packages/core/src/__tests__/chapter-review-cycle.test.ts packages/core/src/__tests__/chapter-audit-evaluator.test.ts packages/core/src/__tests__/audit-policy.test.ts
```

Commit only the owned pipeline/audit files and tests:

```powershell
git add packages/core/src/pipeline/chapter-review-cycle.ts packages/core/src/pipeline/runner.ts packages/core/src/audit/chapter-audit-evaluator.ts packages/core/src/audit/audit-policy.ts packages/core/src/__tests__/chapter-review-cycle.test.ts packages/core/src/__tests__/chapter-audit-evaluator.test.ts packages/core/src/__tests__/audit-policy.test.ts
git commit -m "feat: enforce deterministic Vietnamese review gates"
```

## Task 5: Prevent failed Vietnamese chapters from advancing progress

**Owner:** Agent 2
**Files:** Modify `state-bootstrap.ts`, `manager.ts`, persistence/recovery wiring in `runner.ts`; tests for state manager and recovery.

- [ ] **Step 1: Add failing progress tests**

Assert that Vietnamese chapter 1 with `audit-failed`, `rejected`, `state-degraded`, or in-flight status resolves retry target 1. A stray chapter-2 file must not skip the unresolved chapter. `ready-for-review`, `approved`, `published`, and compatible legacy accepted states advance to chapter 2. Existing zh/en behavior must remain unchanged.

- [ ] **Step 2: Implement a language-scoped eligible-progress resolver**

Keep existing file/status behavior for zh/en. For Vietnamese, resolve contiguous progress from indexed chapters whose status and terminal audit outcome are accepted. Exclude failed/rejected/degraded/in-flight rows. File-only failed artifacts must not advance Vietnamese progress.

- [ ] **Step 3: Retain rejected candidates outside the chapter scanner**

When a Vietnamese candidate is rejected, retain its content and allowlisted metadata under an audit-candidate path that cannot match `^(\d+)_`. Persist operation ID, attempt ID, hash, local count, and rejection reason. Never promote the candidate or replace canonical truth files.

- [ ] **Step 4: Verify restart and idempotency behavior**

Add tests for restart after rejected candidate, retry at the same chapter number, accepted atomic commit followed by next-chapter progress, duplicate candidate writes, and interrupted transaction recovery. Keep `assertNoPendingStateRepair` as an additional guard for state-degraded chapters.

- [ ] **Step 5: Run focused tests and commit**

Run:

```powershell
pnpm exec vitest run packages/core/src/__tests__/state-manager.test.ts packages/core/src/__tests__/atomic-file-set.test.ts packages/core/src/__tests__/chapter-review-cycle.test.ts
```

Then commit only the owned state/recovery files/tests:

```powershell
git add packages/core/src/state/state-bootstrap.ts packages/core/src/state/manager.ts packages/core/src/pipeline/runner.ts packages/core/src/__tests__/state-manager.test.ts packages/core/src/__tests__/atomic-file-set.test.ts
git commit -m "fix: keep failed Vietnamese chapters recoverable"
```

## Task 6: Integration verification before provider qualification

**Owner:** Manager
**Files:** None beyond preceding tasks unless a test exposes a scoped defect.

- [ ] **Step 1: Review both agent diffs**

Check ownership boundaries, strict schema compatibility, and that no provider/secret/book files changed. Reject unrelated edits or overlapping rewrites before running the full suite.

- [ ] **Step 2: Run offline verification**

From `D:\InkOS\write-stories-vi-1.8.0` run:

```powershell
pnpm --filter @actalk/inkos-core run typecheck
pnpm --filter @actalk/inkos-core run test -- --run
pnpm --filter @actalk/inkos-core run build
git diff --check
```

Expected: exit code 0 for typecheck, test, build, and diff check. If a project security scan is required, report pre-existing generic-api-key fixture detections without exposing values.

- [ ] **Step 3: Run a deterministic fixture rehearsal**

Use the existing qualification artifact as a local fixture only. Verify the three known spelling findings, 1,528 local count, contradictory ~600 LLM finding suppression, candidate rejection, and next-chapter retry target without calling Ecoapi.

- [ ] **Step 4: Review qualification state**

Confirm the historical baseline book is unchanged. Confirm the qualification book has no duplicate chapter files or pending transaction directories before any new provider call.

## Task 7: Fresh Ecoapi qualification and stop rules

**Owner:** Manager
**Scope:** Only `phase-a-ecoapi-1150-20260831-0` qualification sandbox; no baseline mutation.

- [ ] **Step 1: Run chapter 1 once with validated Ecoapi configuration**

Use `reasoning_effort=none` and the existing service/model. Record local count, repair attempts, prompt/completion/total tokens by agent, audit decision/findings, spelling findings, continuity/state checks, operation identity, and transaction count.

- [ ] **Step 2: Apply the chapter acceptance rule**

Continue only when status is terminal accepted, local count is within hard range, no verified critical spelling/continuity/state issue remains, and persistence is atomic. A 1,301–1,500 result may continue with an explicit warning.

- [ ] **Step 3: Stop without retry loops**

Stop on provider reasoning-only output, parse failure, unresolved known spelling error, hard length failure after one repair, invalid settlement, stale hash, duplicate write, transaction inconsistency, or progress skip. Do not make a second provider attempt without a new root-cause review.

- [ ] **Step 4: Write the comparison report**

Compare qualification and historical baseline on local chapter length, token trend, audit stability, spelling findings, continuity findings, provider finish behavior, and recovery state. Report warnings separately from blocking failures. Do not promote, delete, or retain a book without the project director's command.

## Plan self-review

- Every approved requirement maps to Tasks 1–7.
- No placeholder steps or unspecified acceptance behavior remain.
- Agent ownership prevents simultaneous edits to shared pipeline files.
- Optional repair hints preserve old audit-run v1 files.
- Offline tests precede all provider calls.
- Candidate rejection never replaces canonical content.
- Provider, baseline, secrets, and promotion decisions remain outside scope.
