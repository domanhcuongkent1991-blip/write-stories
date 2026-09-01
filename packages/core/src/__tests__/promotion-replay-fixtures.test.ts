import { describe, expect, it } from "vitest";
import { assertLegalHookTransition, HookOperationContractError } from "../models/hook-operation-intent.js";
import { buildLengthSpec, isOutsideHardRange } from "../utils/length-metrics.js";
import { PROMOTION_REPLAY_FIXTURES } from "./fixtures/promotion-replay-fixtures.js";

describe("Vietnamese promotion replay fixtures", () => {
  it("covers each observed failure class without storing provider payloads", () => {
    expect(PROMOTION_REPLAY_FIXTURES.map((fixture) => fixture.id)).toEqual([
      "provider-single-envelope",
      "planner-deferred-resolve",
      "quality-hard-range-overrun",
      "quality-malformed-reviser",
      "recovery-snapshot-zero",
    ]);

    for (const fixture of PROMOTION_REPLAY_FIXTURES) {
      expect(fixture.providerPayload).toBeUndefined();
      expect(fixture.rawContent).toBeUndefined();
      expect(fixture.rawPrompt).toBeUndefined();
      expect(fixture.secret).toBeUndefined();
    }

    expect(Object.fromEntries(PROMOTION_REPLAY_FIXTURES.map((fixture) => [fixture.id, {
      owner: fixture.owner,
      expectedOutcome: fixture.expectedOutcome,
    }]))).toEqual({
      "provider-single-envelope": { owner: "adapter", expectedOutcome: "normalize-and-validate" },
      "planner-deferred-resolve": { owner: "planner", expectedOutcome: "reject-before-write" },
      "quality-hard-range-overrun": { owner: "reviewer", expectedOutcome: "retain-canonical" },
      "quality-malformed-reviser": { owner: "reviewer", expectedOutcome: "retain-canonical" },
      "recovery-snapshot-zero": { owner: "harness", expectedOutcome: "preserve-baseline" },
    });
  });

  it("keeps deferred hooks from taking an irreversible resolve transition", () => {
    const fixture = PROMOTION_REPLAY_FIXTURES.find((item) => item.id === "planner-deferred-resolve");
    expect(fixture?.expectedOutcome).toBe("reject-before-write");

    expect(() => assertLegalHookTransition({
      hookId: "H001",
      startChapter: 1,
      type: "mystery",
      status: "deferred",
      lastAdvancedChapter: 1,
      expectedPayoff: "Reveal the deferred fact.",
      notes: "Fixture hook.",
    }, "resolve")).toThrow(HookOperationContractError);
  });

  it("treats the Vietnamese hard-range boundary as deterministic", () => {
    const fixture = PROMOTION_REPLAY_FIXTURES.find((item) => item.id === "quality-hard-range-overrun");
    expect(fixture?.expectedOutcome).toBe("retain-canonical");

    const spec = buildLengthSpec(1150, "vi");
    expect(isOutsideHardRange(1800, spec)).toBe(false);
    expect(isOutsideHardRange(1801, spec)).toBe(true);
  });
});
