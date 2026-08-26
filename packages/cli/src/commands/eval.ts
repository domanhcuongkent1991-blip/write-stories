import { Command } from "commander";
import {
  StateManager,
  evaluateBookQuality,
  formatLengthCount,
  resolveLengthCountingMode,
} from "@actalk/inkos-core";
import { findProjectRoot, resolveBookId, log, logError } from "../utils.js";
import { formatCurrentCliMessage } from "../i18n/messages.js";
import { resolveWritingLanguage } from "../locale.js";

export const evalCommand = new Command("eval")
  .description("Evaluate writing quality for a book — outputs structured quality report")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--json", "Output JSON only")
  .option("--chapters <range>", "Chapter range (e.g. 1-10, 5-20)")
  .action(async (bookIdArg: string | undefined, opts: { json?: boolean; chapters?: string }) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const result = await evaluateBookQuality({ state, bookId, chapters: opts.chapters });

      if (opts.json) {
        // i18n-raw: structured quality report must remain locale-independent.
        log(JSON.stringify(result, null, 2));
      } else {
        const length = formatLengthCount(result.totalWords, resolveLengthCountingMode(resolveWritingLanguage(book.language)));
        log(formatCurrentCliMessage("eval.header", { bookId }));
        log(formatCurrentCliMessage("eval.score", { score: result.qualityScore }));
        log(formatCurrentCliMessage("eval.chapters", { count: result.totalChapters }));
        log(formatCurrentCliMessage("eval.length", { length }));
        log(formatCurrentCliMessage("common.blank"));
        log(formatCurrentCliMessage("eval.dimensions"));
        log(formatCurrentCliMessage("eval.auditRate", { rate: result.auditPassRate }));
        log(formatCurrentCliMessage("eval.aiDensity", { value: result.avgAiTellDensity.toFixed(2) }));
        log(formatCurrentCliMessage("eval.paragraphWarnings", { value: result.avgParagraphWarnings.toFixed(1) }));
        log(formatCurrentCliMessage("eval.hookRate", { rate: result.hookResolveRate }));
        log(formatCurrentCliMessage("eval.duplicateTitles", { count: result.duplicateTitles }));
        log(formatCurrentCliMessage("common.blank"));
        log(formatCurrentCliMessage("eval.trend"));
        for (const { chapter, score } of result.qualityTrend) {
          const bar = "█".repeat(Math.round(score / 5)) + "░".repeat(20 - Math.round(score / 5));
          log(formatCurrentCliMessage("eval.trendRow", { chapter: String(chapter).padStart(3), bar, score }));
        }
        log(formatCurrentCliMessage("common.blank"));

        // Drift detection: compare first half vs second half
        if (result.qualityTrend.length >= 6) {
          const mid = Math.floor(result.qualityTrend.length / 2);
          const firstHalf = result.qualityTrend.slice(0, mid).reduce((s, c) => s + c.score, 0) / mid;
          const secondHalf = result.qualityTrend.slice(mid).reduce((s, c) => s + c.score, 0) / (result.qualityTrend.length - mid);
          const drift = Math.round(secondHalf - firstHalf);
          const formattedDrift = `${drift > 0 ? "+" : ""}${drift}`;
          log(formatCurrentCliMessage(drift >= 0 ? "eval.driftStable" : "eval.driftDegrading", { drift: formattedDrift }));
        }
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCurrentCliMessage("eval.failure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });
