# Minor-Audit Acceptance and Planner Correction Retry

Status: implemented
Date: 2026-09-14
Target branch: `main`

## Problem

Cross-run analysis of six canary namespaces showed the gate now fails almost
exclusively on small, human-fixable prose notes (memo drift, POV slips,
transition/continuity wording) while every hard dimension — state alignment,
surface, spelling, CJK, hard length, format contracts — stays clean. Each such
note cost a full ~13-call chapter rewrite. Separately, the planner's
Vietnamese semantic-correction loop allowed exactly one parse attempt, so a
single truncated/mangled hook ID (a pre-existing failure mode present in the
old candidate too) killed whole chapters.

Per the operator's decision: chapters must reach a 90-point completion bar,
but small user-fixable notes should not block canon acceptance — and
deterministic retry bugs should self-heal instead of consuming rewrites.

## Decision

1. **Minor-audit acceptance (opt-in, default OFF).** After the review cycle,
   a `fail` verdict is accepted as `pass` when ALL of the following hold:
   - `parseFailed` is not set and the decision is `fail`/`repair-required`;
   - `overallScore >= 90` (`MINOR_AUDIT_ACCEPTANCE_MIN_SCORE`);
   - exactly one blocking (critical/error) issue
     (`MINOR_AUDIT_ACCEPTANCE_MAX_ISSUES = 1`);
   - that issue's category is one of: Chapter Memo Drift Check, POV
     Consistency Check, Transition Continuity (case-insensitive).
   The accepted result carries `minorAccepted: true`, `minorNotes`, and a
   synthetic `minor-acceptance` warning issue so the terminal audit-run
   record and qualification evidence document the acceptance. Everything
   else (parse failures, inconclusive verdicts, Hook Check, state, surface,
   spelling, CJK, hard length, more than one blocker) remains fail-closed.
2. **Plumbing.** `PipelineRunner` gains `minorAuditAcceptance?: boolean`
   (default off; Studio behavior unchanged). The qualification runner enables
   it, records the flag in evidence, and persists `minorAccepted`/`minorNotes`
   per chapter. `collectChapterFailureDimensions` skips the audit/verified-
   blocker dimensions for minor-accepted chapters so they count as gate passes.
3. **Planner correction retry.** The Vietnamese semantic-correction memo loop
   allows `parseAttemptLimit: 2` (was 1): a truncated hook ID self-heals with
   the same feedback instead of failing the chapter.

## Alternatives considered

- Score floor 78 with broader category list — rejected by the operator as too
  permissive; 90 with a single issue is the agreed bar.
- Softening the auditor prompts instead — rejected: prompt churn re-opens
  contract behavior; the acceptance is a bounded policy applied after the
  audit, with the auditor left untouched.
- Retrying whole chapters on ID truncation — rejected: burns ~13 calls for a
  one-token planner slip the correction loop can fix itself.

## Scope

- `packages/core/src/audit/audit-policy.ts` (`applyMinorAuditAcceptance` +
  constants);
- `packages/core/src/agents/continuity.ts` (AuditResult fields);
- `packages/core/src/pipeline/runner.ts` (config option + application before
  chapter status resolution);
- `packages/core/src/agents/planner.ts` (correction parse attempts 1 → 2);
- `qualification/promotion-runner.mjs` (flag + evidence fields);
- `qualification/promotion-runner-scope.mjs` (dimension skip for
  minor-accepted chapters).

No changes to: the auditor, prompts, state pipeline, memo parse contracts,
immutable audit-run records (the terminal record reflects the final policy
decision and carries the minor-acceptance warning finding).

## Verification and rollout

Focused suites (`audit-policy`, `planner`, promotion scope), full core suite
(2,298 tests), typecheck, build, secret scan. Rollout: fresh namespace on the
new candidate SHA, 8-chapter gate from chapter 1. The evidence records the
minor-acceptance flag per chapter so the operator can audit every accepted
note.
