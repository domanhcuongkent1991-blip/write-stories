# Vietnamese Short-Chapter Policy Design

> **Superseded:** This document records the former 1,500-word safety ceiling.
> The current approved contract is
> `2026-08-31-vi-phase-b-length-1800-design.md`; do not execute this design.

## Goal

Reduce prompt and output pressure for the Vietnamese Ecoapi qualification run while preserving narrative continuity, language quality, and atomic state safety.

## Approved policy

- Target length: 1,150 Vietnamese word-like tokens (`vi_wordlike_tokens_v1`).
- Preferred range: 1,000–1,300 tokens.
- Below 1,000: blocking length finding; the chapter cannot be accepted as a healthy terminal result.
- Above 1,300: warning only while the chapter remains coherent and safe.
- Technical safety ceiling: 1,500 tokens. This is a provider/runaway guard, not an editorial target; exceeding it remains blocking.
- Existing non-Vietnamese length behavior remains unchanged.

The policy applies to new Vietnamese qualification books. Existing baseline books are historical evidence and are not rewritten or reclassified.

## Evaluation gates

### Length and token telemetry

Every completed chapter records target, preferred/safety bounds, final count, writer count, revision count, and provider token usage. Chapter-to-chapter token deltas are reported but do not fail a chapter by themselves.

### Continuity and progress

The existing governed planner, state validator, hook-health checks, and LLM continuity audit remain authoritative. A chapter must preserve immutable facts, connect causally to the previous state, and advance at least one active thread or consequence. Warnings may pass; verified critical contradictions may not.

### Vietnamese surface lint

Add a zero-LLM deterministic validator for accidental CJK, unbalanced dialogue/bracket delimiters, repeated whitespace, repeated punctuation, and leaked agent/meta notes. These checks produce actionable findings without attempting dictionary-based Vietnamese spell correction.

### Stability and persistence

Reasoning-only or empty provider responses are failures with no chapter artifact. A successful chapter must have a terminal run, matching audit identity/content hash, no pending transaction directories, and no duplicate canonical writes.

## Data flow

1. Resolve Vietnamese target and bounds from the language profile/length utility.
2. Pass the resolved length specification to planner and writer prompts.
3. Run deterministic surface lint together with the existing post-write checks.
4. Run state settlement and continuity audit.
5. Treat preferred-range overflow as a warning, lower-bound/safety overflow as blocking.
6. Persist telemetry and audit findings atomically.

## Compatibility

The change must preserve existing Chinese and English length semantics and all current audit-run schemas. No stable repository or historical qualification book is modified.

## Acceptance criteria

- Vietnamese default chapter target resolves to 1,150.
- A 1,000–1,300 chapter has no length finding.
- A 1,301–1,500 chapter gets a warning but can still pass other gates.
- A chapter below 1,000 or above 1,500 receives a verified blocking length finding.
- Surface-lint findings are deterministic, localized as needed, and covered by unit tests.
- Existing core/studio tests and typechecks remain green.
