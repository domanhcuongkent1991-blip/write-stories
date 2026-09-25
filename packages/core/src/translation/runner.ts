import { join } from "node:path";
import {
  commitProductionArtifacts,
  createProductionRunSnapshot,
  writeProductionRunSnapshot,
} from "../production/harness.js";
import { buildBatchContext } from "./context.js";
import { mergeGlossaryTermsV2 } from "./glossary-merge.js";
import { filterGlossaryForText } from "./glossary-filter.js";
import { normalizeLanguageCode, resolveStyleContract } from "./vi-contract.js";
import {
  loadTranslationChapter,
  loadTranslationGlossary,
  loadTranslationManifest,
  loadTranslationSummaries,
  saveTranslationProgress,
  saveTranslationManifest,
  saveTranslationSummaries,
  type TranslationChapterSummary,
} from "./run-store.js";
import type {
  RunTranslationProjectResult,
  TranslationChapterFile,
  TranslationGlossaryTerm,
  TranslationModelPort,
  TranslationProjectManifest,
  TranslationSegment,
} from "./types.js";

const REFINED_TAIL_CHARS = 250;

export async function runTranslationProject(
  projectRoot: string,
  projectId: string,
  options: {
    readonly model: TranslationModelPort;
    readonly batchSize?: number;
  },
): Promise<RunTranslationProjectResult> {
  const runPath = join("translations", projectId, "status.json");
  const baseArtifacts = [
    join("translations", projectId, "manifest.json"),
    join("translations", projectId, "glossary.json"),
  ];
  await writeProductionRunSnapshot({
    rootDir: projectRoot,
    runPath,
    run: createProductionRunSnapshot({
      kind: "translation",
      id: projectId,
      status: "running",
      stage: "translate",
      artifacts: baseArtifacts,
      observations: [],
    }),
  });

  try {
    let manifest = await loadTranslationManifest(projectRoot, projectId);
    let glossary: ReadonlyArray<TranslationGlossaryTerm> = [...await loadTranslationGlossary(projectRoot, projectId)];
    let summaries = await loadTranslationSummaries(projectRoot, projectId);
    const sourceLanguage = normalizeLanguageCode(manifest.sourceLanguage) ?? manifest.sourceLanguage;
    const targetLanguage = normalizeLanguageCode(manifest.targetLanguage) ?? manifest.targetLanguage;
    const styleContract = resolveStyleContract(sourceLanguage, targetLanguage);
    const reportLines = [`# Translation Review`, ""];
    let translatedSegments = 0;
    let reviewedChapters = 0;
    const batchSize = Math.max(1, Math.min(options.batchSize ?? 8, 32));

  for (const chapterInfo of manifest.chapters) {
    const source = await loadTranslationChapter(projectRoot, chapterInfo.sourcePath);
    const translated = await loadTranslationChapter(projectRoot, chapterInfo.translatedPath).catch(() => ({
      ...source,
      segments: [],
    } satisfies TranslationChapterFile));
    const translatedByIndex = new Map(translated.segments.map((segment) => [segment.index, segment]));
    const translatedTargetsByIndex = (): Map<number, string> => new Map(
      [...translatedByIndex.entries()]
        .map(([index, segment]): [number, string] => [index, segment.target ?? ""])
        .filter(([, target]) => target.length > 0),
    );
    const chapterSummary = summaries.find((item) => item.number === chapterInfo.number - 1)?.summary;

    // Pass 1 — draft: translate every segment that has no draft yet.
    const undrafted = source.segments.filter((segment) => !isDrafted(translatedByIndex.get(segment.index)));
    for (let offset = 0; offset < undrafted.length; offset += batchSize) {
      const batch = undrafted.slice(offset, offset + batchSize);
      const batchContext = buildBatchContext(
        source.segments.map((segment) => ({ index: segment.index, source: segment.source })),
        translatedTargetsByIndex(),
        batch.map((segment) => ({ index: segment.index, source: segment.source })),
      );
      const batchGlossary = filterGlossaryForText(
        glossary,
        batch.map((segment) => segment.source).join("\n\n"),
      );
      const result = await options.model.translateSegments({
        sourceLanguage,
        targetLanguage,
        chapterTitle: source.title,
        segments: batch,
        glossary: batchGlossary,
        contextBefore: batchContext.contextBefore,
        contextAfter: batchContext.contextAfter,
        previousTargetTail: batchContext.previousTargetTail,
        ...(chapterSummary ? { chapterSummary } : {}),
      });
      for (const item of result.segments) {
        const original = source.segments.find((segment) => segment.index === item.index);
        if (!original) continue;
        translatedByIndex.set(item.index, {
          ...original,
          draft: item.target,
          target: item.target,
          stage: "draft",
          ...(item.notes?.trim() ? { notes: item.notes.trim() } : {}),
        });
        translatedSegments++;
      }
      glossary = mergeIntoGlossary(glossary, result.glossary, reportLines);
      await saveTranslationProgress(projectRoot, projectId, chapterInfo.translatedPath, {
        ...source,
        segments: orderedTranslatedSegments(source.segments, translatedByIndex),
      }, glossary);
      await writeProductionRunSnapshot({
        rootDir: projectRoot,
        runPath,
        run: createProductionRunSnapshot({
          kind: "translation",
          id: projectId,
          status: "running",
          stage: "translate",
          artifacts: [...baseArtifacts, chapterInfo.translatedPath],
          observations: [],
          resumeCursor: `${chapterInfo.number}:draft:${offset + batch.length}`,
        }),
      });
    }
    manifest = updateChapterStatus(manifest, chapterInfo.number, "drafted");
    await saveTranslationManifest(projectRoot, manifest);

    // Pass 2 — refine: polish drafts into the final target.
    const unrefined = source.segments.filter((segment) => {
      const current = translatedByIndex.get(segment.index);
      return Boolean(current?.target?.trim()) && current?.stage !== "refined";
    });
    if (options.model.refineSegments && unrefined.length > 0) {
      for (let offset = 0; offset < unrefined.length; offset += batchSize) {
        const batch = unrefined.slice(offset, offset + batchSize);
        const previousRefinedTail = buildBatchContext(
          source.segments.map((segment) => ({ index: segment.index, source: segment.source })),
          translatedTargetsByIndex(),
          batch.map((segment) => ({ index: segment.index, source: segment.source })),
          { tailChars: REFINED_TAIL_CHARS },
        ).previousTargetTail;
        const batchGlossary = filterGlossaryForText(
          glossary,
          batch.map((segment) => segment.source).join("\n\n"),
        );
        const refined = await options.model.refineSegments({
          sourceLanguage,
          targetLanguage,
          chapterTitle: source.title,
          segments: batch,
          glossary: batchGlossary,
          previousRefinedTail,
          styleContract,
        });
        for (const item of refined.segments) {
          const current = translatedByIndex.get(item.index);
          if (!current) continue;
          translatedByIndex.set(item.index, { ...current, target: item.target, stage: "refined" });
        }
        await saveTranslationProgress(projectRoot, projectId, chapterInfo.translatedPath, {
          ...source,
          segments: orderedTranslatedSegments(source.segments, translatedByIndex),
        }, glossary);
        await writeProductionRunSnapshot({
          rootDir: projectRoot,
          runPath,
          run: createProductionRunSnapshot({
            kind: "translation",
            id: projectId,
            status: "running",
            stage: "translate",
            artifacts: [...baseArtifacts, chapterInfo.translatedPath],
            observations: [],
            resumeCursor: `${chapterInfo.number}:refine:${offset + batch.length}`,
          }),
        });
      }
    } else if (unrefined.length > 0) {
      // No refine support on the model: keep the draft as the final target.
      for (const segment of unrefined) {
        const current = translatedByIndex.get(segment.index);
        if (!current) continue;
        translatedByIndex.set(segment.index, { ...current, stage: "refined" });
      }
      await saveTranslationProgress(projectRoot, projectId, chapterInfo.translatedPath, {
        ...source,
        segments: orderedTranslatedSegments(source.segments, translatedByIndex),
      }, glossary);
    }
    manifest = updateChapterStatus(manifest, chapterInfo.number, "refined");
    await saveTranslationManifest(projectRoot, manifest);

    if (options.model.summarizeChapter && source.segments.some((segment) => translatedByIndex.get(segment.index)?.target?.trim())) {
      const { summary } = await options.model.summarizeChapter({
        sourceLanguage,
        targetLanguage,
        chapterTitle: source.title,
        segments: orderedTranslatedSegments(source.segments, translatedByIndex),
      });
      summaries = upsertChapterSummary(summaries, { number: chapterInfo.number, summary });
      await saveTranslationSummaries(projectRoot, projectId, summaries);
    }

    const completedSegments = orderedTranslatedSegments(source.segments, translatedByIndex);
    let status: "refined" | "reviewed" = "refined";
    if (options.model.reviewChapter && completedSegments.some((segment) => segment.target?.trim())) {
      const review = await options.model.reviewChapter({
        sourceLanguage,
        targetLanguage,
        chapterTitle: source.title,
        segments: completedSegments,
        glossary,
      });
      reviewedChapters++;
      status = review.passed ? "reviewed" : "refined";
      reportLines.push(`## ${source.title}`, "", `- passed: ${review.passed ? "yes" : "no"}`, `- summary: ${review.summary}`, "");
      for (const issue of review.issues) {
        reportLines.push(`- issue: ${issue}`);
      }
      reportLines.push("");
    }
    manifest = updateChapterStatus(manifest, chapterInfo.number, status);
    await saveTranslationManifest(projectRoot, manifest);
  }

    const reportPath = `translations/${projectId}/review-report.md`;
    const artifacts = [
      ...baseArtifacts,
      ...manifest.chapters.map((chapter) => chapter.translatedPath),
      reportPath,
    ];
    await commitProductionArtifacts({
      rootDir: projectRoot,
      artifacts: [{
        relativePath: reportPath,
        content: `${reportLines.join("\n").trimEnd()}\n`,
      }],
      runPath,
      run: createProductionRunSnapshot({
        kind: "translation",
        id: projectId,
        status: "complete",
        stage: "complete",
        artifacts,
        observations: [],
      }),
    });
    return {
      projectId,
      translatedSegments,
      reviewedChapters,
      reportPath,
    };
  } catch (error) {
    await writeProductionRunSnapshot({
      rootDir: projectRoot,
      runPath,
      run: createProductionRunSnapshot({
        kind: "translation",
        id: projectId,
        status: "failed",
        stage: "translate",
        artifacts: baseArtifacts,
        observations: [],
        error: error instanceof Error ? error.message : String(error),
      }),
    }).catch(() => undefined);
    throw error;
  }
}

function isDrafted(segment?: TranslationSegment): boolean {
  if (!segment) return false;
  return Boolean(segment.draft?.trim()) || (segment.stage === "draft" && Boolean(segment.target?.trim()));
}

function mergeIntoGlossary(
  glossary: ReadonlyArray<TranslationGlossaryTerm>,
  incoming: ReadonlyArray<TranslationGlossaryTerm> | undefined,
  reportLines: string[],
): ReadonlyArray<TranslationGlossaryTerm> {
  if (!incoming?.length) return glossary;
  const merged = mergeGlossaryTermsV2(glossary, incoming);
  for (const conflict of merged.conflicts) {
    reportLines.push(`- glossary conflict: ${conflict.source} kept "${conflict.keptTarget}", rejected "${conflict.rejectedTarget}"`);
  }
  return [...merged.terms];
}

function upsertChapterSummary(
  summaries: ReadonlyArray<TranslationChapterSummary>,
  summary: TranslationChapterSummary,
): ReadonlyArray<TranslationChapterSummary> {
  const rest = summaries.filter((item) => item.number !== summary.number);
  return [...rest, summary].sort((a, b) => a.number - b.number);
}

function orderedTranslatedSegments(
  sourceSegments: ReadonlyArray<TranslationSegment>,
  translatedByIndex: ReadonlyMap<number, TranslationSegment>,
): ReadonlyArray<TranslationSegment> {
  return sourceSegments.map((segment) => translatedByIndex.get(segment.index) ?? segment);
}

function updateChapterStatus(
  manifest: TranslationProjectManifest,
  chapterNumber: number,
  status: "drafted" | "refined" | "reviewed",
): TranslationProjectManifest {
  return {
    ...manifest,
    updatedAt: new Date().toISOString(),
    chapters: manifest.chapters.map((chapter) =>
      chapter.number === chapterNumber ? { ...chapter, status } : chapter,
    ),
  };
}
