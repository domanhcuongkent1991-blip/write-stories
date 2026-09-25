import type { TranslationGlossaryTerm } from "./types.js";

export interface ChapterQaMetrics {
  readonly adherence: number;
  readonly cjkResidue: number;
  readonly addressVariants: number;
  readonly variants: number;
}

export interface ChapterQaReport {
  readonly passed: boolean;
  readonly metrics: ChapterQaMetrics;
  readonly issues: ReadonlyArray<string>;
}

const CJK_RESIDUE_PATTERN = /\p{Script=Han}/gu;
const ADDRESS_WINDOW_SIZE = 4;
const SOURCE_ADDRESS_PRONOUNS = ["我", "你", "您", "他", "她", "它", "咱"] as const;

// Heuristic, not an exhaustive grammar: these are the Vietnamese address
// forms we recognize when auditing pronoun consistency over segment windows.
const VI_ADDRESS_TERMS = new Set([
  "tôi", "ta", "tớ", "mình", "bạn", "cậu", "cô", "anh", "chị", "em",
  "ông", "bà", "nó", "hắn", "y", "gã", "tràng", "nàng", "thiếp", "trẫm",
  "quân", "đệ", "tao", "mày", "mi", "vãn bối", "tại hạ", "lão phu",
  "bản tọa", "bổn tọa", "các hạ", "tiểu sinh", "lão nô", "nô gia",
]);

// Two-word compounds collapse onto their canonical single-word form so that
// "hắn ta" does not register as a second address form next to "hắn".
const VI_ADDRESS_COMPOUNDS = new Map([
  ["hắn ta", "hắn"],
  ["nàng ta", "nàng"],
  ["chúng ta", "ta"],
  ["chúng tôi", "tôi"],
  ["chúng nó", "nó"],
  ["chúng mày", "mày"],
  ["chúng tao", "tao"],
]);

export function runChapterQa(input: {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly segments: ReadonlyArray<{ readonly source: string; readonly target: string }>;
  readonly glossary: ReadonlyArray<TranslationGlossaryTerm>;
}): ChapterQaReport {
  const combinedSource = input.segments.map((segment) => segment.source).join("\n");
  const combinedTarget = input.segments.map((segment) => segment.target ?? "").join("\n");
  const issues: string[] = [];

  const isVietnamese = isVietnameseTarget(input.targetLanguage);
  const cjkResidue = isVietnamese ? countMatches(combinedTarget, CJK_RESIDUE_PATTERN) : 0;
  if (cjkResidue > 0) {
    issues.push(`cjk-residue: ${cjkResidue} untranslated Han character(s) left in the Vietnamese output.`);
  }

  const flaggedPronouns = isVietnamese ? findAddressVariants(input.segments) : new Set<string>();
  if (flaggedPronouns.size > 0) {
    issues.push(`address-variants: source pronoun(s) ${[...flaggedPronouns].join(", ")} map to multiple Vietnamese address forms within a ${ADDRESS_WINDOW_SIZE}-segment window.`);
  }

  const variantKeys = findGlossaryVariantKeys(input.glossary);
  if (variantKeys.length > 0) {
    issues.push(`variant-detection: glossary source term(s) resolve to more than one target: ${variantKeys.join(", ")}.`);
  }

  return {
    passed: cjkResidue === 0 && flaggedPronouns.size === 0 && variantKeys.length === 0,
    metrics: {
      adherence: measureAdherence(input.glossary, combinedSource, combinedTarget),
      cjkResidue,
      addressVariants: flaggedPronouns.size,
      variants: variantKeys.length,
    },
    issues,
  };
}

function isVietnameseTarget(value: string): boolean {
  return value.trim().toLowerCase().startsWith("vi");
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function measureAdherence(
  glossary: ReadonlyArray<TranslationGlossaryTerm>,
  combinedSource: string,
  combinedTarget: string,
): number {
  const applicable = glossary.filter((term) =>
    sourceForms(term).some((form) => combinedSource.includes(form)),
  );
  if (applicable.length === 0) return 1;
  const hits = applicable.filter((term) =>
    targetForms(term).some((form) => combinedTarget.includes(form)),
  ).length;
  return hits / applicable.length;
}

function findGlossaryVariantKeys(
  glossary: ReadonlyArray<TranslationGlossaryTerm>,
): ReadonlyArray<string> {
  const targetsByKey = new Map<string, { source: string; targets: Set<string> }>();
  for (const term of glossary) {
    const key = term.source.trim().toLowerCase();
    if (!key) continue;
    const entry = targetsByKey.get(key) ?? { source: term.source.trim(), targets: new Set<string>() };
    entry.targets.add(term.target.trim());
    targetsByKey.set(key, entry);
  }
  const keys: string[] = [];
  for (const entry of targetsByKey.values()) {
    if (entry.targets.size > 1) {
      keys.push(entry.source);
    }
  }
  return keys;
}

// Source forms include aliases: 小李 is the same entity as 李明, so a term
// counts as present in the chapter when either form appears.
function sourceForms(term: TranslationGlossaryTerm): ReadonlyArray<string> {
  return [term.source, ...(term.aliases ?? [])].map((form) => form.trim()).filter(Boolean);
}

// Target forms accept the aliases as well: the locked target is preferred,
// but a recognized alias in the output still counts as a hit.
function targetForms(term: TranslationGlossaryTerm): ReadonlyArray<string> {
  return [term.target, ...(term.aliases ?? [])].map((form) => form.trim()).filter(Boolean);
}

function findAddressVariants(
  segments: ReadonlyArray<{ readonly source: string; readonly target: string }>,
): Set<string> {
  const flagged = new Set<string>();
  if (segments.length === 0) return flagged;

  const windowStarts = segments.length <= ADDRESS_WINDOW_SIZE
    ? [0]
    : Array.from({ length: segments.length - ADDRESS_WINDOW_SIZE + 1 }, (_, offset) => offset);

  for (const start of windowStarts) {
    const window = segments.slice(start, start + ADDRESS_WINDOW_SIZE);
    for (const pronoun of SOURCE_ADDRESS_PRONOUNS) {
      if (flagged.has(pronoun)) continue;
      const forms = new Set<string>();
      for (const segment of window) {
        if (!segment.source.includes(pronoun)) continue;
        for (const form of extractAddressForms(segment.target ?? "")) forms.add(form);
      }
      if (forms.size > 1) flagged.add(pronoun);
    }
  }
  return flagged;
}

function extractAddressForms(text: string): ReadonlySet<string> {
  const tokens = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const forms = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const compound = i + 1 < tokens.length ? `${tokens[i]} ${tokens[i + 1]}` : "";
    if (compound && VI_ADDRESS_COMPOUNDS.has(compound)) {
      forms.add(VI_ADDRESS_COMPOUNDS.get(compound)!);
      i++;
      continue;
    }
    if (VI_ADDRESS_TERMS.has(tokens[i]!)) forms.add(tokens[i]!);
  }
  return forms;
}
