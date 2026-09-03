# Vietnamese Planner Legal Hook Action Guidance

## Problem

The Vietnamese promotion canary stopped before chapter writing because the Planner proposed `resolve` for hook `H001` while its canonical status was `deferred`. The lifecycle validator correctly rejected the transition and preserved chapter-zero state. The failure is therefore not a validator defect: the Planner prompt exposed hook status but did not expose the exact actions permitted by that status.

## Decision

Keep hook lifecycle validation fail-closed and keep the existing request/retry policy unchanged. Add one shared, deterministic helper that derives legal hook actions from the same normalized status used by `assertLegalHookTransition`. Use that helper to render `allowed_actions` beside each relevant hook only for Vietnamese planning.

The resulting rules remain:

- `resolved`: no legal operation;
- `deferred`: `advance`, `mention`, or `defer`, never `resolve` directly;
- other current statuses: `advance`, `mention`, `resolve`, or `defer`.

The Planner-facing `allowed_actions` rendering intentionally omits `mention`,
because the governed memo ledger has only `advance`, `resolve`, and `defer`
sections. The lower-level contract still preserves the existing `mention`
acceptance semantics for callers that construct the V2 operation directly.

The validator continues to decide acceptance. Prompt guidance only reduces invalid proposals; it never turns an illegal proposal into a valid transition.

## Alternatives considered

### General prompt warning only

Rejected because it would duplicate lifecycle policy in prose and could drift from validation behavior.

### Automatically repair or retry an illegal operation

Rejected because it would add provider calls, change the bounded retry policy, and risk hiding a provider/model contract failure.

### Remove deferred hooks from Planner context

Rejected because deferred hooks may legally be advanced or deferred again. Removing them would prevent valid narrative reactivation.

## Scope

- Add a tested legal-action derivation beside the existing hook transition contract.
- Make the validator consume that derivation without changing accepted or rejected transitions.
- Add opt-in rendering of legal actions to relevant hook rows.
- Enable the rendering only for Vietnamese Planner runs so existing Chinese and English prompt snapshots remain unchanged.
- Reuse the existing offline replay assertion that `deferred -> resolve` rejects before write.
- Add focused tests proving the Vietnamese prompt exposes `advance|defer` for a deferred hook and never advertises `resolve`.

No public schema, baseline fixture, provider adapter, retry count, audit threshold, or canonical write rule changes.

## Verification and rollout

Run the focused hook contract, Planner context, Planner, and promotion replay tests first. Then run Core tests, typecheck, build, diff checks, and secret scanning before commit. A live retry must use a new evidence namespace and the exact new commit SHA; the failed `zpro-gpt55-01` namespace remains immutable evidence.
