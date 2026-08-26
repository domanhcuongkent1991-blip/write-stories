import { Command } from "commander";
import { PipelineRunner } from "@actalk/inkos-core";
import { buildPipelineConfig, findProjectRoot, loadConfig, log, logError, resolveBookId, resolveContext } from "../utils.js";
import { formatCurrentCliMessage } from "../i18n/messages.js";

export const composeCommand = new Command("compose")
  .description("Compose chapter runtime artifacts");

composeCommand
  .command("chapter")
  .description("Generate context/rule-stack/trace artifacts for the next chapter")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--context <text>", "Chapter steering guidance")
  .option("--context-file <path>", "Read guidance from file")
  .option("--json", "Output JSON")
  .option("-q, --quiet", "Suppress console output")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const config = await loadConfig({ requireApiKey: false });
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const context = await resolveContext(opts);

      const pipeline = new PipelineRunner(
        buildPipelineConfig(config, root, {
          externalContext: context,
          quiet: opts.quiet,
        }),
      );

      const result = await pipeline.composeChapter(bookId, context);

      if (opts.json) {
        // i18n-raw: structured compose artifacts must remain locale-independent.
        log(JSON.stringify(result, null, 2));
      } else {
        log(formatCurrentCliMessage("compose.complete", { chapterNumber: result.chapterNumber, bookId }));
        log(formatCurrentCliMessage("compose.intent", { path: result.intentPath }));
        log(formatCurrentCliMessage("compose.context", { path: result.contextPath }));
        log(formatCurrentCliMessage("compose.ruleStack", { path: result.ruleStackPath }));
        log(formatCurrentCliMessage("compose.trace", { path: result.tracePath }));
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCurrentCliMessage("compose.failure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });
