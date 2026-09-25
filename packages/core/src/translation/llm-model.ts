import type { LLMClient } from "../llm/provider.js";
import { runWorkerAgent } from "../agent/worker-agent.js";
import { appendActivatedSkillGuidance } from "../agents/base.js";
import type { ActivatedSkillGuidance } from "../agent/skill-tool.js";
import { buildRefineSystemPrompt, buildRefineUserPayload, buildTranslationSystemPrompt, buildTranslationUserPayload } from "./prompt-builder.js";
import { resolveStyleContract } from "./vi-contract.js";
import type {
  TranslationGlossaryTerm,
  TranslationModelPort,
  TranslationSegment,
  TranslationTermCategory,
} from "./types.js";

const GLOSSARY_CATEGORIES: ReadonlySet<string> = new Set([
  "person",
  "place",
  "organization",
  "sect",
  "technique",
  "item",
  "other",
]);

export function createLLMTranslationModel(input: {
  readonly client: LLMClient;
  readonly model: string;
  readonly maxTokens?: number;
  readonly activatedSkills?: ReadonlyArray<ActivatedSkillGuidance>;
  readonly signal?: AbortSignal;
}): TranslationModelPort {
  return {
    async translateSegments(request) {
      const response = await runWorkerAgent(input.client, input.model, appendActivatedSkillGuidance([
        {
          role: "system",
          content: buildTranslationSystemPrompt({
            sourceLanguage: request.sourceLanguage,
            targetLanguage: request.targetLanguage,
            glossary: request.glossary,
            styleContract: resolveStyleContract(request.sourceLanguage, request.targetLanguage),
          }),
        },
        {
          role: "user",
          content: buildTranslationUserPayload({
            chapterTitle: request.chapterTitle,
            segments: request.segments,
            context: {
              contextBefore: request.contextBefore,
              contextAfter: request.contextAfter,
              previousTargetTail: request.previousTargetTail,
              previousAddressForms: request.previousAddressForms,
            },
            glossaryFiltered: request.glossary,
          }),
        },
      ], input.activatedSkills), { temperature: 0.2, maxTokens: input.maxTokens ?? 8192, signal: input.signal });
      const parsed = parseJsonObject(response.content);
      return {
        segments: parseTranslatedSegments(parsed.segments, request.segments),
        glossary: parseGlossary(parsed.glossary),
      };
    },
    async reviewChapter(request) {
      const response = await runWorkerAgent(input.client, input.model, appendActivatedSkillGuidance([
        {
          role: "system",
          content: [
            "You are InkOS Translation Review Agent.",
            "Check fidelity, omissions, terminology, pronouns, names, and target-language readability.",
            "Return JSON only: {\"passed\":true,\"summary\":\"...\",\"issues\":[\"...\"]}.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            sourceLanguage: request.sourceLanguage,
            targetLanguage: request.targetLanguage,
            chapterTitle: request.chapterTitle,
            glossary: request.glossary,
            segments: request.segments.map((segment) => ({
              index: segment.index,
              source: segment.source,
              target: segment.target ?? "",
            })),
          }, null, 2),
        },
      ], input.activatedSkills), { temperature: 0.1, maxTokens: 4096, signal: input.signal });
      const parsed = parseJsonObject(response.content);
      return {
        passed: parsed.passed === true,
        summary: typeof parsed.summary === "string" ? parsed.summary : "Translation review completed.",
        issues: Array.isArray(parsed.issues) ? parsed.issues.filter((issue): issue is string => typeof issue === "string") : [],
      };
    },
    async extractGlossary(request) {
      const response = await runWorkerAgent(input.client, input.model, appendActivatedSkillGuidance([
        {
          role: "system",
          content: [
            "You are InkOS Translation Glossary Agent.",
            "Extract recurring proper nouns and domain terminology from the supplied source excerpts.",
            "Propose one locked target translation per source term and group address variants of the same entity as aliases.",
            "Apply the supplied naming policy when proposing targets.",
            "Return JSON only: {\"terms\":[{\"source\":\"...\",\"target\":\"...\",\"category\":\"person|place|organization|sect|technique|item|other\",\"aliases\":[\"...\"],\"note\":\"optional\"}]}",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            sourceLanguage: request.sourceLanguage,
            targetLanguage: request.targetLanguage,
            namingPolicy: request.namingPolicy,
            samples: request.samples,
          }, null, 2),
        },
      ], input.activatedSkills), { temperature: 0.1, maxTokens: input.maxTokens ?? 8192, signal: input.signal });
      const parsed = parseJsonObject(response.content);
      return { terms: parseGlossary(parsed.terms) };
    },
    async refineSegments(request) {
      const response = await runWorkerAgent(input.client, input.model, appendActivatedSkillGuidance([
        {
          role: "system",
          content: buildRefineSystemPrompt({
            sourceLanguage: request.sourceLanguage,
            targetLanguage: request.targetLanguage,
            glossary: request.glossary,
            styleContract: request.styleContract,
          }),
        },
        {
          role: "user",
          content: buildRefineUserPayload({
            chapterTitle: request.chapterTitle,
            segments: request.segments,
            context: { previousTargetTail: request.previousRefinedTail },
            glossaryFiltered: request.glossary,
          }),
        },
      ], input.activatedSkills), { temperature: 0.3, maxTokens: input.maxTokens ?? 8192, signal: input.signal });
      const parsed = parseJsonObject(response.content);
      const refined = parseTranslatedSegments(parsed.segments, request.segments);
      const refinedIndexes = new Set(refined.map((item) => item.index));
      const missing = request.segments
        .map((segment) => segment.index)
        .filter((index) => !refinedIndexes.has(index));
      if (missing.length > 0) {
        throw new Error(`refineSegments did not return target(s) for segment index(es): ${missing.join(", ")}`);
      }
      return { segments: refined };
    },
  };
}

function parseTranslatedSegments(value: unknown, sourceSegments: ReadonlyArray<TranslationSegment>): ReadonlyArray<{
  readonly index: number;
  readonly target: string;
  readonly notes?: string;
}> {
  if (!Array.isArray(value)) {
    throw new Error("Translation model did not return a segments array.");
  }
  const sourceIndex = new Set(sourceSegments.map((segment) => segment.index));
  const parsed = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const index = Number(record.index);
    const target = typeof record.target === "string" ? record.target.trim() : "";
    if (!Number.isInteger(index) || !sourceIndex.has(index) || !target) return [];
    return [{
      index,
      target,
      ...(typeof record.notes === "string" && record.notes.trim() ? { notes: record.notes.trim() } : {}),
    }];
  });
  if (parsed.length === 0) throw new Error("Translation model returned no usable translated segments.");
  return parsed;
}

function parseGlossary(value: unknown): ReadonlyArray<TranslationGlossaryTerm> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const source = typeof record.source === "string" ? record.source.trim() : "";
    const target = typeof record.target === "string" ? record.target.trim() : "";
    if (!source || !target) return [];
    const category = typeof record.category === "string" && GLOSSARY_CATEGORIES.has(record.category)
      ? record.category as TranslationTermCategory
      : undefined;
    const aliases = Array.isArray(record.aliases)
      ? record.aliases
        .filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0)
        .map((alias) => alias.trim())
      : [];
    return [{
      source,
      target,
      ...(typeof record.note === "string" && record.note.trim() ? { note: record.note.trim() } : {}),
      ...(category ? { category } : {}),
      ...(aliases.length ? { aliases } : {}),
      origin: "auto",
    } satisfies TranslationGlossaryTerm];
  });
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = stripFence(raw.trim());
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Try extracting the first object below.
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  }
  throw new Error("Translation model did not return a JSON object.");
}

function stripFence(raw: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw);
  return match ? match[1]!.trim() : raw;
}
