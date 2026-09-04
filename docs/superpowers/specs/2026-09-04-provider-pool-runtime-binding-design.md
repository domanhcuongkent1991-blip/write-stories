# Provider Pool and Runtime Binding Design

Status: proposed for implementation
Date: 2026-09-04
Target branch: `main`
Current candidate before implementation: `75a66f8c9d24589ad2ad7fd743779bb5343a4c9d`

## 1. Goal

Allow InkOS to use and evaluate multiple configured provider/model pairs without weakening story contracts, mixing runtimes inside one chapter attempt, or compromising checkpoint recovery.

The design follows this priority order:

1. Stability.
2. Correctness.
3. Recovery.
4. Testability.
5. Maintainability.
6. Runtime portability.

InkOS already supports provider presets, multiple custom services, per-service secrets, live model discovery, model selection, and a common LLM client. This work adds a thin routing and evidence layer over those existing capabilities. It does not create a second provider registry.

## 2. Confirmed decisions

- Multiple providers may be configured in Studio and used in live evaluation.
- One chapter attempt is bound to exactly one service, model, endpoint identity, API format, and stream mode.
- A provider cannot change between Planner, Writer, Settler, Auditor, or repair work inside the same attempt.
- A failed attempt may move to another provider only after the old attempt is closed and canonical state is proven unchanged.
- Failover reruns the whole chapter from the last clean checkpoint. Planner memos, partial prose, settlement output, and audit output from the failed provider are not reused.
- Writer, Planner, settlement, language, length, and audit contracts remain fail closed.
- Evaluation rotation is deterministic, never random.
- Credentials remain in the existing per-service secret store and never enter source, runtime evidence, prompts, logs, command history, or provider fingerprints.
- Provider/model lineage remains explicit in every qualification and chapter-attempt artifact.

## 3. Non-goals

- No load balancer, cost optimizer, AI-based model chooser, or distributed scheduler.
- No mid-stream continuation by a second provider.
- No automatic acceptance of unstructured prose when a required marker or schema is missing.
- No unlimited retry or retry-until-PASS behavior.
- No cross-provider Promotion evidence aggregation.
- No automatic default-on, deployment, push, or GitHub branch change.
- No vendor-specific logic in the story pipeline.

## 4. Alternatives considered

### 4.1 Manual switching only

This is simple and stable but leaves recovery, evidence consistency, and provider health memory to the operator. It remains a supported policy but is not sufficient as the only operating mode.

### 4.2 Agent-level or mid-chapter failover

This was rejected. Mixing providers inside one chapter attempt makes output lineage ambiguous, can combine incompatible interpretations of context, is difficult to reproduce, and risks duplicate or partial writes when streams finish late.

### 4.3 Attempt-level provider pool

This is the selected design. It preserves a single runtime lineage within an attempt while permitting deterministic rotation between clean attempts or chapters.

## 5. Existing architecture to preserve

The implementation must reuse:

- Studio service configuration and model selector.
- Provider presets and custom services.
- Per-service secret lookup.
- `resolveServiceModel` and effective LLM configuration.
- `createLLMClient` and the shared provider transport.
- Existing immutable three-gate artifacts and state transaction behavior.
- Qualification runner namespace, request budget, and evidence lineage rules.

Provider selection policy must resolve to the same effective service/model configuration used by normal Studio execution. Qualification must not maintain a separate Ecoapi-specific configuration path.

## 6. Core data contracts

### 6.1 Provider candidate

`ProviderCandidate` is configuration, not a live client:

- stable candidate id;
- service key;
- model id;
- optional API-format and stream overrides;
- enabled flag;
- order/priority;
- role: primary, standby, or evaluation-only.

It contains no API key.

### 6.2 Runtime binding

`RuntimeBinding` is an immutable snapshot resolved before an attempt starts:

- candidate id;
- service key;
- model id;
- normalized endpoint host and path identity;
- provider family;
- API format;
- stream mode;
- capability profile id and version;
- configuration fingerprint that excludes secrets;
- attempt id and selected policy.

The binding is persisted in the attempt record before Planner executes. Every model call in that attempt receives the same binding.

### 6.3 Provider capability

`ProviderCapability` records bounded, redacted observations:

- model-list availability and whether the configured model is present;
- non-stream final-answer support;
- stream final-answer and terminal-signal support;
- Planner-schema compliance;
- Writer-marker compliance;
- long-form completion behavior;
- returned model/fingerprint presence when supplied upstream;
- observation time, expiry time, and outcome.

Capability evidence stores only booleans, enums, counts, duration buckets, content-length buckets, field-presence flags, and non-secret identifiers. It never stores prompts or response text.

### 6.4 Chapter attempt record

`ChapterAttemptRecord` contains:

- book and chapter identity;
- attempt id and idempotency key;
- immutable runtime binding;
- checkpoint identity before execution;
- stage transitions;
- failure classification;
- provider request count;
- commit status;
- final state-alignment result;
- superseding attempt id when failover occurs.

Failed records are immutable evidence and are not overwritten by later attempts.

## 7. Selection policies

### 7.1 Manual

Studio uses the provider/model explicitly selected by the operator. No automatic failover occurs. InkOS still records the immutable binding and capability status.

### 7.2 Evaluation

Candidates are selected in a deterministic configured order. Rotation occurs only between chapter attempts. A repeat run with the same candidate list and starting cursor resolves the same sequence.

Evaluation results remain separate per provider/model lineage. A PASS from one provider cannot repair or erase a failure from another.

### 7.3 Primary-standby

The primary candidate is selected unless its circuit state is unavailable or incompatible. A standby may be selected for a new attempt after checkpoint recovery succeeds.

Primary-standby is added only after manual and evaluation modes plus recovery tests are green.

## 8. Attempt state machine

The attempt state machine is:

```text
selected
  -> capability-checked
  -> checkpoint-verified
  -> running
  -> committing
  -> committed

running/committing
  -> failed
  -> recovery-verifying
  -> recovered
  -> eligible-for-new-attempt
```

An attempt cannot transition from `failed` directly to another runtime. The recovery-verifying transition must prove:

- manifest is still at the previous chapter;
- chapter index contains no new accepted chapter;
- no chapter file for the failed chapter was committed;
- canonical state and summaries remain at the previous chapter;
- no transaction directory remains;
- the failed attempt is closed and its evidence is durable.

If any invariant fails, execution stops for operator review. InkOS must not attempt automatic cleanup or provider switching.

## 9. Failure classification and circuit state

Failure classes are kept distinct:

- `provider-unavailable`: network errors and bounded HTTP 429/502/503 failures;
- `provider-protocol`: malformed stream, missing terminal event, empty final response, unsupported API format;
- `provider-semantic-contract`: repeated Planner schema or Writer marker failure;
- `pipeline-contract`: deterministic InkOS validation failure unrelated to transport;
- `quality-gate`: hard range, language, spelling, surface, or audit failure;
- `state-integrity`: checkpoint, transaction, or canonical-state misalignment;
- `configuration`: missing model, secret, endpoint, or unsupported combination.

Circuit states are:

- `closed`: candidate is eligible;
- `unavailable`: temporarily excluded after availability/protocol failure;
- `incompatible`: excluded for the current capability-profile version after bounded semantic-contract failure;
- `half-open`: eligible only for a capability probe, not a story run.

TTL and thresholds are explicit configuration with conservative defaults. State-integrity and pipeline-contract failures never trigger automatic provider failover because changing providers cannot safely fix them.

## 10. Redacted provider diagnostics

The first implementation slice extends the common provider boundary with an optional diagnostic observer. It records:

- requested service/model/API format/stream mode;
- HTTP status and latency bucket;
- returned model and system fingerprint when present;
- finish reason or terminal-event category;
- content/reasoning/refusal/tool field presence;
- content-length bucket;
- required marker-presence booleans supplied by the caller;
- empty, incomplete, refusal, or final-answer outcome.

The observer must not receive or persist request headers, API keys, raw messages, raw content, reasoning text, refusal text, or tool arguments. Default runtime behavior is unchanged when no observer is installed.

## 11. Qualification flow

Qualification consumes a `RuntimeBinding` rather than Ecoapi-specific environment variables. It remains possible to select a provider non-interactively, but configuration resolves through the same provider/service path as Studio.

Each provider/model candidate has independent evidence and Promotion lineage:

1. Capability certification.
2. Chapter 1 checkpoint.
3. Activation Chapter 1 through 3.
4. Promotion 3 through 8 through 15.

Changing service, model, endpoint identity, API format, stream mode, candidate SHA, or capability-profile version creates a new lineage. Credential values never participate directly in stored fingerprints.

## 12. Security

- Existing per-service secret storage remains authoritative.
- Tests use sentinel credentials only.
- Diagnostics and evidence assert that credentials, authorization headers, raw prompts, and raw responses are absent.
- Provider URLs must be normalized and reject embedded credentials, query credentials, and fragments.
- Custom HTTPS endpoints are allowed; HTTP remains restricted to localhost/loopback.
- Live tests are opt-in, bounded, and named by immutable evidence namespace.

An additional custom provider may be configured with service key `custom:Zpro`, endpoint identity `api.zpro.io.vn/v1`, and model `gpt-5.5`. Its credential is supplied only through the project secret store and is not part of this specification.

## 13. Testing strategy

### Unit tests

- Runtime-binding immutability and non-secret fingerprinting.
- Deterministic candidate ordering.
- Failure classification.
- Circuit transitions and TTL.
- Diagnostic redaction and marker booleans.
- Provider-lineage comparison.

### Fake-provider integration tests

- healthy stream and non-stream;
- 429/502/503;
- stream without a terminal event;
- reasoning without final content;
- valid prose without the Writer marker;
- empty Writer marker;
- invalid Planner schema;
- late response after abort;
- provider failure before and after Planner;
- recovery with no write;
- transaction residue blocks failover;
- standby restarts the whole chapter and does not reuse artifacts.

### Studio/API tests

- configure and list multiple services;
- select manual/evaluation/primary-standby policy;
- display effective runtime binding and circuit reason without secrets;
- do not expose credential or raw model output in telemetry APIs.

### Live tests

Live tests are the final evidence layer, not the primary development loop. One bounded namespace is used per candidate/provider/model lineage. A failed namespace is never reused as a fresh run.

## 14. Implementation order

1. Add redacted provider-boundary diagnostics without routing changes.
2. Introduce shared immutable `RuntimeBinding` and lineage fingerprint.
3. Add provider capability certification using fake providers.
4. Add manual and deterministic evaluation policies.
5. Prove checkpoint recovery and whole-chapter restart behavior.
6. Add primary-standby policy and conservative circuit breaker.
7. Integrate Studio controls and runtime visibility.
8. Convert qualification to the shared runtime binding.
9. Run separate live canaries for configured providers.
10. Keep Promotion/default-on as a separate approval after exact-lineage evidence passes.

Each step is a separate verified change. A later step does not begin while the preceding step has unresolved correctness or state-integrity failures.

## 15. Acceptance criteria

- Existing single-provider behavior remains unchanged in manual mode.
- No attempt contains calls from more than one runtime binding.
- Failover never happens without a proven clean checkpoint.
- A standby reruns Planner and every later stage for the chapter.
- Required Writer and Planner contracts remain fail closed.
- Evaluation order is deterministic and testable.
- Provider failures are distinguishable from pipeline, quality, and state failures.
- Evidence identifies runtime lineage without storing secrets or raw content.
- Fake-provider tests cover every routing and recovery branch before live testing.
- Qualification and Studio resolve provider/model configuration through the same runtime-binding path.
- A provider can be added or removed without modifying the story pipeline.

## 16. Rollback

All new routing behavior is feature-gated. Disabling provider-pool routing restores existing manual single-provider resolution. Existing `legacy`, `preview`, `canary`, and `default` story feature modes remain independent from provider-selection policy. No default-on behavior changes as part of this design.
