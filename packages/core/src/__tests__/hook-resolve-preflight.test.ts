import { afterEach, describe, expect, it, vi } from "vitest";
import { HookResolvePreflightAgent, HookResolvePreflightError } from "../agents/hook-resolve-preflight.js";
import type { LLMClient } from "../llm/provider.js";
import * as llmProvider from "../llm/provider.js";
import { hashCanonicalHookPayoff, type HookOperationIntentV2 } from "../models/hook-operation-intent.js";

const STUB_CLIENT: LLMClient = {
  provider: "openai",
  apiFormat: "chat",
  stream: false,
  defaults: { temperature: 0, maxTokens: 2048, thinkingBudget: 0, maxTokensCap: null, extra: {} },
};

function makeAgent(): HookResolvePreflightAgent {
  return new HookResolvePreflightAgent({
    client: STUB_CLIENT,
    model: "test-model",
    projectRoot: "D:/InkOS/write-stories",
  });
}

function contract(action: "advance" | "resolve"): HookOperationIntentV2 {
  const expectedPayoff = action === "resolve"
    ? "Confirm the physical signal-manipulation device"
    : "Identify the actor behind the remote administrator lock";
  const hookId = action === "resolve" ? "H006" : "sabotage-sau-can-thi-thu";
  return {
    schemaVersion: 2,
    operations: [{
      hookId,
      action,
      canonicalExpectedPayoff: expectedPayoff,
      canonicalPayoffHash: hashCanonicalHookPayoff(hookId, expectedPayoff),
      plannedEvidence: action === "resolve" ? "The inspection confirms the device" : "Actor remains unknown",
    }],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HookResolvePreflightAgent", () => {
  it("makes no provider call when the contract contains no resolve", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion");

    const result = await makeAgent().validate({
      contract: contract("advance"),
      chapterGoal: "Keep the actor unresolved.",
      relevantMemoBeat: "The actor remains outside the chapter's evidence.",
    });

    expect(result).toEqual({ results: [] });
    expect(chatSpy).not.toHaveBeenCalled();
  });

  it("returns one strict result for each resolve hook", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: JSON.stringify({ results: [{ hookId: "H006", decision: "pass" }] }),
      usage: { promptTokens: 11, completionTokens: 3, totalTokens: 14 },
    } as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    await expect(makeAgent().validate({
      contract: contract("resolve"),
      chapterGoal: "Confirm only the physical device.",
      relevantMemoBeat: "The inspection scene stays focused on the device.",
    })).resolves.toEqual({
      results: [{ hookId: "H006", decision: "pass" }],
      tokenUsage: { promptTokens: 11, completionTokens: 3, totalTokens: 14 },
    });
    const call = chatSpy.mock.calls[0];
    expect(call?.[1]).toBe("test-model");
    expect(call?.[2]).toEqual(expect.any(Array));
    expect(call?.[3]).toEqual(expect.objectContaining({
      temperature: 0,
      structuredOutput: expect.objectContaining({ name: "hook_resolve_preflight" }),
    }));
    const userMessage = (chatSpy.mock.calls[0]?.[2] as Array<{ role: string; content: string }>)
      .find((message) => message.role === "user");
    expect(JSON.parse(userMessage?.content ?? "{}")).toMatchObject({
      chapterGoal: "Confirm only the physical device.",
      resolves: [{ relevantMemoBeat: "The inspection scene stays focused on the device." }],
    });
  });

  it("normalizes a single-result gateway envelope without weakening hook validation", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: JSON.stringify({
        hookId: "H006",
        decision: "pass",
        status: "completed",
        processed: true,
      }),
      usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
    } as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    await expect(makeAgent().validate({
      contract: contract("resolve"),
      chapterGoal: "Confirm only the physical device.",
      relevantMemoBeat: "The inspection scene stays focused on the device.",
    })).resolves.toMatchObject({
      results: [{ hookId: "H006", decision: "pass" }],
    });
    expect(chatSpy).toHaveBeenCalledTimes(1);
  });

  it("unwraps one whole-response JSON fence without accepting trailing prose", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValueOnce({
      content: `\`\`\`json\n${JSON.stringify({ hookId: "H006", decision: "pass" })}\n\`\`\``,
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    } as Awaited<ReturnType<typeof llmProvider.chatCompletion>>).mockResolvedValueOnce({
      content: `\`\`\`json\n${JSON.stringify({ hookId: "H006", decision: "pass" })}\n\`\`\`\nextra`,
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    } as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    await expect(makeAgent().validate({
      contract: contract("resolve"),
      chapterGoal: "Confirm only the physical device.",
      relevantMemoBeat: "The inspection scene stays focused on the device.",
    })).resolves.toMatchObject({ results: [{ hookId: "H006", decision: "pass" }] });
    await expect(makeAgent().validate({
      contract: contract("resolve"),
      chapterGoal: "Confirm only the physical device.",
      relevantMemoBeat: "The inspection scene stays focused on the device.",
    })).rejects.toBeInstanceOf(HookResolvePreflightError);
    expect(chatSpy).toHaveBeenCalledTimes(2);
  });

  it("fails closed on malformed, missing, duplicate, or extra result IDs", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion");
    for (const content of [
      "not-json",
      JSON.stringify({ results: [] }),
      JSON.stringify({ results: [
        { hookId: "H006", decision: "pass" },
        { hookId: "H006", decision: "pass" },
      ] }),
      JSON.stringify({ results: [
        { hookId: "H006", decision: "pass" },
        { hookId: "H999", decision: "pass" },
      ] }),
      JSON.stringify({ hookId: "H006", decision: "pass", unexpected: true }),
    ]) {
      chatSpy.mockResolvedValueOnce({
        content,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      } as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);
      await expect(makeAgent().validate({
        contract: contract("resolve"),
        chapterGoal: "Confirm only the physical device.",
        relevantMemoBeat: "The inspection scene stays focused on the device.",
      })).rejects.toBeInstanceOf(HookResolvePreflightError);
    }
  });
});
