import { Command } from "commander";
import { PipelineRunner } from "@actalk/inkos-core";
import { buildPipelineConfig, findProjectRoot, loadConfig, log, logError, resolveBookId, resolveContext } from "../utils.js";
import { formatCurrentCliMessage } from "../i18n/messages.js";

export const planCommand = new Command("plan")
  .description("Plan chapter input artifacts");

planCommand
  .command("chapter")
  .description("Generate chapter intent for the next chapter")
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

      const result = await pipeline.planChapter(bookId, context);

      if (opts.json) {
        // i18n-raw: structured planning artifacts must remain locale-independent.
        log(JSON.stringify(result, null, 2));
      } else {
        log(formatCurrentCliMessage("plan.complete", { chapterNumber: result.chapterNumber, bookId }));
        log(formatCurrentCliMessage("plan.goal", { goal: result.goal }));
        log(formatCurrentCliMessage("plan.intent", { path: result.intentPath }));
        if (result.conflicts.length > 0) {
          log(formatCurrentCliMessage("plan.conflicts"));
          for (const conflict of result.conflicts) {
            log(formatCurrentCliMessage("plan.conflict", { conflict }));
          }
        }
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCurrentCliMessage("plan.failure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });
