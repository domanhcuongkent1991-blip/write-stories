# Vietnamese Writer Prompt Length Guidance Implementation Plan

> **Superseded:** Do not execute this former 1,500-word plan. Use
> `2026-08-31-inkos-vi-phase-b-safe-canary.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Vietnamese writer and reviser prompts target 1,100–1,300 word-like tokens while preserving the approved 1,000–1,500 audit policy and existing safety gates.

**Architecture:** Keep `LengthSpec` and audit semantics unchanged. Add one shared formatter in the length utility for the Vietnamese generation target, render it in writer system/user/output prompts and reviser guidance, and verify prompt precedence and audit boundaries with tests. No truncation, provider retry, schema change, or baseline mutation is introduced.

**Tech Stack:** TypeScript, Vitest, existing InkOS writer/reviser pipeline, `vi_wordlike_tokens_v1` counting.

---

### Task 1: Add the shared Vietnamese writer-target formatter

**Files:**
- Modify: `packages/core/src/utils/length-metrics.ts`
- Test: `packages/core/src/__tests__/length-metrics.test.ts`

- [ ] **Step 1: Write failing tests**

Use `buildLengthSpec(1150, "vi")` and assert the new formatter contains `1100-1300`, `vi_wordlike_tokens_v1`, and `1000-1500`. Assert a Chinese spec returns no Vietnamese override so its existing local prompt formatter remains in control.

- [ ] **Step 2: Verify red**

```powershell
pnpm --filter @actalk/inkos-core run test -- src/__tests__/length-metrics.test.ts
```

Expected: FAIL because `formatWriterPromptLengthGuidance` is absent.

- [ ] **Step 3: Implement the smallest shared helper**

Add `formatWriterPromptLengthGuidance(spec, language): string | undefined`. For `language === "vi"`, `spec.target === 1150`, and `spec.countingMode === "vi_wordlike_tokens_v1"`, return explicit instructions: count only `CHAPTER_CONTENT`; target 1,150; aim for 1,100–1,300; stop before 1,300 without filler; use this writing target over stale memo/context ranges; retain audit safety 1,000–1,500, where 1,301–1,500 warns and values outside 1,000–1,500 block. Return `undefined` for all other specs so each existing language-specific prompt formatter remains unchanged.

- [ ] **Step 4: Verify green**

Run the command in Step 2; all length-metrics tests must pass.

- [ ] **Step 5: Commit**

```powershell
git add packages/core/src/utils/length-metrics.ts packages/core/src/__tests__/length-metrics.test.ts
git commit -m "feat: add Vietnamese writer length guidance formatter"
```

### Task 2: Inject the target into writer prompts

**Files:**
- Modify: `packages/core/src/agents/writer-prompts.ts`
- Modify: `packages/core/src/agents/writer.ts`
- Test: `packages/core/src/__tests__/writer-prompts.test.ts`
- Test: `packages/core/src/__tests__/writer.test.ts`

- [ ] **Step 1: Write failing prompt tests**

Build a governed Vietnamese writer prompt with `buildLengthSpec(1150, "vi")`. Assert system, user, and `CHAPTER_CONTENT` text contains `1100-1300`, `vi_wordlike_tokens_v1`, and wording that the prompt target overrides stale memo/context ranges.

- [ ] **Step 2: Verify red**

```powershell
pnpm --filter @actalk/inkos-core run test -- src/__tests__/writer-prompts.test.ts src/__tests__/writer.test.ts
```

Expected: FAIL because the current prompt only renders the generic preferred range.

- [ ] **Step 3: Implement prompt injection**

Import the helper into `writer-prompts.ts` and render it immediately after `buildChapterMemoContract`. In `writer.ts`, use the same helper in `buildLengthRequirementBlock`. Update Vietnamese output-format text next to `CHAPTER_CONTENT` to say `mục tiêu viết 1100-1300 từ` and retain `audit safety range 1000-1500` as a separate note. Leave Chinese/English text unchanged.

- [ ] **Step 4: Verify green**

Run the command in Step 2; all prompt and writer tests must pass.

- [ ] **Step 5: Commit**

```powershell
git add packages/core/src/agents/writer-prompts.ts packages/core/src/agents/writer.ts packages/core/src/__tests__/writer-prompts.test.ts packages/core/src/__tests__/writer.test.ts
git commit -m "feat: guide Vietnamese writer toward shorter chapters"
```

### Task 3: Align reviser generation guidance

**Files:**
- Modify: `packages/core/src/agents/reviser.ts`
- Test: `packages/core/src/__tests__/reviser.test.ts`

- [ ] **Step 1: Write failing reviser test**

Call `reviseChapter` with `lengthSpec: buildLengthSpec(1150, "vi")` and assert the combined prompt contains `1100-1300`, `vi_wordlike_tokens_v1`, and unchanged hard safety range `1000-1500`.

- [ ] **Step 2: Verify red**

```powershell
pnpm --filter @actalk/inkos-core run test -- src/__tests__/reviser.test.ts
```

Expected: FAIL because the Vietnamese reviser currently exposes only the hard range.

- [ ] **Step 3: Implement minimal alignment**

When the spec is the Vietnamese 1,150-token profile, append the shared writer-target guidance after the existing hard structural repair instruction in `buildAutoSystemPrompt`, and include it in the user prompt for every reviser mode (including `auto`). Keep `hardMin=1000` and `hardMax=1500` visible so candidate acceptance remains unchanged.

- [ ] **Step 4: Verify green and commit**

```powershell
pnpm --filter @actalk/inkos-core run test -- src/__tests__/reviser.test.ts
git add packages/core/src/agents/reviser.ts packages/core/src/__tests__/reviser.test.ts
git commit -m "feat: guide Vietnamese revisions toward target range"
```

### Task 4: Run compatibility and full regression checks

**Files:** No further production files; update `packages/core/src/__tests__/chapter-review-cycle.test.ts` only if a missing boundary assertion is discovered.

- [ ] **Step 1: Run focused governance tests**

```powershell
pnpm --filter @actalk/inkos-core run test -- src/__tests__/length-metrics.test.ts src/__tests__/writer-prompts.test.ts src/__tests__/writer.test.ts src/__tests__/reviser.test.ts src/__tests__/chapter-review-cycle.test.ts src/__tests__/pipeline-runner.test.ts
```

Expected: 1,301–1,500 remains warning-only; below 1,000 and above 1,500 remains blocking; non-Vietnamese tests remain unchanged.

- [ ] **Step 2: Run typecheck and build**

```powershell
pnpm --filter @actalk/inkos-core run typecheck
pnpm --filter @actalk/inkos-core run build
```

Expected: exit code 0 for both commands.

- [ ] **Step 3: Run the full Core suite**

```powershell
pnpm --filter @actalk/inkos-core run test
```

Expected: every Core test file passes.

- [ ] **Step 4: Verify repository scope**

```powershell
git diff --check
git status --short
git log -5 --oneline
```

Expected: no whitespace errors and no qualification/baseline book changes.

- [ ] **Step 5: Commit a test-only boundary adjustment if required**

```powershell
git add packages/core/src/__tests__/chapter-review-cycle.test.ts
git commit -m "test: lock Vietnamese prompt range compatibility"
```
