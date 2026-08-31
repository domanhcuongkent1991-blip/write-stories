# Vietnamese Repair Feedback and Progress Gate Design

> **Superseded in part:** Its repair and recovery invariants remain historical
> context, but every 1,500-word bound is replaced by the approved policy in
> `2026-08-31-vi-phase-b-length-1800-design.md`. Do not execute its old range.

**Date:** 2026-08-31  
**Status:** Approved design  
**Scope:** Vietnamese long-fiction qualification pipeline only; no provider configuration change and no baseline-book mutation.

## Goal

Make Vietnamese chapter qualification fail closed and recoverable when a chapter contains high-confidence spelling errors or violates the approved length policy. The system must give the repair model exact, actionable feedback, use the local Vietnamese length counter as the only numeric authority, and prevent an unaccepted chapter from advancing durable story progress.

## Context and observed failure

The qualification book `phase-a-ecoapi-1150-20260831-0` produced a final prose answer through Ecoapi with `reasoning_effort=none`, so provider output was available. The local counter measured 1,528 `vi_wordlike_tokens_v1` tokens against the approved hard range 1,000–1,500. The Auditor independently described the chapter as approximately 600 words, and the automatic Reviser expanded the candidate to 1,584 tokens. The candidate was rejected by the local hard-range gate.

The same chapter contained three high-confidence surface errors:

| Wrong text | Proposed replacement |
| --- | --- |
| `mười mốn` | `mười bốn` |
| `dry khốc` | `khô khốc` |
| `Sound tivi` | `Âm thanh tivi` |

The existing Vietnamese validator runs during writing, but the production review callback can omit those findings. In addition, `PostWriteViolation` and the runner-to-review mapping retain only free-form descriptions, so the Reviser does not receive an exact target/replacement contract. Finally, durable progress currently counts chapter file numbers without checking whether the indexed chapter passed audit.

## Design principles

1. **Stability before speed.** Every external candidate is bounded, locally validated, and committed only after a shared acceptance gate.
2. **Local facts beat model estimates.** The local counter, content hash, deterministic validators, and persisted audit identity are authoritative.
3. **No destructive guessing.** Do not clip prose, delete arbitrary sentences, install a broad dictionary, or silently rewrite unknown words.
4. **Recovery is explicit.** Failed candidates remain inspectable, but cannot become durable progress.
5. **Language isolation.** The Vietnamese path receives these changes; Chinese and English behavior remains unchanged unless a shared type change is strictly backward-compatible.

## Architecture and data flow

```text
Writer LLM
  -> normalize surface
  -> local Vietnamese spelling/surface checks
  -> local length classification
       1000–1300  : continue without length repair
       1301–1500  : warning-only; continue if all other gates pass
       <1000/>1500: one bounded length-repair attempt
  -> state settlement and candidate validation
  -> continuity audit (LLM findings plus deterministic findings)
  -> shared acceptance gate
  -> atomic canonical commit only when accepted
```

Spelling errors use a separate local repair path inside the review cycle:

```text
Deterministic validator
  -> verified local AuditIssue + RepairHint
  -> Reviser PATCHES-only prompt
  -> exact patch application
  -> re-run validator and state/audit checks
  -> accept or reject candidate
```

Length repair is separate from spelling repair. A length candidate must be counted and hashed before state settlement; it must never be accepted solely because the model claims to have shortened or expanded it.

## Repair feedback contract

Add an optional, strict, backward-compatible repair hint to the in-memory and persisted issue types:

```ts
interface RepairHint {
  readonly kind: "exact-replacement";
  readonly targetText: string;
  readonly replacementText: string;
  readonly occurrenceIndexes: ReadonlyArray<number>;
  readonly context: string;
}
```

Contract rules:

- `targetText` and `replacementText` are non-empty and length-limited.
- `occurrenceIndexes` are one-based positions in the normalized chapter content.
- `context` is a bounded excerpt and never contains prompts, chain-of-thought, credentials, or unrelated chapter text.
- The hint is optional so existing audit-run v1 files remain readable.
- The strict audit-run allowlist explicitly permits this field; unknown fields remain rejected.
- The content hash remains the evidence binding. A hint from a different content hash is stale and cannot be applied.

`PostWriteViolation`, `AuditIssue`, and the audit-run serialization schema must preserve the hint. The runner's deterministic-check mapping must copy it rather than reconstructing a reduced issue. The Reviser prompt must render a clearly labeled deterministic block:

```text
DETERMINISTIC REPAIR HINT (verified; obey exactly)
TARGET_TEXT: mười mốn
REPLACEMENT_TEXT: mười bốn
OCCURRENCES: 1
CONTEXT: ... sai lệch mười mốn centimet ...
```

The Reviser remains responsible for returning a patch, but the pipeline is responsible for exact-match validation and re-running the validator. If the target is missing, the occurrence count is wrong, or another known spelling error remains, the candidate is rejected without changing canonical files.

## Vietnamese spelling policy

Use a small versioned catalog of high-confidence replacements. The catalog is deterministic and testable; it is not a general Vietnamese dictionary. Each entry contains the wrong text, replacement text, and a stable rule identifier. The initial catalog contains the three observed errors above.

High-confidence catalog hits are `error` severity and block chapter acceptance. Unknown words, names, loanwords, and technical terms are not guessed or automatically replaced; they remain subject to human review or an explicitly added catalog entry.

The validator must run for the initial writer output and every revision candidate. The runner review callback must include these findings on every assessment, fixing the current path where `output.postWriteErrors` can be bypassed when a custom callback is supplied.

## Length policy and audit semantics

For `vi_wordlike_tokens_v1` with target 1,150:

- Preferred range: 1,000–1,300.
- Hard range: 1,000–1,500.
- 1,301–1,500 emits deterministic `length.soft-range` warning only.
- Below 1,000 or above 1,500 emits verified deterministic `length.hard-range` critical finding.

The local count is the source of truth for writer telemetry, audit-run length, chapter metadata, warning text, and candidate acceptance. LLM length comments may remain as `source="llm"`, `verification="unverified"` diagnostics, but they must not override local classification or create inverse repair instructions. When a deterministic hard-range finding exists, contradictory LLM length guidance is omitted from the Reviser repair brief.

Length repair is bounded to one attempt per operation. The candidate is normalized, checked for non-empty and changed content, counted locally, hashed, settled against the canonical baseline, and re-audited. A candidate outside the hard range, with stale hash, invalid state settlement, score below 85, or any verified critical finding is rejected. No substring clipping or arbitrary sentence deletion is allowed.

## Persistence and recovery

Canonical content and truth files are committed atomically only after the shared acceptance gate. A rejected candidate may be retained under an allowlisted audit-candidate path with its operation ID, attempt ID, content hash, count, and rejection reason. Candidate paths must not match the chapter-file scanner and must not affect chapter numbering.

For Vietnamese progress resolution, only an accepted terminal chapter may advance the durable prefix. `audit-failed`, `rejected`, `state-degraded`, and in-flight statuses do not advance it. A failed chapter remains retryable at the same number. Existing Chinese and English file/status behavior is preserved through an explicit language-scoped policy or an optional resolver mode.

Recovery must preserve audit-run identity and idempotency. A restart after a rejected candidate must not promote it, duplicate it, or skip the unresolved chapter. A restart after an accepted atomic commit must remain idempotent and continue from the next chapter.

## Files and responsibilities

- `packages/core/src/agents/vietnamese-spelling-catalog.ts` — versioned high-confidence catalog only.
- `packages/core/src/agents/vietnamese-surface-validator.ts` — deterministic surface and spelling findings; emits repair hints.
- `packages/core/src/agents/continuity.ts` — shared `AuditIssue` repair-hint type and parsing/normalization.
- `packages/core/src/agents/post-write-validator.ts` — compatible violation contract if shared types are placed there.
- `packages/core/src/agents/reviser.ts` — render deterministic hints and enforce PATCHES-only routing for local spelling errors.
- `packages/core/src/pipeline/chapter-review-cycle.ts` — preserve hints, filter contradictory unverified length guidance, bound repair, and revalidate candidates.
- `packages/core/src/pipeline/runner.ts` — run Vietnamese checks on every assessment and wire candidate retention/recovery.
- `packages/core/src/audit/audit-run.ts` — strict optional hint schema and round-trip persistence.
- `packages/core/src/state/state-bootstrap.ts` and `packages/core/src/state/manager.ts` — Vietnamese status-aware durable-progress resolution.
- Related unit, integration, and recovery tests under `packages/core/src/__tests__/`.

No provider configuration, secret, baseline book, or unrelated language path is in scope.

## Test and acceptance matrix

### Spelling and repair contract

1. Each catalog entry produces one verified blocking issue with exact target, replacement, occurrence, context, rule ID, and content hash.
2. The hint survives Writer → Runner → Review Cycle → AuditRun → Reviser without field loss.
3. Reviser receives PATCHES-only instructions for local spelling issues.
4. Exact unique patch is accepted after validator re-run.
5. Missing target, wrong occurrence, duplicate ambiguity, stale hash, unchanged output, malformed patch, or residual known typo rejects the candidate and leaves canonical content untouched.
6. Legacy audit-run v1 JSON without a hint still parses and round-trips.

### Length and audit

1. Local counts at 950, 1,150, 1,350, 1,500, 1,528, and 1,550 produce the expected hard/preferred classifications.
2. An LLM “~600 words” finding cannot override a local 1,528 count or instruct expansion.
3. A 1,350-token chapter can pass with a warning when score and other gates pass.
4. A 1,528-token candidate receives at most one bounded repair attempt; a 1,584 candidate is rejected.
5. Empty, unchanged, stale, invalidly settled, or still-out-of-range candidates do not mutate canonical state.

### Progress and recovery

1. Vietnamese chapter 1 with `audit-failed`, `rejected`, or `state-degraded` status does not advance next chapter to 2.
2. A failed chapter plus a stray chapter-2 file still resolves the unresolved chapter as the retry target.
3. Accepted chapter 1 advances next chapter to 2.
4. Rejected-candidate files are recoverable but ignored by the chapter scanner.
5. Interrupted atomic writes recover without duplicate chapters or state drift.
6. Existing zh/en progress, counting, audit, and persistence tests remain unchanged.

## Rollout and stop conditions

1. Implement and run offline unit tests first.
2. Run core typecheck, full core tests, diff check, and the project security checks; report pre-existing findings without exposing values.
3. Re-run the existing qualification book only after offline gates pass. Do not modify the historical baseline book.
4. Run one Vietnamese chapter with the validated Ecoapi configuration. Continue to the next chapter only when the current chapter has accepted terminal status and no blocking findings.
5. Stop on provider reasoning-only output, parse failure, unresolved spelling error, hard length failure after one repair, invalid state settlement, stale hash, duplicate-write evidence, or any recovery inconsistency.

## Design review checklist

- No placeholder requirements or unspecified error paths remain.
- The local length counter is authoritative in every numeric decision.
- Spelling repair hints are explicit, bounded, hash-bound, and backward-compatible.
- Candidate rejection never replaces canonical content.
- Failed Vietnamese chapters cannot advance durable progress.
- zh/en behavior is explicitly protected.
- The design does not require provider configuration changes or a broad spell-check dependency.
