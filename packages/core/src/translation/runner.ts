import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  commitProductionArtifacts,
  createProductionRunSnapshot,
  writeProductionRunSnapshot,
} from "../production/harness.js";
import { buildBatchContext } from "./context.js";
import { mergeGlossaryTermsV2 } from "./glossary-merge.js";
import { filterGlossaryForText } from "./glossary-filter.js";
import { collectThirdPersonForms, runChapterQa } from "./qa.js";
import { normalizeLanguageCode, resolveStyleContract } from "./vi-contract.js";
import { prepareTranslationGlossary } from "./glossary-prep.js";
import {
  loadTranslationChapter,
  loadTranslationGlossary,
  loadTranslationGlossaryMeta,
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
    readonly skipPrep?: boolean;
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
    let previousChapterForms: ReadonlyArray<string> | undefined;
    const batchSize = Math.max(1, Math.min(options.batchSize ?? 8, 32));

    // Auto-prep: seed the glossary once before the first run unless skipped.
    const glossaryMeta = await loadTranslationGlossaryMeta(projectRoot, projectId);
    if (!options.skipPrep && options.model.extractGlossary && !glossaryMeta.prepCompletedAt) {
      const prep = await prepareTranslationGlossary(projectRoot, projectId, { model: options.model });
      glossary = prep.terms;
      reportLines.push(`- glossary prep: ${prep.terms.length} term(s), ${prep.conflicts.length} conflict(s)`, "");
    }

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
        ...(previousChapterForms?.length ? { previousAddressForms: previousChapterForms } : {}),
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

    let completedSegments = orderedTranslatedSegments(source.segments, translatedByIndex);

    // Self-healing loop: when Han characters remain, re-refine exactly those
    // segments with concrete feedback (Try–Heal–Retry pattern). Capped at 2
    // attempts; a chapter that stays dirty keeps its QA flag (fail-closed).
    // Only chapters actually touched by this run are healed — previously
    // refined chapters are never rewritten behind the caller's back.
    const touched = undrafted.length > 0 || unrefined.length > 0;
    const HAN_PATTERN = /\p{Script=Han}/u;
    const MAX_CJK_RETRIES = 2;
    let cjkRetries = 0;
    let qaReport = runChapterQa({
      sourceLanguage,
      targetLanguage,
      segments: completedSegments.map((segment) => ({
        source: segment.source,
        target: segment.target ?? "",
      })),
      glossary,
    });
    while (touched && qaReport.metrics.cjkResidue > 0 && options.model.refineSegments && cjkRetries < MAX_CJK_RETRIES) {
      cjkRetries += 1;
      const segmentsWithHan = completedSegments.filter((segment) => HAN_PATTERN.test(segment.target ?? ""));
      if (segmentsWithHan.length === 0) break;
      const hanChars = [...new Set(
        segmentsWithHan.flatMap((segment) => segment.target?.match(/\p{Script=Han}/gu) ?? []),
      )].join("");
      const refined = await options.model.refineSegments({
        sourceLanguage,
        targetLanguage,
        chapterTitle: source.title,
        segments: segmentsWithHan,
        glossary: filterGlossaryForText(
          glossary,
          segmentsWithHan.map((segment) => segment.source).join("\n\n"),
        ),
        previousRefinedTail: buildBatchContext(
          source.segments.map((segment) => ({ index: segment.index, source: segment.source })),
          translatedTargetsByIndex(),
          segmentsWithHan.map((segment) => ({ index: segment.index, source: segment.source })),
          { tailChars: REFINED_TAIL_CHARS },
        ).previousTargetTail,
        styleContract,
        instructions: `The previous translation still contains Han characters (${hanChars}). Replace EVERY remaining Han character with natural Vietnamese; do not leave any Chinese text in the output.`,
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
      completedSegments = orderedTranslatedSegments(source.segments, translatedByIndex);
      qaReport = runChapterQa({
        sourceLanguage,
        targetLanguage,
        segments: completedSegments.map((segment) => ({
          source: segment.source,
          target: segment.target ?? "",
        })),
        glossary,
      });
      reportLines.push(`- cjk auto-retry ${cjkRetries}: re-refined ${segmentsWithHan.length} segment(s)`);
    }

    const qaPath = `translations/${projectId}/qa/chapter-${String(chapterInfo.number).padStart(4, "0")}.json`;
    await mkdir(join(projectRoot, "translations", projectId, "qa"), { recursive: true });
    await writeFile(join(projectRoot, qaPath), JSON.stringify({
      number: chapterInfo.number,
      title: source.title,
      sourceLanguage,
      targetLanguage,
      passed: qaReport.passed,
      metrics: qaReport.metrics,
      issues: qaReport.issues,
    }, null, 2), "utf-8");
    manifest = {
      ...manifest,
      updatedAt: new Date().toISOString(),
      chapters: manifest.chapters.map((chapter) =>
        chapter.number === chapterInfo.number
          ? { ...chapter, qa: { passed: qaReport.passed, reportPath: qaPath } }
          : chapter,
      ),
    };
    await saveTranslationManifest(projectRoot, manifest);
    reportLines.push(
      `- qa: passed=${qaReport.passed ? "yes" : "no"}, adherence=${Math.round(qaReport.metrics.adherence * 1000) / 10}%, cjkResidue=${qaReport.metrics.cjkResidue}, addressVariants=${qaReport.metrics.addressVariants}, variants=${qaReport.metrics.variants}`,
    );
    for (const issue of qaReport.issues) {
      reportLines.push(`- qa issue: ${issue}`);
    }
    reportLines.push("");

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
    previousChapterForms = collectThirdPersonForms(completedSegments);
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

// Fix loop: clears draft/target/stage of the selected chapters and reruns the
// two passes with the current glossary. Other chapters stay untouched.
export async function retranslateChapters(
  projectRoot: string,
  projectId: string,
  options: {
    readonly model: TranslationModelPort;
    readonly chapters: ReadonlyArray<number>;
  },
): Promise<RunTranslationProjectResult> {
  const manifest = await loadTranslationManifest(projectRoot, projectId);
  const selected = new Set(options.chapters);
  const glossary = await loadTranslationGlossary(projectRoot, projectId);
  for (const chapterInfo of manifest.chapters) {
    if (!selected.has(chapterInfo.number)) continue;
    const source = await loadTranslationChapter(projectRoot, chapterInfo.sourcePath);
    await saveTranslationProgress(projectRoot, projectId, chapterInfo.translatedPath, {
      ...source,
      segments: source.segments.map(({ index, source: segmentSource }) => ({ index, source: segmentSource })),
    }, glossary);
  }
  await saveTranslationManifest(projectRoot, {
    ...manifest,
    updatedAt: new Date().toISOString(),
    chapters: manifest.chapters.map((chapter) =>
      selected.has(chapter.number) ? { ...chapter, status: "pending", qa: undefined } : chapter,
    ),
  });
  return runTranslationProject(projectRoot, projectId, { model: options.model, skipPrep: true });
}
