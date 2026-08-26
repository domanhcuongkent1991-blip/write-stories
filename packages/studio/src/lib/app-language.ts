// Global UI locale for display-only code that cannot use the React i18n hook.
// Business, protocol, and persisted writing content must use writing-language.ts instead.
import type { UiLocale } from "./ui-locale";
import {
  formatLocalizedString,
  type FormatValues,
  type StringKey,
} from "../i18n/catalog";

export type AppLanguage = UiLocale;

let current: AppLanguage = "zh";

export function setAppLanguage(lang: AppLanguage): void {
  current = lang;
}

export function getAppLanguage(): AppLanguage {
  return current;
}

/** Legacy display-only bilingual copy. New UI copy should use stable catalog keys. */
export function tr(zh: string, en: string): string {
  return current === "zh" ? zh : en;
}

export function translateAppString(
  key: StringKey,
  values?: FormatValues,
): string {
  return formatLocalizedString(key, current, values);
}
