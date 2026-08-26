import {
  formatLengthCount,
  resolveLengthCountingMode,
  type WritingLanguage,
} from "@actalk/inkos-core";
import type { CliLocale } from "./locale.js";
import { formatCliMessage, type CliMessageKey } from "./i18n/messages.js";

type WriteIssue = {
  readonly severity: string;
  readonly category: string;
  readonly description: string;
};

type WriteResultShape = {
  readonly chapterNumber: number;
  readonly title: string;
  readonly wordCount: number;
  readonly status: string;
  readonly revised: boolean;
  readonly issues: ReadonlyArray<WriteIssue>;
  readonly auditPassed?: boolean;
  readonly passedAudit?: boolean;
};

type ImportResultShape = {
  readonly importedCount: number;
  readonly totalWords: number;
  readonly nextChapter: number;
  readonly continueBookId: string;
};

export function formatBookCreateCreating(
  locale: CliLocale,
  title: string,
  genre: string,
  platform: string,
): string {
  return formatCliMessage(locale, "book.create.creating", { title, genre, platform });
}

export function formatBookCreateCreated(locale: CliLocale, bookId: string): string {
  return formatCliMessage(locale, "book.create.created", { bookId });
}

export function formatBookCreateLocation(locale: CliLocale, bookId: string): string {
  return formatCliMessage(locale, "book.create.location", { bookId });
}

export function formatBookCreateFoundationReady(locale: CliLocale): string {
  return formatCliMessage(locale, "book.create.foundationReady");
}

export function formatBookCreateNextStep(locale: CliLocale, bookId: string): string {
  return formatCliMessage(locale, "book.create.nextStep", { bookId });
}

export function formatWriteNextProgress(
  locale: CliLocale,
  current: number,
  total: number,
  bookId: string,
): string {
  return formatCliMessage(locale, "write.progress", { current, total, bookId });
}

export function formatWriteNextResultLines(
  locale: CliLocale,
  writingLanguage: WritingLanguage,
  result: WriteResultShape,
): string[] {
  const auditPassed = result.auditPassed ?? result.passedAudit ?? false;
  const lengthLabel = formatLengthCount(result.wordCount, resolveLengthCountingMode(writingLanguage));
  const lines = [
    formatCliMessage(locale, "write.result.chapter", {
      chapterNumber: result.chapterNumber,
      title: result.title,
    }),
    formatCliMessage(locale, "write.result.length", { length: lengthLabel }),
    formatCliMessage(locale, auditPassed ? "write.result.auditPassed" : "write.result.auditReview"),
  ];

  if (result.revised) {
    lines.push(formatCliMessage(locale, "write.result.autoRevised"));
  }

  lines.push(formatCliMessage(locale, "write.result.status", { status: result.status }));

  if (result.issues.length > 0) {
    lines.push(formatCliMessage(locale, "write.result.issues"));
    for (const issue of result.issues) {
      lines.push(`    [${issue.severity}] ${issue.category}: ${issue.description}`);
    }
  }

  return lines;
}

export function formatWriteNextComplete(locale: CliLocale): string {
  return formatCliMessage(locale, "write.complete");
}

export function formatAutoWriteStart(
  locale: CliLocale,
  bookId: string,
  startChapter: number,
  targetChapter: number,
): string {
  return formatCliMessage(locale, "auto.start", { bookId, startChapter, targetChapter });
}

export function formatAutoWriteAlreadyComplete(
  locale: CliLocale,
  bookId: string,
  writtenChapters: number,
  targetChapter: number,
): string {
  return formatCliMessage(locale, "auto.alreadyComplete", {
    bookId,
    writtenChapters,
    targetChapter,
  });
}

export type NotifyCommandAction = "write-next" | "write-rewrite" | "revise" | "audit" | "auto";

const NOTIFY_ACTION_KEYS: Record<NotifyCommandAction, CliMessageKey> = {
  "write-next": "notify.action.writeNext",
  "write-rewrite": "notify.action.writeRewrite",
  revise: "notify.action.revise",
  audit: "notify.action.audit",
  auto: "notify.action.auto",
};

export function formatNotifyCommandTitle(
  locale: CliLocale,
  action: NotifyCommandAction,
  bookName: string | undefined,
  succeeded: boolean,
): string {
  const label = formatCliMessage(locale, NOTIFY_ACTION_KEYS[action]);
  const book = bookName === undefined
    ? ""
    : formatCliMessage(locale, "notify.book.zh", { bookName });
  return formatCliMessage(locale, succeeded ? "notify.title.success" : "notify.title.failure", {
    action: label,
    book,
  });
}

export function formatNotifyBatchWriteBody(
  locale: CliLocale,
  writingLanguage: WritingLanguage,
  chapters: ReadonlyArray<{
    readonly chapterNumber: number;
    readonly title: string;
    readonly wordCount: number;
    readonly auditPassed: boolean;
  }>,
): string {
  const first = chapters[0]!;
  const last = chapters[chapters.length - 1]!;
  const lines = [
    formatCliMessage(locale, "notify.batch.head", {
      count: chapters.length,
      first: first.chapterNumber,
      last: last.chapterNumber,
    }),
    ...chapters.map((ch) => {
      const lengthLabel = formatLengthCount(ch.wordCount, resolveLengthCountingMode(writingLanguage));
      return formatCliMessage(locale, ch.auditPassed
        ? "notify.batch.chapterPassed"
        : "notify.batch.chapterReview", {
        chapterNumber: ch.chapterNumber,
        title: ch.title,
        length: lengthLabel,
      });
    }),
  ];
  return lines.join("\n");
}

export function formatNotifyAuditBody(
  locale: CliLocale,
  result: {
    readonly chapterNumber: number;
    readonly passed: boolean;
    readonly issueCount: number;
    readonly summary: string;
  },
): string {
  const head = formatCliMessage(locale, result.passed ? "notify.audit.passed" : "notify.audit.failed", {
    chapterNumber: result.chapterNumber,
    issueCount: result.issueCount,
  });
  return result.summary ? `${head}\n${result.summary}` : head;
}

export function formatNotifyReviseBody(
  locale: CliLocale,
  writingLanguage: WritingLanguage,
  result: {
    readonly chapterNumber: number;
    readonly applied: boolean;
    readonly wordCount: number;
    readonly fixedCount: number;
    readonly skippedReason?: string;
  },
): string {
  if (!result.applied) {
    return formatCliMessage(locale, "notify.revise.skipped", {
      chapterNumber: result.chapterNumber,
      reason: result.skippedReason
        ? `${locale === "zh" ? "：" : ": "}${result.skippedReason}`
        : "",
    });
  }
  const lengthLabel = formatLengthCount(result.wordCount, resolveLengthCountingMode(writingLanguage));
  return formatCliMessage(locale, "notify.revise.applied", {
    chapterNumber: result.chapterNumber,
    length: lengthLabel,
    fixedCount: result.fixedCount,
  });
}

export function formatNotifyFailureBody(locale: CliLocale, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return formatCliMessage(locale, "notify.failure", { detail });
}

export function formatImportChaptersDiscovery(
  locale: CliLocale,
  chapterCount: number,
  bookId: string,
): string {
  return formatCliMessage(locale, "import.chapters.discovery", { chapterCount, bookId });
}

export function formatImportChaptersResume(
  locale: CliLocale,
  resumeFrom: number,
): string {
  return formatCliMessage(locale, "import.chapters.resume", { resumeFrom });
}

export function formatImportChaptersComplete(
  locale: CliLocale,
  writingLanguage: WritingLanguage,
  result: ImportResultShape,
): string[] {
  const lengthLabel = formatLengthCount(result.totalWords, resolveLengthCountingMode(writingLanguage));
  return [
    formatCliMessage(locale, "import.chapters.complete"),
    formatCliMessage(locale, "import.chapters.count", { count: result.importedCount }),
    formatCliMessage(locale, "import.chapters.length", { length: lengthLabel }),
    formatCliMessage(locale, "import.chapters.next", { number: result.nextChapter }),
    "",
    formatCliMessage(locale, "import.chapters.continue", { bookId: result.continueBookId }),
  ];
}

export function formatImportCanonStart(
  locale: CliLocale,
  parentBookId: string,
  targetBookId: string,
): string {
  return formatCliMessage(locale, "import.canon.start", { parentBookId, targetBookId });
}

export function formatImportCanonComplete(locale: CliLocale): string[] {
  return [
    formatCliMessage(locale, "import.canon.complete"),
    formatCliMessage(locale, "import.canon.detect"),
  ];
}

export function formatListModelsEmpty(locale: CliLocale, service: string): string {
  return formatCliMessage(locale, "config.models.empty", { service });
}

export function formatListModelsHeader(
  locale: CliLocale,
  service: string,
  count: number,
): string {
  return formatCliMessage(locale, "config.models.header", { service, count });
}

export function formatDoctorHintQuota(locale: CliLocale): string {
  return formatCliMessage(locale, "doctor.quota");
}

export function formatDoctorHintOpenAiProbeExhausted(locale: CliLocale): string {
  return formatCliMessage(locale, "doctor.probeExhausted");
}

export function formatDoctorHintBaseUrl(locale: CliLocale): string {
  return formatCliMessage(locale, "doctor.baseUrl");
}

export function formatDoctorHintStreamRequirement(locale: CliLocale): string {
  return formatCliMessage(locale, "doctor.streamRequirement");
}

export function formatDoctorHintModelName(locale: CliLocale): string {
  return formatCliMessage(locale, "doctor.modelName");
}

export function formatDoctorHintInvalidApiKey(locale: CliLocale): string {
  return formatCliMessage(locale, "doctor.invalidApiKey");
}

// Fanfic errors are intentionally bilingual in a single string: they can surface
// through `--json` output or be rethrown before any book locale is known.
export function formatFanficInvalidModeError(mode: string): string {
  return formatCliMessage("en", "fanfic.invalidMode", { mode });
}

export function formatFanficSourceTooShortError(length: number): string {
  return formatCliMessage("en", "fanfic.sourceTooShort", { length });
}

export function formatFanficCanonMissingError(): string {
  return formatCliMessage("en", "fanfic.canonMissing");
}

export function formatFanficSourceDirEmptyError(sourcePath: string): string {
  return formatCliMessage("en", "fanfic.sourceDirEmpty", { sourcePath });
}

export function formatChapterSyncNoChanges(locale: CliLocale, checked: number): string {
  return formatCliMessage(locale, "chapter.sync.noChanges", { checked });
}

export function formatChapterSyncChange(
  locale: CliLocale,
  writingLanguage: WritingLanguage,
  change: { number: number; title: string; previousWordCount: number; wordCount: number },
): string {
  const countingMode = resolveLengthCountingMode(writingLanguage);
  const from = formatLengthCount(change.previousWordCount, countingMode);
  const to = formatLengthCount(change.wordCount, countingMode);
  return formatCliMessage(locale, "chapter.sync.change", {
    number: change.number,
    title: change.title,
    from,
    to,
  });
}

export function formatChapterSyncSummary(locale: CliLocale, changed: number, checked: number): string {
  return formatCliMessage(locale, "chapter.sync.summary", { changed, checked });
}

export function formatChapterSyncMissingFiles(locale: CliLocale, numbers: ReadonlyArray<number>): string {
  const separator = locale === "zh" ? "、" : ", ";
  return formatCliMessage(locale, "chapter.sync.missingFiles", { numbers: numbers.join(separator) });
}

export function formatChapterDeleteConfirm(
  locale: CliLocale,
  params: { bookTitle: string; bookId: string; number: number; title: string },
): string {
  return formatCliMessage(locale, "chapter.delete.confirm", {
    bookTitle: params.bookTitle,
    bookId: params.bookId,
    number: params.number,
    title: params.title,
    rolledBackTo: params.number - 1,
  });
}

export function formatChapterDeleteCancelled(locale: CliLocale): string {
  return formatCliMessage(locale, "chapter.delete.cancelled");
}

export function formatChapterDeleteDone(
  locale: CliLocale,
  params: { number: number; title: string; trashedFiles: ReadonlyArray<string>; rolledBackTo: number },
): string {
  const trashNote = params.trashedFiles.length > 0
    ? params.trashedFiles.join(", ")
    : formatCliMessage(locale, "chapter.delete.missingFile");
  return formatCliMessage(locale, "chapter.delete.done", {
    number: params.number,
    title: params.title,
    trashNote,
    rolledBackTo: params.rolledBackTo,
  });
}

export function formatBookBackupCreated(locale: CliLocale, bookId: string, backupId: string): string {
  return formatCliMessage(locale, "book.backup.created", { bookId, backupId });
}

export function formatBookBackupListEmpty(locale: CliLocale, bookId: string): string {
  return formatCliMessage(locale, "book.backup.empty", { bookId });
}

export function formatBookRestoreDone(
  locale: CliLocale,
  params: { bookId: string; backupId: string; preRestoreBackupId: string | null },
): string {
  const preNote = params.preRestoreBackupId
    ? formatCliMessage(locale, "book.restore.preBackup", { backupId: params.preRestoreBackupId })
    : formatCliMessage(locale, "book.restore.noPreBackup");
  return formatCliMessage(locale, "book.restore.done", {
    bookId: params.bookId,
    backupId: params.backupId,
    preNote,
  });
}
