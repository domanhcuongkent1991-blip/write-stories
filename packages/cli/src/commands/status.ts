import { Command } from "commander";
import { StateManager, formatLengthCount, readGenreProfile, resolveLengthCountingMode } from "@actalk/inkos-core";
import { findProjectRoot, getLegacyMigrationHint, log, logError } from "../utils.js";
import { formatCurrentCliMessage } from "../i18n/messages.js";

export const statusCommand = new Command("status")
  .description("Show project status")
  .argument("[book-id]", "Book ID (optional, shows all if omitted)")
  .option("--chapters", "Show per-chapter status and issues")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const state = new StateManager(root);

      const allBookIds = await state.listBooks();
      const bookIds = bookIdArg ? [bookIdArg] : allBookIds;

      if (bookIdArg && !allBookIds.includes(bookIdArg)) {
        throw new Error(
          `Book "${bookIdArg}" not found. Available: ${allBookIds.join(", ") || "(none)"}`,
        );
      }

      const booksData = [];

      if (!opts.json) {
        log(formatCurrentCliMessage("status.project", { root }));
        log(formatCurrentCliMessage("status.books", { count: allBookIds.length }));
        log(formatCurrentCliMessage("common.blank"));
      }

      for (const id of bookIds) {
        const book = await state.loadBookConfig(id);
        const index = await state.loadChapterIndex(id);
        const migrationHint = await getLegacyMigrationHint(root, id);
        const persistedChapterCount = await state.getPersistedChapterCount(id);
        const { profile: genreProfile } = await readGenreProfile(root, book.genre);
        const countingMode = resolveLengthCountingMode(book.language ?? genreProfile.language);

        const approved = index.filter((ch) => ch.status === "approved").length;
        const pending = index.filter(
          (ch) => ch.status === "ready-for-review",
        ).length;
        const failed = index.filter(
          (ch) => ch.status === "audit-failed",
        ).length;
        const degraded = index.filter(
          (ch) => ch.status === "state-degraded",
        ).length;
        const totalWords = index.reduce((sum, ch) => sum + ch.wordCount, 0);
        const avgWords = index.length > 0 ? Math.round(totalWords / index.length) : 0;

        booksData.push({
          id,
          title: book.title,
          status: book.status,
          genre: book.genre,
          platform: book.platform,
          chapters: persistedChapterCount,
          targetChapters: book.targetChapters,
          totalWords,
          avgWordsPerChapter: avgWords,
          approved,
          pending,
          failed,
          degraded,
          ...(migrationHint ? { migrationHint } : {}),
          ...(opts.chapters ? {
            chapterList: index.map((ch) => ({
              number: ch.number,
              title: ch.title,
              status: ch.status,
              wordCount: ch.wordCount,
              ...(ch.status === "audit-failed" || ch.status === "state-degraded"
                ? { issues: ch.auditIssues }
                : {}),
            })),
          } : {}),
        });

        if (!opts.json) {
          log(formatCurrentCliMessage("status.book", { title: book.title, id }));
          log(formatCurrentCliMessage("status.state", { status: book.status }));
          log(formatCurrentCliMessage("status.metadata", { platform: book.platform, genre: book.genre }));
          log(formatCurrentCliMessage("status.chapters", { current: persistedChapterCount, target: book.targetChapters }));
          log(formatCurrentCliMessage("status.length", {
            total: formatLengthCount(totalWords, countingMode),
            average: formatLengthCount(avgWords, countingMode),
          }));
          log(formatCurrentCliMessage("status.reviewCounts", { approved, pending, failed, degraded }));
          if (migrationHint) {
            log(formatCurrentCliMessage("status.migration", { hint: migrationHint }));
          }

          if (opts.chapters && index.length > 0) {
            log(formatCurrentCliMessage("common.blank"));
            for (const ch of index) {
              const icon = ch.status === "approved"
                ? "+"
                : ch.status === "audit-failed"
                  ? "!"
                  : ch.status === "state-degraded"
                    ? "x"
                    : "~";
              log(formatCurrentCliMessage("status.chapter", {
                icon,
                number: ch.number,
                title: ch.title,
                length: formatLengthCount(ch.wordCount, countingMode),
                status: ch.status,
              }));
              if ((ch.status === "audit-failed" || ch.status === "state-degraded") && ch.auditIssues.length > 0) {
                const criticals = ch.auditIssues.filter((i: string) => i.startsWith("[critical]"));
                const warnings = ch.auditIssues.filter((i: string) => i.startsWith("[warning]"));
                if (criticals.length > 0) {
                  for (const issue of criticals) {
                    log(formatCurrentCliMessage("status.rawIssue", { issue }));
                  }
                }
                if (warnings.length > 0) {
                  if (ch.status === "state-degraded") {
                    for (const issue of warnings) {
                      log(formatCurrentCliMessage("status.rawIssue", { issue }));
                    }
                  } else {
                    log(formatCurrentCliMessage("status.moreWarnings", { count: warnings.length }));
                  }
                }
              }
            }
          }
          log(formatCurrentCliMessage("common.blank"));
        }
      }

      if (opts.json) {
        // i18n-raw: structured status data must remain locale-independent.
        log(JSON.stringify({ project: root, books: booksData }, null, 2));
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCurrentCliMessage("status.failure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });
