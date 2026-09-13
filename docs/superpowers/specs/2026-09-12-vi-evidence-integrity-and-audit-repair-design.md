# Vietnamese Evidence Integrity and Audit Verdict Repair

Status: implemented
Date: 2026-09-12
Target branch: `main`

## Problem

Two independent failure modes consumed most of the Vietnamese promotion
campaign wall time, and one of them turned out to be a pipeline defect rather
than model behavior.

### 1. Narrative sanitization manufactured memo drift

The writer's memo block is rendered through `sanitizeNarrativeControlText`
(`packages/core/src/utils/narrative-control.ts`), whose kebab-slug and
`H\d+` rewrites exist to keep mechanical identifiers out of prose guidance.
The rewrites also applied **inside double-quoted spans**, so the ledger line

```
- H004 "admin procedure: pre-processing" -> ...
```

reached the writer as `admin procedure: this thread`. The auditor
(`ContinuityAuditor.auditChapter`) receives the unsanitized memo, compared the
prose (which faithfully reproduced what the writer saw) against the original,
and raised a critical `Chapter Memo Drift Check` — chapter 8 of namespace
`internal-luna-03` failed twice this way. The pipeline manufactured the drift
it failed the chapter for.

Two secondary gaps widened the blast radius:

- `Must Keep` is planner-deterministic (`collectMustKeep` reads only
  `current_state`/`story_bible`) and is normally `- none`; it never carried
  quoted evidence values.
- The rendered intent sections reach the settler/reviser
  (`buildNarrativeIntentBrief`) but never the creative writer, and that path
  re-sanitizes each line.

### 2. Unparseable audit verdicts forced full chapter rewrites

`parseAuditResult` accepts several JSON shapes but not transport envelopes
(`{"status":..,"processed":..,<verdict>}`), and
`bindVietnameseTransitionReview` forces `parseFailed: true` whenever
`transition_evidence` excerpts do not `includes()`-match the chapter texts.
The parse-failure short circuit (`chapter-review-cycle.ts`) then skips
revision and the chapter is retained as audit-failed — a full ~13-call
chapter rewrite is the only recovery, although the draft itself was usually
fine. In gate 8, roughly half the chapters hit this.

A per-chapter harness bound of 15 minutes additionally killed healthy
late-chapter attempts that run multi-cycle settlement recovery with 120s+
calls (chapter 3 of gate 8).

## Decision

1. **Quoted spans are verbatim by contract.** `sanitizeNarrativeControlText`
   splits on `"..."` and `“...”` spans and only rewrites unquoted text. The
   anti-mechanical purpose is preserved for prose guidance; evidence values
   survive intact for every consumer (writer, settler, reviser).
2. **Deterministic verbatim-evidence surfacing, three layers deep:**
   - `renderMemoAsNarrativeBlock` appends an unsanitized
     `## Verbatim Evidence (must appear exactly)` section built from
     `expectedHookContract.operations[].plannedEvidence` quotes;
   - the writer memo contract instructs that these strings must appear in the
     prose exactly as written;
   - for Vietnamese books the planner promotes the same quotes into
     `Must Keep` items (`Bắt buộc xuất hiện nguyên văn: "..."`), which flow
     into intent artifacts and the settler/reviser briefs.
3. **One bounded audit verdict repair, Vietnamese only.** When the first
   audit result ends `parseFailed` (raw parse failure or failed transition
   binding), `auditChapter` makes exactly one temperature-0 re-emission call
   under the writer format-repair pattern: untrusted-output armor, canonical
   JSON instruction, exact-substring instruction for `transition_evidence`,
   `AUDIT_REPAIR_REJECTED` sentinel. The repaired output must reparse and
   rebind; otherwise the original fail-closed result is returned unchanged.
   The repair runs under telemetry stage `auditor-verdict-repair`.
4. **Transport-envelope tolerance in audit parsing.** Top-level
   `status`/`processed` keys are stripped and the remainder parsed before any
   extraction strategy gives up. This closes the silent empty-verdict hole
   where an envelope parsed as `passed: false, issues: []`.
5. **Qualification chapter bound raised 15 → 25 minutes.**

## Alternatives considered

- **Writer-prompt hardening only** — rejected: the memo already carried
  "keep immutable" language and the model still drifted, because the corrupted
  value arrived through deterministic code, not model negligence.
- **Auto-accepting chapters after a second parse failure** — rejected: it
  would weaken the fail-closed audit contract. The repair must reparse and
  rebind or the chapter stays audit-failed.
- **Merging observation and settlement calls** — deferred: largest single
  time block (~42%) but it restructures the state pipeline; not before
  promotion.

## Scope

- `packages/core/src/utils/narrative-control.ts` (sanitizer + evidence
  extraction + verbatim section);
- `packages/core/src/agents/writer-prompts.ts` (memo contract line);
- `packages/core/src/agents/planner.ts` (vi-gated Must Keep promotion);
- `packages/core/src/agents/continuity.ts` (envelope unwrap + verdict repair);
- `packages/core/src/llm/provider-call-telemetry.ts` (new stage);
- `qualification/promotion-runner-scope.mjs` (stage context mapping);
- `qualification/promotion-runner.mjs` (bound).

No changes to: memo parse/retry contracts, `assertFreshMemoGovernance`,
preflight structured output, `assertHookContractCurrent`, the writer
format-repair, `decideAudit` mapping, `AuditRunV1Schema`, or the
parse-failure short circuit.

## Verification and rollout

Focused suites (`narrative-control`, `writer`, `planner`, `continuity`,
`chapter-review-cycle`, `audit-parse`, `audit-policy`,
`chapter-audit-evaluator`), then the full core suite, typecheck, build,
secret scan. Rollout is a fresh evidence namespace on the new candidate SHA
re-running the 8-chapter gate from chapter 1; expected steady-state cost is
~11–13 minutes per chapter with roughly half the previous retry volume.
