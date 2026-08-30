import type {
  PromptStrategy,
  ScaffoldLanguage,
  WritingLanguage,
} from "../models/writing-language.js";
import type { LengthCountingMode } from "../models/length-governance.js";

export interface WritingLanguageProfile {
  readonly language: WritingLanguage;
  readonly promptStrategy: PromptStrategy;
  readonly scaffoldLanguage: ScaffoldLanguage;
  readonly countingMode: LengthCountingMode | "vi_wordlike_tokens_v1";
  readonly defaultChapterLength: number;
  readonly supportsLongFiction: true;
}

const WRITING_LANGUAGE_PROFILES: Readonly<
  Record<WritingLanguage, WritingLanguageProfile>
> = {
  zh: {
    language: "zh",
    promptStrategy: "legacy-zh",
    scaffoldLanguage: "zh",
    countingMode: "zh_chars",
    defaultChapterLength: 3000,
    supportsLongFiction: true,
  },
  en: {
    language: "en",
    promptStrategy: "legacy-en",
    scaffoldLanguage: "en",
    countingMode: "en_words",
    defaultChapterLength: 2000,
    supportsLongFiction: true,
  },
  vi: {
    language: "vi",
    promptStrategy: "en-scaffold-vi-contract",
    scaffoldLanguage: "en",
    countingMode: "vi_wordlike_tokens_v1",
    defaultChapterLength: 1150,
    supportsLongFiction: true,
  },
};

export function resolveWritingLanguageProfile(
  language: WritingLanguage,
): WritingLanguageProfile {
  return WRITING_LANGUAGE_PROFILES[language];
}

/**
 * Infer the writing language from a free-text brief/premise when the user did not set one explicitly.
 *
 * Conservative by design: defaults to "zh" (preserving prior behaviour for Chinese users) and only
 * returns "en" when the text is clearly Latin-dominant. A Chinese brief that mentions an English name
 * or term still resolves to "zh"; incidental CJK inside an otherwise English brief resolves to "en".
 */
export function inferLanguage(text?: string | null): ScaffoldLanguage {
  const t = text ?? "";
  const cjk = (t.match(/[一-鿿]/g) ?? []).length;
  const latin = (t.match(/[A-Za-z]/g) ?? []).length;
  if (cjk === 0 && latin > 0) return "en";
  if (latin > 0 && cjk * 4 < latin) return "en";
  return "zh";
}
