import { Command } from "commander";
import { loadChaptersFromPath, PipelineRunner, StateManager } from "@actalk/inkos-core";
import { resolve } from "node:path";
import { loadConfig, buildPipelineConfig, findProjectRoot, resolveBookId, log, logError } from "../utils.js";
import {
  formatImportCanonComplete,
  formatImportCanonStart,
  formatImportChaptersComplete,
  formatImportChaptersDiscovery,
  formatImportChaptersResume,
} from "../localization.js";
import { resolveCliLocale, resolveWritingLanguage } from "../locale.js";
import { formatCliMessage } from "../i18n/messages.js";

export const importCommand = new Command("import")
  .description("Import external data into a book");

importCommand
  .command("canon")
  .description("Import parent book's canon for spinoff writing")
  .argument("[target-book-id]", "Target book ID (auto-detected if only one book)")
  .requiredOption("--from <parent-book-id>", "Parent book ID to import canon from")
  .option("--json", "Output JSON")
  .action(async (targetBookIdArg: string | undefined, opts) => {
    const locale = resolveCliLocale();
    try {
      const root = findProjectRoot();
      const targetBookId = await resolveBookId(targetBookIdArg, root);
      const config = await loadConfig();
      const state = new StateManager(root);
      await state.loadBookConfig(targetBookId);

      const pipeline = new PipelineRunner(buildPipelineConfig(config, root));

      if (!opts.json) log(formatImportCanonStart(locale, opts.from, targetBookId));

      await pipeline.importCanon(targetBookId, opts.from);

      if (opts.json) {
        // i18n-raw: structured canon import result must remain locale-independent.
        log(JSON.stringify({
          targetBookId,
          parentBookId: opts.from,
          output: "story/parent_canon.md",
        }, null, 2));
      } else {
        for (const line of formatImportCanonComplete(locale)) {
          log(line);
        }
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCliMessage(locale, "import.canonFailure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });

importCommand
  .command("chapters")
  .description("Import existing chapters for continuation writing. Reverse-engineers all truth files.")
  .argument("[book-id]", "Target book ID (auto-detected if only one book)")
  .requiredOption("--from <path>", "Path to a text file (auto-split) or directory of .md/.txt files")
  .option("--split <regex>", "Custom regex for chapter splitting (single-file mode)")
  .option("--resume-from <n>", "Resume from chapter N (for interrupted imports)", parseInt)
  .option("--series", "Treat as a new series (shared universe, independent story) instead of direct continuation")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    const locale = resolveCliLocale();
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const config = await loadConfig();

      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const writingLanguage = resolveWritingLanguage(book.language);
      const existingChapterCount = (await state.getNextChapterNumber(bookId)) - 1;
      if (existingChapterCount > 0 && !opts.resumeFrom) {
        throw new Error(
          `Book "${bookId}" already has ${existingChapterCount} chapter(s). ` +
          `Use --resume-from <n> to append, or delete existing chapters first.`
        );
      }

      const fromPath = resolve(opts.from);
      const chapters = [...await loadChaptersFromPath(fromPath, opts.split)];

      if (!opts.json) {
        log(formatImportChaptersDiscovery(locale, chapters.length, bookId));
        if (opts.resumeFrom) {
          log(formatImportChaptersResume(locale, opts.resumeFrom));
        }
      }

      const pipeline = new PipelineRunner(buildPipelineConfig(config, root));

      const result = await pipeline.importChapters({
        bookId,
        chapters,
        resumeFrom: opts.resumeFrom,
        importMode: opts.series ? "series" : "continuation",
      });

      if (opts.json) {
        // i18n-raw: structured chapter import result must remain locale-independent.
        log(JSON.stringify(result, null, 2));
      } else {
        for (const line of formatImportChaptersComplete(locale, writingLanguage, {
          importedCount: result.importedCount,
          totalWords: result.totalWords,
          nextChapter: result.nextChapter,
          continueBookId: bookId,
        })) {
          log(line);
        }
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCliMessage(locale, "import.chapterFailure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });
