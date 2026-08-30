import { describe, expect, it } from "vitest";
import { validateExpectedHookOps } from "../utils/hook-intent-validator.js";

const contentHash = "a".repeat(64);
const expected = {
  upsert: [],
  mention: ["H007"],
  resolve: ["H003"],
  defer: ["H009"],
};

describe("validateExpectedHookOps", () => {
  it("does not satisfy an advance upsert unless the typed record advances this chapter", () => {
    const issues = validateExpectedHookOps({
      expected: {
        upsert: [{
          hookId: "H007",
          startChapter: 1,
          type: "mystery",
          status: "progressing",
          lastAdvancedChapter: 4,
          expectedPayoff: "badge",
          notes: "",
        }],
        mention: [],
        resolve: [],
        defer: [],
      },
      actual: {
        upsert: [{
          hookId: "H007",
          startChapter: 1,
          type: "mystery",
          status: "progressing",
          lastAdvancedChapter: 3,
          expectedPayoff: "badge",
          notes: "",
        }],
        mention: [],
        resolve: [],
        defer: [],
      },
      runtimeHooks: [{
        hookId: "H007",
        startChapter: 1,
        type: "mystery",
        status: "progressing",
        lastAdvancedChapter: 3,
        expectedPayoff: "badge",
        notes: "",
      }],
      acceptanceCriteria: ["H007 must advance."],
      contentHash,
    });

    expect(issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        verification: "unverified",
        acceptanceCriteria: ["H007 must advance."],
      }),
    ]);
  });

  it("treats a terminal final status for an advance upsert as a verified contradiction", () => {
    const issues = validateExpectedHookOps({
      expected: {
        upsert: [{
          hookId: "H007",
          startChapter: 1,
          type: "mystery",
          status: "progressing",
          lastAdvancedChapter: 4,
          expectedPayoff: "badge",
          notes: "",
        }],
        mention: [],
        resolve: [],
        defer: [],
      },
      actual: {
        upsert: [{
          hookId: "H007",
          startChapter: 1,
          type: "mystery",
          status: "resolved",
          lastAdvancedChapter: 4,
          expectedPayoff: "badge",
          notes: "",
        }],
        mention: [],
        resolve: [],
        defer: [],
      },
      runtimeHooks: [{
        hookId: "H007",
        startChapter: 1,
        type: "mystery",
        status: "resolved",
        lastAdvancedChapter: 4,
        expectedPayoff: "badge",
        notes: "",
      }],
      acceptanceCriteria: [],
      contentHash,
    });

    expect(issues).toEqual([
      expect.objectContaining({ severity: "critical", verification: "verified" }),
    ]);
  });

  it("rejects an advance upsert whose authoritative final status remains open", () => {
    const issues = validateExpectedHookOps({
      expected: {
        upsert: [{
          hookId: "H007",
          startChapter: 1,
          type: "mystery",
          status: "progressing",
          lastAdvancedChapter: 4,
          expectedPayoff: "badge",
          notes: "",
        }],
        mention: [],
        resolve: [],
        defer: [],
      },
      actual: {
        upsert: [{
          hookId: "H007",
          startChapter: 1,
          type: "mystery",
          status: "open",
          lastAdvancedChapter: 4,
          expectedPayoff: "badge",
          notes: "",
        }],
        mention: [],
        resolve: [],
        defer: [],
      },
      runtimeHooks: [{
        hookId: "H007",
        startChapter: 1,
        type: "mystery",
        status: "open",
        lastAdvancedChapter: 4,
        expectedPayoff: "badge",
        notes: "",
      }],
      acceptanceCriteria: [],
      contentHash,
    });

    expect(issues).toEqual([
      expect.objectContaining({
        severity: "critical",
        verification: "verified",
        evidence: expect.objectContaining({ stateRef: "runtime:hook:H007" }),
      }),
    ]);
  });

  it("accepts matching typed runtime operations", () => {
    expect(validateExpectedHookOps({
      expected,
      actual: {
        upsert: [],
        mention: ["H007"],
        resolve: ["H003"],
        defer: ["H009"],
      },
      runtimeHooks: [],
      acceptanceCriteria: [],
      contentHash,
    })).toEqual([]);
  });

  it("keeps a missing typed operation as an unverified warning with relevant acceptance criteria", () => {
    const issues = validateExpectedHookOps({
      expected,
      actual: { upsert: [], mention: [], resolve: [], defer: ["H009"] },
      runtimeHooks: [],
      acceptanceCriteria: [
        "H007 must advance through an observable action.",
        "Unrelated character voice remains stable.",
      ],
      contentHash,
    });

    expect(issues).toContainEqual(expect.objectContaining({
      severity: "warning",
      verification: "unverified",
      description: expect.stringContaining("H007"),
      acceptanceCriteria: ["H007 must advance through an observable action."],
    }));
  });

  it("emits a verified blocker only for the same hook ID with contradictory runtime evidence", () => {
    const issues = validateExpectedHookOps({
      expected,
      actual: { upsert: [], mention: ["H007"], resolve: [], defer: ["H003", "H009"] },
      runtimeHooks: [{
        hookId: "H003",
        startChapter: 1,
        type: "mystery",
        status: "deferred",
        lastAdvancedChapter: 4,
        expectedPayoff: "badge resolved",
        notes: "runtime kept it deferred",
      }],
      acceptanceCriteria: ["H003 must be resolved in runtime truth."],
      contentHash,
    });

    expect(issues).toContainEqual(expect.objectContaining({
      severity: "critical",
      source: "state",
      verification: "verified",
      description: expect.stringContaining("H003"),
      evidence: expect.objectContaining({
        contentHash,
        stateRef: "runtime:hook:H003",
        excerpt: expect.stringContaining("defer"),
      }),
      acceptanceCriteria: ["H003 must be resolved in runtime truth."],
    }));
  });

  it("does not let a compatible final status hide a contradictory typed delta", () => {
    const issues = validateExpectedHookOps({
      expected: { upsert: [], mention: [], resolve: ["H009"], defer: [] },
      actual: { upsert: [], mention: [], resolve: [], defer: ["H009"] },
      runtimeHooks: [{
        hookId: "H009",
        startChapter: 2,
        type: "mystery",
        status: "resolved",
        lastAdvancedChapter: 5,
        expectedPayoff: "the hidden debt is revealed",
        notes: "snapshot is resolved but delta contradicts the intent",
      }],
      acceptanceCriteria: ["H009 must resolve."],
      contentHash,
    });

    expect(issues).toEqual([
      expect.objectContaining({
        severity: "critical",
        verification: "verified",
        evidence: expect.objectContaining({ stateRef: "runtime:hook:H009" }),
      }),
    ]);
  });
});
