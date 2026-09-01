import { describe, expect, it } from "vitest";
import {
  OFFLINE_QUALIFICATION_CHECKPOINTS,
  OfflineReplayConfigurationError,
  runOfflinePromotionReplay,
} from "./fixtures/promotion-offline-replay.js";

describe("offline Vietnamese promotion replay", () => {
  it("runs 3 → 8 → 15 checkpoints with one abort/restart and no provider calls", () => {
    const result = runOfflinePromotionReplay({ abortAtChapter: 5 });

    expect(OFFLINE_QUALIFICATION_CHECKPOINTS).toEqual([3, 8, 15]);
    expect(result.status).toBe("PASS_OFFLINE");
    expect(result.providerCalls).toBe(0);
    expect(result.checkpoints.map((checkpoint) => checkpoint.chapter)).toEqual([3, 8, 15]);
    expect(result.checkpoints.every((checkpoint) => checkpoint.status === "pass")).toBe(true);
    expect(result.abortRestart).toEqual({
      requested: true,
      completed: true,
      chapter: 5,
    });
    expect(result.canonicalChapter).toBe(15);
    expect(result.manifestChapter).toBe(15);
    expect(result.transactionResidue).toBe(false);
    expect(result.snapshotZeroPreserved).toBe(true);
  });

  it.each([
    "planner-deferred-resolve",
    "quality-hard-range-overrun",
    "quality-malformed-reviser",
  ] as const)("holds before writing when %s is injected", (fixtureId) => {
    const result = runOfflinePromotionReplay({
      abortAtChapter: 5,
      failure: { chapter: 2, fixtureId },
    });

    expect(result.status).toBe("HOLD");
    expect(result.failedAtChapter).toBe(2);
    expect(result.providerCalls).toBe(0);
    expect(result.checkpoints).toEqual([]);
    expect(result.canonicalChapter).toBe(1);
    expect(result.manifestChapter).toBe(1);
    expect(result.transactionResidue).toBe(false);
    expect(result.failureFixtureId).toBe(fixtureId);
  });

  it("requires the abort drill to stay inside chapters 4–8", () => {
    expect(() => runOfflinePromotionReplay({ abortAtChapter: 3 }))
      .toThrow(OfflineReplayConfigurationError);
    expect(() => runOfflinePromotionReplay({ abortAtChapter: 9 }))
      .toThrow(OfflineReplayConfigurationError);
  });
});
