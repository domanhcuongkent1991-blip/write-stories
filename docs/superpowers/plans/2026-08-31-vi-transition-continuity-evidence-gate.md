# Vietnamese Transition Continuity Evidence Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute inline because the project director has prohibited subagent delegation. Do not commit until the director explicitly approves it.

**Goal:** Make cross-chapter time and physical-state contradictions host-verifiable, blocking, recoverable, and testable without adding a new agent or deterministic semantic heuristic.

**Architecture:** Extend the existing Continuity Auditor response with a required Vietnamese transition checklist and exact excerpts from the previous/current chapter. Bind those excerpts inside the host and feed only successfully bound contradictions into the existing deterministic review gate; malformed claims become inconclusive.

**Tech Stack:** TypeScript, Vitest, existing `ContinuityAuditor`, `runChapterReviewCycle`, `ChapterAuditEvaluation`, and `PipelineRunner.reviseDraft`.

---

### Task 1: Add RED tests for the transition contract

**Files:**
- Modify: `packages/core/src/__tests__/continuity.test.ts`
- Modify: `packages/core/src/__tests__/chapter-review-cycle.test.ts`

- [ ] **Step 1: Add a parser test for typed checklist and evidence**

Create an audit JSON fixture with `transition_check.status="contradiction"`, all
five required dimensions, and exact `previous_text` / `current_text` fields.
Assert the normalized result preserves camel-cased typed values.

- [ ] **Step 2: Add an Auditor binding test**

Create chapter 1 containing `Vạch mực nước chạm đúng mốc 1,22m lúc 08:40.` and
audit chapter 2 containing `Trong đêm, mặt nước trở lại 1,34m.`. Mock Auditor
JSON with exact evidence and assert one host finding:

```ts
expect(result.hostFindings).toEqual([
  expect.objectContaining({
    severity: "critical",
    ruleId: "continuity.transition",
    verification: "verified",
    repairScope: "structural",
    repairTarget: "prose",
  }),
]);
```

- [ ] **Step 3: Add invalid and missing evidence tests**

Assert a missing checklist or an excerpt absent from the corresponding chapter
sets `parseFailed=true`, returns no host finding, and therefore cannot trigger a
revision.

- [ ] **Step 4: Add review-cycle routing tests**

Return an Auditor result with a host finding. Assert it reaches the Reviser as a
verified `continuity.transition` issue and that only one automatic revision is
attempted. Add a residual-blocker case that remains rejected.

- [ ] **Step 5: Run RED tests**

```powershell
pnpm --filter @actalk/inkos-core test -- continuity.test.ts chapter-review-cycle.test.ts
```

Expected: failures because transition types, parsing, host binding, and review
cycle routing do not exist yet.

### Task 2: Implement parsing and exact host binding

**Files:**
- Modify: `packages/core/src/agents/continuity.ts`

- [ ] **Step 1: Add bounded internal types**

Add `TransitionDimension`, `TransitionCheck`, and `TransitionEvidence` unions.
Extend `AuditResult` with optional `transitionCheck` and `hostFindings`; extend
`AuditIssue` with optional parsed `transitionEvidence`.

- [ ] **Step 2: Normalize untrusted model fields**

Accept only `consistent|contradiction`, the five exact dimension values, and
3-500 character excerpts. Reject arrays with missing required dimensions,
duplicates, unknown dimensions, or malformed evidence.

- [ ] **Step 3: Harden the Vietnamese prompt**

Require a transition check before scoring. Explain that a change is valid only
when the current chapter depicts elapsed time or a causal event; historical
references must not be treated as current state. Require exact excerpts for
every contradiction.

- [ ] **Step 4: Bind findings after response parsing**

When chapter 2+ is Vietnamese, check the transition contract. Exact substring
matches become standard host findings with current content hash and a bounded
combined excerpt. Remove bound transition claims from ordinary LLM findings to
avoid duplicates. Missing/invalid claims set `parseFailed=true`.

- [ ] **Step 5: Run focused Auditor tests**

```powershell
pnpm --filter @actalk/inkos-core test -- continuity.test.ts
```

Expected: all Continuity Auditor tests pass.

### Task 3: Route host findings through the deterministic gate

**Files:**
- Modify: `packages/core/src/pipeline/chapter-review-cycle.ts`
- Test: `packages/core/src/__tests__/chapter-review-cycle.test.ts`

- [ ] **Step 1: Merge host findings with deterministic findings**

Add `rawLlmAudit.hostFindings ?? []` beside Vietnamese surface, sensitive-word,
AI-tell, and post-write findings before `evaluateChapterAudit`.

- [ ] **Step 2: Preserve inconclusive safety**

Keep `parseFailed` behavior unchanged: no Reviser call is allowed when exact
transition binding failed.

- [ ] **Step 3: Run focused review tests**

```powershell
pnpm --filter @actalk/inkos-core test -- continuity.test.ts chapter-review-cycle.test.ts chapter-audit-evaluator.test.ts
```

Expected: all focused tests pass and the residual contradiction stays blocked.

### Task 4: Verify the complete repository

**Files:**
- Inspect only; do not mutate baseline or qualification books.

- [ ] **Step 1: Run full Core tests and typechecks**

```powershell
pnpm --filter @actalk/inkos-core test
pnpm --filter @actalk/inkos-core typecheck
pnpm --filter @actalk/inkos-studio typecheck
```

Expected: all commands exit 0.

- [ ] **Step 2: Build the Core distribution**

```powershell
pnpm --filter @actalk/inkos-core build
```

Expected: exit 0 so the temporary qualification runner imports the new code.

- [ ] **Step 3: Inspect diff and security scope**

```powershell
git diff --check
git diff --stat
git diff --name-only
```

Expected: no whitespace error, no book/baseline file, no credential, and no
unrelated dependency change. Gitleaks remains `limited` unless a project-local
scanner is already available; do not install one without approval.

### Task 5: Rework Phase B chapters 8 through 10 through InkOS

**Files:**
- Create: `C:\tmp\CodexScratch\2026-08-31-inkos-phase-b-length-1800\rework-phase-b-transition.mjs`
- Write evidence only under the same temporary task directory.

- [ ] **Step 1: Add a redacted recovery harness**

Instantiate `PipelineRunner` using the existing redacted qualification config.
Call `reviseDraft(bookId, 8, "auto", brief)` with a brief requiring a visible
08:40-to-late-morning transition and preserving the accepted physical state.
The explicit brief still forces execution, while `auto` routes verified host
blockers through the bounded production repair path.
Never store raw prompt, response, header, or credential values.

- [ ] **Step 2: Verify chapter 8 before touching chapter 9**

Require `auditDecision=pass`, 1,000-1,800 words, zero spelling/CJK/blockers,
and chapters 9-10 marked `needs-revision`. Because chapter 8 is historical,
live truth remains at chapter 10 until the latest chapter is accepted again.

- [ ] **Step 3: Rework chapter 9, then chapter 10**

Rework chapter 9 against accepted chapter 8, then require chapter 10 to remain
`needs-revision`. Rework chapter 10 against accepted chapter 9. Preserve 1.22m
unless the prose depicts a causal rise; preserve the NVRAM handoff and
van-sabotage discovery; keep every scene in the same late-morning timeline.

- [ ] **Step 4: Verify all ten canonical chapters**

Require chapters 1-10 exactly once, every accepted word count in 1,000-1,800,
audit score at least 85, zero chapter spelling/CJK/blockers, final manifest and
current state at 10, ten summaries, and no incomplete transaction directory.

- [ ] **Step 5: Stop rules**

Classify reasoning-only or transport failure as `BLOCKED_PROVIDER` and allow at
most one same-chapter provider resume after a successful health gate. Stop after
one failed quality revision; do not loop or manually edit the book.

### Task 6: Report without integrating

- [ ] Report the before/after transition evidence, word counts, scores, context
  sizes, provider outcomes, and final state alignment.
- [ ] Report the chapter-4 derived-summary typo separately as a non-chapter
  metadata defect; do not rewrite historical snapshots in this task.
- [ ] Do not commit, merge, promote, delete, or retain the qualification book
  without an explicit project-director command.
