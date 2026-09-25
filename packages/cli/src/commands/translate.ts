import { Command } from "commander";
import {
  activatedSkillIds,
  createLLMTranslationModel,
  createTranslationProjectFromFile,
  loadAvailableAgentSkills,
  prepareTranslationGlossary,
  resolveProductionSkillActivations,
  runTranslationProject,
  writeTranslationExport,
} from "@actalk/inkos-core";
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

function fail(key: CliMessageKey, error: unknown, json: boolean): never {
  if (json) {
    // i18n-raw: structured JSON errors remain identical across locales.
    log(JSON.stringify({ error: String(error) }));
  } else {
    logError(formatCurrentCliMessage(key, { detail: String(error) }));
  }
  process.exit(1);
}
