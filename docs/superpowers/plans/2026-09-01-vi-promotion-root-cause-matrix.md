# Vietnamese promotion hardening: root-cause matrix

Status: `HOLD`

Candidate: `f0a69b4f`

Scope: offline analysis and replay fixtures only. No provider calls, promotion, or LKG update.

## Evidence boundary

The matrix is derived from the sanitized qualification records for candidate
`f0a69b4f`. It records failure shapes and decisions, not API keys, raw prompts,
raw provider responses, or full chapter prose.

## Root-cause matrix

| Failure class | Observed shape | Owning boundary | Existing guard | Offline acceptance |
| --- | --- | --- | --- | --- |
| Provider contract | Single result object with `status`/`processed` metadata; occasional whole-response JSON fence | `HookResolvePreflightAgent` parser | Strict Zod result schema and exact hook IDs | Normalize only the documented envelope/fence; reject unknown keys, malformed JSON, and ID mismatch |
| Planner contract | `deferred` hook proposed with irreversible `resolve` action | Hook lifecycle contract | `assertLegalHookTransition` | Reject before writer/state mutation; preserve canonical state |
| Hard length | Vietnamese count `1812` against hard max `1800` | Review acceptance gate | `isOutsideHardRange` and shared candidate gate | Retain canonical chapter; do not spend a second structural call |
| Reviser/auditor output | Post-revision structured audit output cannot be parsed | Review cycle | Parse-failure short circuit and bounded repair | Mark inconclusive/failed and retain canonical chapter |
| Recovery harness | Resume path lacked snapshot `0` after a failed run | Qualification harness | Baseline snapshot and state alignment checks | Recreate or preserve snapshot `0`; rerun is idempotent and provider-free |

## Decisions

1. Treat provider output and planner intent as untrusted input.
2. Keep lifecycle, hard-length, and candidate-acceptance gates strict.
3. Keep normalization at one provider boundary; do not add agent-specific parsers.
4. Use sanitized fixtures for replay; never persist raw provider payloads.
5. Stop live qualification at the first failed checkpoint; do not retry a
   candidate whose failure class has not passed offline replay.

## Replay fixture inventory

The test-only inventory is in
`packages/core/src/__tests__/fixtures/promotion-replay-fixtures.ts` and is
covered by `promotion-replay-fixtures.test.ts`. It contains five cases:

- provider single-envelope normalization;
- deferred-hook resolve rejection;
- Vietnamese hard-range overrun;
- malformed post-revision output;
- chapter-zero baseline preservation during resume.

The fixture inventory intentionally contains only identifiers, shape metadata,
owner boundary, evidence class, and expected outcome.

`promotion-offline-replay.test.ts` exercises a test-only deterministic state
machine over the required `3 → 8 → 15` checkpoints and one chapter `4–8`
abort/restart. It reports `PASS_OFFLINE` or `HOLD`, verifies that canonical and
manifest chapters stay aligned, and always requires zero provider calls. This
is a control-plane replay, not a replacement for the production pipeline or a
live qualification.

## Explicitly out of scope

- changing public APIs, schemas, agent architecture, provider, model, or runtime;
- widening the Vietnamese hard range or weakening revision acceptance;
- increasing retry loops;
- live provider calls;
- merge, push, tag, publish, or LKG promotion.
