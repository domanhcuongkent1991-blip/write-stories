import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  probeChatContract,
  probeModelsFromUpstream,
  type ChatProbeResult,
} from "../llm/providers/probe.js";

describe("probeModelsFromUpstream", () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("正常响应返回 ProbedModel 数组", async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-4" }, { id: "gpt-3.5" }] }),
    });
    const result = await probeModelsFromUpstream("https://api.example.com/v1", "sk-test");
    expect(result).toEqual([
      { id: "gpt-4", name: "gpt-4", contextWindow: 0 },
      { id: "gpt-3.5", name: "gpt-3.5", contextWindow: 0 },
    ]);
  });

  it("非 2xx 返回空数组", async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: false });
    const result = await probeModelsFromUpstream("https://api.example.com/v1", "sk-test");
    expect(result).toEqual([]);
  });

  it("fetch 抛错返回空数组", async () => {
    (globalThis.fetch as any).mockRejectedValue(new Error("network down"));
    const result = await probeModelsFromUpstream("https://api.example.com/v1", "sk-test");
    expect(result).toEqual([]);
  });

  it("响应 json.data 不是数组返回空数组", async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: "not-an-array" }),
    });
    const result = await probeModelsFromUpstream("https://api.example.com/v1", "sk-test");
    expect(result).toEqual([]);
  });

  it("baseUrl 空直接返回空数组,不发请求", async () => {
    const r1 = await probeModelsFromUpstream("", "sk-test");
    expect(r1).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("apiKey 空时仍可探测不需要鉴权的本地模型端点", async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "qwen3.6:35b-a3b" }] }),
    });

    const result = await probeModelsFromUpstream("http://localhost:11434/v1", "");

    expect(result).toEqual([{ id: "qwen3.6:35b-a3b", name: "qwen3.6:35b-a3b", contextWindow: 0 }]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:11434/v1/models",
      expect.objectContaining({ headers: {} }),
    );
  });

  it("过滤掉 id 非字符串的 entry", async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "valid" }, { id: null }, { id: 123 }, {}] }),
    });
    const result = await probeModelsFromUpstream("https://api.example.com/v1", "sk-test");
    expect(result).toEqual([{ id: "valid", name: "valid", contextWindow: 0 }]);
  });
});

describe("probeChatContract", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reports a non-stream final answer without retaining response text", async () => {
    (globalThis.fetch as any).mockResolvedValue(new Response(JSON.stringify({
      id: "response-1",
      choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await probeChatContract("https://api.example.com/v1", "sk-test", "gemini-test");

    expect(result).toMatchObject<Partial<ChatProbeResult>>({
      ok: true,
      outcome: "final-answer",
      stream: false,
      contentPresent: true,
      reasoningPresent: false,
      httpStatus: 200,
      finishReason: "stop",
    });
    expect(result).not.toHaveProperty("content");
    expect(result).not.toHaveProperty("response");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"stream":false'),
      }),
    );
  });

  it("classifies reasoning-only non-stream output as an external contract failure", async () => {
    (globalThis.fetch as any).mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "", reasoning_content: "internal reasoning" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(probeChatContract("https://api.example.com/v1", "sk-test", "gemini-test"))
      .resolves.toMatchObject({
        ok: false,
        outcome: "reasoning-only",
        contentPresent: false,
        reasoningPresent: true,
        httpStatus: 200,
      });
  });

  it("classifies stream final and reasoning deltas without returning their text", async () => {
    const payload = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "think" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "OK" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    (globalThis.fetch as any).mockResolvedValue(new Response(payload, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    const result = await probeChatContract("https://api.example.com/v1", "sk-test", "gemini-test", {
      stream: true,
      reasoningEffort: "none",
    });

    expect(result).toMatchObject({
      ok: true,
      outcome: "final-answer",
      stream: true,
      contentPresent: true,
      reasoningPresent: true,
      finishReason: "stop",
    });
    const requestBody = JSON.parse(String((globalThis.fetch as any).mock.calls[0]?.[1]?.body));
    expect(requestBody).toMatchObject({ stream: true, reasoning_effort: "none" });
  });

  it("returns only status metadata for HTTP, JSON and network failures", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(new Response("provider detail with secret", { status: 503 }));
    await expect(probeChatContract("https://api.example.com/v1", "sk-test", "gemini-test"))
      .resolves.toMatchObject({ ok: false, outcome: "http-error", httpStatus: 503 });

    (globalThis.fetch as any).mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    await expect(probeChatContract("https://api.example.com/v1", "sk-test", "gemini-test"))
      .resolves.toMatchObject({ ok: false, outcome: "invalid-json", httpStatus: 200 });

    (globalThis.fetch as any).mockRejectedValueOnce(new Error("secret-bearing network detail"));
    const network = await probeChatContract("https://api.example.com/v1", "sk-test", "gemini-test");
    expect(network).toMatchObject({ ok: false, outcome: "network-error" });
    expect(network).not.toHaveProperty("errorMessage");
  });

  it("does not make a request when base URL or model is missing", async () => {
    await expect(probeChatContract("", "sk-test", "gemini-test"))
      .resolves.toMatchObject({ ok: false, outcome: "invalid-request" });
    await expect(probeChatContract("https://api.example.com/v1", "sk-test", ""))
      .resolves.toMatchObject({ ok: false, outcome: "invalid-request" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
