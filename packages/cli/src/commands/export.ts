import { Command } from "commander";
import { StateManager, formatLengthCount, resolveLengthCountingMode, writeExportArtifact } from "@actalk/inkos-core";
import { join } from "node:path";
import { findProjectRoot, resolveBookId, log, logError } from "../utils.js";
import { formatCurrentCliMessage } from "../i18n/messages.js";
import { resolveWritingLanguage } from "../locale.js";

export const exportCommand = new Command("export")
  .description("Export book chapters to a single file")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--format <format>", "Output format (txt, md, epub)", "txt")
  .option("--output <path>", "Output file path")
  .option("--approved-only", "Only export approved chapters")
  .option("--json", "Output JSON metadata")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);

      const result = await writeExportArtifact(state, bookId, {
        format: opts.format as "txt" | "md" | "epub",
        approvedOnly: Boolean(opts.approvedOnly),
        outputPath: opts.output ?? join(root, `${bookId}_export.${opts.format}`),
      });

      if (opts.json) {
        // i18n-raw: structured export metadata must remain locale-independent.
        log(JSON.stringify({
          bookId,
          chaptersExported: result.chaptersExported,
          totalWords: result.totalWords,
          format: result.format,
          outputPath: result.outputPath,
        }, null, 2));
      } else {
        const length = formatLengthCount(
          result.totalWords,
          resolveLengthCountingMode(resolveWritingLanguage(book.language)),
        );
        log(formatCurrentCliMessage("export.complete", { chapters: result.chaptersExported, length }));
        log(formatCurrentCliMessage("export.output", { path: result.outputPath }));
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCurrentCliMessage("export.failure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });
