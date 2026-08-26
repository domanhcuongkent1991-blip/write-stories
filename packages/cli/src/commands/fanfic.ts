import { Command } from "commander";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { deriveBookIdFromTitle, normalizePlatformOrOther, PipelineRunner, type BookConfig, type FanficMode } from "@actalk/inkos-core";
import { loadConfig, buildPipelineConfig, findProjectRoot, resolveBookId, log, logError } from "../utils.js";
import {
  formatFanficCanonMissingError,
  formatFanficInvalidModeError,
  formatFanficSourceDirEmptyError,
  formatFanficSourceTooShortError,
} from "../localization.js";
import { formatCurrentCliMessage } from "../i18n/messages.js";

export const fanficCommand = new Command("fanfic")
  .description("Fan fiction writing tools");

fanficCommand
  .command("init")
  .description("Create a fanfic book from external source material")
  .requiredOption("--title <title>", "Book title")
  .requiredOption("--from <path>", "Source file or directory (novel text, wiki, character docs)")
  .option("--mode <mode>", "Fanfic mode: canon|au|ooc|cp", "canon")
  .option("--genre <genre>", "Genre", "other")
  .option("--platform <platform>", "Target platform", "other")
  .option("--target-chapters <n>", "Target chapter count", "100")
  .option("--chapter-words <n>", "Words per chapter", "3000")
  .option("--lang <language>", "Writing language: zh or en. Defaults from genre.")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      const config = await loadConfig();
      const root = findProjectRoot();

      const mode = opts.mode as FanficMode;
      if (!["canon", "au", "ooc", "cp"].includes(mode)) {
        throw new Error(formatFanficInvalidModeError(mode));
      }

      // Read source material
      const sourcePath = resolve(opts.from);
      const sourceText = await readSourceMaterial(sourcePath);
      const sourceName = basename(sourcePath);

      if (!sourceText || sourceText.length < 100) {
        throw new Error(formatFanficSourceTooShortError(sourceText.length));
      }

      const bookId = deriveBookIdFromTitle(opts.title) || `book-${Date.now().toString(36)}`;

      const now = new Date().toISOString();
      const book: BookConfig = {
        id: bookId,
        title: opts.title,
        platform: normalizePlatformOrOther(opts.platform),
        genre: opts.genre,
        status: "outlining",
        targetChapters: parseInt(opts.targetChapters, 10),
        chapterWordCount: parseInt(opts.chapterWords, 10),
        language: opts.lang ?? config.language,
        createdAt: now,
        updatedAt: now,
        fanficMode: mode,
      };

      if (!opts.json) log(formatCurrentCliMessage("fanfic.creating", { title: book.title, mode, genre: book.genre }));
      if (!opts.json) log(formatCurrentCliMessage("fanfic.source", { source: sourceName, length: sourceText.length }));

      const pipeline = new PipelineRunner(buildPipelineConfig(config, root));
      await pipeline.initFanficBook(book, sourceText, sourceName, mode);

      if (opts.json) {
        // i18n-raw: structured fanfic creation data must remain locale-independent.
        log(JSON.stringify({
          bookId,
          title: book.title,
          genre: book.genre,
          fanficMode: mode,
          source: sourceName,
          location: `books/${bookId}/`,
          nextStep: `inkos write next ${bookId}`,
        }, null, 2));
      } else {
        log(formatCurrentCliMessage("fanfic.created", { bookId }));
        log(formatCurrentCliMessage("fanfic.mode", { mode }));
        log(formatCurrentCliMessage("fanfic.location", { bookId }));
        log(formatCurrentCliMessage("fanfic.foundation"));
        log(formatCurrentCliMessage("common.blank"));
        log(formatCurrentCliMessage("fanfic.next", { bookId }));
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCurrentCliMessage("fanfic.createFailure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });

fanficCommand
  .command("show")
  .description("Display parsed fanfic canon")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      await loadConfig();
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const { StateManager } = await import("@actalk/inkos-core");
      const state = new StateManager(root);
      const bookDir = state.bookDir(bookId);

      let canon: string;
      try {
        canon = await readFile(join(bookDir, "story/fanfic_canon.md"), "utf-8");
      } catch {
        throw new Error(formatFanficCanonMissingError());
      }

      if (opts.json) {
        // i18n-raw: structured canon data must remain locale-independent.
        log(JSON.stringify({ bookId, fanficCanon: canon }, null, 2));
      } else {
        log(formatCurrentCliMessage("fanfic.canonHeader", { bookId }));
        // i18n-raw: canon is writing content and must remain byte-for-byte unchanged.
        log(canon);
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCurrentCliMessage("notify.failure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });

fanficCommand
  .command("refresh")
  .description("Re-import source material and regenerate fanfic canon")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .requiredOption("--from <path>", "Source file or directory")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const config = await loadConfig();
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const { StateManager } = await import("@actalk/inkos-core");
      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);

      const mode = (book.fanficMode ?? "canon") as FanficMode;
      const sourcePath = resolve(opts.from);
      const sourceText = await readSourceMaterial(sourcePath);
      const sourceName = basename(sourcePath);

      if (!opts.json) log(formatCurrentCliMessage("fanfic.refreshing", { bookId, source: sourceName }));

      const pipeline = new PipelineRunner(buildPipelineConfig(config, root));
      await pipeline.importFanficCanon(bookId, sourceText, sourceName, mode);

      if (opts.json) {
        // i18n-raw: structured refresh metadata must remain locale-independent.
        log(JSON.stringify({ bookId, source: sourceName, refreshedAt: new Date().toISOString() }));
      } else {
        log(formatCurrentCliMessage("fanfic.refreshed", { source: sourceName }));
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCurrentCliMessage("fanfic.refreshFailure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });

async function readSourceMaterial(sourcePath: string): Promise<string> {
  const s = await stat(sourcePath);
  if (s.isDirectory()) {
    const files = await readdir(sourcePath);
    const textFiles = files.filter((f) => f.endsWith(".txt") || f.endsWith(".md"));
    if (textFiles.length === 0) {
      throw new Error(formatFanficSourceDirEmptyError(sourcePath));
    }
    const contents = await Promise.all(
      textFiles.sort().map((f) => readFile(join(sourcePath, f), "utf-8")),
    );
    return contents.join("\n\n---\n\n");
  }
  return readFile(sourcePath, "utf-8");
}
