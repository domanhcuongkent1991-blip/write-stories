import { Command } from "commander";
import { PipelineRunner, StateManager, resolveChapterReviewMode } from "@actalk/inkos-core";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig, buildPipelineConfig, findProjectRoot, getLegacyMigrationHint, resolveContext, resolveBookId, log, logError } from "../utils.js";
import {
  formatNotifyBatchWriteBody,
  formatNotifyCommandTitle,
  formatNotifyFailureBody,
  formatWriteNextComplete,
  formatWriteNextProgress,
  formatWriteNextResultLines,
} from "../localization.js";
import { resolveCliLocale, resolveWritingLanguage } from "../locale.js";
import { formatCliMessage } from "../i18n/messages.js";
import { sendCommandNotification } from "../notify-helper.js";

export const writeCommand = new Command("write")
  .description("Write chapters");

writeCommand
  .command("next")
  .description("Write the next chapter for a book")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--count <n>", "Number of chapters to write", "1")
  .option("--words <n>", "Words per chapter (overrides book config)")
  .option("--context <text>", "Creative guidance (natural language)")
  .option("--context-file <path>", "Read guidance from file")
  .option("--json", "Output JSON")
  .option("-q, --quiet", "Suppress console output")
  .option("--notify", "Send a notification to configured notify channels when the command finishes")
  .action(async (bookIdArg: string | undefined, opts) => {
    const locale = resolveCliLocale();
    let notifyBookName: string | undefined;
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const context = await resolveContext(opts);
      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const writingLanguage = resolveWritingLanguage(book.language);
      notifyBookName = book.title ?? bookId;
      const migrationHint = await getLegacyMigrationHint(root, bookId);
      if (migrationHint && !opts.json) {
        log(formatCliMessage(locale, "common.migration", { hint: migrationHint }));
      }
      const config = await loadConfig();

      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, {
        externalContext: context,
        quiet: opts.quiet,
        chapterReviewMode: resolveChapterReviewMode(book, config.writing),
      }));

      const count = parseInt(opts.count, 10);
      const wordCount = opts.words ? parseInt(opts.words, 10) : undefined;

      const results = [];
      for (let i = 0; i < count; i++) {
        if (!opts.json) log(formatWriteNextProgress(locale, i + 1, count, bookId));

        const result = await pipeline.writeNextChapter(bookId, wordCount);
        results.push(result);

        if (!opts.json) {
          for (const line of formatWriteNextResultLines(locale, writingLanguage, {
            chapterNumber: result.chapterNumber,
            title: result.title,
            wordCount: result.wordCount,
            auditPassed: result.auditResult.passed,
            revised: result.revised,
            status: result.status,
            issues: result.auditResult.issues,
          })) {
            log(line);
          }
          log(formatCliMessage(locale, "common.blank"));
        }

        if (result.status === "state-degraded") {
          if (!opts.json) {
            log(formatCliMessage(locale, "write.stateRepair"));
          }
          break;
        }
      }

      if (opts.json) {
        // i18n-raw: structured JSON results must remain locale-independent.
        log(JSON.stringify(results, null, 2));
      } else {
        log(formatWriteNextComplete(locale));
      }

      // The pipeline itself already sends one notification per completed
      // chapter whenever notify channels are configured (runner.ts, end of
      // writeNextChapter). A single-chapter run would therefore duplicate that
      // exact notification — only send a command-level batch summary when this
      // run wrote more than one chapter.
      if (opts.notify && results.length > 1) {
        await sendCommandNotification({
          title: formatNotifyCommandTitle(locale, "write-next", notifyBookName, true),
          body: formatNotifyBatchWriteBody(locale, writingLanguage, results.map((r) => ({
            chapterNumber: r.chapterNumber,
            title: r.title,
            wordCount: r.wordCount,
            auditPassed: r.auditResult.passed,
          }))),
        }, config);
      }
    } catch (e) {
      if (opts.notify) {
        await sendCommandNotification({
          title: formatNotifyCommandTitle(locale, "write-next", notifyBookName, false),
          body: formatNotifyFailureBody(locale, e),
        });
      }
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCliMessage(locale, "write.failure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });

writeCommand
  .command("rewrite")
  .description("Re-generate a specific chapter: rewrite [book-id] <chapter>")
  .argument("<args...>", "Book ID (optional) and chapter number")
  .option("--force", "Skip confirmation prompt")
  .option("--words <n>", "Words per chapter (overrides book config)")
  .option("--brief <text>", "One-off creative guidance for this rewrite only")
  .option("--json", "Output JSON")
  .option("--notify", "Send a notification to configured notify channels when the command finishes")
  .action(async (args: ReadonlyArray<string>, opts) => {
    const locale = resolveCliLocale();
    let notifyBookName: string | undefined;
    try {
      const root = findProjectRoot();

      let bookId: string;
      let chapter: number;
      if (args.length === 1) {
        chapter = parseInt(args[0]!, 10);
        if (isNaN(chapter)) throw new Error(`Expected chapter number, got "${args[0]}"`);
        bookId = await resolveBookId(undefined, root);
      } else if (args.length === 2) {
        chapter = parseInt(args[1]!, 10);
        if (isNaN(chapter)) throw new Error(`Expected chapter number, got "${args[1]}"`);
        bookId = await resolveBookId(args[0], root);
      } else {
        throw new Error("Usage: inkos write rewrite [book-id] <chapter>");
      }

      if (!opts.force) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(`Rewrite chapter ${chapter} of "${bookId}"? This will delete chapter ${chapter} and all later chapters. (y/N) `, resolve);
        });
        rl.close();
        if (answer.toLowerCase() !== "y") {
          log(formatCliMessage(locale, "write.cancelled"));
          return;
        }
      }

      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const writingLanguage = resolveWritingLanguage(book.language);
      notifyBookName = book.title ?? bookId;
      const bookDir = state.bookDir(bookId);
      const chaptersDir = join(bookDir, "chapters");
      const restoreFrom = chapter - 1;
      const restoreSnapshotDir = join(bookDir, "story", "snapshots", String(restoreFrom));
      await stat(restoreSnapshotDir).catch(() => {
        throw new Error(`Cannot rewrite chapter ${chapter}: missing snapshot for chapter ${restoreFrom}`);
      });
      const migrationHint = await getLegacyMigrationHint(root, bookId);
      if (migrationHint && !opts.json) {
          log(formatCliMessage(locale, "common.migration", { hint: migrationHint }));
      }

      // Remove existing chapter file
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapter).padStart(4, "0");
      const existing = files.filter((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      for (const f of existing) {
        await unlink(join(chaptersDir, f));
        if (!opts.json) log(formatCliMessage(locale, "write.removed", { path: f }));
      }

      // Remove from index (and all chapters after it)
      const index = await state.loadChapterIndex(bookId);
      const trimmed = index.filter((ch) => ch.number < chapter);
      await state.saveChapterIndex(bookId, trimmed);

      // Also remove later chapter files since state will be rolled back
      const laterFiles = files.filter((f) => {
        const num = parseInt(f.slice(0, 4), 10);
        return num > chapter && f.endsWith(".md");
      });
      for (const f of laterFiles) {
        await unlink(join(chaptersDir, f));
        if (!opts.json) log(formatCliMessage(locale, "write.removedLater", { path: f }));
      }

      // Restore state to previous chapter's end-state (chapter 1 uses snapshot-0 from initBook)
      const restored = await state.restoreState(bookId, restoreFrom);
      if (!restored) {
        throw new Error(`Cannot rewrite chapter ${chapter}: failed to restore snapshot for chapter ${restoreFrom}`);
      }
      if (!opts.json) log(formatCliMessage(locale, "write.stateRestored", { chapter: restoreFrom }));

      const nextChapter = await state.getNextChapterNumber(bookId);
      if (nextChapter !== chapter) {
        throw new Error(`Cannot rewrite chapter ${chapter}: expected next chapter to be ${chapter}, but resolved to ${nextChapter}`);
      }

      if (!opts.json) log(formatCliMessage(locale, "write.regenerating", { chapter }));

      const wordCount = opts.words ? parseInt(opts.words, 10) : undefined;

      const config = await loadConfig();
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, {
        externalContext: opts.brief,
        chapterReviewMode: resolveChapterReviewMode(book, config.writing),
      }));

      const result = await pipeline.writeNextChapter(bookId, wordCount);

      if (opts.json) {
        // i18n-raw: structured JSON results must remain locale-independent.
        log(JSON.stringify(result, null, 2));
      } else {
        for (const line of formatWriteNextResultLines(locale, writingLanguage, {
          chapterNumber: result.chapterNumber,
          title: result.title,
          wordCount: result.wordCount,
          auditPassed: result.auditResult.passed,
          revised: result.revised,
          status: result.status,
          issues: result.auditResult.issues,
        })) {
          log(line);
        }
      }

      // Success notification intentionally skipped: the pipeline already sent
      // the per-chapter notification for this exact chapter (runner.ts, end of
      // writeNextChapter) — a command-level one would be a duplicate. --notify
      // only adds the failure notification for this command.
    } catch (e) {
      if (opts.notify) {
        await sendCommandNotification({
          title: formatNotifyCommandTitle(locale, "write-rewrite", notifyBookName, false),
          body: formatNotifyFailureBody(locale, e),
        });
      }
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCliMessage(locale, "write.rewriteFailure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });

writeCommand
  .command("sync")
  .description("Rebuild truth files and SQLite indexes from the latest edited chapter body")
  .argument("<args...>", "Book ID (optional) and chapter number")
  .option("--brief <text>", "One-off guidance for how to interpret the edited chapter while syncing")
  .option("--json", "Output JSON")
  .action(async (args: ReadonlyArray<string>, opts) => {
    const locale = resolveCliLocale();
    try {
      const root = findProjectRoot();

      let bookId: string;
      let chapter: number;
      if (args.length === 1) {
        chapter = parseInt(args[0]!, 10);
        if (isNaN(chapter)) throw new Error(`Expected chapter number, got "${args[0]}"`);
        bookId = await resolveBookId(undefined, root);
      } else if (args.length === 2) {
        chapter = parseInt(args[1]!, 10);
        if (isNaN(chapter)) throw new Error(`Expected chapter number, got "${args[1]}"`);
        bookId = await resolveBookId(args[0], root);
      } else {
        throw new Error("Usage: inkos write sync [book-id] <chapter>");
      }

      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const config = await loadConfig();
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, {
        externalContext: opts.brief,
      }));
      const result = await pipeline.resyncChapterArtifacts(bookId, chapter);

      if (opts.json) {
        // i18n-raw: structured sync result must remain locale-independent.
        log(JSON.stringify(result, null, 2));
      } else {
        for (const line of formatWriteNextResultLines(locale, resolveWritingLanguage(book.language), {
          chapterNumber: result.chapterNumber,
          title: result.title,
          wordCount: result.wordCount,
          auditPassed: result.auditResult.passed,
          revised: result.revised,
          status: result.status,
          issues: result.auditResult.issues,
        })) {
          log(line);
        }
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCliMessage(locale, "write.syncFailure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });

writeCommand
  .command("repair-state")
  .description("Rebuild truth files for a persisted state-degraded chapter without rewriting body text")
  .argument("<args...>", "Book ID (optional) and chapter number")
  .option("--json", "Output JSON")
  .action(async (args: ReadonlyArray<string>, opts) => {
    const locale = resolveCliLocale();
    try {
      const root = findProjectRoot();

      let bookId: string;
      let chapter: number;
      if (args.length === 1) {
        chapter = parseInt(args[0]!, 10);
        if (isNaN(chapter)) throw new Error(`Expected chapter number, got "${args[0]}"`);
        bookId = await resolveBookId(undefined, root);
      } else if (args.length === 2) {
        chapter = parseInt(args[1]!, 10);
        if (isNaN(chapter)) throw new Error(`Expected chapter number, got "${args[1]}"`);
        bookId = await resolveBookId(args[0], root);
      } else {
        throw new Error("Usage: inkos write repair-state [book-id] <chapter>");
      }

      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const config = await loadConfig();
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root));
      const result = await pipeline.repairChapterState(bookId, chapter);

      if (opts.json) {
        // i18n-raw: structured repair result must remain locale-independent.
        log(JSON.stringify(result, null, 2));
      } else {
        for (const line of formatWriteNextResultLines(locale, resolveWritingLanguage(book.language), {
          chapterNumber: result.chapterNumber,
          title: result.title,
          wordCount: result.wordCount,
          auditPassed: result.auditResult.passed,
          revised: result.revised,
          status: result.status,
          issues: result.auditResult.issues,
        })) {
          log(line);
        }
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCliMessage(locale, "write.repairFailure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });
