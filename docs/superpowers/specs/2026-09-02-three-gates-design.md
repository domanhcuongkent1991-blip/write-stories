# InkOS Three-Gate Pipeline Design

**Status:** Proposed design

**Date:** 2026-09-02

**Scope:** Vietnamese long-form pipeline: Writer → Validator/Audit → Repair → Committer

**Priority:** Stability → correctness → recovery → testability → maintainability → runtime replaceability → delivery speed

## 1. Executive summary

The pipeline is governed by three independent gates:

1. **Integration Gate** — proves that the code can safely exist in `master` while the new behavior is disabled.
2. **Activation Gate** — proves that the new behavior works in a controlled internal or canary scope.
3. **Promotion Gate** — proves that the behavior is reliable enough to become the official/default path.

The gates are sequential prerequisites, but their decisions are independent. Integration may be `MERGEABLE_OFF` while Activation is `HOLD_ACTIVATION`. Activation may be `ACTIVATABLE_INTERNAL` while Promotion remains `HOLD_PROMOTION`.

The system must not use a single percentage such as “80% passed” to authorize a commit. Instead, every finding has a severity and disposition. Integrity and safety checks are always 100% blocking; quality findings may enter a user repair queue only when they are explicitly classified as repairable.

## 2. Goals and non-goals

### Goals

- Keep the legacy behavior safe and fully usable when the new behavior is `OFF`.
- Separate draft creation, validation/audit, repair, and canonical commit responsibilities.
- Make provider, parser, quality, state, recovery, and environment failures distinguishable.
- Allow a user to review and repair quality findings without corrupting the original draft or canonical state.
- Make every gate independently testable and independently reversible.
- Produce evidence sufficient to decide `MERGEABLE_OFF`, `ACTIVATABLE_INTERNAL`, or `PROMOTABLE_DEFAULT`.

### Non-goals

- Do not weaken security, state, atomicity, or hard-range gates to improve pass rate.
- Do not make a provider retry indefinitely.
- Do not allow Writer, Audit, or Repair to write canonical state directly.
- Do not change the public API, book schema, or runtime architecture in the first extraction step unless a compatibility-preserving migration is separately approved.
- Do not make live provider availability a prerequisite for testing behavior-neutral code in Integration Gate.

## 3. Core principles

### 3.1. No percentage-based promotion

“80% quality coverage” is an informational metric, not an acceptance decision. The decision is based on findings:

```text
BLOCKED > REPAIR_REQUIRED > WARNING > PASSED
```

If a coverage metric is reported, it means only:

```text
coverage = applicable checks executed / applicable checks configured
```

It does not mean that the same percentage of defects may be ignored. An unevaluated check is `NOT_EVALUATED`, never `PASSED`. Integration and Promotion require 100% execution of their applicable integrity and safety checks.

The following categories must always have zero unresolved findings before commit:

- provider final-response contract;
- parsing and language contract;
- security and secret handling;
- hard length bounds;
- canonical state alignment;
- atomicity and recovery;
- duplicate or partial canonical writes.

### 3.2. Immutable intermediate artifacts

Each stage creates a new artifact. A later stage never overwrites an earlier artifact. The original draft remains available for diff, review, rollback, and forensic analysis.

### 3.3. One canonical writer

Only `Committer` may update canonical chapter/state files. This includes chapter body, index, manifest, current state, summaries, hooks, memory projections, and hashes.

### 3.4. Fail closed

An unknown error, invalid feature flag, incomplete provider response, stale state, or failed recovery must stop the new path. The system may fall back to the legacy path only when no new-path canonical write has occurred.

## 4. Architecture and responsibilities

```text
ProviderAdapter
    ↓ normalized ProviderResult
Writer
    ↓ DraftArtifact
DeterministicValidator
    ↓ ValidationReport
Auditor
    ↓ AuditReport
Repairer / User Repair
    ↓ RepairCandidate
Re-audit + hard validation
    ↓ CommitDecision
Committer
    ↓ atomic canonical write
Canonical book state
```

### ProviderAdapter

Normalizes provider-specific responses and errors. It must distinguish final text from reasoning-only, empty, malformed, partial, timeout, HTTP, and transport-interrupted responses. It must never silently convert an invalid response into an empty draft.

### Writer

Consumes the approved context and creates a `DraftArtifact`. It does not update canonical state and does not decide whether the chapter is acceptable.

### DeterministicValidator

Checks machine-verifiable invariants such as parsing, language, length, chapter number, content hash, forbidden artifacts, and required structure.

### Auditor

Checks continuity, hooks, quality dimensions, spelling, style, and other configured review dimensions. It returns findings with evidence and severity. It does not modify the draft.

### Repairer

Receives only explicitly repairable findings and creates a new `RepairCandidate`. It may be automated once or performed by the user. It must provide a diff and source hash.

### Committer

Revalidates the final candidate, evaluates the commit decision, acquires the book lock, revalidates against the latest canonical checkpoint, and performs the atomic canonical write. It is the only component allowed to advance canonical state.

### Orchestrator

Coordinates transitions and retry policy. It must not contain provider parsing, audit heuristics, or direct canonical persistence logic.

## 5. State machine

### 5.1. Chapter state machine

```text
CREATED
  → PROVIDER_READY
  → DRAFT_CREATED
  → VALIDATED
  → AUDITED
      ├─ BLOCKED
      ├─ QUALITY_BLOCKED
      ├─ REPAIR_REQUIRED
      │    → REPAIR_CANDIDATE_CREATED
      │    → REVALIDATED
      │    ├─ BLOCKED
      │    ├─ REPAIR_REQUIRED
      │    └─ READY_FOR_COMMIT
      ├─ PREVIEW_WITH_WARNINGS
      └─ READY_FOR_COMMIT
  → COMMITTED
```

Terminal or controlled recovery states:

```text
PROVIDER_BLOCKED
PARSE_BLOCKED
SAFETY_BLOCKED
QUALITY_BLOCKED
STATE_BLOCKED
RECOVERY_REQUIRED
CANCELLED
ENVIRONMENT_BLOCKED
```

The following transitions are forbidden:

- `PROVIDER_BLOCKED → COMMITTED`;
- `PARSE_BLOCKED → COMMITTED`;
- `SAFETY_BLOCKED → COMMITTED`;
- `QUALITY_BLOCKED → COMMITTED` by a per-run user acknowledgement; only a separately reviewed audit-policy change may alter how a future finding is classified;
- `REPAIR_REQUIRED → COMMITTED` without revalidation;
- `PREVIEW_WITH_WARNINGS → COMMITTED` without an explicit user acceptance policy and a fresh hard-gate check;
- any state → `COMMITTED` while a transaction or stale lock remains unresolved.

### 5.2. Run-level state

```text
LEGACY_OFF
  → INTERNAL_PREVIEW
  → INTERNAL_CANARY
  → PROMOTION_CANDIDATE
  → DEFAULT_ON
```

Run-level promotion never bypasses chapter-level gates. `DEFAULT_ON` is a separate activation change and must not be inferred from a successful canary.

## 6. Error taxonomy

Every error must include a stable code, stage, retryability, repairability, user disposition, and evidence reference. No raw credentials, headers, prompts, or provider responses may be stored.

| Family | Example codes | Retryable | User repairable | Canonical commit allowed |
|---|---|---:|---:|---:|
| Provider contract | `PROVIDER_REASONING_ONLY`, `PROVIDER_EMPTY`, `PROVIDER_MALFORMED` | Bounded | No | No |
| Provider transport | `PROVIDER_TIMEOUT`, `PROVIDER_PARTIAL_RESPONSE`, `PROVIDER_TRANSPORT` | Bounded | No | No |
| Provider HTTP | `PROVIDER_HTTP_ERROR`, `PROVIDER_MODEL_UNAVAILABLE` | Policy-based | No | No |
| Parse/language | `PARSE_INVALID`, `LANGUAGE_INVALID`, `STRUCTURE_INVALID` | No | Sometimes | No |
| Integrity | `HARD_RANGE_FAIL`, `CONTENT_HASH_MISMATCH`, `CHAPTER_NUMBER_MISMATCH` | No | No | No |
| Quality blocker | `QUALITY_BLOCKED`, `SPELLING_CRITICAL`, `HOOK_BLOCKER` | No | No by default; explicit policy review only | No |
| Quality repair | `QUALITY_REPAIR_REQUIRED`, `SPELLING_REPAIR_REQUIRED`, `HOOK_REPAIR_REQUIRED` | No | Yes | No until re-audit |
| Warning | `QUALITY_WARNING`, `PREFERRED_RANGE_WARNING` | No | Optional | Only if policy permits and hard gates pass |
| State/recovery | `STATE_MISMATCH`, `ATOMIC_COMMIT_FAILED`, `STALE_LOCK`, `RESUME_INVALID` | Controlled recovery | No | No |
| Security | `SECRET_DETECTED`, `UNSAFE_PATH`, `UNTRUSTED_ARTIFACT` | No | No | No |
| Environment | `EPERM_DIST_WRITE`, `RUNTIME_MISSING`, `PROCESS_HUNG` | Controlled | No | No for the affected evidence |

Provider retry policy is bounded per run and must record attempt number, model, mode, and outcome. A fallback model cannot silently change the lineage of an already promoted chapter.

## 7. Feature flag and rollout policy

Use one typed server-side mode resolved before a run starts:

```text
viPipelineMode = legacy | preview | canary | default
```

Rules:

- Missing, invalid, or conflicting configuration resolves to `legacy` and emits a safe configuration diagnostic.
- `legacy` is the default until Promotion Gate passes.
- `preview` may expose a draft and repair findings but must not update canonical state.
- `canary` is restricted to an explicit internal book/project allowlist.
- `default` is permitted only after Promotion Gate and a separate default-on change.
- The flag is enforced at the orchestration/API boundary, not only in the UI.
- The resolved mode, flag source, candidate SHA, and feature configuration hash are recorded in safe evidence.
- No feature flag may bypass hard, security, parser, state, or recovery gates.
- Rollback is performed by changing the mode to `legacy`; no broad data deletion is required.

## 8. Artifact contracts

### DraftArtifact

Required fields:

- schema version;
- draft ID and run ID;
- book ID and chapter number;
- parent canonical checkpoint/hash;
- content hash and length metadata;
- provider/model/transport lineage;
- creation timestamp;
- safe storage path.

### ValidationReport

Required fields:

- validator version;
- checks executed and results;
- hard blockers;
- warnings;
- computed content hash;
- source draft hash;
- no-secret assertion.

### AuditReport

Each finding must include:

- stable rule ID;
- category;
- severity;
- disposition: `blocked`, `repair-required`, `warning`, or `passed`;
- human-readable description;
- machine-verifiable evidence when available;
- repair hint when repairable;
- auditor version and timestamp.

### RepairCandidate

Required fields:

- source draft/candidate hash;
- changed candidate hash;
- requested finding IDs;
- bounded repair attempt number;
- diff summary;
- validator and audit results;
- acceptance decision.

### User repair acceptance

User repair is permitted only for findings whose disposition is `repair-required`. The UI/API must show the original draft, the finding list, the candidate diff, and the post-repair validation result. A user acknowledgement may accept a `warning`, but it may not override a provider, parser, security, integrity, state, recovery, or `quality-blocked` finding.

### CommitDecision

Required fields:

- decision: `preview`, `needs-review`, `blocked`, `ready-for-commit`, or `committed`;
- all unresolved blockers;
- accepted warnings;
- canonical checkpoint before commit;
- final invariant result;
- atomic commit result;
- rollback reference.

## 9. Evidence matrix

| Gate | Required evidence | Minimum Go criteria | No-Go criteria |
|---|---|---|---|
| Integration | build, typecheck, full tests, compatibility fixtures, security scans, feature-OFF tests, diff review | All required checks pass; legacy behavior unchanged; flag OFF verified at API/UI/CLI boundaries; no unresolved Critical/High security issue | Build/test/typecheck failure; backward incompatibility; flag bypass; unsafe migration; unreviewed security finding |
| Activation | contract fixtures, deterministic fake-provider matrix, stage artifacts, fault injection, crash/restart, state invariants, bounded internal canary | Deterministic activation suite passes; Writer/Audit/Repair/Committer boundaries hold; invalid provider output never commits; recovery is idempotent; preview/repair path works; and, when provider-backed activation is in scope, the provider canary passes. An unavailable/unstable canary is recorded as `PROVIDER_INCONCLUSIVE`, not as Activation Go | Any invalid response commits; state drift; repair overwrites source; stale lock unrecoverable; unbounded retry; missing lineage |
| Promotion | exact SHA, live provider evidence, 3→8→15 qualification, 15/15 chapter results, audit/hard-range results, abort/restart evidence, token growth, CI | All required chapters pass; blocker 0; state aligned; recovery pass; provider evidence reproducible and redacted; default-on change separately reviewed | Any provider blocker; unresolved repair; partial qualification; recovery failure; missing evidence; default behavior not reversible |

The evidence collector must produce one safe summary per run and preserve failed runs. Failed runs are evidence, not promotion candidates.

## 10. Go/No-Go procedure

### Integration Gate

**Go:** create a merge candidate with the new mode still `legacy`, run the full offline matrix, inspect exact diff and verify that disabling the feature stops all new side effects.

**No-Go:** do not merge. Keep the branch isolated, fix the smallest failing scope, and retain the previous rollback SHA.

### Activation Gate

**Go:** enable `preview` or `canary` only for an internal namespace. Run the deterministic success/failure fixture suite, then one bounded live canary if the provider is available. Record deterministic activation and live-provider canary as separate results. Confirm the canonical directory is unchanged for preview and consistent after a successful commit.

**No-Go:** switch back to `legacy`, preserve evidence, and fix the failing component. Do not proceed to long live qualification.

If the deterministic suite passes but the provider canary is unavailable or unstable, the result is `ACTIVATABLE_DETERMINISTIC / PROVIDER_INCONCLUSIVE`. It is useful internal evidence, but it is not a full Activation Gate pass, is not permission to enable the provider-backed path broadly, and does not satisfy Promotion Gate.

### Promotion Gate

**Go:** run the long qualification on the exact candidate SHA. Only after all required evidence is green may the default-on change be proposed.

**No-Go:** keep `legacy` as default, classify the blocker, and do not claim release readiness. A single successful chapter or an 80% quality score is insufficient.

## 11. Rollback and recovery

### Code rollback

- Keep each extraction or behavior change in a focused commit.
- Record the last known-good SHA before each checkpoint.
- Revert only the affected commit or disable the feature; never broad-reset the worktree.

### Runtime rollback

- Set `viPipelineMode=legacy`.
- Stop new canary scheduling.
- Leave draft, audit, repair, and failed-run evidence intact.
- Do not delete books or evidence automatically.

### Data rollback

- Before canonical commit, discard only the uncommitted candidate by reference; retain the source draft.
- After an interrupted commit, use the existing recovery mechanism to reclaim locks and reconstruct from the last canonical checkpoint.
- Never restore a failed audit candidate directly over canonical state.

### Provider rollback

- Stop provider calls for the affected run after the bounded budget is reached.
- A fallback model may be used only in a new isolated run or an explicitly recorded fallback attempt.
- Do not mix unverified provider output into a promotion run without lineage and re-audit.

## 12. Risk register and mitigations

| Risk | Impact | Mitigation | Detection evidence |
|---|---|---|---|
| Multiple components write canonical state | High | Committer-only write boundary | write-path tests, file-set invariant |
| Feature OFF does not fully disable behavior | High | Server-side flag enforcement and OFF tests for all entrypoints | mode evidence, side-effect snapshot |
| Fake provider passes but real provider fails | High | Provider contract fixtures plus bounded live canary | provider result matrix |
| Reasoning-only/partial output is accepted | High | Explicit provider error taxonomy and fail-closed parser | negative contract tests |
| Repair corrupts the original draft | High | Immutable source hash and candidate-only repair | diff/hash evidence |
| Audit false positive blocks useful work | Medium | `repair-required` and `warning` dispositions | rule-level report |
| Warning is treated as promotion pass | High | No aggregate percentage decision | CommitDecision |
| Crash causes state drift | High | Atomic commit, crash injection, resume idempotence | invariant snapshots |
| Retry loop increases cost or duplicates writes | High | Per-run budget and idempotency keys | request/operation counters |
| Secrets enter evidence | High | Redaction and Gitleaks before gate close | safe evidence assertions |
| Schema migration breaks old books | High | Versioned artifacts and no first-phase schema change | compatibility fixtures |
| Windows EPERM is mistaken for a source defect | Medium | Separate environment gate and evidence classification | environment diagnostics |
| Refactor produces merge conflict or broad scope | Medium | Focused commits, explicit file allowlist, master guard | Git diff and ancestry checks |

## 13. Implementation phases

1. Add stable error taxonomy and disposition types without changing canonical behavior.
2. Add provider contract fixtures for final, reasoning-only, empty, malformed, partial, timeout, and transport errors.
3. Introduce immutable `DraftArtifact` and `ValidationReport` behind the existing orchestration path.
4. Run Audit in shadow mode and compare reports without changing commit decisions.
5. Introduce `RepairCandidate` and manual preview/repair flow.
6. Extract Committer as the only canonical writer; add crash and recovery tests.
7. Add typed mode flag with default `legacy`; test OFF behavior across API, CLI, and UI.
8. Close Integration Gate on a behavior-neutral merge candidate.
9. Close Activation Gate with deterministic faults and a bounded canary.
10. Close Promotion Gate with exact-SHA 3→8→15 live qualification.
11. Propose a separate default-on change only after Promotion Gate.

## 14. Master integration policy

Integration into `master` is allowed only for a candidate whose behavior remains `legacy` by default and whose Integration Gate is green. The merge candidate must not silently enable `preview`, `canary`, or `default` mode.

The recommended commit sequence is:

```text
contracts/error taxonomy, default OFF
→ stage extraction, default OFF
→ deterministic Activation tests
→ internal preview/canary enablement
→ live Promotion evidence
→ separate default-on change
```

Each step requires an explicit rollback SHA. Passing Integration Gate does not authorize the default-on change. Passing Activation Gate does not authorize a release. A merge proposal must state the three gate results separately.

## 15. Current project interpretation

The recent Ecoapi results are classified as Activation/Promotion evidence:

- reasoning-only responses are `PROVIDER_REASONING_ONLY` and cannot enter repair;
- interrupted responses are `PROVIDER_PARTIAL_RESPONSE` or `PROVIDER_TRANSPORT` and cannot commit;
- a real spelling/quality finding is `REPAIR_REQUIRED` only when a valid final draft exists;
- a failed run must not be reused as a promotion namespace.

These results do not by themselves decide whether behavior-neutral code can pass Integration Gate. They do prove that the provider contract and long qualification remain separate Activation/Promotion work.

## 16. Definition of done for this design

The design is ready for implementation when:

- all three gate questions and outputs are accepted;
- state transitions and forbidden transitions are implemented as contracts;
- all error families have retry/repair/commit dispositions;
- feature mode defaults to `legacy` and is enforceable outside the UI;
- each artifact has a version, source hash, and safe evidence record;
- Go/No-Go and rollback criteria are executable as tests or checklist items;
- no rule permits an 80% score to bypass an integrity blocker.
