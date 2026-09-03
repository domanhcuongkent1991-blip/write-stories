# Vietnamese Planner Legal Hook Action Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Vietnamese Planner memos from proposing a direct `resolve` for a deferred hook by exposing validator-derived legal actions without changing lifecycle enforcement or retry policy.

**Architecture:** Add one pure helper in the hook-operation contract module that normalizes a hook status and returns every action accepted by the existing validator, including the lower-level `mention` action. Refactor the validator to consume that helper, then let `formatRelevantThreads` optionally render only the three memo-ledger actions (`advance|resolve|defer`). `PlannerAgent` enables that option only when the book language is Vietnamese; Chinese and English prompt output stays byte-for-byte compatible.

**Tech Stack:** TypeScript, Zod schemas, Vitest, pnpm workspace scripts, direct Gitleaks binary.

---

### Task 1: Share the hook lifecycle action derivation

**Files:**
- Modify: `packages/core/src/models/hook-operation-intent.ts`
- Test: `packages/core/src/__tests__/hook-operation-intent.test.ts`

- [ ] **Step 1: Write failing tests for normalized status action sets**

Add the import and test to `hook-operation-intent.test.ts`:

```ts
import {
  getLegalHookActions,
} from "../models/hook-operation-intent.js";

it("derives legal actions from normalized hook status", () => {
  expect(getLegalHookActions({ status: "resolved" })).toEqual([]);
  expect(getLegalHookActions({ status: "paused" })).toEqual([
    "advance",
    "mention",
    "defer",
  ]);
  expect(getLegalHookActions({ status: "open" })).toEqual([
    "advance",
    "mention",
    "resolve",
    "defer",
  ]);
});
```

The `paused` assertion proves alias normalization (`paused` → `deferred`), and the `mention` entries prove the helper does not silently narrow existing low-level contract behavior.

- [ ] **Step 2: Run the focused test and verify it fails**

Run from `packages/core`:

```powershell
..\..\node_modules\.bin\vitest.cmd run src/__tests__/hook-operation-intent.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

Expected: FAIL because `getLegalHookActions` is not exported yet.

- [ ] **Step 3: Implement the pure helper and refactor validation**

In `hook-operation-intent.ts`, add this function immediately before `assertLegalHookTransition`:

```ts
export function getLegalHookActions(
  hook: Pick<StoredHook, "status">,
): ReadonlyArray<ExpectedHookOperationAction> {
  const status = normalizeStoredHookStatus(hook.status);
  if (status === "resolved") return [];
  if (status === "deferred") return ["advance", "mention", "defer"];
  return ["advance", "mention", "resolve", "defer"];
}
```

Replace the two independent status checks in `assertLegalHookTransition` with:

```ts
  const status = normalizeStoredHookStatus(hook.status);
  if (!getLegalHookActions(hook).includes(action)) {
    if (status === "resolved") {
      throw new HookOperationContractError(
        `illegal ${action} transition for resolved hook ${hook.hookId}`,
      );
    }
    throw new HookOperationContractError(
      `illegal resolve transition for deferred hook ${hook.hookId}`,
    );
  }
```

The helper is the only source of accepted actions; the error text remains unchanged for existing callers.

- [ ] **Step 4: Run contract and replay tests**

Run:

```powershell
..\..\node_modules\.bin\vitest.cmd run src/__tests__/hook-operation-intent.test.ts src/__tests__/promotion-replay-fixtures.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

Expected: PASS, including the existing offline `deferred -> resolve` reject-before-write replay.

- [ ] **Step 5: Commit the lifecycle contract change**

```powershell
git add packages/core/src/models/hook-operation-intent.ts packages/core/src/__tests__/hook-operation-intent.test.ts packages/core/src/__tests__/promotion-replay-fixtures.test.ts
git commit -m "fix(core): share legal hook action derivation"
```

### Task 2: Add Vietnamese-only Planner guidance

**Files:**
- Modify: `packages/core/src/agents/planner-context.ts`
- Modify: `packages/core/src/agents/planner.ts`
- Test: `packages/core/src/__tests__/planner-context.test.ts`
- Test: `packages/core/src/__tests__/planner.test.ts`

- [ ] **Step 1: Write failing formatting and wiring tests**

In `planner-context.test.ts`, import the new optional behavior through the existing `formatRelevantThreads` import and add:

```ts
it("renders validator-derived planner actions for deferred hooks when opted in", () => {
  const threads = formatRelevantThreads([
    {
      hookId: "H-deferred",
      startChapter: 1,
      type: "mystery",
      status: "paused",
      lastAdvancedChapter: 1,
      expectedPayoff: "the sealed room",
      notes: "keep the pressure alive",
    },
  ], "", "en", { includeAllowedActions: true });

  expect(threads).toContain("H-deferred");
  expect(threads).toContain("allowed_actions=advance|defer");
  expect(threads).not.toContain("allowed_actions=advance|resolve|defer");
});

it("does not add action guidance unless explicitly requested", () => {
  const threads = formatRelevantThreads([
    {
      hookId: "H-open",
      startChapter: 1,
      type: "mystery",
      status: "open",
      lastAdvancedChapter: 1,
      expectedPayoff: "the sealed room",
      notes: "",
    },
  ], "", "en");

  expect(threads).not.toContain("allowed_actions=");
});
```

In `planner.test.ts`, add this direct memo test. The `language: "en"` scaffold is intentional: production `book.language: "vi"` resolves to the English scaffold while the explicit opt-in flag carries the Vietnamese policy.

```ts
it("renders legal deferred-hook actions only when Vietnamese guidance is enabled", async () => {
  const deferredHook = {
    hookId: "H-deferred",
    startChapter: 1,
    type: "mystery",
    status: "deferred",
    lastAdvancedChapter: 1,
    expectedPayoff: "the sealed room",
    notes: "keep the pressure alive",
  } as const;
  const input = {
    storyDir: join(bookDir, "story"),
    bookDir,
    chapterNumber: 1,
    isGoldenOpening: true,
    fallbackGoal: "advance the sealed-room investigation",
    chapterSummariesRaw: "",
    relevantHooks: [deferredHook],
    lengthSpec: {
      target: 3000,
      softMin: 2700,
      softMax: 3300,
      hardMin: 2400,
      hardMax: 3600,
      countingMode: "zh_chars" as const,
    },
    language: "en" as const,
  };
  const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
    content: validMemoRaw(1),
    usage: ZERO_USAGE,
  } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

  await makePlanner().planChapterMemo({
    ...input,
    includeAllowedHookActions: true,
  });
  const guidedMessages = chatSpy.mock.calls[0]![2] as ReadonlyArray<{ role: string; content: string }>;
  expect(guidedMessages.find((message) => message.role === "user")?.content)
    .toContain("allowed_actions=advance|defer");
  expect(guidedMessages.find((message) => message.role === "user")?.content)
    .not.toContain("allowed_actions=advance|resolve|defer");

  chatSpy.mockClear();
  await makePlanner().planChapterMemo(input);
  const legacyMessages = chatSpy.mock.calls[0]![2] as ReadonlyArray<{ role: string; content: string }>;
  expect(legacyMessages.find((message) => message.role === "user")?.content)
    .not.toContain("allowed_actions=");
});
```

- [ ] **Step 2: Run the focused Planner tests and verify they fail**

Run from `packages/core`:

```powershell
..\..\node_modules\.bin\vitest.cmd run src/__tests__/planner-context.test.ts src/__tests__/planner.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

Expected: FAIL because the formatter has no options parameter and the Planner input has no opt-in field.

- [ ] **Step 3: Implement opt-in guidance without changing default prompts**

In `planner-context.ts`, import `getLegalHookActions` and add the fourth parameter:

```ts
export function formatRelevantThreads(
  hooks: ReadonlyArray<StoredHook>,
  subplotBoardRaw: string,
  language: ScaffoldLanguage = "zh",
  options: { readonly includeAllowedActions?: boolean } = {},
): string {
  const hookRows = hooks.map((hook) => {
    const base = [hook.type, hook.status, hook.expectedPayoff, hook.payoffTiming, hook.notes]
      .filter(Boolean)
      .join(" | ");
    if (!options.includeAllowedActions) return `- ${hook.hookId}: ${base}`;
    const allowedActions = getLegalHookActions(hook)
      .filter((action) => action !== "mention")
      .join("|") || "none";
    return `- ${hook.hookId}: ${base} | allowed_actions=${allowedActions}`;
  });
```

Keep the existing subplot/empty-result code unchanged below that block. The filter removes `mention` only from the Planner-facing ledger guidance; the shared helper and validator still retain it.

In both `planChapterMemo` and the private `planChapterMemoWithUsage` input types, add:

```ts
readonly includeAllowedHookActions?: boolean;
```

When building the user message, call:

```ts
relevantThreads: formatRelevantThreads(
  input.relevantHooks ?? [],
  subplotBoard,
  language,
  { includeAllowedActions: input.includeAllowedHookActions === true },
),
```

In `planChapter`, set the field on `memoInput` as:

```ts
includeAllowedHookActions: writingLanguage === "vi",
```

No retry branch, parser rule, validator rule, provider adapter, or non-Vietnamese call site changes.

- [ ] **Step 4: Run the focused Planner tests**

Run the same Vitest command from Step 2. Expected: PASS, including all existing Chinese/English prompt tests and the new opt-in assertions.

- [ ] **Step 5: Commit the Planner guidance change**

```powershell
git add packages/core/src/agents/planner-context.ts packages/core/src/agents/planner.ts packages/core/src/__tests__/planner-context.test.ts packages/core/src/__tests__/planner.test.ts
git commit -m "fix(core): guide Vietnamese planner hook actions"
```

### Task 3: Full verification and bounded live canary

**Files:**
- No source changes expected.
- Evidence output: `C:\Users\Admin\Documents\Codex\InkOS\promotion-evidence\2026-09-02-new-candidate-sha-stream-zpro-gpt55-02` (replace `new-candidate-sha` with the exact commit SHA before execution)

- [ ] **Step 1: Run Core verification sequentially**

From `packages/core`, run each command separately with one worker:

```powershell
pnpm test -- --maxWorkers=1 --minWorkers=1 --no-file-parallelism
pnpm run typecheck
pnpm run build
```

Expected: all Core tests pass, TypeScript exits 0, and build emits `dist` successfully.

- [ ] **Step 2: Check the diff and scan staged content**

From the worktree root:

```powershell
git diff --check
git status --short --branch
git diff HEAD~2..HEAD --stat
git diff HEAD~2..HEAD --name-only
.codex\tools\bin\gitleaks.exe git --staged --redact --no-banner --exit-code 1
```

Expected: only the two intentional commits’ source/tests/docs are listed; the pre-existing untracked `.codex/` and `osv-*.json` files remain unstaged; Gitleaks reports no leaks. Do not run OSV because this change does not modify manifests or lockfiles.

- [ ] **Step 3: Run the new Zpro canary with the exact candidate SHA**

Use the already-authorized, self-limiting API key through the runner’s ephemeral environment variable; never write it to a file, prompt, output, or evidence. Use namespace `zpro-gpt55-02`, model `gpt-5.5`, stream mode, and target chapter 1 with the runner’s existing cumulative budget of 25. Confirm the runner reports the exact new SHA, provider `zpro`, model `gpt-5.5`, and no chapter/evidence write before success.

Expected: either a clean chapter-1 canary with evidence under the new namespace, or a fail-fast evidence record that preserves chapter-zero state. Do not reuse `zpro-gpt55-01`, do not retry inside the same failed namespace, and do not start chapters 3/8/15 until the owner approves a sufficient cumulative request budget after the canary result.

- [ ] **Step 4: Report the checkpoint**

Include the two commit SHAs, focused/full verification results, exact candidate SHA, evidence namespace path, request count reported by the runner, and whether the canary passed. Redact all credentials and do not claim Promotion from a chapter-1 canary alone.
