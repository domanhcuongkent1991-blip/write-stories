# Redacted Provider Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded, content-free provider response diagnostics that explain protocol and semantic-output failures without changing routing or story contracts.

**Architecture:** A focused diagnostics module builds immutable redacted observations from final LLM responses or normalized errors. `createLLMClient` accepts an optional runtime-only observer, while the existing transport adds only non-secret wire-shape metadata to `LLMResponse`; qualification records those observations beside existing request telemetry.

**Tech Stack:** TypeScript, Node.js, Vitest, native Fetch/SSE parsing, existing InkOS qualification runner, project-local Gitleaks.

---

## File map

- Create `packages/core/src/llm/provider-diagnostics.ts`: redacted diagnostic types, buckets, marker checks, and safe observer emission.
- Create `packages/core/src/__tests__/provider-diagnostics.test.ts`: pure redaction, immutability, marker, result, and error tests.
- Modify `packages/core/src/llm/provider.ts`: runtime observer attachment, redacted wire-shape extraction, and final result/error emission.
- Modify `packages/core/src/index.ts`: public exports for diagnostic types and runtime options.
- Modify `packages/core/src/__tests__/provider.test.ts`: custom OpenAI-compatible stream/non-stream observer integration tests.
- Modify `qualification/promotion-runner-scope.mjs`: qualification-specific recorder that attaches the current stage without accepting raw content.
- Modify `qualification/promotion-runner-scope.test.mjs`: recorder redaction and stage tests.
- Modify `qualification/promotion-runner.mjs`: persist `providerDiagnostics` and attach the observer to qualification clients.

### Task 1: Pure redacted diagnostics contract

**Files:**
- Create: `packages/core/src/llm/provider-diagnostics.ts`
- Test: `packages/core/src/__tests__/provider-diagnostics.test.ts`

- [ ] **Step 1: Write failing diagnostics tests**

Create tests that construct a final response containing secret-looking raw content, then assert the returned observation has no `content`, `messages`, `headers`, `apiKey`, `rawResponse`, or `errorMessage` properties.

```ts
import { describe, expect, it, vi } from "vitest";
import {
  buildProviderDiagnosticObservation,
  emitProviderDiagnostic,
  type ProviderDiagnosticObserver,
} from "../llm/provider-diagnostics.js";

describe("provider diagnostics", () => {
  it("records only redacted shape and configured marker presence", () => {
    const observation = buildProviderDiagnosticObservation({
      service: "custom:Fixture",
      requestedModel: "fixture-model",
      apiFormat: "chat",
      stream: true,
      durationMs: 1234,
      markers: ["CHAPTER_CONTENT", "RUNTIME_STATE_DELTA"],
      response: {
        content: "secret prose === CHAPTER_CONTENT === body",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: "stop",
        providerMetadata: {
          returnedModel: "wire-model",
          systemFingerprint: "fp-fixture",
          contentFieldPresent: true,
          reasoningFieldPresent: false,
          refusalFieldPresent: false,
          toolFieldPresent: false,
        },
      },
    });

    expect(observation).toMatchObject({
      schemaVersion: 1,
      outcome: "final-answer",
      contentLengthBucket: "1-1k",
      markerPresence: { CHAPTER_CONTENT: true, RUNTIME_STATE_DELTA: false },
      returnedModel: "wire-model",
      systemFingerprint: "fp-fixture",
    });
    expect(JSON.stringify(observation)).not.toContain("secret prose");
    for (const forbidden of ["content", "messages", "headers", "apiKey", "rawResponse", "errorMessage"]) {
      expect(observation).not.toHaveProperty(forbidden);
    }
  });

  it("swallows observer failures so diagnostics cannot break writing", () => {
    const observer: ProviderDiagnosticObserver = { observe: vi.fn(() => { throw new Error("observer failed"); }) };
    expect(() => emitProviderDiagnostic(observer, { schemaVersion: 1 } as never)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx vitest run packages/core/src/__tests__/provider-diagnostics.test.ts
```

Expected: FAIL because `provider-diagnostics.ts` does not exist.

- [ ] **Step 3: Implement the pure contract**

Define:

```ts
export type ProviderDiagnosticOutcome =
  | "final-answer"
  | "empty-final"
  | "reasoning-without-final"
  | "incomplete"
  | "policy-block"
  | "provider-error";

export type ContentLengthBucket = "0" | "1-1k" | "1k-10k" | "10k-100k" | "100k+";
export type DurationBucket = "<1s" | "1-5s" | "5-30s" | "30-120s" | "120s+";

export interface ProviderResponseMetadata {
  readonly returnedModel?: string;
  readonly systemFingerprint?: string;
  readonly contentFieldPresent: boolean;
  readonly reasoningFieldPresent: boolean;
  readonly refusalFieldPresent: boolean;
  readonly toolFieldPresent: boolean;
}

export interface ProviderDiagnosticObservation {
  readonly schemaVersion: 1;
  readonly service: string | null;
  readonly requestedModel: string;
  readonly returnedModel?: string;
  readonly systemFingerprint?: string;
  readonly apiFormat: "chat" | "responses";
  readonly stream: boolean;
  readonly outcome: ProviderDiagnosticOutcome;
  readonly finishReason: string | null;
  readonly contentLengthBucket: ContentLengthBucket;
  readonly durationBucket: DurationBucket;
  readonly contentFieldPresent: boolean;
  readonly reasoningFieldPresent: boolean;
  readonly refusalFieldPresent: boolean;
  readonly toolFieldPresent: boolean;
  readonly markerPresence: Readonly<Record<string, boolean>>;
  readonly errorClass: string | null;
  readonly errorCode: string | null;
  readonly httpStatus: number | null;
}

export interface ProviderDiagnosticObserver {
  readonly markers?: ReadonlyArray<string>;
  readonly observe: (observation: ProviderDiagnosticObservation) => void;
}
```

Implement pure bucket helpers, exact `=== MARKER ===` line detection with escaped marker names, `buildProviderDiagnosticObservation`, `buildProviderErrorDiagnosticObservation`, and `emitProviderDiagnostic`. Freeze the observation and nested marker map. `emitProviderDiagnostic` must catch observer exceptions.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same Vitest command. Expected: all diagnostics tests PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add packages/core/src/llm/provider-diagnostics.ts packages/core/src/__tests__/provider-diagnostics.test.ts
git commit -m "feat(core): define redacted provider diagnostics"
```

### Task 2: Attach diagnostics to the provider boundary

**Files:**
- Modify: `packages/core/src/llm/provider.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/__tests__/provider.test.ts`

- [ ] **Step 1: Add failing stream and non-stream integration tests**

Mock OpenAI-compatible responses that include `model`, `system_fingerprint`, content/reasoning/refusal/tool fields, and sentinel raw text. Create the client with:

```ts
const observations: ProviderDiagnosticObservation[] = [];
const client = createLLMClient(config, {
  diagnostics: {
    markers: ["CHAPTER_CONTENT"],
    observe: (observation) => observations.push(observation),
  },
});
```

Assert one final observation per `chatCompletion` call, correct stream mode and field-presence booleans, marker presence, returned model/fingerprint, and absence of sentinel text. Add an error test that asserts normalized class/code/status and no provider error body.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
npx vitest run packages/core/src/__tests__/provider-diagnostics.test.ts packages/core/src/__tests__/provider.test.ts
```

Expected: new provider integration tests FAIL because `createLLMClient` has no runtime diagnostics option.

- [ ] **Step 3: Extend response and client types**

In `provider.ts`:

```ts
export interface LLMResponse {
  readonly content: string;
  readonly usage: { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number };
  readonly providerMetadata?: ProviderResponseMetadata;
  // Preserve every existing optional field unchanged.
}

export interface LLMClientRuntimeOptions {
  readonly diagnostics?: ProviderDiagnosticObserver;
}

export interface LLMClient {
  // Preserve existing public fields.
  readonly _diagnostics?: ProviderDiagnosticObserver;
}

export function createLLMClient(config: LLMConfig, runtime: LLMClientRuntimeOptions = {}): LLMClient {
  // Preserve existing resolution and include `_diagnostics: runtime.diagnostics` only when supplied.
}
```

Extend `createLLMResponse` metadata with `providerMetadata` and copy only the already-redacted shape object.

- [ ] **Step 4: Extract redacted wire shape**

For custom OpenAI-compatible chat non-stream responses, derive:

```ts
const message = json?.choices?.[0]?.message;
const providerMetadata: ProviderResponseMetadata = {
  ...(nonEmptyString(json?.model) ? { returnedModel: nonEmptyString(json.model) } : {}),
  ...(nonEmptyString(json?.system_fingerprint) ? { systemFingerprint: nonEmptyString(json.system_fingerprint) } : {}),
  contentFieldPresent: message?.content !== undefined && message?.content !== null,
  reasoningFieldPresent: message?.reasoning_content !== undefined || message?.reasoning !== undefined,
  refusalFieldPresent: message?.refusal !== undefined && message?.refusal !== null,
  toolFieldPresent: Array.isArray(message?.tool_calls) && message.tool_calls.length > 0,
};
```

For stream responses, accumulate the same booleans and first non-empty returned model/fingerprint from chunks. Do not retain chunk objects after parsing.

- [ ] **Step 5: Emit once from `chatCompletion`**

Measure the full bounded call. After retries finish, add retry counts, build a final observation from response metadata, and safely emit it. In the catch path, normalize the error first, then emit only error class/code/status and rethrow the same normalized error.

Stub mode must also emit a final observation with no provider metadata so test and offline behavior are consistent.

- [ ] **Step 6: Export diagnostics API**

Export diagnostic types/builders and `LLMClientRuntimeOptions` from `packages/core/src/index.ts` without exporting any secret-bearing internal helper.

- [ ] **Step 7: Run focused and provider regression tests**

Run:

```powershell
npx vitest run packages/core/src/__tests__/provider-diagnostics.test.ts packages/core/src/__tests__/provider.test.ts packages/core/src/__tests__/phase-a-internal-routing.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 8: Commit Task 2**

```powershell
git add packages/core/src/llm/provider.ts packages/core/src/index.ts packages/core/src/__tests__/provider.test.ts
git commit -m "feat(core): observe redacted provider responses"
```

### Task 3: Persist diagnostics in qualification evidence

**Files:**
- Modify: `qualification/promotion-runner-scope.mjs`
- Modify: `qualification/promotion-runner-scope.test.mjs`
- Modify: `qualification/promotion-runner.mjs`

- [ ] **Step 1: Write failing qualification recorder tests**

Add tests for:

```js
const target = [];
let stage = "health-chat-stream";
const observer = createQualificationProviderDiagnosticObserver(target, () => stage);
observer.observe(Object.freeze({ schemaVersion: 1, requestedModel: "fixture", markerPresence: {} }));
assert.deepEqual(target, [{ stage: "health-chat-stream", schemaVersion: 1, requestedModel: "fixture", markerPresence: {} }]);
assert.throws(() => createQualificationProviderDiagnosticObserver({}, () => "stage"));
```

Also assert the observer exposes only the allowlisted markers `PRE_WRITE_CHECK`, `CHAPTER_TITLE`, `CHAPTER_CONTENT`, `RUNTIME_STATE_DELTA`, and `POST_SETTLEMENT`.

- [ ] **Step 2: Run scope tests and verify RED**

Run:

```powershell
node --test qualification/promotion-runner-scope.test.mjs
```

Expected: FAIL because the recorder does not exist.

- [ ] **Step 3: Implement the recorder**

Export `createQualificationProviderDiagnosticObserver(target, readStage)` from the scope module. It must validate `target` and `readStage`, shallow-copy the immutable observation plus the current stage, freeze the stored record, and never accept content/messages/headers parameters.

- [ ] **Step 4: Attach it to qualification clients**

Initialize `safe.providerDiagnostics = []`. Create one recorder after `currentStage` is declared. Pass `{ diagnostics: recorder }` as the second argument to every qualification `createLLMClient` call used by story execution. Health probes keep their existing compact telemetry and do not duplicate observations.

Persist these diagnostics in the existing immutable evidence file. Do not print diagnostic arrays to stdout.

- [ ] **Step 5: Run qualification and core focused tests**

Run:

```powershell
node --test qualification/promotion-runner-scope.test.mjs qualification/candidate-config.test.mjs
npx vitest run packages/core/src/__tests__/provider-diagnostics.test.ts packages/core/src/__tests__/provider.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit Task 3**

```powershell
git add qualification/promotion-runner-scope.mjs qualification/promotion-runner-scope.test.mjs qualification/promotion-runner.mjs
git commit -m "feat(qualification): persist redacted provider diagnostics"
```

### Task 4: Verification and security gate

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run related regression suites**

```powershell
npx vitest run packages/core/src/__tests__/provider-diagnostics.test.ts packages/core/src/__tests__/provider.test.ts packages/core/src/__tests__/phase-a-internal-routing.test.ts packages/core/src/__tests__/writer-parser.test.ts packages/core/src/__tests__/writer.test.ts
node --test qualification/promotion-runner-scope.test.mjs qualification/candidate-config.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run Core typecheck and build**

```powershell
npm run typecheck
npm run build
```

Expected: both commands exit 0.

- [ ] **Step 3: Run repository checks**

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors and only intentional plan-tracking state, if any.

- [ ] **Step 4: Run project-local staged secret scan before each remaining commit**

```powershell
.\.codex\tools\bin\gitleaks.exe git --staged --redact --no-banner .
```

Expected: no leaks found. Do not print or compare API-key values.

- [ ] **Step 5: Perform one offline fake/provider test only**

Run the existing fake and mocked provider suites. Do not call Ecoapi, Zpro, or another live provider in this task.

- [ ] **Step 6: Record the new candidate SHA and stop for review**

Report the commits, exact tests, candidate SHA, and any diagnostic coverage limitations. Live canary is a separate authorized step after review.
