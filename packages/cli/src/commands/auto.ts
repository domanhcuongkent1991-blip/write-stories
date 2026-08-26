import { Command } from "commander";
import { PipelineRunner, StateManager } from "@actalk/inkos-core";
import { loadConfig, buildPipelineConfig, findProjectRoot, getLegacyMigrationHint, resolveBookId, log, logError } from "../utils.js";
import {
  formatAutoWriteAlreadyComplete,
  formatAutoWriteStart,
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

export const autoCommand = new Command("auto")
  .description("Auto-write chapters until the book reaches a target chapter number: auto [book-id] <target-chapter>")
  .argument("<args...>", "Book ID (optional, auto-detected if only one book) and target chapter number")
  .option("--words <n>", "Words per chapter (overrides book config)")
  .option("--json", "Output JSON")
  .option("-q, --quiet", "Suppress console output")
  .option("--notify", "Send a notification to configured notify channels when the command finishes")
  .action(async (args: ReadonlyArray<string>, opts) => {
    const locale = resolveCliLocale();
    let notifyBookName: string | undefined;
    try {
      const root = findProjectRoot();

      let bookId: string;
      let targetChapter: number;
      if (args.length === 1) {
        targetChapter = parseInt(args[0]!, 10);
        if (isNaN(targetChapter)) throw new Error(`Expected target chapter number, got "${args[0]}"`);
        bookId = await resolveBookId(undefined, root);
      } else if (args.length === 2) {
        targetChapter = parseInt(args[1]!, 10);
        if (isNaN(targetChapter)) throw new Error(`Expected target chapter number, got "${args[1]}"`);
        bookId = await resolveBookId(args[0], root);
      } else {
        throw new Error("Usage: inkos auto [book-id] <target-chapter>");
      }
      if (targetChapter < 1) {
        throw new Error(`Target chapter must be >= 1, got ${targetChapter}`);
      }

      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const writingLanguage = resolveWritingLanguage(book.language);
      notifyBookName = book.title ?? bookId;
      const migrationHint = await getLegacyMigrationHint(root, bookId);
      if (migrationHint && !opts.json) {
        log(formatCliMessage(locale, "common.migration", { hint: migrationHint }));
      }

      const startChapter = await state.getNextChapterNumber(bookId);
      if (startChapter > targetChapter) {
        if (opts.json) {
          // i18n-raw: structured JSON results must remain locale-independent.
          log(JSON.stringify([], null, 2));
        } else {
          log(formatAutoWriteAlreadyComplete(locale, bookId, startChapter - 1, targetChapter));
        }
        return;
      }

      const config = await loadConfig();
      // `inkos auto` is unattended batch writing, so the audit→revise loop must
      // run inline: force "auto" regardless of book/project reviewMode settings.
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, {
        quiet: opts.quiet,
        chapterReviewMode: "auto",
      }));

      if (!opts.json) log(formatAutoWriteStart(locale, bookId, startChapter, targetChapter));

      const wordCount = opts.words ? parseInt(opts.words, 10) : undefined;

      const results = [];
      for (let chapter = startChapter; chapter <= targetChapter; chapter++) {
        if (!opts.json) log(formatWriteNextProgress(locale, chapter, targetChapter, bookId));

        let result;
        try {
          result = await pipeline.writeNextChapter(bookId, wordCount);
        } catch (e) {
          throw new Error(
            `Chapter ${chapter} failed, stopping auto-write (${results.length} chapter(s) completed this run): ${e instanceof Error ? e.message : String(e)}`,
            { cause: e },
          );
        }
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
          throw new Error(
            `Chapter ${result.chapterNumber} finished in state-degraded status, stopping auto-write. Run "inkos write repair-state ${bookId} ${result.chapterNumber}" first, then re-run inkos auto.`,
          );
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
          title: formatNotifyCommandTitle(locale, "auto", notifyBookName, true),
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
          title: formatNotifyCommandTitle(locale, "auto", notifyBookName, false),
          body: formatNotifyFailureBody(locale, e),
        });
      }
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCliMessage(locale, "auto.failure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });
