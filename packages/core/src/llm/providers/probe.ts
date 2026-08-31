import { fetchWithProxy } from "../../utils/proxy-fetch.js";

/**
 * 通用 OpenAI 兼容 /models 探针。
 * 任何失败（网络错、超时、非 JSON、非 2xx）一律返回空数组，不抛异常。
 */

export interface ProbedModel {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
}

/**
 * A deliberately small, response-shape-only probe for an OpenAI-compatible
 * chat endpoint. It is intended to distinguish an upstream response-contract
 * failure from an InkOS state/persistence failure without retaining prompts,
 * response text, headers or credentials.
 */
export type ChatProbeOutcome =
  | "final-answer"
  | "reasoning-only"
  | "empty"
  | "output-limit"
  | "policy-block"
  | "http-error"
  | "invalid-json"
  | "network-error"
  | "invalid-request";

export interface ChatProbeResult {
  readonly ok: boolean;
  readonly outcome: ChatProbeOutcome;
  readonly stream: boolean;
  readonly contentPresent: boolean;
  readonly reasoningPresent: boolean;
  readonly httpStatus?: number;
  readonly finishReason?: string;
  readonly latencyMs: number;
  /** Error name only; the provider's error text is intentionally discarded. */
  readonly errorName?: string;
}

export interface ChatProbeOptions {
  readonly stream?: boolean;
  readonly reasoningEffort?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly timeoutMs?: number;
  readonly proxyUrl?: string;
}

const PROBE_PROMPT = "Respond with exactly OK.";

function hasText(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((part) => hasText(part));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return hasText(record.text) || hasText(record.content) || hasText(record.value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function safeFinishReason(value: unknown): string | undefined {
  const reason = firstString(value);
  if (!reason || reason.length > 64 || /[\u0000-\u001f\u007f]/u.test(reason)) return undefined;
  return reason;
}

function classifyFinishReason(reason: string | undefined): ChatProbeOutcome | undefined {
  const normalized = reason?.toLowerCase().replaceAll("-", "_");
  if (!normalized) return undefined;
  if (["length", "max_tokens", "max_output_tokens", "max_output"].includes(normalized)) return "output-limit";
  if (["content_filter", "contentfilter", "safety_filter", "safety"].includes(normalized)) return "policy-block";
  return undefined;
}

function chatProbeResult(
  startedAt: number,
  stream: boolean,
  values: {
    readonly outcome: ChatProbeOutcome;
    readonly contentPresent?: boolean;
    readonly reasoningPresent?: boolean;
    readonly httpStatus?: number;
    readonly finishReason?: string;
    readonly errorName?: string;
  },
): ChatProbeResult {
  return {
    ok: values.outcome === "final-answer",
    outcome: values.outcome,
    stream,
    contentPresent: values.contentPresent ?? false,
    reasoningPresent: values.reasoningPresent ?? false,
    ...(values.httpStatus !== undefined ? { httpStatus: values.httpStatus } : {}),
    ...(values.finishReason !== undefined ? { finishReason: values.finishReason } : {}),
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    ...(values.errorName ? { errorName: values.errorName } : {}),
  };
}

function classifyResponseShape(
  contentPresent: boolean,
  reasoningPresent: boolean,
  finishReason: string | undefined,
): ChatProbeOutcome {
  const finishOutcome = classifyFinishReason(finishReason);
  if (finishOutcome) return finishOutcome;
  if (contentPresent) return "final-answer";
  if (reasoningPresent) return "reasoning-only";
  return "empty";
}

function classifyJsonMessage(json: unknown): {
  readonly contentPresent: boolean;
  readonly reasoningPresent: boolean;
  readonly finishReason?: string;
} {
  const root = asRecord(json) ?? {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.message) ?? asRecord(choice?.delta) ?? asRecord(root.message);
  const contentPresent = hasText(choice?.text) || hasText(message?.content) || hasText(root.content);
  const reasoningPresent = [
    choice?.reasoning_content,
    choice?.reasoning,
    message?.reasoning_content,
    message?.reasoning,
    message?.thinking,
    root.reasoning_content,
    root.reasoning,
    root.thinking,
  ].some((value) => hasText(value));
  return {
    contentPresent,
    reasoningPresent,
    finishReason: safeFinishReason(choice?.finish_reason ?? root.finish_reason ?? root.stop_reason),
  };
}

function parseSseShape(raw: string): {
  readonly contentPresent: boolean;
  readonly reasoningPresent: boolean;
  readonly finishReason?: string;
} {
  let contentPresent = false;
  let reasoningPresent = false;
  let finishReason: string | undefined;
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const shape = classifyJsonMessage(JSON.parse(data));
      contentPresent ||= shape.contentPresent;
      reasoningPresent ||= shape.reasoningPresent;
      finishReason ??= shape.finishReason;
    } catch {
      // A malformed event is reported by the caller as invalid-json.
      throw new SyntaxError("invalid SSE JSON");
    }
  }
  return { contentPresent, reasoningPresent, ...(finishReason ? { finishReason } : {}) };
}

/**
 * Probe the exact OpenAI-compatible /chat/completions response contract with
 * a fixed, non-sensitive prompt. The return value contains only booleans,
 * bounded status metadata and an error name; it never exposes response text.
 */
export async function probeChatContract(
  baseUrl: string,
  apiKey: string,
  model: string,
  options: ChatProbeOptions = {},
): Promise<ChatProbeResult> {
  const stream = options.stream ?? false;
  const startedAt = performance.now();
  if (!baseUrl.trim() || !model.trim()) {
    return chatProbeResult(startedAt, stream, { outcome: "invalid-request" });
  }

  const payload: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: PROBE_PROMPT }],
    stream,
    temperature: options.temperature ?? 0,
    max_tokens: Math.max(1, Math.floor(options.maxTokens ?? 16)),
  };
  if (options.reasoningEffort !== undefined) payload.reasoning_effort = options.reasoningEffort;

  try {
    const response = await fetchWithProxy(
      `${baseUrl.replace(/\/$/u, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      },
      options.proxyUrl,
    );
    if (!response.ok) {
      return chatProbeResult(startedAt, stream, { outcome: "http-error", httpStatus: response.status });
    }

    if (stream) {
      const raw = await response.text();
      let shape: ReturnType<typeof parseSseShape>;
      try {
        shape = parseSseShape(raw);
      } catch (error) {
        return chatProbeResult(startedAt, stream, {
          outcome: "invalid-json",
          httpStatus: response.status,
          errorName: error instanceof Error ? error.name : "SyntaxError",
        });
      }
      return chatProbeResult(startedAt, stream, {
        outcome: classifyResponseShape(shape.contentPresent, shape.reasoningPresent, shape.finishReason),
        contentPresent: shape.contentPresent,
        reasoningPresent: shape.reasoningPresent,
        httpStatus: response.status,
        finishReason: shape.finishReason,
      });
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      return chatProbeResult(startedAt, stream, {
        outcome: "invalid-json",
        httpStatus: response.status,
        errorName: error instanceof Error ? error.name : "SyntaxError",
      });
    }
    const shape = classifyJsonMessage(json);
    return chatProbeResult(startedAt, stream, {
      outcome: classifyResponseShape(shape.contentPresent, shape.reasoningPresent, shape.finishReason),
      contentPresent: shape.contentPresent,
      reasoningPresent: shape.reasoningPresent,
      httpStatus: response.status,
      finishReason: shape.finishReason,
    });
  } catch (error) {
    return chatProbeResult(startedAt, stream, {
      outcome: "network-error",
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export async function probeModelsFromUpstream(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 10_000,
): Promise<ReadonlyArray<ProbedModel>> {
  if (!baseUrl) return [];
  try {
    const modelsUrl = baseUrl.replace(/\/$/, "") + "/models";
    const res = await fetchWithProxy(modelsUrl, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id: unknown }> };
    if (!Array.isArray(json.data)) return [];
    return json.data
      .filter((m): m is { id: string } => typeof m.id === "string" && m.id.length > 0)
      .map((m) => ({ id: m.id, name: m.id, contextWindow: 0 }));
  } catch {
    return [];
  }
}
