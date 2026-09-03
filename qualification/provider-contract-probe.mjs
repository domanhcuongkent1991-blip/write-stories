import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  isQualificationProviderRequest,
  resolveQualificationCredential,
  resolveQualificationProviderConfig,
} from "./promotion-runner-scope.mjs";

const worktreeRoot = "C:/tmp/CodexScratch/2026-09-01-inkos-promotion-hardening";
const baselineRoot = "C:/Users/Admin/Documents/Codex/InkOS/vi-writing-sandbox";
const providerConfig = resolveQualificationProviderConfig(process.env);
const { baseUrl, baseHost, basePath, serviceKey, model } = providerConfig;
const maxAttempts = 6;
const timeoutMs = 30_000;
const core = await import(pathToFileURL(`${worktreeRoot}/packages/core/dist/index.js`).href);
const { chatCompletion, createLLMClient, probeModelsFromUpstream } = core;
const secrets = JSON.parse(await readFile(`${baselineRoot}/.inkos/secrets.json`, "utf8"));
const credential = resolveQualificationCredential({
  environmentApiKey: process.env.INKOS_QUALIFICATION_API_KEY,
  services: secrets.services,
  serviceKey,
});
const { apiKey } = credential;

const structuredOutput = {
  name: "hook_resolve_preflight",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["hookId", "decision"],
          properties: {
            hookId: { type: "string", minLength: 1 },
            decision: { enum: ["pass", "repair-required", "inconclusive"] },
          },
        },
      },
    },
  },
};

const cells = [
  {
    id: "tiny-plain",
    stream: false,
    messages: [
      { role: "system", content: "Return a final answer containing only the word OK." },
      { role: "user", content: "ping" },
    ],
  },
  {
    id: "tiny-plain-stream",
    stream: true,
    messages: [
      { role: "system", content: "Return a final answer containing only the word OK." },
      { role: "user", content: "ping" },
    ],
  },
  {
    id: "strict-hook-json",
    stream: false,
    messages: [
      { role: "system", content: "Validate the supplied hook evidence and return only the requested structured result." },
      {
        role: "user",
        content: JSON.stringify({
          chapterGoal: "Continue the field inspection and resolve the TN-04 seal mystery.",
          resolves: [{
            hookId: "H003",
            canonicalExpectedPayoff: "Technician Tuan finds non-standard contractor security seals on the physical TN-04 sluice controls",
            plannedEvidence: "Technician Tuan identifies the non-standard contractor seals on the TN-04 sluice controls.",
            relevantMemoBeat: "Tuan identifies and documents the contractor seals on the physical sluice controls.",
          }],
        }),
      },
    ],
    structuredOutput,
  },
  {
    id: "strict-hook-json-stream",
    stream: true,
    messages: [
      { role: "system", content: "Validate the supplied hook evidence and return only the requested structured result." },
      {
        role: "user",
        content: JSON.stringify({
          chapterGoal: "Continue the field inspection and resolve the TN-04 seal mystery.",
          resolves: [{
            hookId: "H003",
            canonicalExpectedPayoff: "Technician Tuan finds non-standard contractor security seals on the physical TN-04 sluice controls",
            plannedEvidence: "Technician Tuan identifies the non-standard contractor seals on the TN-04 sluice controls.",
            relevantMemoBeat: "Tuan identifies and documents the contractor seals on the physical sluice controls.",
          }],
        }),
      },
    ],
    structuredOutput,
  },
];

let attempts = 0;
const observations = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const requestUrl = typeof Request !== "undefined" && input instanceof Request ? input.url : String(input);
  if (!isQualificationProviderRequest(requestUrl, baseUrl)) return originalFetch(input, init);
  attempts += 1;
  if (attempts > maxAttempts) {
    const error = new Error(`provider contract probe exceeded ${maxAttempts} attempts`);
    error.code = "PROBE_BUDGET_EXCEEDED";
    throw error;
  }
  return originalFetch(input, init);
};

function safeError(error) {
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    code: error && typeof error === "object" && typeof error.code === "string" ? error.code : null,
    message: error instanceof Error ? error.message : String(error),
  };
}

function parseStructuredShape(content) {
  const trimmed = content.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  const parsed = JSON.parse(unfenced);
  const validObject = Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  const results = validObject && Array.isArray(parsed.results) ? parsed.results : [];
  const validResults = results.length > 0 && results.every((item) => (
    item && typeof item === "object"
    && typeof item.hookId === "string"
    && ["pass", "repair-required", "inconclusive"].includes(item.decision)
  ));
  if (!validObject || !validResults) throw new Error("structured response shape is not provider-consumable");
  return { object: true, keys: Object.keys(parsed).sort(), resultsCount: results.length, fenced: unfenced !== trimmed };
}

async function runCell(cell) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("provider contract probe timeout")), timeoutMs);
  const client = createLLMClient({
    provider: "custom",
    service: serviceKey,
    baseUrl,
    apiKey,
    model,
    temperature: 0,
    thinkingBudget: 0,
    apiFormat: "chat",
    stream: cell.stream,
    extra: { reasoning_effort: "none" },
  });
  const started = performance.now();
  try {
    const response = await chatCompletion(client, model, cell.messages, {
      temperature: 0,
      maxTokens: cell.structuredOutput ? 512 : 32,
      signal: controller.signal,
      firstEventTimeoutMs: timeoutMs,
      streamIdleTimeoutMs: timeoutMs,
      ...(cell.structuredOutput ? { structuredOutput: cell.structuredOutput } : {}),
      retry: false,
    });
    const content = response.content.trim();
    if (!content) throw new Error("provider returned no final content");
    const shape = cell.structuredOutput ? parseStructuredShape(content) : { contentPresent: true };
    return {
      id: cell.id,
      stream: cell.stream,
      payloadKind: cell.structuredOutput ? "strict-hook-json" : "tiny-plain",
      inputChars: cell.messages.reduce((sum, message) => sum + message.content.length, 0),
      structuredOutput: Boolean(cell.structuredOutput),
      reasoningEffort: "none",
      ok: true,
      contentLength: content.length,
      shape,
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      id: cell.id,
      stream: cell.stream,
      payloadKind: cell.structuredOutput ? "strict-hook-json" : "tiny-plain",
      inputChars: cell.messages.reduce((sum, message) => sum + message.content.length, 0),
      structuredOutput: Boolean(cell.structuredOutput),
      reasoningEffort: "none",
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      error: safeError(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

const result = {
  model,
  serviceKey,
  baseHost,
  basePath,
  credentialSource: credential.source,
  maxAttempts,
  timeoutMs,
  attempts: 0,
  modelPresent: false,
  cells: [],
  pass: false,
};
try {
  const models = await probeModelsFromUpstream(baseUrl, apiKey, timeoutMs);
  result.modelPresent = models.some((entry) => entry.id === model);
  if (!result.modelPresent) throw new Error(`model ${model} is not present in provider model list`);
  for (const cell of cells) {
    const observation = await runCell(cell);
    result.cells.push(observation);
    if (!observation.ok) break;
  }
  result.pass = result.modelPresent && result.cells.length === cells.length && result.cells.every((cell) => cell.ok);
} catch (error) {
  result.error = safeError(error);
}
result.attempts = attempts;
console.log(JSON.stringify(result));
process.exitCode = result.pass ? 0 : 1;
