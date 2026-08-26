import type { WritingLanguage as CoreWritingLanguage } from "@actalk/inkos-core";

export type WritingLanguage = Extract<CoreWritingLanguage, "zh" | "en">;

let currentWritingLanguage: WritingLanguage = "zh";

export function resolveProjectWritingLanguage(value: unknown): WritingLanguage {
  return value === "en" ? "en" : "zh";
}

export function setWritingLanguage(language: WritingLanguage): void {
  currentWritingLanguage = language;
}

export function getWritingLanguage(): WritingLanguage {
  return currentWritingLanguage;
}

export function selectWritingText(
  zh: string,
  en: string,
  language: WritingLanguage = currentWritingLanguage,
): string {
  return language === "en" ? en : zh;
}
