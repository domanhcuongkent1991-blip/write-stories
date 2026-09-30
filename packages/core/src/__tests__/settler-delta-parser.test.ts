import { describe, expect, it } from "vitest";
import { parseSettlerDeltaOutput, SettlerDeltaParseError } from "../agents/settler-delta-parser.js";

describe("parseSettlerDeltaOutput", () => {
  it("parses a valid runtime-state delta block", () => {
    const result = parseSettlerDeltaOutput([
      "=== POST_SETTLEMENT ===",
      "| 伏笔变动 | mentor-oath 推进 | 同步更新 |",
      "",
      "=== RUNTIME_STATE_DELTA ===",
      "```json",
      JSON.stringify({
        chapter: 12,
        currentStatePatch: {
          currentGoal: "追到河埠旧账的尽头",
          currentConflict: "商会噪音仍在干扰师债主线",
        },
        hookOps: {
          upsert: [
            {
              hookId: "mentor-oath",
              startChapter: 8,
              type: "relationship",
              status: "progressing",
              lastAdvancedChapter: 12,
              expectedPayoff: "揭开师债真相",
              notes: "河埠旧账把师债再往前推了一格",
            },
          ],
          resolve: [],
          defer: [],
        },
        chapterSummary: {
          chapter: 12,
          title: "河埠对账",
          characters: "林月",
          events: "林月核对河埠旧账",
          stateChanges: "师债线索进一步收束",
          hookActivity: "mentor-oath advanced",
          mood: "紧绷",
          chapterType: "主线推进",
        },
        notes: ["保留商会噪音，但不盖过主线"],
      }, null, 2),
      "```",
    ].join("\n"));

    expect(result.postSettlement).toContain("mentor-oath");
    expect(result.runtimeStateDelta.chapter).toBe(12);
    expect(result.runtimeStateDelta.hookOps.upsert[0]?.hookId).toBe("mentor-oath");
    expect(result.runtimeStateDelta.chapterSummary?.title).toBe("河埠对账");
  });

  it("normalizes known narrative hook-status aliases before schema validation", () => {
    const result = parseSettlerDeltaOutput([
      "=== RUNTIME_STATE_DELTA ===",
      "```json",
      JSON.stringify({
        chapter: 12,
        hookOps: {
          upsert: [
            {
              hookId: "mentor-oath",
              startChapter: 8,
              type: "relationship",
              status: "pressured",
              lastAdvancedChapter: 12,
              expectedPayoff: "揭开师债真相",
            },
          ],
          mention: [],
          resolve: [],
          defer: [],
        },
      }),
      "```",
    ].join("\n"));

    expect(result.runtimeStateDelta.hookOps.upsert[0]?.status).toBe("progressing");
  });

  it("normalizes near-payoff narrative statuses to progressing", () => {
    for (const status of ["near_payoff", "near-payoff", "near payoff"]) {
      const result = parseSettlerDeltaOutput([
        "=== RUNTIME_STATE_DELTA ===",
        "```json",
        JSON.stringify({
          chapter: 12,
          hookOps: {
            upsert: [
              {
                hookId: "mentor-oath",
                startChapter: 8,
                type: "relationship",
                status,
                lastAdvancedChapter: 12,
                expectedPayoff: "揭开师债真相",
              },
            ],
            mention: [],
            resolve: [],
            defer: [],
          },
        }),
        "```",
      ].join("\n"));

      expect(result.runtimeStateDelta.hookOps.upsert[0]?.status).toBe("progressing");
    }
  });

  it("keeps unknown hook-status values fail-closed", () => {
    expect(() => parseSettlerDeltaOutput([
      "=== RUNTIME_STATE_DELTA ===",
      "```json",
      JSON.stringify({
        chapter: 12,
        hookOps: {
          upsert: [
            {
              hookId: "mentor-oath",
              startChapter: 8,
              type: "relationship",
              status: "invented-status",
              lastAdvancedChapter: 12,
              expectedPayoff: "揭开师债真相",
            },
          ],
          mention: [],
          resolve: [],
          defer: [],
        },
      }),
      "```",
    ].join("\n"))).toThrow(/runtime state delta failed schema validation/i);
  });

  it("rejects invalid runtime-state delta payloads", () => {
    expect(() =>
      parseSettlerDeltaOutput([
        "=== RUNTIME_STATE_DELTA ===",
        "```json",
        JSON.stringify({
          chapter: 12,
          hookOps: {
            upsert: [
              {
                hookId: "mentor-oath",
                startChapter: 8,
                type: "relationship",
                status: "open",
                lastAdvancedChapter: "chapter twelve",
              },
            ],
            resolve: [],
            defer: [],
          },
        }),
        "```",
      ].join("\n")),
    ).toThrow(/runtime state delta/i);
  });

  it("reports a missing marker separately from malformed JSON", () => {
    expect(() => parseSettlerDeltaOutput("=== POST_SETTLEMENT ===\nNo delta."))
      .toThrowError(expect.objectContaining({
        name: "SettlerDeltaParseError",
        reason: "missing-marker",
      } satisfies Partial<SettlerDeltaParseError>));
  });

  it("reports invalid JSON with a typed diagnostic", () => {
    expect(() => parseSettlerDeltaOutput([
      "=== RUNTIME_STATE_DELTA ===",
      "```json",
      "{not-json}",
      "```",
    ].join("\n"))).toThrowError(expect.objectContaining({
      name: "SettlerDeltaParseError",
      reason: "invalid-json",
    } satisfies Partial<SettlerDeltaParseError>));
  });

  it("reports schema-invalid JSON with a typed diagnostic", () => {
    expect(() => parseSettlerDeltaOutput([
      "=== RUNTIME_STATE_DELTA ===",
      "```json",
      JSON.stringify({ chapter: "twelve" }),
      "```",
    ].join("\n"))).toThrowError(expect.objectContaining({
      name: "SettlerDeltaParseError",
      reason: "schema-invalid",
    } satisfies Partial<SettlerDeltaParseError>));
  });

  it("parses hook resolve and defer operations", () => {
    const result = parseSettlerDeltaOutput([
      "=== RUNTIME_STATE_DELTA ===",
      "```json",
      JSON.stringify({
        chapter: 20,
        hookOps: {
          upsert: [],
          mention: ["mentor-oath"],
          resolve: ["old-seal"],
          defer: ["guild-route"],
        },
        notes: [],
      }),
      "```",
    ].join("\n"));

    expect(result.runtimeStateDelta.hookOps.mention).toEqual(["mentor-oath"]);
    expect(result.runtimeStateDelta.hookOps.resolve).toEqual(["old-seal"]);
    expect(result.runtimeStateDelta.hookOps.defer).toEqual(["guild-route"]);
  });

  it("accepts a fenced JSON payload when the model adds a short lead-in", () => {
    const payload = JSON.stringify({
      chapter: 22,
      hookOps: {
        upsert: [],
        mention: [],
        resolve: [],
        defer: [],
      },
      notes: [],
    });

    const result = parseSettlerDeltaOutput([
      "=== RUNTIME_STATE_DELTA ===",
      "Dưới đây là delta trạng thái:",
      "```json",
      payload,
      "```",
      "Không thêm thay đổi nào khác.",
    ].join("\n"));

    expect(result.runtimeStateDelta.chapter).toBe(22);
  });

  it("accepts an unfenced JSON object surrounded by harmless prose", () => {
    const result = parseSettlerDeltaOutput([
      "=== RUNTIME_STATE_DELTA ===",
      "Delta JSON:",
      JSON.stringify({
        chapter: 23,
        hookOps: {
          upsert: [],
          mention: [],
          resolve: [],
          defer: [],
        },
        notes: [],
      }),
      "Kết thúc.",
    ].join("\n"));

    expect(result.runtimeStateDelta.chapter).toBe(23);
  });

  it("parses new hook candidates separately from existing hook ops", () => {
    const result = parseSettlerDeltaOutput([
      "=== RUNTIME_STATE_DELTA ===",
      "```json",
      JSON.stringify({
        chapter: 21,
        hookOps: {
          upsert: [],
          mention: ["mentor-oath"],
          resolve: [],
          defer: [],
        },
        newHookCandidates: [
          {
            type: "source-risk",
            expectedPayoff: "Reveal what the anonymous source already knew about the route and address",
            notes: "This chapter opens a fresh unresolved question about source knowledge.",
          },
        ],
        notes: [],
      }),
      "```",
    ].join("\n"));

    expect(result.runtimeStateDelta.hookOps.upsert).toEqual([]);
    expect(result.runtimeStateDelta.newHookCandidates).toEqual([
      expect.objectContaining({
        type: "source-risk",
      }),
    ]);
  });

  it("coerces common model-shaped deltas before schema validation", () => {
    const result = parseSettlerDeltaOutput([
      "=== RUNTIME_STATE_DELTA ===",
      "```json",
      JSON.stringify({
        chapter: "23",
        hookOps: {
          upsert: [],
          mention: [],
          resolve: [],
          defer: [
            { hookId: "mentor-oath", reason: "chưa lộ tín hiệu" },
            "ledger-open",
          ],
        },
        newHookCandidates: [
          "source-risk",
          {
            type: "source-risk",
            expectedPayoff: "Reveal what the anonymous source already knew",
            notes: "Fresh unresolved question.",
          },
        ],
        notes: [],
      }),
      "```",
    ].join("\n"));

    expect(result.runtimeStateDelta.chapter).toBe(23);
    expect(result.runtimeStateDelta.hookOps.defer).toEqual(["mentor-oath", "ledger-open"]);
    expect(result.runtimeStateDelta.newHookCandidates).toHaveLength(2);
  });
});
