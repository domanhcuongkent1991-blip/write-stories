import type { TranslationGlossaryTerm, TranslationSegment } from "./types.js";

export interface PromptContext {
  readonly contextBefore?: string;
  readonly contextAfter?: string;
  readonly previousTargetTail?: string;
  readonly chapterSummary?: string;
}

export interface BuildTranslationSystemPromptInput {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly glossary: ReadonlyArray<TranslationGlossaryTerm>;
  readonly styleContract?: string;
}

export interface BuildTranslationUserPayloadInput {
  readonly chapterTitle: string;
  readonly segments: ReadonlyArray<TranslationSegment>;
  readonly context: PromptContext;
  readonly glossaryFiltered: ReadonlyArray<TranslationGlossaryTerm>;
}

const GLOSSARY_LABEL = "# GLOSSARY - REQUIRED TRANSLATIONS";
const CAST_LABEL = "# CAST";
const STYLE_LABEL = "# STYLE INSTRUCTIONS";
const SUMMARY_LABEL = "# CHAPTER SUMMARY (do NOT translate)";
const CONTEXT_LABEL = "# CONTEXT (do NOT translate)";
const PREVIOUS_TAIL_LABEL = "# PREVIOUS TRANSLATION TAIL (do NOT translate)";
const REFINED_TAIL_LABEL = "# PREVIOUS REFINED TAIL (do NOT translate)";
const DRAFT_LABEL = "# DRAFT";
const TASK_LABEL = "# TASK";

// Labeled prompt assembly for the draft pass: block order
// ROLE -> GLOSSARY -> CAST -> STYLE (system) then SUMMARY -> CONTEXT -> TAIL
// -> TASK (user). Blocks without data are omitted entirely.
export function buildTranslationSystemPrompt(input: BuildTranslationSystemPromptInput): string {
  const lines = [
    "You are InkOS Translation Agent.",
    `Translate faithfully from ${input.sourceLanguage} to ${input.targetLanguage}.`,
    "Preserve paragraph order, scene meaning, tone, and terminology.",
    "Do not summarize. Do not add commentary outside JSON.",
  ];

  if (input.glossary.length > 0) {
    lines.push("", GLOSSARY_LABEL, "These source terms have locked target translations. Always use them.");
    for (const term of input.glossary) {
      lines.push(formatTerm(term));
    }
    const cast = input.glossary.filter((term) => term.category === "person");
    if (cast.length > 0) {
      lines.push("", CAST_LABEL, "Address forms and aliases for these characters are locked.");
      for (const term of cast) {
        lines.push(formatTerm(term));
      }
    }
  }

  if (input.styleContract?.trim()) {
    lines.push("", STYLE_LABEL, input.styleContract.trim());
  }

  return lines.join("\n");
}

export function buildTranslationUserPayload(input: BuildTranslationUserPayloadInput): string {
  return buildLabeledPayload(input.chapterTitle, input.segments, input.context, input.glossaryFiltered, {
    includeDraft: false,
  });
}

export function buildRefineSystemPrompt(input: BuildTranslationSystemPromptInput): string {
  const lines = [
    "You are InkOS Translation Refine Agent.",
    `You receive a drafted translation from ${input.sourceLanguage} to ${input.targetLanguage} and must refine it.`,
    "Your task is to refine and polish the draft: fix address-form drift, terminology drift, and awkward Vietnamese phrasing.",
    "Do not change the meaning. Do not add or remove content. Do not translate the source again from scratch.",
    "Return JSON only: {\"segments\":[{\"index\":1,\"target\":\"...\"}]}.",
  ];

  if (input.glossary.length > 0) {
    lines.push("", GLOSSARY_LABEL, "These source terms have locked target translations. Enforce them in the refined text.");
    for (const term of input.glossary) {
      lines.push(formatTerm(term));
    }
  }

  if (input.styleContract?.trim()) {
    lines.push("", STYLE_LABEL, input.styleContract.trim());
  }

  return lines.join("\n");
}

export function buildRefineUserPayload(input: BuildTranslationUserPayloadInput): string {
  return buildLabeledPayload(input.chapterTitle, input.segments, input.context, input.glossaryFiltered, {
    includeDraft: true,
  });
}

function buildLabeledPayload(
  chapterTitle: string,
  segments: ReadonlyArray<TranslationSegment>,
  context: PromptContext,
  glossary: ReadonlyArray<TranslationGlossaryTerm>,
  options: { readonly includeDraft: boolean },
): string {
  const lines: string[] = [`Chapter: ${chapterTitle}`];

  if (context.chapterSummary?.trim()) {
    lines.push("", SUMMARY_LABEL, context.chapterSummary.trim());
  }

  if (context.contextBefore?.trim() || context.contextAfter?.trim()) {
    lines.push("", CONTEXT_LABEL, "For understanding only. Do NOT translate or copy this text into the output.");
    if (context.contextBefore?.trim()) {
      lines.push(`Before: ${context.contextBefore.trim()}`);
    }
    if (context.contextAfter?.trim()) {
      lines.push(`After: ${context.contextAfter.trim()}`);
    }
  }

  if (context.previousTargetTail?.trim()) {
    lines.push("", options.includeDraft ? REFINED_TAIL_LABEL : PREVIOUS_TAIL_LABEL,
      "For continuity only. Do NOT translate or copy this text into the output.",
      context.previousTargetTail.trim());
  }

  if (options.includeDraft) {
    lines.push("", DRAFT_LABEL, "Refine this draft for each segment. Keep the segment order and meaning.");
  }

  lines.push("", TASK_LABEL);
  if (options.includeDraft) {
    lines.push("Refine the draft target for each segment below. Keep the segment order.");
  } else {
    lines.push(`Translate the following segments to the target language. Use the glossary and CAST verbatim where they apply.`);
  }
  lines.push('Return JSON only: {"segments":[{"index":1,"target":"...","notes":"optional"}]}.');
  lines.push(JSON.stringify({
    segments: segments.map((segment) => ({
      index: segment.index,
      source: segment.source,
      ...(options.includeDraft && segment.target?.trim() ? { draft: segment.target.trim() } : {}),
    })),
  }));

  if (glossary.length > 0) {
    lines.push("", `Glossary terms relevant to this batch: ${glossary.length}.`);
  }

  return lines.join("\n");
}

function formatTerm(term: TranslationGlossaryTerm): string {
  const parts = [`${term.source} -> ${term.target}`];
  if (term.aliases?.length) {
    parts.push(`(aliases: ${term.aliases.join(", ")})`);
  }
  if (term.note?.trim()) {
    parts.push(`[note: ${term.note.trim()}]`);
  }
  return `- ${parts.join(" ")}`;
}
