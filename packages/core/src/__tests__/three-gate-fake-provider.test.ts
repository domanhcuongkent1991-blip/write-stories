import { describe, expect, it } from "vitest";
import {
  runThreeGateFakeProviderMatrix,
  runThreeGateFakeProviderScenario,
} from "../pipeline/three-gate-fake-provider.js";

describe("three-gate deterministic fake-provider matrix", () => {
  it("covers provider, quality, repair, and preview outcomes without canonical writes", () => {
    const results = runThreeGateFakeProviderMatrix({ mode: "preview" });
    expect(results.map((result) => result.scenario)).toEqual([
      "success",
      "reasoning-only",
      "empty",
      "malformed",
      "partial",
      "timeout",
      "transport",
      "hard-range",
      "repair-required",
      "quality-blocked",
    ]);

    const success = results.find((result) => result.scenario === "success");
    expect(success).toMatchObject({
      disposition: "preview",
      providerAccepted: true,
      canonicalCommit: false,
    });
    expect(success?.artifacts.draft).toBeDefined();
    expect(success?.artifacts.validation?.passed).toBe(true);

    for (const result of results.filter((item) => item.scenario !== "success")) {
      expect(result.canonicalCommit).toBe(false);
    }
  });

  it("commits only the valid canary result for an allowlisted book", () => {
    const result = runThreeGateFakeProviderScenario("success", {
      mode: "canary",
      bookId: "book-1",
      canaryBookIds: ["book-1"],
    });
    expect(result).toMatchObject({ disposition: "committed", canonicalCommit: true });
    expect(result.artifacts.commit?.decision).toBe("committed");
  });

  it("keeps repair-required findings reviewable but never auto-committed", () => {
    const result = runThreeGateFakeProviderScenario("repair-required", { mode: "preview" });
    expect(result).toMatchObject({ disposition: "repair-required", canonicalCommit: false });
    expect(result.artifacts.repair?.acceptance).toBe("needs-review");
  });
});
