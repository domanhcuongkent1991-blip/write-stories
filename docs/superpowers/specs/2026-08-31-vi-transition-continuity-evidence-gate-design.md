# InkOS Vietnamese Transition Continuity Evidence Gate Design

**Status:** Approved for inline implementation by the project director on 2026-08-31.

## Goal

Prevent a Vietnamese chapter from passing when its opening or ongoing physical
state silently contradicts the previous chapter. The first production case is
the Phase B sequence where chapter 7 records 08:40 and 1.22m, chapter 8 jumps
back to 01:15, chapter 9 stays at night without elapsed-time support, and
chapter 10 restores 1.34m without a causal event.

## Root cause

The Continuity Auditor already receives the previous chapter in full, but its
general timeline instruction does not require an explicit comparison. More
importantly, ordinary LLM findings are normalized as `unverified`; therefore a
high-scoring audit can pass even when the model reports a critical transition
issue. The typed runtime state cannot close this gap because its current facts
do not retain every transient measurement or clock value.

## Considered approaches

1. **Prompt-only checklist:** small and runtime-portable, but an LLM finding
   remains unverified and cannot fail the deterministic acceptance gate.
2. **Host-side numeric/time heuristics:** deterministic, but brittle across
   genres. Repeated numbers may be history, thresholds, comparisons, or current
   state, so false blockers would be common.
3. **Typed quantitative continuity ledger:** strongest long-term authority, but
   adds schema, migration, prompt, reducer, and UI surface beyond this personal
   project's current needs.
4. **Selected: host-bound LLM evidence:** keep the existing Auditor call, force
   an explicit transition checklist, and accept a blocking finding only when
   the host can locate exact excerpts in both the previous and current chapter.

## Contract

For a Vietnamese chapter with a previous chapter, Auditor JSON must include:

```json
{
  "transition_check": {
    "status": "consistent",
    "dimensions_checked": [
      "time",
      "location",
      "physical-state",
      "device-state",
      "possession"
    ]
  }
}
```

If an unexplained reversal exists, `status` is `contradiction` and at least one
critical issue must carry:

```json
{
  "transition_evidence": {
    "dimension": "physical-state",
    "previous_text": "Vạch mực nước chạm đúng mốc 1,22m",
    "current_text": "mặt nước thực tế cuồn cuộn ở mốc 1,34m"
  }
}
```

Each excerpt must be a non-empty, bounded, exact substring of its corresponding
chapter. The host does not infer a contradiction from bare numbers. It verifies
only the evidence binding and promotes a model-identified contradiction into a
deterministic `continuity.transition` blocker.

## Data flow

1. `ContinuityAuditor` loads the previous chapter as it does today.
2. The prompt orders a separate comparison of time, location, physical state,
   device state, and possession before scoring.
3. The parser retains the checklist and optional transition evidence.
4. The Auditor binds both excerpts to the two real chapter bodies.
5. Valid bindings are returned separately as host findings; they are not mixed
   with ordinary unverified LLM findings.
6. `runChapterReviewCycle` adds host findings to deterministic findings.
7. The existing gate invokes at most one Reviser pass. Residual verified
   transition blockers reject the candidate.

## Failure behavior

- Missing or malformed checklist on Vietnamese chapter 2+ makes the audit
  inconclusive. It never triggers a blind rewrite.
- `contradiction` without exact bound excerpts is inconclusive.
- Exact excerpts bound to the wrong chapter are inconclusive.
- A verified contradiction is structural, targets prose, and contains both
  excerpts in its persisted audit evidence.
- Provider interruption remains `BLOCKED_PROVIDER`; canonical files remain at
  the last accepted chapter state.

## Current Phase B recovery

After offline gates pass, rework chapters 8, 9, and 10 in order through
`reviseDraft` with exact briefs restoring the 08:40-to-late-morning sequence.
Preserve 1.22m unless a visible causal rise is written. Do not edit Markdown,
snapshots, runtime JSON, or index files by hand.

## Non-goals

- No new agent, provider call stage, dependency, runtime setting, UI, or typed
  quantitative ledger.
- No automatic repair of historical derived summaries.
- No merge, promotion, book deletion, or commit without director approval.

## Success criteria

- Exact transition evidence is required and host-bound before it can block.
- Invalid evidence is inconclusive and never rewrites prose.
- One bounded revision can clear a verified transition blocker.
- Residual contradiction stays rejected.
- Full Core tests, Core/Studio typecheck, build, and diff checks pass.
- Reworked Phase B chapters 8 through 10 pass length, spelling, audit, transition,
  hook, and state alignment gates; all ten canonical chapters remain present.
