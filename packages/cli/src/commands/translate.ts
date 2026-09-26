import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  activatedSkillIds,
  createLLMTranslationModel,
  createTranslationProjectFromFile,
  loadAvailableAgentSkills,
  prepareTranslationGlossary,
  retranslateChapters,
  resolveProductionSkillActivations,
  runTranslationProject,
  writeTranslationExport,
} from "@actalk/inkos-core";
import type { TranslationProjectManifest } from "@actalk/inkos-core";
import { createClient, findProjectRoot, loadConfig, log, logError } from "../utils.js";
import { formatCurrentCliMessage, type CliMessageKey } from "../i18n/messages.js";

export const translateCommand = new Command("translate")
  .description("Translate and localize novels/scripts across languages");

translateCommand
  .command("init")
  .description("Create a translation project from EPUB/PDF/TXT/Markdown")
  .requiredOption("--from <path>", "Source file path")
  .requiredOption("--source <language>", "Source language, e.g. ja, en, zh, ko, auto")
  .requiredOption("--target <language>", "Target language, e.g. zh, en, ja")
  .option("--title <title>", "Override translation title")
  .option("--segment-max-chars <n>", "Max chars per segment before splitting long paragraphs", parseInt)
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      const root = findProjectRoot();
      const result = await createTranslationProjectFromFile(root, {
        filePath: opts.from,
        sourceLanguage: opts.source,
        targetLanguage: opts.target,
        title: opts.title,
        segmentMaxChars: opts.segmentMaxChars,
      });
      if (opts.json) {
        // i18n-raw: structured translation project must remain locale-independent.
        log(JSON.stringify(result, null, 2));
      } else {
        log(formatCurrentCliMessage("translate.created", { id: result.manifest.id }));
        log(formatCurrentCliMessage("translate.title", { title: result.manifest.title }));
        log(formatCurrentCliMessage("translate.chapters", { count: result.manifest.chapters.length }));
        log(formatCurrentCliMessage("translate.manifest", { path: result.manifestPath }));
      }
    } catch (error) {
      fail("translate.createFailure", error, opts.json);
    }
  });

translateCommand
  .command("run")
  .description("Translate pending segments and write a review report")
  .argument("<project-id>", "Translation project ID under translations/")
  .option("--batch-size <n>", "Segments per model call", parseInt)
  .option("--max-tokens <n>", "Max output tokens per translation batch", parseInt)
  .option("--skip-prep", "Skip automatic glossary prep before running")
  .option("--json", "Output JSON")
  .action(async (projectId: string, opts) => {
    try {
      const root = findProjectRoot();
      const config = await loadConfig({ requireApiKey: true, projectRoot: root });
      const configuredSkills = await loadAvailableAgentSkills({ projectRoot: root });
      const activatedSkills = resolveProductionSkillActivations(configuredSkills.skills, "translation");
      const model = createLLMTranslationModel({
        client: createClient(config),
        model: config.llm.model,
        maxTokens: opts.maxTokens,
        activatedSkills,
      });
      const result = await runTranslationProject(root, projectId, {
        model,
        batchSize: opts.batchSize,
        skipPrep: opts.skipPrep,
      });
      if (opts.json) {
        // i18n-raw: structured translation run result must remain locale-independent.
        log(JSON.stringify(result, null, 2));
      } else {
        log(formatCurrentCliMessage("translate.skills", { skills: activatedSkillIds(activatedSkills).join(", ") }));
        log(formatCurrentCliMessage("translate.segments", { count: result.translatedSegments }));
        log(formatCurrentCliMessage("translate.reviewed", { count: result.reviewedChapters }));
        log(formatCurrentCliMessage("translate.report", { path: result.reportPath }));
      }
    } catch (error) {
      fail("translate.runFailure", error, opts.json);
    }
  });

translateCommand
  .command("prep")
  .description("Sample source chapters and prepare an editable glossary seed")
  .argument("<project-id>", "Translation project ID under translations/")
  .option("--sample-count <n>", "Number of chapters sampled across the book", parseInt)
  .option("--max-tokens <n>", "Max output tokens for glossary extraction", parseInt)
  .option("--json", "Output JSON")
  .action(async (projectId: string, opts) => {
    try {
      const root = findProjectRoot();
      if (!opts.json) {
        log(formatCurrentCliMessage("translate.prepStarted", { id: projectId }));
      }
      const config = await loadConfig({ requireApiKey: true, projectRoot: root });
      const configuredSkills = await loadAvailableAgentSkills({ projectRoot: root });
      const activatedSkills = resolveProductionSkillActivations(configuredSkills.skills, "translation");
      const model = createLLMTranslationModel({
        client: createClient(config),
        model: config.llm.model,
        maxTokens: opts.maxTokens,
        activatedSkills,
      });
      const result = await prepareTranslationGlossary(root, projectId, {
        model,
        sampleCount: opts.sampleCount,
      });
      if (opts.json) {
        // i18n-raw: structured glossary prep result must remain locale-independent.
        log(JSON.stringify(result, null, 2));
      } else {
        log(formatCurrentCliMessage("translate.prepTerms", { count: result.terms.length }));
        log(formatCurrentCliMessage("translate.prepConflicts", { count: result.conflicts.length }));
      }
    } catch (error) {
      fail("translate.prepFailure", error, opts.json);
    }
  });

translateCommand
  .command("apply-glossary")
  .description("Apply the current glossary by retranslating selected chapters")
  .argument("<project-id>", "Translation project ID under translations/")
  .requiredOption("--chapters <list>", "Chapters to retranslate, e.g. 1,3-5")
  .option("--max-tokens <n>", "Max output tokens per translation batch", parseInt)
  .option("--json", "Output JSON")
  .action(async (projectId: string, opts) => {
    try {
      const root = findProjectRoot();
      const chapters = parseChapterList(opts.chapters);
      if (!opts.json) {
        log(formatCurrentCliMessage("translate.applyGlossaryStarted", { chapters: opts.chapters }));
      }
      const config = await loadConfig({ requireApiKey: true, projectRoot: root });
      const configuredSkills = await loadAvailableAgentSkills({ projectRoot: root });
      const activatedSkills = resolveProductionSkillActivations(configuredSkills.skills, "translation");
      const model = createLLMTranslationModel({
        client: createClient(config),
        model: config.llm.model,
        maxTokens: opts.maxTokens,
        activatedSkills,
      });
      const result = await retranslateChapters(root, projectId, { model, chapters });
      if (opts.json) {
        // i18n-raw: structured retranslation result must remain locale-independent.
        log(JSON.stringify(result, null, 2));
      } else {
        log(formatCurrentCliMessage("translate.applyGlossaryDone", { count: result.translatedSegments }));
      }
    } catch (error) {
      fail("translate.applyGlossaryFailure", error, opts.json);
    }
  });

translateCommand
  .command("qa")
  .description("Print per-chapter QA metrics from the latest reports")
  .argument("<project-id>", "Translation project ID under translations/")
  .option("--json", "Output JSON")
  .action(async (projectId: string, opts) => {
    try {
      const root = findProjectRoot();
      const manifestPath = join(root, "translations", projectId, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as TranslationProjectManifest;
      const reports = [];
      for (const chapter of manifest.chapters) {
        if (!chapter.qa?.reportPath) continue;
        const report = JSON.parse(await readFile(join(root, chapter.qa.reportPath), "utf-8")) as {
          number: number;
          passed: boolean;
          metrics: { adherence: number; cjkResidue: number; addressVariants: number; variants: number };
        };
        reports.push(report);
      }
      if (opts.json) {
        // i18n-raw: structured QA output must remain locale-independent.
        log(JSON.stringify({ reports }, null, 2));
        return;
      }
      if (reports.length === 0) {
        log(formatCurrentCliMessage("translate.qaNoReports"));
        return;
      }
      log(formatCurrentCliMessage("translate.qaStarted", { id: projectId }));
      for (const report of reports) {
        log(formatCurrentCliMessage("translate.qaLine", {
          number: report.number,
          passed: report.passed ? "yes" : "no",
          adherence: Math.round(report.metrics.adherence * 1000) / 10,
          cjk: report.metrics.cjkResidue,
          address: report.metrics.addressVariants,
          variants: report.metrics.variants,
        }));
      }
    } catch (error) {
      fail("translate.qaFailure", error, opts.json);
    }
  });

translateCommand
  .command("export")
  .description("Export translated text to Markdown/TXT/EPUB")
  .argument("<project-id>", "Translation project ID under translations/")
  .option("--format <format>", "Output format: md, txt, epub", "md")
  .option("--output <path>", "Output file path")
  .option("--json", "Output JSON")
  .action(async (projectId: string, opts) => {
    try {
      const root = findProjectRoot();
      const result = await writeTranslationExport(root, projectId, {
        format: opts.format,
        outputPath: opts.output,
      });
      if (opts.json) {
        // i18n-raw: structured translation export result must remain locale-independent.
        log(JSON.stringify(result, null, 2));
      } else {
        log(formatCurrentCliMessage("translate.exported", { count: result.chaptersExported }));
        log(formatCurrentCliMessage("translate.output", { path: result.outputPath }));
      }
    } catch (error) {
      fail("translate.exportFailure", error, opts.json);
    }
  });

function parseChapterList(value: string): ReadonlyArray<number> {
  const chapters: number[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const range = /^(\d+)-(\d+)$/.exec(trimmed);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      for (let chapter = Math.min(start, end); chapter <= Math.max(start, end); chapter++) {
        chapters.push(chapter);
      }
      continue;
    }
    const chapter = Number(trimmed);
    if (!Number.isInteger(chapter) || chapter <= 0) {
      throw new Error(`Invalid chapter list: ${value}`);
    }
    chapters.push(chapter);
  }
  return [...new Set(chapters)].sort((a, b) => a - b);
}

function fail(key: CliMessageKey, error: unknown, json: boolean): never {
  if (json) {
    // i18n-raw: structured JSON errors remain identical across locales.
    log(JSON.stringify({ error: String(error) }));
  } else {
    logError(formatCurrentCliMessage(key, { detail: String(error) }));
  }
  process.exit(1);
}
