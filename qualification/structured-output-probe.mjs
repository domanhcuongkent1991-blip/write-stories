import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const worktreeRoot = "C:/tmp/CodexScratch/2026-09-01-inkos-promotion-hardening";
const baselineRoot = "C:/Users/Admin/Documents/Codex/InkOS/vi-writing-sandbox";
const core = await import(pathToFileURL(`${worktreeRoot}/packages/core/dist/index.js`).href);
const { chatCompletion, createLLMClient } = core;
const { HookResolvePreflightAgent } = await import(
  pathToFileURL(`${worktreeRoot}/packages/core/dist/agents/hook-resolve-preflight.js`).href,
);
const secrets = JSON.parse(await readFile(`${baselineRoot}/.inkos/secrets.json`, "utf8"));
const apiKey = secrets.services?.["custom:Ecoapi"]?.apiKey;
if (typeof apiKey !== "string" || apiKey.length === 0) throw new Error("Ecoapi key is not configured");

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
            decision: { const: "pass" },
          },
        },
      },
    },
  },
};

const messages = [
  { role: "system", content: "Return strict JSON only with the requested schema." },
  { role: "user", content: JSON.stringify({ hookId: "H003", decision: "pass" }) },
];

for (const stream of [false, true]) {
  const client = createLLMClient({
    provider: "custom",
    service: "custom:Ecoapi",
    baseUrl: "https://ecoapi.net/v1",
    apiKey,
    model: "gemini-3-6-flash-high",
    temperature: 0,
    thinkingBudget: 0,
    apiFormat: "chat",
    stream,
    extra: { reasoning_effort: "none" },
  });
  try {
    const response = await chatCompletion(client, "gemini-3-6-flash-high", messages, {
      temperature: 0,
      maxTokens: 128,
      structuredOutput,
    });
    const content = response.content.trim();
    let jsonShape = null;
    try {
      const parsed = JSON.parse(content);
      jsonShape = {
        object: Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed)),
        keys: parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? Object.keys(parsed).sort()
          : [],
      };
    } catch {
      jsonShape = { object: false, keys: [] };
    }
    console.log(JSON.stringify({ stream, ok: true, contentLength: content.length, jsonShape }));
  } catch (error) {
    console.log(JSON.stringify({
      stream,
      ok: false,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorCode: error && typeof error === "object" && typeof error.code === "string" ? error.code : null,
      errorMessage: error instanceof Error ? error.message : String(error),
    }));
  }
}

const streamingClient = createLLMClient({
  provider: "custom",
  service: "custom:Ecoapi",
  baseUrl: "https://ecoapi.net/v1",
  apiKey,
  model: "gemini-3-6-flash-high",
  temperature: 0,
  thinkingBudget: 0,
  apiFormat: "chat",
  stream: true,
  extra: { reasoning_effort: "none" },
});
const preflight = new HookResolvePreflightAgent({
  client: streamingClient,
  model: "gemini-3-6-flash-high",
  projectRoot: worktreeRoot,
});
const canonicalExpectedPayoff = "Technician Tuan finds non-standard contractor security seals on the physical TN-04 sluice controls";
const contract = {
  schemaVersion: 2,
  operations: [{
    hookId: "H003",
    action: "resolve",
    canonicalExpectedPayoff,
    canonicalPayoffHash: core.hashCanonicalHookPayoff("H003", canonicalExpectedPayoff),
    plannedEvidence: "Technician Tuan identifies the non-standard contractor seals on the TN-04 sluice controls.",
  }],
};
for (let attempt = 1; attempt <= 3; attempt += 1) {
  try {
    const result = await preflight.validate({
      contract,
      chapterGoal: "Continue the field inspection and resolve the TN-04 seal mystery.",
      relevantMemoBeat: "Tuan identifies and documents the contractor seals on the physical sluice controls.",
    });
    console.log(JSON.stringify({ exactPreflightAttempt: attempt, ok: true, decisions: result.results.map((item) => ({ hookId: item.hookId, decision: item.decision })) }));
  } catch (error) {
    console.log(JSON.stringify({
      exactPreflightAttempt: attempt,
      ok: false,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorCode: error && typeof error === "object" && typeof error.code === "string" ? error.code : null,
      errorMessage: error instanceof Error ? error.message : String(error),
    }));
  }
}
