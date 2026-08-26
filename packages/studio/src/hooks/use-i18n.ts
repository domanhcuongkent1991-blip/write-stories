import { useCallback, useSyncExternalStore } from "react";
import type { WritingLanguage } from "@actalk/inkos-core";
import {
  formatLocalizedString,
  type TFunction,
} from "../i18n/catalog";
import {
  getUiLocalePreference,
  resolveUiLocale,
  setUiLocalePreference,
  subscribeUiLocale,
} from "../lib/ui-locale";
import { useApi } from "./use-api";

export type { TFunction } from "../i18n/catalog";

export function useI18n() {
  const { data } = useApi<{ language: WritingLanguage }>("/project");
  const lang: WritingLanguage = data?.language === "en" ? "en" : "zh";
  const getSnapshot = useCallback(
    () => resolveUiLocale(getUiLocalePreference(), lang),
    [lang],
  );
  const locale = useSyncExternalStore(
    subscribeUiLocale,
    getSnapshot,
    getSnapshot,
  );
  const t = useCallback<TFunction>(
    (key, values) => formatLocalizedString(key, locale, values),
    [locale],
  );

  return { t, lang, locale, setLocale: setUiLocalePreference };
}
