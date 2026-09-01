import { Command } from "commander";
import { access, readFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { deriveBookIdFromTitle, formatLengthCount, normalizePlatformOrOther, PipelineRunner, resolveLengthCountingMode, StateManager, type BookConfig } from "@actalk/inkos-core";
import {
  formatBookBackupCreated,
  formatBookBackupListEmpty,
  formatBookCreateCreated,
  formatBookCreateCreating,
  formatBookCreateFoundationReady,
  formatBookCreateLocation,
  formatBookCreateNextStep,
  formatBookRestoreDone,
} from "../localization.js";
import { resolveBookLanguageUpdate, resolveCliLocale, resolveWritingLanguage } from "../locale.js";
import { createBookBackup, listBookBackups, restoreBookBackup } from "../book-backup.js";
import { loadConfig, buildPipelineConfig, findProjectRoot, resolveBookId, log, logError } from "../utils.js";
import { formatCurrentCliMessage } from "../i18n/messages.js";

export const bookCommand = new Command("book")
  .description("Manage books");

bookCommand
  .command("create")
  .description("Create a new book with AI-generated foundation")
  .requiredOption("--title <title>", "Book title")
  .option("--genre <genre>", "Genre", "xuanhuan")
  .option("--platform <platform>", "Target platform", "tomato")
  .option("--target-chapters <n>", "Target chapter count", "200")
  .option("--chapter-words <n>", "Words per chapter", "3000")
  .option("--brief <path>", "Path to creative brief file (.md/.txt) — Architect builds from your ideas instead of generating from scratch")
  .option("--lang <language>", "Writing language: zh (Chinese), en (English), or vi (Vietnamese experimental). Defaults from genre.")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    const locale = resolveCliLocale();
    try {
      const root = findProjectRoot();

      const bookId = deriveBookIdFromTitle(opts.title) || `book-${Date.now().toString(36)}`;

      const bookDir = join(root, "books", bookId);
      try {
        await access(bookDir);
        const state = new StateManager(root);
        if (await state.isCompleteBookDirectory(bookDir)) {
          throw new Error(`Book "${bookId}" already exists at books/${bookId}/. Use a different title or delete the existing book first.`);
        }
        await rm(bookDir, { recursive: true, force: true });
      } catch (e) {
        if (e instanceof Error && e.message.includes("already exists")) throw e;
        // Directory doesn't exist, good
      }

      const config = await loadConfig();
      const now = new Date().toISOString();
      const book: BookConfig = {
        id: bookId,
        title: opts.title,
        platform: normalizePlatformOrOther(opts.platform),
        genre: opts.genre,
        status: "outlining",
        targetChapters: parseInt(opts.targetChapters, 10),
        chapterWordCount: parseInt(opts.chapterWords, 10),
        language: resolveWritingLanguage(opts.lang ?? config.language),
        createdAt: now,
        updatedAt: now,
      };
      if (!opts.json) log(formatBookCreateCreating(locale, book.title, book.genre, book.platform));

      const brief = opts.brief
        ? await readFile(resolve(opts.brief), "utf-8")
        : undefined;

      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, { externalContext: brief }));

      await pipeline.initBook(book);

      if (opts.json) {
        // i18n-raw: structured book data must remain locale-independent.
        log(JSON.stringify({
          bookId,
          title: book.title,
          genre: book.genre,
          platform: book.platform,
          location: `books/${bookId}/`,
          nextStep: `inkos write next ${bookId}`,
        }, null, 2));
      } else {
        log(formatBookCreateCreated(locale, bookId));
        log(formatBookCreateLocation(locale, bookId));
        log(formatBookCreateFoundationReady(locale));
        log(formatCurrentCliMessage("common.blank"));
        log(formatBookCreateNextStep(locale, bookId));
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCurrentCliMessage("book.createFailure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });

bookCommand
  .command("update")
  .description("Update book settings")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--chapter-words <n>", "Words per chapter")
  .option("--target-chapters <n>", "Target chapter count")
  .option("--status <status>", "Book status (outlining/active/paused/completed)")
  .option("--lang <language>", "Writing language: zh, en, or vi (Vietnamese experimental)")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);

      const updates: Record<string, unknown> = {};
      if (opts.chapterWords) updates.chapterWordCount = parseInt(opts.chapterWords, 10);
      if (opts.targetChapters) updates.targetChapters = parseInt(opts.targetChapters, 10);
      if (opts.status) updates.status = opts.status;
      if (opts.lang !== undefined) updates.language = resolveBookLanguageUpdate(book.language, opts.lang);

      if (Object.keys(updates).length === 0) {
        if (opts.json) {
          // i18n-raw: structured book data must remain locale-independent.
          log(JSON.stringify(book, null, 2));
        } else {
          const length = formatLengthCount(book.chapterWordCount, resolveLengthCountingMode(resolveWritingLanguage(book.language)));
          log(formatCurrentCliMessage("book.info", { title: book.title, bookId }));
          log(formatCurrentCliMessage("book.chapterLength", { length }));
          log(formatCurrentCliMessage("book.targetChapters", { count: book.targetChapters }));
          log(formatCurrentCliMessage("book.status", { status: book.status }));
          log(formatCurrentCliMessage("book.metadata", { genre: book.genre, platform: book.platform }));
        }
        return;
      }

      const updated: BookConfig = {
        ...book,
        ...updates,
        updatedAt: new Date().toISOString(),
      };
      await state.saveBookConfig(bookId, updated);

      if (opts.json) {
        // i18n-raw: structured book data must remain locale-independent.
        log(JSON.stringify(updated, null, 2));
      } else {
        for (const [key, value] of Object.entries(updates)) {
          log(formatCurrentCliMessage("book.updatedField", { key, before: String((book as Record<string, unknown>)[key]), after: String(value) }));
        }
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCurrentCliMessage("book.updateFailure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });

bookCommand
  .command("list")
  .description("List all books")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      const root = findProjectRoot();
      const state = new StateManager(root);
      const bookIds = await state.listBooks();

      if (bookIds.length === 0) {
        if (opts.json) {
          // i18n-raw: structured book lists must remain locale-independent.
          log(JSON.stringify({ books: [] }));
        } else {
          log(formatCurrentCliMessage("book.empty"));
        }
        return;
      }

      const books = [];
      for (const id of bookIds) {
        const book = await state.loadBookConfig(id);
        const nextChapter = await state.getNextChapterNumber(id);
        const info = {
          id,
          title: book.title,
          genre: book.genre,
          platform: book.platform,
          status: book.status,
          chapters: nextChapter - 1,
        };
        books.push(info);
        if (!opts.json) {
          log(formatCurrentCliMessage("book.listRow", { id, title: book.title, genre: book.genre, platform: book.platform, status: book.status, chapters: nextChapter - 1 }));
        }
      }

      if (opts.json) {
        // i18n-raw: structured book lists must remain locale-independent.
        log(JSON.stringify({ books }, null, 2));
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCurrentCliMessage("book.listFailure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });

bookCommand
  .command("delete")
  .description("Delete a book and all its chapters, truth files, and snapshots")
  .argument("<book-id>", "Book ID to delete")
  .option("--force", "Skip confirmation prompt")
  .option("--json", "Output JSON")
  .action(async (bookId: string, opts) => {
    try {
      const root = findProjectRoot();
      const state = new StateManager(root);

      const allBooks = await state.listBooks();
      if (!allBooks.includes(bookId)) {
        throw new Error(`Book "${bookId}" not found. Available: ${allBooks.join(", ") || "(none)"}`);
      }

      const book = await state.loadBookConfig(bookId);
      const index = await state.loadChapterIndex(bookId);

      if (!opts.force) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(
            formatCurrentCliMessage("book.deleteConfirm", { title: book.title, bookId, chapters: index.length }),
            resolve,
          );
        });
        rl.close();
        if (answer.toLowerCase() !== "y") {
          log(formatCurrentCliMessage("book.deleteCancelled"));
          return;
        }
      }

      const bookDir = join(root, "books", bookId);
      await rm(bookDir, { recursive: true, force: true });

      if (opts.json) {
        // i18n-raw: structured delete results must remain locale-independent.
        log(JSON.stringify({ deleted: bookId, chapters: index.length }));
      } else {
        log(formatCurrentCliMessage("book.deleted", { title: book.title, bookId, chapters: index.length }));
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCurrentCliMessage("book.deleteFailure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });

bookCommand
  .command("backup")
  .description("Snapshot the whole book directory into .inkos/backups/<book-id>/ (or list backups with --list)")
  .argument("<book-id>", "Book ID")
  .option("--list", "List existing backups instead of creating one")
  .option("--json", "Output JSON")
  .action(async (bookId: string, opts) => {
    try {
      const root = findProjectRoot();
      // Backups must also work on broken books (e.g. corrupted book.json),
      // so the output language follows the environment, not the book config.
      const locale = resolveCliLocale();

      if (opts.list) {
        const backups = await listBookBackups(root, bookId);
        if (opts.json) {
          // i18n-raw: structured backup data must remain locale-independent.
          log(JSON.stringify({ bookId, backups }, null, 2));
        } else if (backups.length === 0) {
          log(formatBookBackupListEmpty(locale, bookId));
        } else {
          for (const backup of backups) {
            // i18n-raw: backup identifiers and timestamps are technical data.
            log(`  ${backup.id}  ${backup.createdAt}`);
          }
        }
        return;
      }

      const result = await createBookBackup(root, bookId);
      if (opts.json) {
        // i18n-raw: structured backup data must remain locale-independent.
        log(JSON.stringify({ bookId, backupId: result.backupId }, null, 2));
      } else {
        log(formatBookBackupCreated(locale, bookId, result.backupId));
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCurrentCliMessage("book.backupFailure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });

bookCommand
  .command("restore")
  .description("Restore a whole-book backup (the current book state is automatically backed up first)")
  .argument("<book-id>", "Book ID")
  .argument("<backup-id>", "Backup ID, see `inkos book backup <book-id> --list`")
  .option("--json", "Output JSON")
  .action(async (bookId: string, backupId: string, opts) => {
    try {
      const root = findProjectRoot();
      const locale = resolveCliLocale();

      const result = await restoreBookBackup(root, bookId, backupId);

      if (opts.json) {
        // i18n-raw: structured restore results must remain locale-independent.
        log(JSON.stringify(result, null, 2));
      } else {
        log(formatBookRestoreDone(locale, {
          bookId,
          backupId: result.restoredFrom,
          preRestoreBackupId: result.preRestoreBackupId,
        }));
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCurrentCliMessage("book.restoreFailure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });
