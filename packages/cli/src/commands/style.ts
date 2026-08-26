import { Command } from "commander";
import { StateManager, analyzeStyle, PipelineRunner } from "@actalk/inkos-core";
import { loadConfig, buildPipelineConfig, findProjectRoot, resolveBookId, log, logError } from "../utils.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { formatCurrentCliMessage } from "../i18n/messages.js";

export const styleCommand = new Command("style")
  .description("Style fingerprint analysis and import");

styleCommand
  .command("analyze")
  .description("Analyze a text file and extract style profile")
  .argument("<file>", "Text file to analyze")
  .option("--name <name>", "Source name for the profile")
  .option("--json", "Output JSON only")
  .action(async (file: string, opts) => {
    try {
      const text = await readFile(resolve(file), "utf-8");
      const profile = analyzeStyle(text, opts.name ?? file);

      if (opts.json) {
        // i18n-raw: structured style profile must remain locale-independent.
        log(JSON.stringify(profile, null, 2));
      } else {
        log(formatCurrentCliMessage("style.profile"));
        log(formatCurrentCliMessage("style.source", { source: profile.sourceName ?? "unknown" }));
        log(formatCurrentCliMessage("style.avgSentence", { value: profile.avgSentenceLength }));
        log(formatCurrentCliMessage("style.sentenceDeviation", { value: profile.sentenceLengthStdDev }));
        log(formatCurrentCliMessage("style.avgParagraph", { value: profile.avgParagraphLength }));
        log(formatCurrentCliMessage("style.paragraphRange", { min: profile.paragraphLengthRange.min, max: profile.paragraphLengthRange.max }));
        log(formatCurrentCliMessage("style.diversity", { value: profile.vocabularyDiversity }));
        if (profile.topPatterns.length > 0) {
          log(formatCurrentCliMessage("style.patterns", { patterns: profile.topPatterns.join(", ") }));
        }
        if (profile.rhetoricalFeatures.length > 0) {
          log(formatCurrentCliMessage("style.features", { features: profile.rhetoricalFeatures.join(", ") }));
        }
      }
    } catch (e) {
      logError(formatCurrentCliMessage("style.analysisFailure", { detail: String(e) }));
      process.exit(1);
    }
  });

styleCommand
  .command("import")
  .description("Import style profile + generate style guide (LLM) into a book")
  .argument("<file>", "Text file to analyze and import")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--name <name>", "Source name for the profile")
  .option("--stats-only", "Only save statistical profile, skip LLM style guide generation")
  .option("--json", "Output JSON")
  .action(async (file: string, bookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);
      const bookDir = state.bookDir(bookId);

      const text = await readFile(resolve(file), "utf-8");
      const profile = analyzeStyle(text, opts.name ?? file);

      const storyDir = join(bookDir, "story");
      await mkdir(storyDir, { recursive: true });
      await writeFile(
        join(storyDir, "style_profile.json"),
        JSON.stringify(profile, null, 2),
        "utf-8",
      );

      if (!opts.json) log(formatCurrentCliMessage("style.saved", { value: profile.vocabularyDiversity }));

      // LLM-powered style guide generation
      if (!opts.statsOnly) {
        if (!opts.json) log(formatCurrentCliMessage("style.generatingGuide"));
        const config = await loadConfig();
        const pipeline = new PipelineRunner(buildPipelineConfig(config, root));
        await pipeline.generateStyleGuide(bookId, text, opts.name ?? file);
        if (!opts.json) log(formatCurrentCliMessage("style.guideGenerated"));
      }

      if (opts.json) {
        // i18n-raw: structured style import result must remain locale-independent.
        log(JSON.stringify({
          bookId,
          file,
          statsProfile: `story/style_profile.json`,
          styleGuide: opts.statsOnly ? null : `story/style_guide.md`,
        }, null, 2));
      } else {
        log(formatCurrentCliMessage("style.imported", { bookId, file }));
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCurrentCliMessage("style.importFailure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });
