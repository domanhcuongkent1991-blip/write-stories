# Vietnamese Hook-Contract Preflight and Bounded Local Repair Design

**Date:** 2026-09-01

**Status:** Approved design; awaiting written-spec review
**Scope:** Vietnamese long-fiction write/review pipeline only. Shared types may change only when backward-compatible. No provider configuration, historical-book mutation, promotion, push, deploy, tag, or LKG change is included.

## Goal

Prevent an incorrect Planner hook contract from causing repeated state settlement, rejected spelling repairs, or false runtime truth. Preserve the existing fail-closed guarantees while allowing an exact Vietnamese spelling correction to reuse already-generated truth safely when it has not changed story semantics.

The priority order is:

1. Stability.
2. Correctness.
3. Recoverability.
4. Testability.
5. Maintainability.
6. Runtime portability.
7. Delivery speed.

## Evidence and corrected diagnosis

The promotion pilot chapter 2 exposed two independent findings:

1. The prose contained the verified typo `lầy bơi`. The retained candidate changed only that phrase to `bãi bùn đất lầy lội` and remained inside the hard length range.
2. The governed chapter plan required `sabotage-sau-can-thi-thu` to resolve. Its canonical payoff is identifying the actor behind the remote administrator lock, but the planned and written scene only found a physical signal-manipulation device. That beat belongs to `H006`; it does not resolve the actor-identification hook.

The state settler kept `sabotage-sau-can-thi-thu` open. The candidate was then rejected with the generic reason `candidate state validation failed or degraded`. The persisted evidence did not retain the exact validation warnings that determined the rejection.

Therefore the failure cannot safely be attributed only to provider instability or to unnecessary state regeneration. An unconditional `state-neutral` shortcut would risk hiding a real Planner/runtime contradiction.

## Design principles

1. **Canonical hook truth is authoritative.** Planner prose cannot redefine a hook's payoff.
2. **Reject before writing when possible.** A bad `resolve` contract should not consume Writer, Auditor, Reviser, or settlement budget.
3. **Exact patch is an optimization, not an acceptance bypass.** Corrected prose still passes state, hook, audit, length, spelling, CJK, and transition gates.
4. **One bounded correction per layer.** At most one Planner correction, one settlement recovery, and one LLM structural revision. There is no open-ended retry.
5. **Discover all blockers before spending the revision.** Initial truth findings and initial audit findings are merged before candidate construction.
6. **Persist actionable diagnostics.** A generic rejection reason is insufficient for recovery or qualification evidence.
7. **No fuzzy local semantics as authority.** Token overlap or keyword similarity may be diagnostic, but cannot approve a hook resolution.

## Rejected approaches

### Unconditional state-neutral spelling bypass

This reduces calls but can preserve stale entity, numerical, timeline, or hook truth. It also would have hidden the chapter-2 hook mismatch. Rejected.

### Increase settlement retries

Repeated generation cannot reconcile an incorrect upstream contract without inventing facts. It increases provider cost and nondeterminism. Rejected.

### Downgrade missing planned hook operations to warnings

This improves throughput but permits continuity drift to accumulate over long books. Rejected.

### Force runtime truth to follow Planner output

This can mark an unresolved hook as resolved without supporting prose. That is canonical-state corruption. Rejected.

### Force the chapter to satisfy every Planner resolve

Planner intent is not more authoritative than the canonical hook definition and story state. Rewriting the chapter to identify the attacker prematurely would distort the story to satisfy a bad plan. Rejected.

## Architecture

```text
Canonical hook snapshot
  -> Planner memo
  -> deterministic hook-contract binding
  -> semantic preflight for resolve operations only
       valid                    -> continue
       incorrect/inconclusive   -> one bounded Planner correction
       still invalid            -> stop before chapter generation
  -> Writer draft + initial typed settlement
  -> early truth/hook validation
  -> initial continuity audit + deterministic surface checks
  -> merge all verified blockers
  -> apply exact local spelling patches to the candidate base
  -> optional one bounded structural LLM revision
  -> candidate state handling
       exact-patch-only         -> reuse initial settlement, then validate
       structural content change -> regenerate settlement, then validate
  -> exactly one post-candidate audit
  -> shared acceptance gate
  -> atomic canonical commit
```

## 1. Typed hook-operation contract

Introduce a versioned hook-operation intent that binds each operation to canonical truth:

```ts
interface ExpectedHookOperationV2 {
  readonly hookId: string;
  readonly action: "advance" | "mention" | "resolve" | "defer";
  readonly canonicalPayoffHash: string;
  readonly canonicalExpectedPayoff: string;
  readonly plannedEvidence: string;
}
```

The host, not the model, fills `canonicalPayoffHash` and `canonicalExpectedPayoff` from the active hook snapshot. The Planner supplies the action and planned chapter evidence. Persisted governed plans retain this contract so restart and review use the same authority.

Deterministic preflight checks:

- hook ID exists in the authoritative active snapshot;
- payoff hash matches the current canonical record;
- one hook does not receive contradictory actions;
- the requested status transition is legal;
- a `resolve` operation contains non-empty planned evidence;
- the same stable hook operation is not duplicated through separate memo sections.

These checks do not try to decide semantic entailment through keyword overlap.

## 2. Resolve-only semantic preflight

`resolve` is irreversible enough to justify one semantic check before writing. `advance`, `mention`, and `defer` remain governed by deterministic transition checks and downstream evidence validation.

For each planned resolve, a runtime-neutral validator receives only:

- hook ID;
- canonical expected payoff;
- planned chapter evidence;
- chapter goal and relevant memo beat.

It returns a typed result:

```ts
type HookResolvePreflight =
  | { readonly decision: "pass" }
  | {
      readonly decision: "repair-required";
      readonly code: "payoff-mismatch" | "insufficient-evidence";
      readonly description: string;
    }
  | { readonly decision: "inconclusive"; readonly description: string };
```

On `repair-required`, Planner gets the canonical payoff and exact failure once. The corrected plan is re-bound and revalidated. A second failure, parse failure, reasoning-only response, transport error, or inconclusive result stops before Writer execution. No book chapter or truth file is written.

The chapter-2 regression must remove the invalid actor-identification resolve, resolve `H006` only when the prose explicitly confirms the physical device, and leave `sabotage-sau-can-thi-thu` open. It must not fabricate the attacker.

## 3. Early truth validation

The Writer already produces the draft and initial typed settlement before the review cycle. Validate that settlement before spending the only LLM revision.

Early validation produces typed findings for:

- current state versus prose;
- hook operations versus canonical hook state;
- expected hook operations versus actual runtime delta;
- summary and manifest consistency;
- transition contradictions tied to persisted truth.

Merge these findings with the first continuity audit and deterministic Vietnamese checks. This prevents a spelling repair from consuming the revision opportunity while a state or hook blocker remains undiscovered.

Early validation does not persist chapter or truth files. Its output is an in-memory candidate and bounded evidence only.

## 4. Exact spelling repair and revision budget

A verified Vietnamese spelling finding remains eligible only when it is hash-bound, exact-replacement, occurrence-aware, and local. The pipeline applies these patches through existing deterministic patch code; it does not call the Reviser provider for them.

Track this separately:

```ts
interface LocalRepairTelemetry {
  readonly attempted: boolean;
  readonly applied: boolean;
  readonly patchCount: number;
  readonly inputContentHash: string;
  readonly outputContentHash?: string;
}
```

A deterministic exact patch does not consume the single LLM structural-revision budget. It is applied to the candidate base before any structural revision. There is still only one post-candidate audit:

- spelling-only blocker: exact patch, then final candidate checks;
- spelling plus structural blocker: exact patch first, one structural revision from the patched base, then final candidate checks;
- unsafe or stale patch: reject without structural guessing.

The final candidate must have zero verified spelling blockers. Unknown words and unbound Auditor suggestions are never auto-corrected.

## 5. Candidate state handling

### Exact-patch-only candidate

Reuse the Writer's initial typed settlement as the candidate truth input. Update only candidate content, content hash, and locally measured word count. Do not call `settleChapterState` merely because the prose hash changed.

This is not automatic acceptance. Run the full truth/hook validator against the corrected prose and reused settlement. If it passes, pass the exact truth overrides into the post-candidate audit. If it fails, allow one bounded settlement recovery using the explicit findings. A second failure rejects the candidate.

### Structural candidate

Any LLM structural revision must use the existing full settlement path for the exact revised prose. It receives one bounded settlement recovery and then the same final state/hook gate.

### Shared final gate

Both candidate classes require:

- local word count inside `1000–1800`;
- post-candidate audit score at least 85 and `decision=pass`;
- zero verified critical spelling, CJK, transition, state, or hook findings;
- candidate content hash matching audited and persisted evidence;
- manifest, current state, summaries, hooks, chapter index, and canonical file set aligned;
- no incomplete transaction directory;
- no more than one post-candidate audit.

## 6. Failure evidence and recovery

Extend retained candidate and audit evidence with bounded structured diagnostics:

```ts
interface CandidateRejectionEvidence {
  readonly rejectionCode:
    | "planner-contract-invalid"
    | "state-validation-failed"
    | "hook-contract-failed"
    | "audit-failed"
    | "provider-unavailable";
  readonly ownerClass: "PLANNER_CONTRACT" | "STATE_SETTLEMENT" | "AUDIT" | "PROVIDER";
  readonly findings: ReadonlyArray<{
    readonly category: string;
    readonly description: string;
    readonly stateRef?: string;
  }>;
}
```

Descriptions are bounded and exclude raw prompts, responses, reasoning, headers, and credentials. The exact reason must be available to Studio and the next same-chapter recovery attempt.

On failure:

- canonical accepted progress remains unchanged;
- retained candidates stay outside the chapter scanner;
- the unresolved Vietnamese chapter remains the next target;
- no later chapter may advance durable progress;
- restart must not promote the rejected candidate or create duplicates;
- provider failure remains `INCONCLUSIVE_PROVIDER` when InkOS state is safe.

## 7. Provider-call telemetry

Qualification caps cannot be enforced from aggregate token usage alone. Add per-operation, per-stage completion-call counters at the provider boundary:

```ts
interface ProviderCallTelemetry {
  readonly total: number;
  readonly byStage: Readonly<Record<string, number>>;
  readonly transportRetries: number;
  readonly outputRetries: number;
}
```

Required stage labels include Planner, resolve preflight, Writer draft, initial settlement, state validation, local repair, structural revision, candidate settlement, settlement recovery, Auditor, and post-candidate Auditor. Local deterministic work records zero provider calls.

Telemetry must be runtime-agnostic and populated by the shared provider client or agent context, not by Ecoapi-specific code. Aggregate counts are persisted; request bodies, headers, raw responses, and secrets are not.

## 8. Interfaces and maintainability

Keep responsibilities isolated:

- Planner creates a proposed narrative plan.
- Hook-contract binding attaches canonical authority.
- Resolve preflight assesses only irreversible semantic payoff.
- Truth validation compares prose and typed runtime truth.
- Local repair applies exact patches only.
- Review cycle orchestrates one candidate and one post-candidate evaluation.
- Persistence commits only an accepted canonical file set.
- Provider telemetry counts external calls independently of provider implementation.

No component may infer acceptance from another component's success. Provider-specific response parsing remains behind the current provider interface, allowing Ecoapi or another runtime to be replaced without changing hook or repair policy.

## Error-handling matrix

| Failure | Action | Durable mutation |
| --- | --- | --- |
| Unknown/stale hook ID or payoff hash | Stop before Writer | None |
| Resolve payoff mismatch | One Planner correction | None |
| Resolve preflight still invalid/inconclusive | Stop and report | None |
| Exact patch stale or ambiguous | Reject candidate | None |
| Initial truth mismatch | Include in shared repair brief | None |
| Structural revision unchanged/out of range | Reject candidate | None |
| Candidate settlement fails twice | Retain candidate and findings | None |
| Final audit blocker | Retain rejected candidate | None |
| Atomic commit interruption | Recover transaction idempotently | No partial canonical progress |
| Provider transport/reasoning-only failure | Stop with provider classification | None or last completed atomic commit only |

## Test matrix

### Planner and hook contract

1. Unknown hook IDs fail before Writer.
2. Stale payoff fingerprints fail before Writer.
3. Contradictory operations for the same hook fail deterministically.
4. The chapter-2 fixture cannot resolve the actor-identification hook using physical-device evidence.
5. One corrected plan resolves `H006` from explicit physical-device evidence and leaves the actor-identification hook open.
6. A second invalid plan stops without chapter, state, audit, or transaction files.

### Local repair

1. Exact spelling patches never call the Reviser provider.
2. A patch-only candidate reuses initial typed settlement before validation.
3. Reused truth still passes the full state/hook gate; the gate is not bypassed.
4. Stale hash, wrong occurrence, ambiguous target, or residual typo rejects the candidate.
5. Spelling plus a structural blocker uses one deterministic patch and at most one LLM structural revision.
6. Exactly one post-candidate audit is performed.

### Persistence and recovery

1. Rejected candidates never replace canonical prose or truth.
2. A failed Vietnamese chapter remains the next target after restart.
3. No duplicate chapter or `.inkos-file-txn-*` remains after recovery.
4. Manifest, current state, summaries, hooks, index, and chapter number align after acceptance.
5. zh/en behavior remains unchanged.

### Telemetry

1. Every provider POST increments exactly one stage counter.
2. Deterministic local patch increments no provider counter.
3. Retry counters distinguish transport and output retries.
4. Persisted telemetry contains no prompt, response, header, reasoning, or secret material.

## Rollout

1. Implement with failing unit and integration tests first.
2. Run targeted Planner, hook-validator, review-cycle, truth-validation, provider, persistence, and recovery tests.
3. Run Core typecheck, full Core tests, build, `git diff --check`, and security checks.
4. Do not mutate the failed promotion book. Preserve it as evidence.
5. Start a fresh Vietnamese promotion book only after offline gates pass.
6. Recalculate the pilot completion-call cap to include resolve preflight and obtain budget approval before any new Ecoapi run.
7. Run the pilot sequentially and stop on the first hard failure.

## Acceptance criteria

- A bad Planner resolve operation is rejected or corrected before Writer execution.
- Canonical hook payoff meaning cannot be replaced by Planner prose.
- Exact spelling repair avoids unnecessary settlement generation but never skips validation.
- Initial state/hook blockers are visible before the single structural revision is spent.
- Candidate rejection evidence states the real failing contract instead of a generic reason.
- Provider-call caps are enforceable from persisted stage counters.
- Failed chapters remain recoverable at the same number without duplicate or partial state.
- No existing zh/en regression, provider-specific policy coupling, or historical-book mutation is introduced.

## Non-goals

- General Vietnamese dictionary or broad automatic grammar correction.
- Multiple automatic chapter rewrites.
- Fuzzy keyword matching as an acceptance authority.
- Provider failover or Ecoapi-specific business logic.
- Promotion, push, deployment, LKG update, historical-book repair, or deletion of qualification evidence.
