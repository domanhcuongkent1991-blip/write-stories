import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StoredHook } from "../state/memory-db.js";
import {
  HookOperationContractError,
  assertHookContractCurrent,
  getLegalHookActions,
  hashCanonicalHookPayoff,
} from "../models/hook-operation-intent.js";
import {
  bindExpectedHookOperationsV2,
} from "../utils/hook-ledger-validator.js";
import {
  loadPersistedPlan,
  savePersistedPlan,
} from "../pipeline/persisted-governed-plan.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const activeHooks: StoredHook[] = [
  {
    hookId: "sabotage-sau-can-thi-thu",
    startChapter: 1,
    type: "mystery",
    status: "progressing",
    lastAdvancedChapter: 1,
    expectedPayoff: "Identify the actor behind the remote administrator lock",
    notes: "",
  },
  {
    hookId: "H006",
    startChapter: 1,
    type: "device",
    status: "progressing",
    lastAdvancedChapter: 1,
    expectedPayoff: "Confirm the physical signal-manipulation device",
    notes: "",
  },
];

const governedMemoBody = `## Scene and length budget
Write three causal scenes with enough detail to stay inside the approved local length range.

## Current task
Inspect the damaged equipment and distinguish physical sabotage from the unknown remote actor.

## What the reader is waiting for right now
The reader needs concrete evidence about the device without a fabricated attacker identity.

## To pay off / to keep buried
Pay off the physical device evidence and keep the administrator-lock actor unresolved.

## What the slow / transitional beats carry
Every transition moves the inspection forward and preserves the unresolved identity pressure.

## Three-question check on the key choice
The choice is supported by evidence, changes the investigation, and creates a later consequence.

## Required end-of-chapter change
The team confirms a physical device exists while the person controlling the remote lock remains unknown.

## Hook ledger for this chapter
open:
- [new] serial-number trail || investigate the device supplier later
advance:
- sabotage-sau-can-thi-thu "remote administrator lock" -> actor still unknown
resolve:
- H006 "signal manipulation device" -> the inspection confirms the physical device
defer:
- none

## Do not
- Do not invent or identify the remote attacker.`;

describe("canonical hook-operation intent V2", () => {
  it("derives legal actions from normalized hook status", () => {
    expect(getLegalHookActions({ status: "resolved" })).toEqual([]);
    expect(getLegalHookActions({ status: "paused" })).toEqual([
      "advance",
      "mention",
      "defer",
    ]);
    expect(getLegalHookActions({ status: "open" })).toEqual([
      "advance",
      "mention",
      "resolve",
      "defer",
    ]);
  });

  it("binds resolve evidence to the host-owned canonical payoff hash", () => {
    const contract = bindExpectedHookOperationsV2(governedMemoBody, {
      activeHooks,
      chapterNumber: 2,
    });

    expect(contract).toEqual({
      schemaVersion: 2,
      operations: [
        expect.objectContaining({
          hookId: "sabotage-sau-can-thi-thu",
          action: "advance",
          canonicalExpectedPayoff: "Identify the actor behind the remote administrator lock",
        }),
        {
          hookId: "H006",
          action: "resolve",
          canonicalExpectedPayoff: "Confirm the physical signal-manipulation device",
          canonicalPayoffHash: hashCanonicalHookPayoff(
            "H006",
            "Confirm the physical signal-manipulation device",
          ),
          plannedEvidence: "\"signal manipulation device\" -> the inspection confirms the physical device",
        },
      ],
    });
  });

  it("rejects an unknown hook before semantic validation", () => {
    const memo = governedMemoBody.replace(
      "- H006 \"signal manipulation device\" -> the inspection confirms the physical device",
      "- H999 \"signal manipulation device\" -> the inspection confirms the physical device",
    );

    expect(() => bindExpectedHookOperationsV2(memo, { activeHooks, chapterNumber: 2 }))
      .toThrow(/unknown stable hook ID H999/i);
  });

  it("rejects duplicate and contradictory operations instead of deduplicating them", () => {
    const duplicate = governedMemoBody.replace(
      "- H006 \"signal manipulation device\" -> the inspection confirms the physical device",
      "- H006 \"signal manipulation device\" -> the inspection confirms the physical device\n- H006 \"signal manipulation device\" -> the inspection confirms the physical device",
    );
    expect(() => bindExpectedHookOperationsV2(duplicate, { activeHooks, chapterNumber: 2 }))
      .toThrow(/duplicate.*H006/i);

    const contradictory = governedMemoBody.replace(
      "- sabotage-sau-can-thi-thu \"remote administrator lock\" -> actor still unknown",
      "- H006 \"signal manipulation device\" -> physical clue advances",
    );
    expect(() => bindExpectedHookOperationsV2(contradictory, { activeHooks, chapterNumber: 2 }))
      .toThrow(/contradictory.*H006/i);
  });

  it("rejects resolve without meaningful planned evidence", () => {
    const memo = governedMemoBody.replace(
      "- H006 \"signal manipulation device\" -> the inspection confirms the physical device",
      "- H006",
    );

    expect(() => bindExpectedHookOperationsV2(memo, { activeHooks, chapterNumber: 2 }))
      .toThrow(/resolve.*planned evidence/i);
  });

  it("rejects a persisted contract whose canonical payoff hash is stale", () => {
    const contract = bindExpectedHookOperationsV2(governedMemoBody, {
      activeHooks,
      chapterNumber: 2,
    });
    const changedHooks = activeHooks.map((hook) => hook.hookId === "H006"
      ? { ...hook, expectedPayoff: "Identify the supplier and operator of the physical device" }
      : hook);

    expect(() => assertHookContractCurrent(contract, changedHooks))
      .toThrow(HookOperationContractError);
    expect(() => assertHookContractCurrent(contract, changedHooks))
      .toThrow(/stale canonical payoff.*H006/i);
  });

  it("round-trips V2 while legacy persisted plans remain readable", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-hook-contract-"));
    tempRoots.push(root);
    await mkdir(join(root, "story", "runtime"), { recursive: true });
    const contract = bindExpectedHookOperationsV2(governedMemoBody, {
      activeHooks,
      chapterNumber: 2,
    });
    const basePlan = {
      intent: {
        chapter: 2,
        goal: "Confirm physical sabotage without inventing the attacker.",
        mustKeep: [],
        mustAvoid: [],
        styleEmphasis: [],
        acceptanceCriteria: [],
        pacingCode: "reveal" as const,
        expectedHookOps: { upsert: [], mention: [], resolve: ["H006"], defer: [] },
      },
      memo: {
        chapter: 2,
        goal: "Confirm physical sabotage.",
        isGoldenOpening: false,
        body: governedMemoBody,
        threadRefs: ["H006"],
      },
      intentMarkdown: "# Chapter 2 Intent",
      plannerInputs: ["story/runtime/current_state.json"],
      runtimePath: join(root, "story", "runtime", "chapter-0002.intent.md"),
    };

    await savePersistedPlan(root, {
      ...basePlan,
      intent: { ...basePlan.intent, expectedHookContract: contract },
    });
    await expect(loadPersistedPlan(root, 2)).resolves.toEqual(
      expect.objectContaining({
        intent: expect.objectContaining({ expectedHookContract: contract }),
      }),
    );
    const changedHooks = activeHooks.map((hook) => hook.hookId === "H006"
      ? { ...hook, expectedPayoff: "Identify the device supplier and operator" }
      : hook);
    await expect(loadPersistedPlan(root, 2, changedHooks)).resolves.toBeNull();

    await savePersistedPlan(root, basePlan);
    await expect(loadPersistedPlan(root, 2)).resolves.toEqual(
      expect.objectContaining({
        intent: expect.not.objectContaining({ expectedHookContract: expect.anything() }),
      }),
    );
  });
});
