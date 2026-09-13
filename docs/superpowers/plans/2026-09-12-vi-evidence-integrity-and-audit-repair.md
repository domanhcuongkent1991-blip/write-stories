# Vietnamese Evidence Integrity and Audit Verdict Repair — Implementation Plan

> **For agentic workers:** implement task-by-task with the TDD steps below.
> Steps use checkbox (`- [x]`) syntax; all tasks are complete.

**Goal:** stop the pipeline from manufacturing memo drift, recover unparseable
audit verdicts with one bounded call, and stop killing healthy late-chapter
attempts with the 15-minute bound.

**Architecture:** quoted spans become verbatim by contract in
`sanitizeNarrativeControlText`; verbatim evidence surfaces deterministically
to the writer (new prompt section), the planner (vi-only Must Keep promotion),
and the auditor gains envelope tolerance plus exactly one bounded
verdict-repair call under the writer format-repair pattern.

**Tech Stack:** TypeScript, Vitest, existing InkOS audit and telemetry
infrastructure.

---

### Task 1: Sanitizer quote exemption + verbatim evidence section

**Files:**
- Test: `packages/core/src/__tests__/narrative-control.test.ts`
- Modify: `packages/core/src/utils/narrative-control.ts`

- [x] Write failing tests: quoted spans (`"..."`, `“...”`) survive
      sanitization while hook ids/slugs outside quotes are still rewritten;
      `extractVerbatimEvidenceQuotes` collects unique quoted strings from
      `plannedEvidence` (limit enforced); `renderMemoAsNarrativeBlock` appends
      an unsanitized `## Verbatim Evidence (must appear exactly)` section and
      omits it without quotes/contract.
- [x] Implement: split on the quoted-span pattern, sanitize only unquoted
      parts; add the extractor and the evidence section built from
      `intent.expectedHookContract`.
- [x] Focused tests GREEN (9/9), writer regression suites GREEN (40/40).

### Task 2: Writer memo contract obligation

**Files:**
- Modify: `packages/core/src/agents/writer-prompts.ts`

- [x] Add one obligation line to `buildChapterMemoContract` in both language
      variants: every Verbatim Evidence string must appear in the prose exactly
      as written (no paraphrase, translation, or reformatting).

### Task 3: Planner Must Keep promotion (vi only)

**Files:**
- Test: `packages/core/src/__tests__/planner.test.ts`
- Modify: `packages/core/src/agents/planner.ts`

- [x] Write failing integration tests: for `language: "vi"` a planned chapter
      exposes `Bắt buộc xuất hiện nguyên văn: "..."` items in `intent.mustKeep`
      (preflight mocked); for `zh` books no such items are added.
- [x] Implement after `expectedHookContract` attachment in `planChapter`:
      promote up to 6 quotes via `extractVerbatimEvidenceQuotes`, cap the
      merged list at 8, keep the existing `unique` semantics.
- [x] Planner suites GREEN (49/49).

### Task 4: Auditor envelope tolerance + bounded verdict repair

**Files:**
- Test: `packages/core/src/__tests__/continuity.test.ts`
- Modify: `packages/core/src/agents/continuity.ts`
- Modify: `packages/core/src/llm/provider-call-telemetry.ts`
- Modify: `qualification/promotion-runner-scope.mjs`

- [x] Write failing tests: transport envelope unwrapping; exactly one repair
      call at temperature 0 with untrusted-output armor when the first audit
      cannot bind; sentinel and provider-failure paths keep the fail-closed
      result; non-Vietnamese parse failures never repair.
- [x] Implement `unwrapAuditTransportEnvelope` as Strategy 0 of
      `parseAuditResult` (strip allowlisted `status`/`processed` keys only).
- [x] Implement `repairVietnameseAuditVerdict`: one `runWithProviderCallStage`
      ("auditor-verdict-repair") call at temperature 0; repaired output must
      reparse and rebind via `bindVietnameseTransitionReview`; on any failure
      return the original result; merge repair token usage into the chapter
      telemetry.
- [x] Register the new stage in `ProviderCallStageSchema` and in
      `PROVIDER_STAGE_CONTEXT` (`agent: "auditor", substage: "verdict-repair"`).
- [x] Auditor + review-cycle + audit suites GREEN (67/67).

### Task 5: Qualification chapter bound

**Files:**
- Modify: `qualification/promotion-runner.mjs`

- [x] Raise the per-chapter bound from 15 to 25 minutes with a comment
      recording why; leave the 750 ms abort drill untouched.

### Task 6: Verification and security gate

**Files:**
- Verify only.

- [x] Focused suites across all touched modules.
- [x] Full core suite (`npx vitest run` in `packages/core`).
- [x] `npx tsc --noEmit` and `npx tsc` build.
- [x] `git diff --check`; project-local gitleaks staged scan before commit.
- [x] Commit on `main`; live re-qualification is a separate authorized step
      (fresh namespace `internal-luna-04`, 8-chapter gate from chapter 1).
