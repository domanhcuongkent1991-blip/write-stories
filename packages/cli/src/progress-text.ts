import {
  formatImportChaptersComplete,
  formatImportChaptersDiscovery,
  formatImportChaptersResume,
  formatWriteNextComplete,
  formatWriteNextProgress,
  formatWriteNextResultLines,
} from "./localization.js";
import type { WritingLanguage } from "@actalk/inkos-core";
import type { CliLocale } from "./locale.js";

export { type CliLocale } from "./locale.js";

export function formatWriteStartLine(
  locale: CliLocale,
  current: number,
  total: number,
  bookId: string,
): string {
  return formatWriteNextProgress(locale, current, total, bookId);
}

export function formatWriteCompletionLines(
  locale: CliLocale,
  writingLanguage: WritingLanguage,
  result: {
    readonly chapterNumber: number;
    readonly title: string;
    readonly wordCount: number;
    readonly passedAudit: boolean;
    readonly revised: boolean;
    readonly status: string;
    readonly issues: ReadonlyArray<{
      readonly severity: string;
      readonly category: string;
      readonly description: string;
    }>;
  },
): string[] {
  return [...formatWriteNextResultLines(locale, writingLanguage, result), ""];
}

export function formatWriteDoneLine(locale: CliLocale): string {
  return formatWriteNextComplete(locale);
}

export function formatImportDiscoveryLine(
  locale: CliLocale,
  chapterCount: number,
  bookId: string,
): string {
  return formatImportChaptersDiscovery(locale, chapterCount, bookId);
}

export function formatImportResumeLine(
  locale: CliLocale,
  resumeFrom: number,
): string {
  return formatImportChaptersResume(locale, resumeFrom);
}

export function formatImportCompletionLines(
  locale: CliLocale,
  writingLanguage: WritingLanguage,
  result: {
    readonly importedCount: number;
    readonly totalWords: number;
    readonly nextChapter: number;
    readonly bookId: string;
  },
): string[] {
  return formatImportChaptersComplete(locale, writingLanguage, {
    importedCount: result.importedCount,
    totalWords: result.totalWords,
    nextChapter: result.nextChapter,
    continueBookId: result.bookId,
  });
}
