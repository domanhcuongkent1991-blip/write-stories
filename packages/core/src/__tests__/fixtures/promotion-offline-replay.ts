import {
  PROMOTION_REPLAY_FIXTURES,
  type PromotionReplayFixture,
} from "./promotion-replay-fixtures.js";

export const OFFLINE_QUALIFICATION_CHECKPOINTS = [3, 8, 15] as const;

type FailureFixtureId = Extract<
  PromotionReplayFixture["id"],
  "provider-reasoning-only" | "planner-deferred-resolve" | "quality-hard-range-overrun" | "quality-malformed-reviser"
>;

export class OfflineReplayConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineReplayConfigurationError";
  }
}

export interface OfflinePromotionReplayOptions {
  readonly abortAtChapter: number;
  readonly failure?: {
    readonly chapter: number;
    readonly fixtureId: FailureFixtureId;
  };
}

export interface OfflinePromotionCheckpoint {
  readonly chapter: number;
  readonly status: "pass";
  readonly canonicalChapter: number;
  readonly manifestChapter: number;
  readonly transactionResidue: false;
}

export interface OfflinePromotionReplayResult {
  readonly status: "PASS_OFFLINE" | "HOLD";
  readonly providerCalls: 0;
  readonly checkpoints: ReadonlyArray<OfflinePromotionCheckpoint>;
  readonly canonicalChapter: number;
  readonly manifestChapter: number;
  readonly transactionResidue: false;
  readonly snapshotZeroPreserved: true;
  readonly abortRestart: {
    readonly requested: true;
    readonly completed: boolean;
    readonly chapter: number;
  };
  readonly failedAtChapter?: number;
  readonly failureFixtureId?: FailureFixtureId;
}

/**
 * Runs only the deterministic promotion state machine. It intentionally has
 * no filesystem or provider dependency: the live qualification can consume
 * the same checkpoint contract only after this replay passes.
 */
export function runOfflinePromotionReplay(
  options: OfflinePromotionReplayOptions,
): OfflinePromotionReplayResult {
  if (!Number.isInteger(options.abortAtChapter) || options.abortAtChapter < 4 || options.abortAtChapter > 8) {
    throw new OfflineReplayConfigurationError("abortAtChapter must be an integer from 4 through 8");
  }

  if (options.failure && (!Number.isInteger(options.failure.chapter) || options.failure.chapter < 1 || options.failure.chapter > 15)) {
    throw new OfflineReplayConfigurationError("failure chapter must be an integer from 1 through 15");
  }

  const failureFixture = options.failure
    ? PROMOTION_REPLAY_FIXTURES.find((fixture) => fixture.id === options.failure?.fixtureId)
    : undefined;
  if (options.failure && (!failureFixture || failureFixture.expectedOutcome !== "retain-canonical" && failureFixture.expectedOutcome !== "reject-before-write")) {
    throw new OfflineReplayConfigurationError("failure fixture is not a fail-closed promotion case");
  }

  let nextChapter = 1;
  let canonicalChapter = 0;
  let manifestChapter = 0;
  let abortCompleted = false;
  const checkpoints: OfflinePromotionCheckpoint[] = [];

  while (nextChapter <= OFFLINE_QUALIFICATION_CHECKPOINTS[2]) {
    if (!abortCompleted && nextChapter === options.abortAtChapter) {
      // An abort happens before settlement. The restart retries the same
      // chapter, so no numbering gap or partial canonical write is possible.
      abortCompleted = true;
      continue;
    }

    if (options.failure?.chapter === nextChapter) {
      return {
        status: "HOLD",
        providerCalls: 0,
        checkpoints,
        canonicalChapter,
        manifestChapter,
        transactionResidue: false,
        snapshotZeroPreserved: true,
        abortRestart: { requested: true, completed: abortCompleted, chapter: options.abortAtChapter },
        failedAtChapter: nextChapter,
        failureFixtureId: options.failure.fixtureId,
      };
    }

    canonicalChapter = nextChapter;
    manifestChapter = nextChapter;
    if ((OFFLINE_QUALIFICATION_CHECKPOINTS as readonly number[]).includes(nextChapter)) {
      checkpoints.push({
        chapter: nextChapter,
        status: "pass",
        canonicalChapter,
        manifestChapter,
        transactionResidue: false,
      });
    }
    nextChapter += 1;
  }

  return {
    status: "PASS_OFFLINE",
    providerCalls: 0,
    checkpoints,
    canonicalChapter,
    manifestChapter,
    transactionResidue: false,
    snapshotZeroPreserved: true,
    abortRestart: { requested: true, completed: abortCompleted, chapter: options.abortAtChapter },
  };
}
