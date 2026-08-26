import type { WritingLanguage } from "@actalk/inkos-core";

export type UiLocale = "zh" | "en" | "vi";

export const UI_LOCALE_STORAGE_KEY = "inkos:studio:ui-locale";

const subscribers = new Set<() => void>();
let sessionPreference: UiLocale | null = null;

export function isUiLocale(value: unknown): value is UiLocale {
  return value === "zh" || value === "en" || value === "vi";
}

function getBrowserStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

export function getUiLocalePreference(): UiLocale | null {
  if (sessionPreference !== null) return sessionPreference;

  try {
    const storedPreference = getBrowserStorage()?.getItem(UI_LOCALE_STORAGE_KEY);
    if (isUiLocale(storedPreference)) {
      sessionPreference = storedPreference;
      return storedPreference;
    }
  } catch {
    // Browsers can deny storage access; the in-memory preference remains usable.
  }

  return null;
}

export function setUiLocalePreference(locale: UiLocale): void {
  sessionPreference = locale;

  try {
    getBrowserStorage()?.setItem(UI_LOCALE_STORAGE_KEY, locale);
  } catch {
    // Persistence is best-effort; keep the selected locale for this session.
  }

  for (const subscriber of [...subscribers]) {
    try {
      subscriber();
    } catch {
      // A broken subscriber must not prevent the remaining listeners from updating.
    }
  }
}

export function subscribeUiLocale(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

export function resolveUiLocale(
  explicitPreference: UiLocale | null,
  writingLanguage: WritingLanguage | undefined,
): UiLocale {
  if (explicitPreference !== null) return explicitPreference;
  return writingLanguage === "en" ? "en" : "zh";
}
