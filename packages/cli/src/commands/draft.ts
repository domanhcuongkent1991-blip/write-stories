import { Command } from "commander";
import { PipelineRunner, StateManager, formatLengthCount, resolveLengthCountingMode } from "@actalk/inkos-core";
import { loadConfig, buildPipelineConfig, findProjectRoot, resolveContext, resolveBookId, log, logError } from "../utils.js";
import { formatCurrentCliMessage } from "../i18n/messages.js";
import { resolveWritingLanguage } from "../locale.js";

export const draftCommand = new Command("draft")
  .description("Write a draft chapter (no audit/revise)")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--words <n>", "Words per chapter (overrides book config)")
  .option("--context <text>", "Creative guidance (natural language)")
  .option("--context-file <path>", "Read guidance from file")
  .option("--json", "Output JSON")
  .option("-q, --quiet", "Suppress console output")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const config = await loadConfig();
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const context = await resolveContext(opts);
      const book = await new StateManager(root).loadBookConfig(bookId);

      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, { quiet: opts.quiet }));

      const wordCount = opts.words ? parseInt(opts.words, 10) : undefined;

      if (!opts.json) log(formatCurrentCliMessage("draft.start", { bookId }));

      const result = await pipeline.writeDraft(bookId, context, wordCount);

      if (opts.json) {
        // i18n-raw: structured draft result must remain locale-independent.
        log(JSON.stringify(result, null, 2));
      } else {
        const length = formatLengthCount(
          result.wordCount,
          resolveLengthCountingMode(resolveWritingLanguage(book.language)),
        );
        log(formatCurrentCliMessage("draft.chapter", { chapterNumber: result.chapterNumber, title: result.title }));
        log(formatCurrentCliMessage("draft.length", { length }));
        log(formatCurrentCliMessage("draft.file", { path: result.filePath }));
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCurrentCliMessage("draft.failure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });
