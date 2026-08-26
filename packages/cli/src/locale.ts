import type { WritingLanguage } from "@actalk/inkos-core";

export type CliLocale = "zh" | "en" | "vi";

function normalizeLocaleTag(value: string | undefined): CliLocale | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "auto" || normalized === "c" || normalized === "posix") {
    return undefined;
  }
  if (normalized.startsWith("vi")) return "vi";
  if (normalized.startsWith("en")) return "en";
  if (normalized.startsWith("zh")) return "zh";
  return undefined;
}

export function resolveCliLocale(env: NodeJS.ProcessEnv = process.env): CliLocale {
  for (const value of [env.INKOS_LOCALE, env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const locale = normalizeLocaleTag(value);
    if (locale) return locale;
  }
  return "zh";
}

export function resolveWritingLanguage(
  explicit: unknown,
  env: NodeJS.ProcessEnv = process.env,
): WritingLanguage {
  if (explicit !== undefined && explicit !== null) {
    if (explicit === "zh" || explicit === "en") return explicit;
    throw new Error("Writing language must be zh or en.");
  }

  return env.INKOS_DEFAULT_LANGUAGE === "en" || env.INKOS_DEFAULT_LANGUAGE === "zh"
    ? env.INKOS_DEFAULT_LANGUAGE
    : "zh";
}
