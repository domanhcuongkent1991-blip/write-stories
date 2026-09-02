import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const root = "C:/tmp/CodexScratch/2026-09-01-inkos-promotion-hardening";
const baseline = "C:/Users/Admin/Documents/Codex/InkOS/vi-writing-sandbox";
const core = await import(pathToFileURL(`${root}/packages/core/dist/index.js`).href);
const { chatCompletion, createLLMClient } = core;
const secrets = JSON.parse(await readFile(`${baseline}/.inkos/secrets.json`, "utf8"));
const apiKey = secrets.services?.["custom:Ecoapi"]?.apiKey;
const structuredOutput = {
  name: "hook_resolve_preflight",
  strict: true,
  schema: { type: "object", additionalProperties: false, required: ["results"], properties: {
    results: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false,
      required: ["hookId", "decision"], properties: { hookId: { type: "string" }, decision: { type: "string" } } } },
  } },
};
const system = `You validate irreversible novel hook resolutions before chapter writing.

For each proposed resolution, decide whether the PLANNED EVIDENCE would actually satisfy the CANONICAL EXPECTED PAYOFF.
- PASS only when the evidence explicitly entails the canonical payoff.
- REPAIR-REQUIRED with payoff-mismatch when it proves a different fact.
- REPAIR-REQUIRED with insufficient-evidence when it is too weak or indirect.
- INCONCLUSIVE when the supplied fields are not enough to decide.

Do not infer identities, causes, or actors that are not stated. Return strict JSON only with this shape:
{"results":[{"hookId":"...","decision":"pass"}|{"hookId":"...","decision":"repair-required","code":"payoff-mismatch|insufficient-evidence","description":"..."}|{"hookId":"...","decision":"inconclusive","description":"..."}]}`;
const user = JSON.stringify({ chapterGoal: "Continue the field inspection and resolve the TN-04 seal mystery.", resolves: [{
  hookId: "H003",
  canonicalExpectedPayoff: "Technician Tuan finds non-standard contractor security seals on the physical TN-04 sluice controls",
  plannedEvidence: "Technician Tuan identifies the non-standard contractor seals on the TN-04 sluice controls.",
  relevantMemoBeat: "Tuan identifies and documents the contractor seals on the physical sluice controls.",
}] });
for (const stream of [false, true]) {
  const client = createLLMClient({ provider: "custom", service: "custom:Ecoapi", baseUrl: "https://ecoapi.net/v1", apiKey,
    model: "gemini-3-6-flash-high", temperature: 0, thinkingBudget: 0, apiFormat: "chat", stream,
    extra: { reasoning_effort: "none" } });
  let response = null;
  try {
    response = await chatCompletion(client, "gemini-3-6-flash-high", [{ role: "system", content: system }, { role: "user", content: user }],
      { temperature: 0, maxTokens: 512, structuredOutput });
    const parsed = JSON.parse(response.content.trim());
    const item = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    console.log(JSON.stringify({ stream, ok: true, topKeys: Object.keys(item).sort(), decision: item.decision ?? null,
      hookId: item.hookId ?? null, status: item.status ?? null, processed: item.processed ?? null,
      resultsCount: Array.isArray(item.results) ? item.results.length : null,
      resultKeys: Array.isArray(item.results) && item.results[0] && typeof item.results[0] === "object" ? Object.keys(item.results[0]).sort() : [] }));
  } catch (error) {
    const trimmed = typeof response?.content === "string" ? response.content.trim() : "";
    console.log(JSON.stringify({ stream, ok: false, errorName: error instanceof Error ? error.name : "UnknownError",
      errorCode: error && typeof error === "object" && typeof error.code === "string" ? error.code : null,
      contentLength: trimmed.length, startsWithJsonObject: trimmed.startsWith("{"), startsWithFence: trimmed.startsWith("```") }));
  }
}
