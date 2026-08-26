import { Command } from "commander";
import { PipelineRunner, StateManager } from "@actalk/inkos-core";
import { loadConfig, buildPipelineConfig, findProjectRoot, resolveBookId, log, logError } from "../utils.js";
import {
  formatNotifyAuditBody,
  formatNotifyCommandTitle,
  formatNotifyFailureBody,
} from "../localization.js";
import { resolveCliLocale } from "../locale.js";
import { formatCliMessage } from "../i18n/messages.js";
import { sendCommandNotification } from "../notify-helper.js";

export const auditCommand = new Command("audit")
  .description("Audit a chapter for continuity issues")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .argument("[chapter]", "Chapter number (defaults to latest)")
  .option("--json", "Output JSON")
  .option("--notify", "Send a notification to configured notify channels when the command finishes")
  .action(async (bookIdArg: string | undefined, chapterStr: string | undefined, opts) => {
    const locale = resolveCliLocale();
    let notifyBookName: string | undefined;
    try {
      const config = await loadConfig();
      const root = findProjectRoot();

      // If first arg looks like a number, treat it as chapter (auto-detect book)
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
      notifyBookName = book.title ?? bookId;

      const pipeline = new PipelineRunner(buildPipelineConfig(config, root));

      if (!opts.json) log(formatCliMessage(locale, chapterNumber ? "audit.startChapter" : "audit.startLatest", {
        bookId,
        ...(chapterNumber ? { chapter: chapterNumber } : {}),
      }));

      const result = await pipeline.auditDraft(bookId, chapterNumber);

      if (opts.json) {
        // i18n-raw: structured audit result must remain locale-independent.
        log(JSON.stringify(result, null, 2));
      } else {
        log(formatCliMessage(locale, result.passed ? "audit.resultPassed" : "audit.resultFailed", { chapter: result.chapterNumber }));
        log(formatCliMessage(locale, "audit.summary", { summary: result.summary }));
        if (result.issues.length > 0) {
          log(formatCliMessage(locale, "audit.issues"));
          for (const issue of result.issues) {
            log(formatCliMessage(locale, "audit.rawIssue", { severity: issue.severity, category: issue.category, description: issue.description }));
          }
        }
      }

      // Unlike write commands, the pipeline sends no notification for
      // auditDraft, so --notify always sends the completion notification here.
      if (opts.notify) {
        await sendCommandNotification({
          title: formatNotifyCommandTitle(locale, "audit", notifyBookName, true),
          body: formatNotifyAuditBody(locale, {
            chapterNumber: result.chapterNumber,
            passed: result.passed,
            issueCount: result.issues.length,
            summary: result.summary,
          }),
        }, config);
      }
    } catch (e) {
      if (opts.notify) {
        await sendCommandNotification({
          title: formatNotifyCommandTitle(locale, "audit", notifyBookName, false),
          body: formatNotifyFailureBody(locale, e),
        });
      }
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCliMessage(locale, "audit.failure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });
