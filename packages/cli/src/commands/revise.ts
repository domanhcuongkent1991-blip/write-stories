import { Command } from "commander";
import { DEFAULT_REVISE_MODE, PipelineRunner, StateManager, formatLengthCount, resolveLengthCountingMode, resolveRevisionGate, type ReviseMode } from "@actalk/inkos-core";
import { loadConfig, buildPipelineConfig, findProjectRoot, resolveBookId, log, logError } from "../utils.js";
import {
  formatNotifyCommandTitle,
  formatNotifyFailureBody,
  formatNotifyReviseBody,
} from "../localization.js";
import { resolveCliLocale, resolveWritingLanguage } from "../locale.js";
import { sendCommandNotification } from "../notify-helper.js";
import { formatCliMessage } from "../i18n/messages.js";

export const reviseCommand = new Command("revise")
  .description("Revise a chapter based on audit issues")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .argument("[chapter]", "Chapter number (defaults to latest)")
  .option("--mode <mode>", "Revise mode: spot-fix, polish, rewrite, rework, anti-detect", DEFAULT_REVISE_MODE)
  .option("--brief <text>", "One-off creative guidance for this revise/rewrite only")
  .option("--json", "Output JSON")
  .option("--notify", "Send a notification to configured notify channels when the command finishes")
  .action(async (bookIdArg: string | undefined, chapterStr: string | undefined, opts) => {
    const locale = resolveCliLocale();
    let notifyBookName: string | undefined;
    try {
      const config = await loadConfig();
      const root = findProjectRoot();

      let bookId: string;
      let chapterNumber: number | undefined;
      if (bookIdArg && /^\d+$/.test(bookIdArg)) {
        bookId = await resolveBookId(undefined, root);
        chapterNumber = parseInt(bookIdArg, 10);
      } else {
        bookId = await resolveBookId(bookIdArg, root);
        chapterNumber = chapterStr ? parseInt(chapterStr, 10) : undefined;
      }

      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const writingLanguage = resolveWritingLanguage(book.language);
      notifyBookName = book.title ?? bookId;
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, {
        externalContext: opts.brief,
        revisionGate: resolveRevisionGate(book, config.writing),
      }));

      const mode = opts.mode as ReviseMode;
      if (!opts.json) log(formatCliMessage(locale, chapterNumber ? "revise.startChapter" : "revise.startLatest", {
        bookId,
        mode,
        ...(chapterNumber ? { chapter: chapterNumber } : {}),
      }));

      const result = await pipeline.reviseDraft(bookId, chapterNumber, mode);

      if (opts.json) {
        // i18n-raw: structured revision result must remain locale-independent.
        log(JSON.stringify(result, null, 2));
      } else if (!result.applied) {
        log(formatCliMessage(locale, "revise.kept", { chapter: result.chapterNumber }));
        if (result.skippedReason) log(formatCliMessage(locale, "revise.reason", { reason: result.skippedReason }));
      } else {
        const length = formatLengthCount(result.wordCount, resolveLengthCountingMode(writingLanguage));
        log(formatCliMessage(locale, "revise.applied", { chapter: result.chapterNumber }));
        log(formatCliMessage(locale, "revise.length", { length }));
        log(formatCliMessage(locale, "revise.status", { status: result.status }));
        log(formatCliMessage(locale, "revise.fixed"));
        for (const fix of result.fixedIssues) {
          log(formatCliMessage(locale, "revise.rawFix", { fix }));
        }
      }

      // Unlike write commands, the pipeline sends no notification for
      // reviseDraft, so --notify always sends the completion notification here.
      if (opts.notify) {
        await sendCommandNotification({
          title: formatNotifyCommandTitle(locale, "revise", notifyBookName, true),
          body: formatNotifyReviseBody(locale, writingLanguage, {
            chapterNumber: result.chapterNumber,
            applied: result.applied,
            wordCount: result.wordCount,
            fixedCount: result.fixedIssues.length,
            skippedReason: result.skippedReason,
          }),
        }, config);
      }
    } catch (e) {
      if (opts.notify) {
        await sendCommandNotification({
          title: formatNotifyCommandTitle(locale, "revise", notifyBookName, false),
          body: formatNotifyFailureBody(locale, e),
        });
      }
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCliMessage(locale, "revise.failure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });
