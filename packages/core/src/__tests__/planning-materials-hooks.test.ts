import { describe, expect, it } from "vitest";
import { collectAuthoritativeMemoHooks } from "../utils/planning-materials.js";
import type { StoredHook } from "../state/memory-db.js";

const hook = (
  hookId: string,
  status: string,
  promoted?: boolean,
): StoredHook => ({
  hookId,
  startChapter: 0,
  type: "mystery",
  status,
  lastAdvancedChapter: 0,
  expectedPayoff: "",
  payoffTiming: "mid-arc",
  notes: "",
  ...(promoted === undefined ? {} : { promoted }),
} as unknown as StoredHook);

describe("collectAuthoritativeMemoHooks", () => {
  it("accepts every unresolved hook even when retrieval missed it and promoted is false", () => {
    // G2 ch25: H003 is progressing with promoted=false (seed metadata from
    // chapter 1), retrieval did not select it, but chapter summaries still
    // mention it — the memo referencing it must not fail as "unknown".
    const selection = {
      activeHooks: [hook("H004", "progressing", true)],
      hooks: [hook("H004", "progressing", true), hook("H008", "progressing", true)],
      allUnresolvedHooks: [
        hook("H004", "progressing", true),
        hook("H003", "progressing", false),
        hook("H002", "progressing", false),
        hook("H007", "deferred", false),
        hook("seed-dormant", "open", false),
      ],
    };
    const ids = collectAuthoritativeMemoHooks(selection).map((h) => h.hookId);
    expect(ids).toContain("H003");
    expect(ids).toContain("H002");
    expect(ids).toContain("H007");
    expect(ids).toContain("seed-dormant");
    expect(ids).toContain("H004");
    expect(ids).toContain("H008");
  });

  it("excludes resolved hooks from the contract", () => {
    const selection = {
      activeHooks: [hook("H004", "progressing", true)],
      hooks: [],
      allUnresolvedHooks: [
        hook("H004", "progressing", true),
        hook("H003", "resolved", false),
        hook("H009", "closed", false),
      ],
    };
    const ids = collectAuthoritativeMemoHooks(selection).map((h) => h.hookId);
    expect(ids).toEqual(["H004"]);
  });

  it("dedupes by hookId across sources", () => {
    const selection = {
      activeHooks: [hook("H004", "progressing", true)],
      hooks: [hook("H004", "progressing", true), hook("H003", "progressing", false)],
      allUnresolvedHooks: [hook("H004", "progressing", true), hook("H003", "progressing", false)],
    };
    const ids = collectAuthoritativeMemoHooks(selection).map((h) => h.hookId);
    expect(ids.filter((id) => id === "H004")).toHaveLength(1);
    expect(ids.filter((id) => id === "H003")).toHaveLength(1);
  });
});
