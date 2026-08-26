import { Command } from "commander";
import { StateManager, computeAnalytics, formatLengthCount, resolveLengthCountingMode } from "@actalk/inkos-core";
import { loadConfig, findProjectRoot, resolveBookId, log, logError } from "../utils.js";
import { formatCurrentCliMessage } from "../i18n/messages.js";
import { resolveWritingLanguage } from "../locale.js";

export const analyticsCommand = new Command("analytics")
  .alias("stats")
  .description("Show analytics and token stats for a book")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      await loadConfig();
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const chapters = await state.loadChapterIndex(bookId);
      const countingMode = resolveLengthCountingMode(resolveWritingLanguage(book.language));

      const analytics = computeAnalytics(bookId, chapters);

      if (opts.json) {
        // i18n-raw: structured analytics must remain locale-independent.
        log(JSON.stringify(analytics, null, 2));
      } else {
        log(formatCurrentCliMessage("analytics.header", { bookId }));
        log(formatCurrentCliMessage("common.blank"));
        log(formatCurrentCliMessage("analytics.chapters", { count: analytics.totalChapters }));
        log(formatCurrentCliMessage("analytics.totalLength", { length: formatLengthCount(analytics.totalWords, countingMode) }));
        log(formatCurrentCliMessage("analytics.averageLength", { length: formatLengthCount(analytics.avgWordsPerChapter, countingMode) }));
        log(formatCurrentCliMessage("analytics.auditRate", { rate: analytics.auditPassRate }));
        log(formatCurrentCliMessage("common.blank"));

        if (Object.keys(analytics.statusDistribution).length > 0) {
          log(formatCurrentCliMessage("analytics.statusDistribution"));
          for (const [status, count] of Object.entries(analytics.statusDistribution)) {
            log(formatCurrentCliMessage("analytics.statusRow", { status, count }));
          }
          log(formatCurrentCliMessage("common.blank"));
        }

        if (analytics.tokenStats) {
          log(formatCurrentCliMessage("analytics.tokenUsage"));
          log(formatCurrentCliMessage("analytics.totalTokens", { count: analytics.tokenStats.totalTokens.toLocaleString() }));
          log(formatCurrentCliMessage("analytics.promptTokens", { count: analytics.tokenStats.totalPromptTokens.toLocaleString() }));
          log(formatCurrentCliMessage("analytics.completionTokens", { count: analytics.tokenStats.totalCompletionTokens.toLocaleString() }));
          log(formatCurrentCliMessage("analytics.averageTokens", { count: analytics.tokenStats.avgTokensPerChapter.toLocaleString() }));
          if (analytics.tokenStats.recentTrend.length > 0) {
            log(formatCurrentCliMessage("analytics.recentTrend"));
            for (const { chapter, totalTokens } of analytics.tokenStats.recentTrend) {
              log(formatCurrentCliMessage("analytics.trendRow", { chapter, count: totalTokens.toLocaleString() }));
            }
          }
          log(formatCurrentCliMessage("common.blank"));
        }

        if (analytics.topIssueCategories.length > 0) {
          log(formatCurrentCliMessage("analytics.issueCategories"));
          for (const { category, count } of analytics.topIssueCategories) {
            log(formatCurrentCliMessage("analytics.categoryRow", { category, count }));
          }
          log(formatCurrentCliMessage("common.blank"));
        }

        if (analytics.chaptersWithMostIssues.length > 0) {
          log(formatCurrentCliMessage("analytics.issueChapters"));
          for (const { chapter, issueCount } of analytics.chaptersWithMostIssues) {
            log(formatCurrentCliMessage("analytics.issueChapterRow", { chapter, count: issueCount }));
          }
        }
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCurrentCliMessage("analytics.failure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });
