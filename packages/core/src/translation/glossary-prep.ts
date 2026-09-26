import { sampleTranslationChapters } from "./document-sampler.js";
import { mergeGlossaryTermsV2 } from "./glossary-merge.js";
import {
  loadTranslationChapter,
  loadTranslationGlossary,
  loadTranslationManifest,
  saveTranslationGlossary,
} from "./run-store.js";
import type { GlossaryMergeConflict } from "./glossary-merge.js";
import type { TranslationGlossaryTerm, TranslationModelPort } from "./types.js";

export const DEFAULT_TRANSLATION_NAMING_POLICY = [
  "Selective Sino-Vietnamese naming policy (zh->vi):",
  "People and sect/organization names keep their Sino-Vietnamese readings (e.g. 李明 -> Lý Minh, 青云门 -> Thanh Vân Môn).",
  "Places use the familiar Sino-Vietnamese reading when one is established, otherwise translate the meaning.",
  "Techniques and items prefer natural Vietnamese wording; fall back to Sino-Vietnamese only when no natural term exists.",
  "Group address variants of the same entity as aliases of one canonical entry.",
].join(" ");

export interface PrepareTranslationGlossaryResult {
  readonly terms: ReadonlyArray<TranslationGlossaryTerm>;
  readonly conflicts: ReadonlyArray<GlossaryMergeConflict>;
  readonly sampleCount: number;
}

export async function prepareTranslationGlossary(
  projectRoot: string,
  projectId: string,
  options: {
    readonly model: TranslationModelPort;
    readonly sampleCount?: number;
    readonly maxCharsPerSample?: number;
    readonly namingPolicy?: string;
  },
): Promise<PrepareTranslationGlossaryResult> {
  const { model } = options;
  if (!model.extractGlossary) {
    throw new Error("Translation model does not support glossary extraction (missing extractGlossary).");
  }

  const manifest = await loadTranslationManifest(projectRoot, projectId);
  const chapters: Array<{ number: number; text: string }> = [];
  for (const chapterInfo of manifest.chapters) {
    const chapter = await loadTranslationChapter(projectRoot, chapterInfo.sourcePath);
    chapters.push({
      number: chapter.number,
      text: chapter.segments.map((segment) => segment.source).join("\n\n"),
    });
  }

  const samples = sampleTranslationChapters(chapters, {
    sampleCount: options.sampleCount,
    maxCharsPerSample: options.maxCharsPerSample,
  });

  const { terms: extracted } = await model.extractGlossary({
    sourceLanguage: manifest.sourceLanguage,
    targetLanguage: manifest.targetLanguage,
    namingPolicy: options.namingPolicy?.trim() || DEFAULT_TRANSLATION_NAMING_POLICY,
    samples: samples.map((sample) => ({ chapterNumber: sample.number, text: sample.text })),
  });

  const existing = await loadTranslationGlossary(projectRoot, projectId);
  const merged = mergeGlossaryTermsV2(existing, extracted);
  await saveTranslationGlossary(projectRoot, projectId, merged.terms, {
    prepCompletedAt: new Date().toISOString(),
  });

  return {
    terms: merged.terms,
    conflicts: merged.conflicts,
    sampleCount: samples.length,
  };
}
