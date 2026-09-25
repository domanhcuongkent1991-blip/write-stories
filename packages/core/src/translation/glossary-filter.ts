import type { TranslationGlossaryTerm } from "./types.js";

export interface FilterGlossaryForTextOptions {
  readonly maxTerms?: number;
}

const DEFAULT_MAX_TERMS = 80;
const CJK_PATTERN = /\p{Script=Han}/u;

// Filters the glossary down to terms relevant for one batch: CJK terms match
// by substring, Latin terms by word boundary, aliases included. Person terms
// and pinned terms are exempt from the cap so character names are never
// dropped from the prompt.
export function filterGlossaryForText(
  terms: ReadonlyArray<TranslationGlossaryTerm>,
  text: string,
  options: FilterGlossaryForTextOptions = {},
): ReadonlyArray<TranslationGlossaryTerm> {
  const maxTerms = Math.max(0, options.maxTerms ?? DEFAULT_MAX_TERMS);
  const exempt: TranslationGlossaryTerm[] = [];
  const matching: TranslationGlossaryTerm[] = [];

  for (const term of terms) {
    if (isExempt(term)) {
      exempt.push(term);
      continue;
    }
    if (matchesText(term, text)) {
      matching.push(term);
    }
  }

  const capped = [...exempt, ...matching.sort((a, b) => b.source.length - a.source.length)];
  return capped.slice(0, Math.max(maxTerms, exempt.length));
}

function isExempt(term: TranslationGlossaryTerm): boolean {
  return term.category === "person" || term.pinned === true;
}

function matchesText(term: TranslationGlossaryTerm, text: string): boolean {
  if (matchesWord(term.source, text)) return true;
  return (term.aliases ?? []).some((alias) => matchesWord(alias, text));
}

function matchesWord(source: string, text: string): boolean {
  const needle = source.trim();
  if (!needle) return false;
  if (CJK_PATTERN.test(needle)) {
    return text.includes(needle);
  }
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}
