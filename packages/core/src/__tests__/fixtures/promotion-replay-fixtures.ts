/**
 * Sanitized, deterministic descriptions of the failure modes observed during
 * the f0a69b4f qualification. These fixtures deliberately contain shape and
 * outcome metadata only; provider payloads, prompts, prose, and credentials
 * are not part of the replay contract.
 */
export type PromotionReplayFixture = {
  readonly id:
    | "provider-single-envelope"
    | "planner-deferred-resolve"
    | "quality-hard-range-overrun"
    | "quality-malformed-reviser"
    | "recovery-snapshot-zero";
  readonly owner: "adapter" | "planner" | "reviewer" | "harness";
  readonly observedEvidence: "live-qualification-f0a69b4f" | "offline-harness";
  readonly inputShape: string;
  readonly expectedOutcome: "normalize-and-validate" | "reject-before-write" | "retain-canonical" | "preserve-baseline";
  readonly providerPayload?: never;
  readonly rawContent?: never;
  readonly rawPrompt?: never;
  readonly secret?: never;
};

export const PROMOTION_REPLAY_FIXTURES: ReadonlyArray<PromotionReplayFixture> = [
  {
    id: "provider-single-envelope",
    owner: "adapter",
    observedEvidence: "live-qualification-f0a69b4f",
    inputShape: "single-result-object-with-status-and-processed-metadata",
    expectedOutcome: "normalize-and-validate",
  },
  {
    id: "planner-deferred-resolve",
    owner: "planner",
    observedEvidence: "live-qualification-f0a69b4f",
    inputShape: "deferred-hook-plus-resolve-operation",
    expectedOutcome: "reject-before-write",
  },
  {
    id: "quality-hard-range-overrun",
    owner: "reviewer",
    observedEvidence: "live-qualification-f0a69b4f",
    inputShape: "vietnamese-chapter-count-1812-hard-max-1800",
    expectedOutcome: "retain-canonical",
  },
  {
    id: "quality-malformed-reviser",
    owner: "reviewer",
    observedEvidence: "live-qualification-f0a69b4f",
    inputShape: "post-revision-audit-output-parse-failed",
    expectedOutcome: "retain-canonical",
  },
  {
    id: "recovery-snapshot-zero",
    owner: "harness",
    observedEvidence: "offline-harness",
    inputShape: "resume-from-chapter-zero-baseline",
    expectedOutcome: "preserve-baseline",
  },
];
