import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadProjectConfig } from "../utils/config-loader.js";
import { resolveServiceModel } from "../llm/service-resolver.js";
import { chatCompletion, createLLMClient, LLMError } from "../llm/provider.js";

const TEST_PARENT = "C:/tmp/CodexScratch/2026-08-30-phase-a-offline-evidence-45356b6-1914/test-tmp";
const SENTINEL_KEY = "unit-test-credential";
const ENV_KEYS = [
  "INKOS_LLM_SERVICE",
  "INKOS_LLM_PROVIDER",
  "INKOS_LLM_BASE_URL",
  "INKOS_LLM_MODEL",
  "INKOS_LLM_API_KEY",
  "INKOS_LLM_API_FORMAT",
  "INKOS_LLM_STREAM",
  "INKOS_LLM_HEADERS",
  "INKOS_DEFAULT_LANGUAGE",
] as const;

function phaseAMeta(ctx: { task: { meta: unknown } }, value: Record<string, unknown>): void {
  (ctx.task.meta as Record<string, unknown>).phaseA = value;
}

function sseResponse(): Response {
  const encoder = new TextEncoder();
  const payload = [
    `data: ${JSON.stringify({ id: "synthetic-response", choices: [{ delta: { content: "ok" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("Phase A Internal custom routing characterization", () => {
  let root = "";
  const previousEnv = new Map<string, string | undefined>();

  beforeEach(async () => {
    await mkdir(TEST_PARENT, { recursive: true });
    root = await mkdtemp(join(TEST_PARENT, "internal-routing-"));
    for (const key of ENV_KEYS) {
      previousEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      name: "phase-a-internal-routing",
      version: "0.1.0",
      language: "en",
      llm: {
        provider: "custom",
        service: "custom",
        configSource: "studio",
        baseUrl: "http://localhost:56154/v1",
        model: "gpt-5-6-luna",
        defaultModel: "gpt-5-6-luna",
        apiFormat: "chat",
        stream: true,
        services: [{
          service: "custom",
          name: "Internal",
          baseUrl: "http://localhost:56154/v1",
          models: ["gpt-5-6-luna"],
          apiFormat: "chat",
          stream: true,
        }],
      },
      notify: [],
    }, null, 2), "utf8");
    await mkdir(join(root, ".inkos"), { recursive: true });
    await writeFile(join(root, ".inkos", "secrets.json"), JSON.stringify({
      services: {
        "custom:Internal": { apiKey: SENTINEL_KEY },
        "custom:Other": { apiKey: "other-unit-credential" },
      },
    }, null, 2), "utf8");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previousEnv.clear();
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("resolves Internal through Studio config and native chat transport", async (ctx) => {
    const config = await loadProjectConfig(root, { consumer: "studio" });
    const resolved = await resolveServiceModel(
      "custom:Internal",
      "gpt-5-6-luna",
      root,
      "http://localhost:56154/v1",
      "chat",
    );
    const client = createLLMClient(config.llm);

    expect(config.llm.service).toBe("custom");
    expect(config.llm.provider).toBe("custom");
    expect(config.llm.model).toBe("gpt-5-6-luna");
    expect(config.llm.configSource).toBe("studio");
    expect(config.llm.baseUrl).toBe("http://localhost:56154/v1");
    expect(config.llm.apiFormat).toBe("chat");
    expect(config.llm.stream).toBe(true);
    expect(client.service).toBe("custom");
    expect(client.provider).toBe("openai");
    expect(client.configSource).toBe("studio");
    expect(client.apiFormat).toBe("chat");
    expect(client.stream).toBe(true);
    expect(client._piModel?.id).toBe("gpt-5-6-luna");
    expect(client._piModel?.provider).toBe("openai");
    expect(client._piModel?.api).toBe("openai-completions");
    expect(client._piModel?.baseUrl).toBe("http://localhost:56154/v1");
    expect(resolved.apiKey).toBe(SENTINEL_KEY);
    expect(client._apiKey).toBe(SENTINEL_KEY);
    expect(resolved.apiKey).toBe(client._apiKey);
    expect(resolved.model.id).toBe("gpt-5-6-luna");
    expect(resolved.model.provider).toBe("openai");
    expect(resolved.model.api).toBe("openai-completions");
    expect(resolved.model.baseUrl).toBe("http://localhost:56154/v1");

    let requestCount = 0;
    let credentialForwarded = false;
    let wireModelId: string | undefined;
    let finalEndpoint = "";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestCount += 1;
      finalEndpoint = String(input);
      const headers = new Headers(init?.headers);
      credentialForwarded = headers.get("authorization") === `Bearer ${SENTINEL_KEY}`;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      wireModelId = typeof body.model === "string" ? body.model : undefined;
      expect(init?.method).toBe("POST");
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
      return sseResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatCompletion(client, "gpt-5-6-luna", [{ role: "user", content: "synthetic" }]);
    expect(result.content).toBe("ok");
    expect(requestCount).toBe(1);
    expect(finalEndpoint).toBe("http://localhost:56154/v1/chat/completions");
    expect(wireModelId).toBe("gpt-5-6-luna");
    expect(credentialForwarded).toBe(true);

    phaseAMeta(ctx, {
      scenario: "internal-chat-success",
      configuredServiceKey: "custom:Internal",
      normalizedClientService: client.service,
      configuredProvider: config.llm.provider,
      effectiveProvider: client.provider,
      transportProvider: "openai",
      requestedModelId: "gpt-5-6-luna",
      effectiveModelId: config.llm.model,
      wireModelId,
      resolvedPiModelId: resolved.model.id,
      configSource: client.configSource,
      baseHost: new URL(config.llm.baseUrl).host,
      basePath: new URL(config.llm.baseUrl).pathname,
      apiFormat: client.apiFormat,
      stream: client.stream,
      transportSeam: "native-custom-openai-compatible",
      finalEndpoint,
      credentialSource: "studio-secret",
      keyPresent: resolved.apiKey.length > 0,
      sameSyntheticCredential: resolved.apiKey === client._apiKey,
      credentialForwarded,
      httpStatus: 200,
      retryable: false,
      requestCount,
      transportRetries: result.retryCounts?.transport ?? 0,
      outputRetries: result.retryCounts?.output ?? 0,
      qualityRetries: result.retryCounts?.quality ?? 0,
      secretRedacted: true,
      liveCredentialParityProven: false,
      observationLevel: "intercepted-native-mock",
    });
  });

  it("fails closed on model-scope 404 without retry or partial success", async (ctx) => {
    const config = await loadProjectConfig(root, { consumer: "studio" });
    const client = createLLMClient(config.llm);
    let requestCount = 0;
    let credentialForwarded = false;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestCount += 1;
      const headers = new Headers(init?.headers);
      credentialForwarded = headers.get("authorization") === `Bearer ${SENTINEL_KEY}`;
      return new Response(JSON.stringify({ detail: "model unavailable for this credential" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    let captured: unknown;
    try {
      await chatCompletion(client, "gpt-5-6-luna", [{ role: "user", content: "synthetic" }]);
    } catch (caught) {
      captured = caught;
    }
    expect(captured).toBeInstanceOf(LLMError);
    const llmError = captured as LLMError;
    expect(llmError.status).toBe(404);
    expect(llmError.retryable).toBe(false);
    expect(requestCount).toBe(1);
    expect(llmError.retryCounts.transport).toBe(0);
    expect(llmError.retryCounts.output).toBe(0);
    expect(llmError.retryCounts.quality).toBe(0);
    expect(llmError.message).not.toContain(SENTINEL_KEY);

    phaseAMeta(ctx, {
      scenario: "internal-chat-model-scope-404",
      configuredServiceKey: "custom:Internal",
      normalizedClientService: client.service,
      configuredProvider: config.llm.provider,
      effectiveProvider: client.provider,
      transportProvider: "openai",
      requestedModelId: "gpt-5-6-luna",
      effectiveModelId: config.llm.model,
      resolvedPiModelId: client._piModel?.id,
      configSource: client.configSource,
      baseHost: new URL(config.llm.baseUrl).host,
      basePath: new URL(config.llm.baseUrl).pathname,
      apiFormat: client.apiFormat,
      stream: client.stream,
      transportSeam: "native-custom-openai-compatible",
      credentialSource: "studio-secret",
      keyPresent: Boolean(client._apiKey),
      sameSyntheticCredential: client._apiKey === SENTINEL_KEY,
      credentialForwarded,
      httpStatus: llmError.status,
      retryable: llmError.retryable,
      requestCount,
      transportRetries: llmError.retryCounts.transport,
      outputRetries: llmError.retryCounts.output,
      qualityRetries: llmError.retryCounts.quality,
      secretRedacted: !llmError.message.includes(SENTINEL_KEY),
      liveCredentialParityProven: false,
      observationLevel: "intercepted-native-mock",
    });
  });

  it("keeps distinct synthetic service credentials and model identities distinguishable", async () => {
    const internal = await resolveServiceModel("custom:Internal", "gpt-5-6-luna", root, "http://localhost:56154/v1", "chat");
    const other = await resolveServiceModel("custom:Other", "other-model", root, "http://localhost:56155/v1", "chat");

    expect(internal.apiKey).toBe(SENTINEL_KEY);
    expect(other.apiKey).toBe("other-unit-credential");
    expect(internal.apiKey).not.toBe(other.apiKey);
    expect(internal.model.id).toBe("gpt-5-6-luna");
    expect(other.model.id).toBe("other-model");
    expect(internal.model.id).not.toBe(other.model.id);
    expect(internal.model.baseUrl).not.toBe(other.model.baseUrl);
  });
});
