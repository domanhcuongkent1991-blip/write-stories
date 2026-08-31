# Vietnamese Writer Prompt Length Guidance Design

## Goal

Reduce Vietnamese chapter overrun at generation time without changing the approved audit policy or weakening continuity, spelling, persistence, and recovery gates.

## Confirmed policy

- The audit safety policy remains unchanged: 1,000–1,500 `vi_wordlike_tokens_v1` tokens.
- 1,100–1,300 tokens is the writer's generation target range.
- 1,301–1,500 remains warning-only when all other gates pass.
- Below 1,000 or above 1,500 remains blocking.
- The existing target remains 1,150 tokens; no book configuration or historical baseline is rewritten.

## Root cause addressed

The writer prompt currently presents the preferred range without clearly distinguishing it from the audit safety range. Chapter memo/context text can also contain the wider 1,000–1,500 range. The model therefore has no unambiguous instruction to stop near 1,300, which contributed to the observed 1,612-token chapter and 1,762-token revision candidate.

## Design

### One prompt contract in two writer messages

The same Vietnamese guidance is rendered into both the writer system prompt and the governed writer user prompt. It will state:

- count only `CHAPTER_CONTENT` with `vi_wordlike_tokens_v1`;
- aim for 1,150 and normally finish around 1,100–1,200;
- treat 1,100–1,300 as the required writing target, not a suggestion;
- close the current scene and stop before 1,300 rather than adding filler;
- ignore conflicting length ranges in stale memo/context for generation purposes;
- the reviewer may warn, but can still accept 1,301–1,500 if the other gates pass.

The output-format block will repeat the same range so the instruction is present immediately beside `CHAPTER_CONTENT`.

### Shared range formatter

The writer and reviser prompts will use one small length-guidance formatter instead of duplicating Vietnamese-specific constants. Non-Vietnamese prompts and generic custom length specs retain their current behavior. The `LengthSpec` and audit schemas remain unchanged.

The reviser receives the same generation target guidance in addition to its existing hard safety range. This prevents a repair candidate from expanding an overlong chapter while still preserving the 1,000–1,500 acceptance policy.

### Deterministic authority remains final

No truncation, sentence deletion, `maxTokens` shortcut, or provider retry is introduced. The existing deterministic counter and shared candidate gate remain authoritative. Prompt guidance reduces overrun probability; the audit gate protects correctness when the model ignores the prompt.

## Error handling and recovery

An over-1,300 but ≤1,500 chapter produces the existing warning. A chapter outside 1,000–1,500 remains rejected and its candidate is retained. Existing Vietnamese retry snapshot restoration and SQLite cache invalidation are unaffected.

## Testing

- Assert the existing `buildLengthSpec(1150, "vi")` policy remains 1,000–1,500.
- Assert writer system/user/output prompts contain the explicit 1,100–1,300 Vietnamese generation target and precedence wording.
- Assert reviser guidance contains the same target while retaining hard range 1,000–1,500.
- Keep boundary tests for warning-only 1,301–1,500 and blocking <1,000/>1,500.
- Run focused tests, full Core tests, typecheck, build, and `git diff --check`.

## Compatibility

Chinese and English prompts, length calculations, audit schemas, baseline books, provider configuration, and persistence formats remain unchanged.
