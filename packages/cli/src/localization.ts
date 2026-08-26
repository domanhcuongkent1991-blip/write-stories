import {
  formatLengthCount,
  resolveLengthCountingMode,
  type WritingLanguage,
} from "@actalk/inkos-core";
import type { CliLocale } from "./locale.js";

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

function localize(locale: CliLocale, messages: { zh: string; en: string }): string {
  return locale === "zh" ? messages.zh : messages.en;
}

export function formatBookCreateCreating(
  locale: CliLocale,
  title: string,
  genre: string,
  platform: string,
): string {
  return localize(locale, {
    zh: `创建书籍 "${title}"（${genre} / ${platform}）...`,
    en: `Creating book "${title}" (${genre} / ${platform})...`,
  });
}

export function formatBookCreateCreated(locale: CliLocale, bookId: string): string {
  return localize(locale, {
    zh: `已创建书籍：${bookId}`,
    en: `Book created: ${bookId}`,
  });
}

export function formatBookCreateLocation(locale: CliLocale, bookId: string): string {
  return localize(locale, {
    zh: `  位置：books/${bookId}/`,
    en: `  Location: books/${bookId}/`,
  });
}

export function formatBookCreateFoundationReady(locale: CliLocale): string {
  return localize(locale, {
    zh: "  故事圣经、大纲和书籍规则已生成。",
    en: "  Story bible, outline, book rules generated.",
  });
}

export function formatBookCreateNextStep(locale: CliLocale, bookId: string): string {
  return localize(locale, {
    zh: `下一步：inkos write next ${bookId}`,
    en: `Next: inkos write next ${bookId}`,
  });
}

export function formatWriteNextProgress(
  locale: CliLocale,
  current: number,
  total: number,
  bookId: string,
): string {
  return localize(locale, {
    zh: `[${current}/${total}] 为「${bookId}」撰写章节...`,
    en: `[${current}/${total}] Writing chapter for "${bookId}"...`,
  });
}

export function formatWriteNextResultLines(
  locale: CliLocale,
  writingLanguage: WritingLanguage,
  result: WriteResultShape,
): string[] {
  const auditPassed = result.auditPassed ?? result.passedAudit ?? false;
  const lengthLabel = formatLengthCount(result.wordCount, resolveLengthCountingMode(writingLanguage));
  const lines = [
    localize(locale, {
      zh: `  第${result.chapterNumber}章：${result.title}`,
      en: `  Chapter ${result.chapterNumber}: ${result.title}`,
    }),
    localize(locale, {
      zh: `  字数：${lengthLabel}`,
      en: `  Length: ${lengthLabel}`,
    }),
    localize(locale, {
      zh: `  审计：${auditPassed ? "通过" : "需复核"}`,
      en: `  Audit: ${auditPassed ? "PASSED" : "NEEDS REVIEW"}`,
    }),
  ];

  if (result.revised) {
    lines.push(localize(locale, {
      zh: "  自动修正：已执行（已修复关键问题）",
      en: "  Auto-revised: YES (critical issues were fixed)",
    }));
  }

  lines.push(localize(locale, {
    zh: `  状态：${result.status}`,
    en: `  Status: ${result.status}`,
  }));

  if (result.issues.length > 0) {
    lines.push(localize(locale, {
      zh: "  问题：",
      en: "  Issues:",
    }));
    for (const issue of result.issues) {
      lines.push(`    [${issue.severity}] ${issue.category}: ${issue.description}`);
    }
  }

  return lines;
}

export function formatWriteNextComplete(locale: CliLocale): string {
  return localize(locale, {
    zh: "完成。",
    en: "Done.",
  });
}

export function formatAutoWriteStart(
  locale: CliLocale,
  bookId: string,
  startChapter: number,
  targetChapter: number,
): string {
  return localize(locale, {
    zh: `自动写作「${bookId}」：从第${startChapter}章连续写到第${targetChapter}章...`,
    en: `Auto-writing "${bookId}": chapter ${startChapter} through chapter ${targetChapter}...`,
  });
}

export function formatAutoWriteAlreadyComplete(
  locale: CliLocale,
  bookId: string,
  writtenChapters: number,
  targetChapter: number,
): string {
  return localize(locale, {
    zh: `「${bookId}」已写到第${writtenChapters}章（目标第${targetChapter}章），无需继续。`,
    en: `"${bookId}" already has ${writtenChapters} chapter(s) written (target: chapter ${targetChapter}). Nothing to do.`,
  });
}

export type NotifyCommandAction = "write-next" | "write-rewrite" | "revise" | "audit" | "auto";

const NOTIFY_ACTION_LABELS: Record<NotifyCommandAction, { zh: string; en: string }> = {
  "write-next": { zh: "写作", en: "Write" },
  "write-rewrite": { zh: "重写", en: "Rewrite" },
  revise: { zh: "修订", en: "Revise" },
  audit: { zh: "审计", en: "Audit" },
  auto: { zh: "自动连写", en: "Auto-write" },
};

export function formatNotifyCommandTitle(
  locale: CliLocale,
  action: NotifyCommandAction,
  bookName: string | undefined,
  succeeded: boolean,
): string {
  const label = localize(locale, NOTIFY_ACTION_LABELS[action]);
  const book = bookName === undefined
    ? ""
    : localize(locale, { zh: `《${bookName}》`, en: `: ${bookName}` });
  return succeeded
    ? localize(locale, { zh: `✅ ${label}完成${book}`, en: `✅ ${label} complete${book}` })
    : localize(locale, { zh: `❌ ${label}失败${book}`, en: `❌ ${label} failed${book}` });
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
    localize(locale, {
      zh: `本次完成 ${chapters.length} 章（第${first.chapterNumber}章到第${last.chapterNumber}章）`,
      en: `${chapters.length} chapter(s) written (chapter ${first.chapterNumber} to ${last.chapterNumber})`,
    }),
    ...chapters.map((ch) => {
      const lengthLabel = formatLengthCount(ch.wordCount, resolveLengthCountingMode(writingLanguage));
      return localize(locale, {
        zh: `第${ch.chapterNumber}章 ${ch.title} | ${lengthLabel} | ${ch.auditPassed ? "审计通过" : "需复核"}`,
        en: `Chapter ${ch.chapterNumber} ${ch.title} | ${lengthLabel} | ${ch.auditPassed ? "audit passed" : "needs review"}`,
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
  const head = localize(locale, {
    zh: `第${result.chapterNumber}章审计${result.passed ? "通过" : "未通过"}（${result.issueCount} 个问题）`,
    en: `Chapter ${result.chapterNumber} audit ${result.passed ? "passed" : "failed"} (${result.issueCount} issue(s))`,
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
    return localize(locale, {
      zh: `第${result.chapterNumber}章保留原稿${result.skippedReason ? `：${result.skippedReason}` : ""}`,
      en: `Chapter ${result.chapterNumber} kept original draft${result.skippedReason ? `: ${result.skippedReason}` : ""}`,
    });
  }
  const lengthLabel = formatLengthCount(result.wordCount, resolveLengthCountingMode(writingLanguage));
  return localize(locale, {
    zh: `第${result.chapterNumber}章已修订 | ${lengthLabel} | 修复 ${result.fixedCount} 个问题`,
    en: `Chapter ${result.chapterNumber} revised | ${lengthLabel} | ${result.fixedCount} issue(s) fixed`,
  });
}

export function formatNotifyFailureBody(locale: CliLocale, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return localize(locale, {
    zh: `错误：${detail}`,
    en: `Error: ${detail}`,
  });
}

export function formatImportChaptersDiscovery(
  locale: CliLocale,
  chapterCount: number,
  bookId: string,
): string {
  return localize(locale, {
    zh: `发现 ${chapterCount} 章，准备导入到「${bookId}」。`,
    en: `Found ${chapterCount} chapters to import into "${bookId}".`,
  });
}

export function formatImportChaptersResume(
  locale: CliLocale,
  resumeFrom: number,
): string {
  return localize(locale, {
    zh: `从第 ${resumeFrom} 章继续导入。`,
    en: `Resuming from chapter ${resumeFrom}.`,
  });
}

export function formatImportChaptersComplete(
  locale: CliLocale,
  writingLanguage: WritingLanguage,
  result: ImportResultShape,
): string[] {
  const lengthLabel = formatLengthCount(result.totalWords, resolveLengthCountingMode(writingLanguage));
  return [
    localize(locale, {
      zh: "导入完成：",
      en: "Import complete:",
    }),
    localize(locale, {
      zh: `  已导入章节：${result.importedCount}`,
      en: `  Chapters imported: ${result.importedCount}`,
    }),
    localize(locale, {
      zh: `  总长度：${lengthLabel}`,
      en: `  Total length: ${lengthLabel}`,
    }),
    localize(locale, {
      zh: `  下一章编号：${result.nextChapter}`,
      en: `  Next chapter number: ${result.nextChapter}`,
    }),
    "",
    localize(locale, {
      zh: `运行 "inkos write next ${result.continueBookId}" 继续写作。`,
      en: `Run "inkos write next ${result.continueBookId}" to continue writing.`,
    }),
  ];
}

export function formatImportCanonStart(
  locale: CliLocale,
  parentBookId: string,
  targetBookId: string,
): string {
  return localize(locale, {
    zh: `把 "${parentBookId}" 的正典导入到 "${targetBookId}"...`,
    en: `Importing canon from "${parentBookId}" into "${targetBookId}"...`,
  });
}

export function formatImportCanonComplete(locale: CliLocale): string[] {
  return [
    localize(locale, {
      zh: "正典已导入：story/parent_canon.md",
      en: "Canon imported: story/parent_canon.md",
    }),
    localize(locale, {
      zh: "Writer 和 auditor 会在番外模式下自动识别这个文件。",
      en: "Writer and auditor will auto-detect this file for spinoff mode.",
    }),
  ];
}

export function formatListModelsEmpty(locale: CliLocale, service: string): string {
  return localize(locale, {
    zh: `${service} 没有可用模型（可能需要 --api-key 和 --base-url）`,
    en: `No models available for ${service} (you may need --api-key and --base-url)`,
  });
}

export function formatListModelsHeader(
  locale: CliLocale,
  service: string,
  count: number,
): string {
  return localize(locale, {
    zh: `${service}：${count} 个模型`,
    en: `${service}: ${count} model(s)`,
  });
}

export function formatDoctorHintQuota(locale: CliLocale): string {
  return localize(locale, {
    zh: "检查 API Key 是否正确、模型是否可用，以及账号余额或配额是否足够。",
    en: "Check that the API key is valid, the model is available, and the account has enough balance or quota.",
  });
}

export function formatDoctorHintOpenAiProbeExhausted(locale: CliLocale): string {
  return localize(locale, {
    zh: "当前已自动尝试 chat/responses 与流式开关组合；如果仍失败，问题更可能在模型名、baseUrl 路径或服务商兼容性本身。",
    en: "All chat/responses and stream on/off combinations were already probed; if it still fails, the problem is more likely the model name, the baseUrl path, or provider compatibility itself.",
  });
}

export function formatDoctorHintBaseUrl(locale: CliLocale): string {
  return localize(locale, {
    zh: "baseUrl 可能不正确，检查 INKOS_LLM_BASE_URL 是否包含完整路径（如 /v1）",
    en: "The baseUrl may be wrong. Check that INKOS_LLM_BASE_URL includes the full path (e.g. /v1).",
  });
}

export function formatDoctorHintStreamRequirement(locale: CliLocale): string {
  return localize(locale, {
    zh: "检查提供方文档，确认该接口要求 stream=true、stream=false，还是根本不支持 stream",
    en: "Check the provider docs to confirm whether the endpoint requires stream=true, stream=false, or does not support streaming at all.",
  });
}

export function formatDoctorHintModelName(locale: CliLocale): string {
  return localize(locale, {
    zh: "检查模型名称是否正确（INKOS_LLM_MODEL）",
    en: "Check that the model name is correct (INKOS_LLM_MODEL).",
  });
}

export function formatDoctorHintInvalidApiKey(locale: CliLocale): string {
  return localize(locale, {
    zh: "API Key 无效，检查 INKOS_LLM_API_KEY",
    en: "The API key is invalid. Check INKOS_LLM_API_KEY.",
  });
}

// Fanfic errors are intentionally bilingual in a single string: they can surface
// through `--json` output or be rethrown before any book locale is known.
export function formatFanficInvalidModeError(mode: string): string {
  return `Invalid fanfic mode: "${mode}". Valid modes: canon, au, ooc, cp（无效的同人模式："${mode}"，可选 canon、au、ooc、cp）`;
}

export function formatFanficSourceTooShortError(length: number): string {
  return `Source material too short (${length} chars); provide at least 100 chars（源素材内容过短，仅 ${length} 字符，请提供至少 100 字符的原作素材）`;
}

export function formatFanficCanonMissingError(): string {
  return "No fanfic canon found for this book. Create one with `inkos fanfic init`（该书没有同人正典文件，用 inkos fanfic init 创建同人书）";
}

export function formatFanficSourceDirEmptyError(sourcePath: string): string {
  return `No .txt or .md files found in ${sourcePath}（目录 ${sourcePath} 中没有 .txt 或 .md 文件）`;
}

export function formatChapterSyncNoChanges(locale: CliLocale, checked: number): string {
  return localize(locale, {
    zh: `已核对 ${checked} 章，index.json 字数无需修正。`,
    en: `Checked ${checked} chapter(s); index.json word counts already match the files.`,
  });
}

export function formatChapterSyncChange(
  locale: CliLocale,
  writingLanguage: WritingLanguage,
  change: { number: number; title: string; previousWordCount: number; wordCount: number },
): string {
  const countingMode = resolveLengthCountingMode(writingLanguage);
  const from = formatLengthCount(change.previousWordCount, countingMode);
  const to = formatLengthCount(change.wordCount, countingMode);
  return localize(locale, {
    zh: `  第${change.number}章 ${change.title}：${from} → ${to}`,
    en: `  Chapter ${change.number} ${change.title}: ${from} → ${to}`,
  });
}

export function formatChapterSyncSummary(locale: CliLocale, changed: number, checked: number): string {
  return localize(locale, {
    zh: `已核对 ${checked} 章，修正了 ${changed} 章的 index.json 字数。`,
    en: `Checked ${checked} chapter(s); corrected ${changed} index.json word count(s).`,
  });
}

export function formatChapterSyncMissingFiles(locale: CliLocale, numbers: ReadonlyArray<number>): string {
  return localize(locale, {
    zh: `警告：index.json 中的第 ${numbers.join("、")} 章找不到对应的章节文件，已跳过。`,
    en: `Warning: chapter(s) ${numbers.join(", ")} exist in index.json but have no chapter file on disk; skipped.`,
  });
}

export function formatChapterDeleteConfirm(
  locale: CliLocale,
  params: { bookTitle: string; bookId: string; number: number; title: string },
): string {
  return localize(locale, {
    zh: `将删除《${params.bookTitle}》(${params.bookId}) 的最新章：第${params.number}章 ${params.title}。`
      + `章节文件会移入 chapters/.trash/，索引和故事状态回滚到第${params.number - 1}章。确认删除？(y/N) `,
    en: `Delete the latest chapter of "${params.bookTitle}" (${params.bookId}): chapter ${params.number} ${params.title}? `
      + `The chapter file moves to chapters/.trash/ and the index and story state roll back to chapter ${params.number - 1}. (y/N) `,
  });
}

export function formatChapterDeleteCancelled(locale: CliLocale): string {
  return localize(locale, {
    zh: "已取消。",
    en: "Cancelled.",
  });
}

export function formatChapterDeleteDone(
  locale: CliLocale,
  params: { number: number; title: string; trashedFiles: ReadonlyArray<string>; rolledBackTo: number },
): string {
  const trashNote = params.trashedFiles.length > 0
    ? params.trashedFiles.join(", ")
    : localize(locale, { zh: "（章节文件已不存在，未移动）", en: "(chapter file was already gone; nothing moved)" });
  return localize(locale, {
    zh: `已删除第${params.number}章 ${params.title}：章节文件保留在 ${trashNote}，索引和故事状态已回滚到第${params.rolledBackTo}章。`,
    en: `Deleted chapter ${params.number} ${params.title}: chapter file kept at ${trashNote}; index and story state rolled back to chapter ${params.rolledBackTo}.`,
  });
}

export function formatBookBackupCreated(locale: CliLocale, bookId: string, backupId: string): string {
  return localize(locale, {
    zh: `已备份 ${bookId} → .inkos/backups/${bookId}/${backupId}/`,
    en: `Backed up ${bookId} → .inkos/backups/${bookId}/${backupId}/`,
  });
}

export function formatBookBackupListEmpty(locale: CliLocale, bookId: string): string {
  return localize(locale, {
    zh: `${bookId} 还没有备份。用 inkos book backup ${bookId} 创建一份。`,
    en: `No backups for ${bookId} yet. Create one with: inkos book backup ${bookId}`,
  });
}

export function formatBookRestoreDone(
  locale: CliLocale,
  params: { bookId: string; backupId: string; preRestoreBackupId: string | null },
): string {
  const preNote = params.preRestoreBackupId
    ? localize(locale, {
        zh: `恢复前的状态已自动备份为 ${params.preRestoreBackupId}。`,
        en: `The pre-restore state was automatically backed up as ${params.preRestoreBackupId}.`,
      })
    : localize(locale, {
        zh: "书目录当时不存在，未创建恢复前备份。",
        en: "The book directory did not exist, so no pre-restore backup was created.",
      });
  return localize(locale, {
    zh: `已把 ${params.bookId} 恢复到备份 ${params.backupId}。${preNote}`,
    en: `Restored ${params.bookId} to backup ${params.backupId}. ${preNote}`,
  });
}
