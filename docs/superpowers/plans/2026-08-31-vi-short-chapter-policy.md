# Vietnamese Short-Chapter Policy Implementation Plan

> **Superseded:** Do not execute this former 1,500-word plan. Use
> `2026-08-31-inkos-vi-phase-b-safe-canary.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Vietnamese 1,150-token chapter policy with a 1,000–1,300 preferred range, warning-only overflow up to a technical safety ceiling, deterministic surface lint, and regression coverage.

**Architecture:** Keep the existing `LengthSpec` shape and persistence schemas. Make the Vietnamese default profile resolve to an explicit asymmetric policy through `buildLengthSpec`, teach the audit evaluator to distinguish preferred overflow from blocking underflow/safety overflow, and add an isolated Vietnamese surface validator that is composed into `WriterAgent` without changing Chinese/English validators.

**Tech Stack:** TypeScript, Zod schemas, Vitest, existing InkOS core pipeline and atomic persistence.

---

### Task 1: Lock the Vietnamese length policy in the length utility

**Files:**
- Modify: `packages/core/src/utils/language.ts`
- Modify: `packages/core/src/utils/length-metrics.ts`
- Test: `packages/core/src/__tests__/length-metrics.test.ts`
- Test: `packages/core/src/__tests__/writing-language-preflight.test.ts`

- [ ] **Step 1: Add failing policy assertions**

Assert that the Vietnamese profile default is `1150`, and `buildLengthSpec(1150, "vi")` returns `softMin=1000`, `softMax=1300`, `hardMin=1000`, `hardMax=1500`, and `countingMode="vi_wordlike_tokens_v1"`.

- [ ] **Step 2: Run the focused tests and verify failure**

Run from `D:\InkOS\write-stories-vi-1.8.0`:

```powershell
pnpm exec vitest run packages/core/src/__tests__/length-metrics.test.ts packages/core/src/__tests__/writing-language-preflight.test.ts
```

Expected: FAIL because the current Vietnamese default is 2,000 and the generic scaled range is still used.

- [ ] **Step 3: Implement the explicit Vietnamese default**

Set the Vietnamese profile default chapter length to `1150`. In `buildLengthSpec`, preserve the current generic calculation for `zh`, `en`, and custom Vietnamese targets, but return the approved explicit bounds when `language === "vi" && target === 1150`:

```ts
if (language === "vi" && target === 1150) {
  return {
    target,
    softMin: 1000,
    softMax: 1300,
    hardMin: 1000,
    hardMax: 1500,
    countingMode: "vi_wordlike_tokens_v1",
  };
}
```

- [ ] **Step 4: Run the focused tests and verify pass**

Run the same Vitest command. Expected: PASS with existing non-Vietnamese assertions unchanged.

- [ ] **Step 5: Commit the isolated policy change**

```powershell
git add packages/core/src/utils/language.ts packages/core/src/utils/length-metrics.ts packages/core/src/__tests__/length-metrics.test.ts packages/core/src/__tests__/writing-language-preflight.test.ts
git commit -m "feat: define Vietnamese short chapter length policy"
```

### Task 2: Make audit semantics warning-only above the preferred Vietnamese range

**Files:**
- Modify: `packages/core/src/audit/chapter-audit-evaluator.ts`
- Modify: `packages/core/src/pipeline/runner.ts`
- Test: `packages/core/src/__tests__/chapter-audit-evaluator.test.ts`
- Test: `packages/core/src/__tests__/pipeline-runner.test.ts`

- [ ] **Step 1: Add evaluator tests for all three ranges**

Cover a Vietnamese `LengthSpec` with content counts representing 1,150, 1,350, 950, and 1,550 tokens. Assert the first has no deterministic length finding, the second has a warning-only `length.soft-range` finding, and the last two have a verified critical `length.hard-range` finding.

- [ ] **Step 2: Run the focused evaluator tests and verify failure**

```powershell
pnpm exec vitest run packages/core/src/__tests__/chapter-audit-evaluator.test.ts
```

Expected: FAIL because the current evaluator treats every hard-range overflow identically and does not emit a preferred-range warning.

- [ ] **Step 3: Implement language-aware length findings**

In `evaluateChapterAudit`, retain current behavior for non-Vietnamese specs. For `vi_wordlike_tokens_v1`, add a deterministic warning when `count > softMax && count <= hardMax`; retain the critical hard-range finding when `count < hardMin || count > hardMax`. Use rule IDs `length.soft-range` and `length.hard-range` so findings remain stable and auditable.

- [ ] **Step 4: Align production-run length warnings**

Update `buildLengthWarnings` so Vietnamese uses the preferred range for warning text, while Chinese/English continue using their existing hard-range behavior. Do not change the persisted `AuditRunV1` shape.

- [ ] **Step 5: Run focused tests and verify pass**

```powershell
pnpm exec vitest run packages/core/src/__tests__/chapter-audit-evaluator.test.ts packages/core/src/__tests__/pipeline-runner.test.ts
```

Expected: PASS, including all existing non-Vietnamese length tests.

- [ ] **Step 6: Commit the audit semantics change**

```powershell
git add packages/core/src/audit/chapter-audit-evaluator.ts packages/core/src/pipeline/runner.ts packages/core/src/__tests__/chapter-audit-evaluator.test.ts packages/core/src/__tests__/pipeline-runner.test.ts
git commit -m "feat: warn on Vietnamese preferred length overflow"
```

### Task 3: Add deterministic Vietnamese surface lint

**Files:**
- Create: `packages/core/src/agents/vietnamese-surface-validator.ts`
- Modify: `packages/core/src/agents/writer.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/vietnamese-surface-validator.test.ts`

- [ ] **Step 1: Write failing surface-lint tests**

Test that `validateVietnameseSurface` returns an `error` with rule `vi-cjk-leak` for CJK text, and warnings for unbalanced delimiters, repeated spaces, repeated punctuation, and leaked `[writer-note]` lines. A clean Vietnamese paragraph must return `[]`.

- [ ] **Step 2: Run the focused test and verify failure**

```powershell
pnpm exec vitest run packages/core/src/__tests__/vietnamese-surface-validator.test.ts
```

Expected: FAIL because the validator file does not exist.

- [ ] **Step 3: Implement the isolated validator**

Export `validateVietnameseSurface(content: string): ReadonlyArray<PostWriteViolation>`. Emit an `error` for CJK or agent-note leakage and `warning` findings for delimiter imbalance, repeated whitespace, or repeated punctuation. Keep the validator zero-LLM and avoid dictionary guesses that could reject valid names or loanwords.

- [ ] **Step 4: Compose it only for Vietnamese writes**

In `WriterAgent.writeChapter`, import the validator and append its findings to `ruleViolations` only when `writingLanguage === "vi"`. Chinese and English execution paths must remain unchanged.

- [ ] **Step 5: Export and run tests**

Export the validator from `packages/core/src/index.ts`, then run:

```powershell
pnpm exec vitest run packages/core/src/__tests__/vietnamese-surface-validator.test.ts packages/core/src/__tests__/writer.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the surface-lint change**

```powershell
git add packages/core/src/agents/vietnamese-surface-validator.ts packages/core/src/agents/writer.ts packages/core/src/index.ts packages/core/src/__tests__/vietnamese-surface-validator.test.ts
git commit -m "feat: add Vietnamese surface quality lint"
```

### Task 4: Verify the complete offline regression surface

**Files:** None beyond the preceding tasks.

- [ ] **Step 1: Run core typecheck**

```powershell
pnpm --filter @inkos/core run typecheck
```

Expected: exit code 0.

- [ ] **Step 2: Run the full core test suite**

```powershell
pnpm --filter @inkos/core test -- --run
```

Expected: all tests pass.

- [ ] **Step 3: Run repository diff and secret checks**

```powershell
git diff --check
gitleaks detect --source . --no-banner --redact
```

Expected: no whitespace errors. Any pre-existing generic-api-key fixture detections must be reported without exposing values and must not be silently reclassified.

- [ ] **Step 4: Commit the verified documentation**

```powershell
git add docs/superpowers/specs/2026-08-31-vi-short-chapter-policy-design.md docs/superpowers/plans/2026-08-31-vi-short-chapter-policy.md
git commit -m "docs: specify Vietnamese short chapter qualification"
```

### Task 5: Run a fresh Ecoapi qualification book

**Files:** New sandbox book under `C:\Users\Admin\Documents\Codex\InkOS\vi-writing-sandbox`; no stable repository files.

- [ ] **Step 1: Create a fresh Vietnamese qualification book with target 1,150**

Use the existing Studio/API qualification flow with `language=vi`, `chapterWordCount=1150`, the already validated Ecoapi service/model, and no failover.

- [ ] **Step 2: Write chapters sequentially**

After each chapter, capture final word-like count, all token telemetry, audit decision/findings, continuity/hook state, surface-lint findings, operation identity, and transaction-directory count.

- [ ] **Step 3: Apply the acceptance rule per chapter**

Continue after an upper-range warning only when there is no verified critical continuity/language/state issue and persistence is terminal. Stop on reasoning-only output, lower-bound failure, safety-ceiling failure, incomplete transaction, or duplicate-write evidence.

- [ ] **Step 4: Produce a comparison report**

Compare the new 1,150-target run with the historical 2,000-target baseline: chapter length, prompt/total token growth, continuity findings, surface findings, provider finish reasons, and completion stability. Do not modify the baseline book.
