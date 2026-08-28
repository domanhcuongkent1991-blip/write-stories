import type { WritingLanguage } from "../models/writing-language.js";

export function selectWritingText<T>(
  language: WritingLanguage,
  copy: { readonly zh: T; readonly en: T; readonly vi: T },
): T {
  return copy[language];
}

export function defaultChapterTitle(chapter: number, language: WritingLanguage): string {
  return selectWritingText(language, {
    zh: `第${chapter}章`,
    en: `Chapter ${chapter}`,
    vi: `Chương ${chapter}`,
  });
}

export function chapterHeading(
  chapter: number,
  title: string,
  language: WritingLanguage,
): string {
  return selectWritingText(language, {
    zh: `# 第${chapter}章 ${title}`,
    en: `# Chapter ${chapter}: ${title}`,
    vi: `# Chương ${chapter}: ${title}`,
  });
}

export function statePlaceholder(language: WritingLanguage): string {
  return selectWritingText(language, {
    zh: "(状态卡未更新)",
    en: "(state card not updated)",
    vi: "(trạng thái chưa được cập nhật)",
  });
}

export function ledgerPlaceholder(language: WritingLanguage): string {
  return selectWritingText(language, {
    zh: "(账本未更新)",
    en: "(ledger not updated)",
    vi: "(sổ theo dõi chưa được cập nhật)",
  });
}

export function hooksPlaceholder(language: WritingLanguage): string {
  return selectWritingText(language, {
    zh: "(伏笔池未更新)",
    en: "(hooks pool not updated)",
    vi: "(các tình tiết cài cắm chưa được cập nhật)",
  });
}

export function chapterSummariesHeader(language: WritingLanguage): string {
  return selectWritingText(language, {
    zh: "# 章节摘要\n\n| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |\n|------|------|----------|----------|----------|----------|----------|----------|\n",
    en: "# Chapter Summaries\n\n| Chapter | Title | Characters | Key Events | State Changes | Hook Activity | Mood | Chapter Type |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n",
    vi: "# Tóm tắt chương\n\n| Chương | Tiêu đề | Nhân vật | Sự kiện chính | Thay đổi trạng thái | Diễn biến tình tiết cài cắm | Sắc thái | Loại chương |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n",
  });
}

export function stateDegradedDescription(language: WritingLanguage): string {
  return selectWritingText(language, {
    zh: "状态结算重试后仍未通过校验。",
    en: "State validation still failed after settlement retry.",
    vi: "Xác thực trạng thái vẫn thất bại sau khi thử cập nhật lại.",
  });
}

export function stateDegradedSuggestion(language: WritingLanguage): string {
  return selectWritingText(language, {
    zh: "请先基于已保存正文修复本章 state，再继续后续章节。",
    en: "Repair chapter state from the persisted body before continuing.",
    vi: "Hãy sửa trạng thái chương dựa trên nội dung đã lưu trước khi tiếp tục.",
  });
}
