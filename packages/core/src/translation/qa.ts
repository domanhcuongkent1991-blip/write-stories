import type { TranslationGlossaryTerm } from "./types.js";

export interface ChapterQaMetrics {
  readonly adherence: number;
  readonly cjkResidue: number;
  readonly addressVariants: number;
  readonly variants: number;
  readonly hallucination: number;
}

export interface ChapterQaReport {
  readonly passed: boolean;
  readonly metrics: ChapterQaMetrics;
  readonly issues: ReadonlyArray<string>;
  readonly addressDrift?: boolean;
}

const CJK_RESIDUE_PATTERN = /\p{Script=Han}/gu;

// Official zh->vi pronoun alignment table (locked; do not extend without
// owner approval). Forms claimed by narrower groups first so that 他+它 in one
// segment with target hắn+nó resolves to one form per group, not a false mix.
const PRONOUN_GROUPS: ReadonlyArray<{ readonly sources: ReadonlyArray<string>; readonly forms: ReadonlyArray<string> }> = [
  { sources: ["它", "牠"], forms: ["nó"] },
  { sources: ["他"], forms: ["hắn", "y", "nó", "cậu", "chàng"] },
  { sources: ["她"], forms: ["nàng", "cô", "chị", "nó", "丫头", "mỹ nữ"] },
  { sources: ["我"], forms: ["ta", "tôi", "thiếp", "lão phu", "tại hạ"] },
  { sources: ["你", "妳"], forms: ["ngươi", "cậu", "huynh", "tỷ", "cô"] },
];

// Two-word compounds collapse onto their canonical single-word form so that
// "hắn ta" does not register as a second address form next to "hắn".
const VI_ADDRESS_COMPOUNDS = new Map([
  ["hắn ta", "hắn"],
  ["nàng ta", "nàng"],
  ["chúng ta", "ta"],
  ["chúng tôi", "tôi"],
  ["chúng nó", "nó"],
  ["mỹ nữ", "mỹ nữ"],
]);

export function runChapterQa(input: {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly segments: ReadonlyArray<{ readonly source: string; readonly target: string }>;
  readonly glossary: ReadonlyArray<TranslationGlossaryTerm>;
  readonly previousChapterForms?: ReadonlyArray<string>;
}): ChapterQaReport {
  const combinedSource = input.segments.map((segment) => segment.source).join("\n");
  const combinedTarget = input.segments.map((segment) => segment.target ?? "").join("\n");
  const issues: string[] = [];

  const isVietnamese = isVietnameseTarget(input.targetLanguage);
  const cjkResidue = isVietnamese ? countMatches(combinedTarget, CJK_RESIDUE_PATTERN) : 0;
  if (cjkResidue > 0) {
    issues.push(`cjk-residue: ${cjkResidue} untranslated Han character(s) left in the Vietnamese output.`);
  }

  const addressVariants = isVietnamese ? findAddressVariants(input.segments) : 0;
  if (addressVariants > 0) {
    // P5: the alignment table counts one SOURCE pronoun per chapter, but multi-character
    // novels legitimately map 他/她 of different characters to different Vietnamese forms —
    // informational warning only, never a gate failure (cross-chapter addressDrift still detects real shifts).
    issues.push(`address-variants-warning: ${addressVariants} source pronoun group(s) map to multiple Vietnamese address forms from the alignment table.`);
  }

  const variantKeys = findGlossaryVariantKeys(input.glossary);
  if (variantKeys.length > 0) {
    issues.push(`variant-detection: glossary source term(s) resolve to more than one target: ${variantKeys.join(", ")}.`);
  }

  const hallucinations = isVietnamese
    ? findEntityHallucinations(input.segments, input.glossary)
    : [];
  if (hallucinations.length > 0) {
    issues.push(`entity-hallucination: locked proper noun(s) appear in the output without their source form nearby: ${hallucinations.join("; ")}.`);
  }

  const addressDrift = detectAddressDrift(input.segments, input.previousChapterForms);

  return {
    passed: cjkResidue === 0 && variantKeys.length === 0 && hallucinations.length === 0,
    metrics: {
      adherence: measureAdherence(input.glossary, combinedSource, combinedTarget),
      cjkResidue,
      addressVariants,
      variants: variantKeys.length,
      hallucination: hallucinations.length,
    },
    issues,
    ...(addressDrift ? { addressDrift: true } : {}),
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
  // Case-insensitive: "Ngự khí" at sentence start must still match the
  // locked form "ngự khí" — capitalization is not a terminology drift.
  const haystackSource = combinedSource.toLowerCase();
  const haystackTarget = combinedTarget.toLowerCase();
  const applicable = glossary.filter((term) =>
    sourceForms(term).some((form) => haystackSource.includes(form.toLowerCase())),
  );
  if (applicable.length === 0) return 1;
  const hits = applicable.filter((term) =>
    targetForms(term).some((form) => haystackTarget.includes(form.toLowerCase())),
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

// Alignment-aware address audit: only segments whose SOURCE contains a source
// pronoun are examined; only Vietnamese forms from that pronoun's alignment
// group are counted. A pronoun group accumulates its forms over the chapter;
// a group ends up flagged when two distinct forms appear (per segment or
// across segments). Narrower groups (fewer forms) claim shared forms first.
function findAddressVariants(
  segments: ReadonlyArray<{ readonly source: string; readonly target: string }>,
): number {
  const formsByGroup = new Map<(typeof PRONOUN_GROUPS)[number], Set<string>>();
  for (const segment of segments) {
    const groupsInSegment = PRONOUN_GROUPS.filter(
      (group) => group.sources.some((source) => segment.source.includes(source)),
    );
    if (groupsInSegment.length === 0) continue;
    const targetForms = extractAddressForms(segment.target ?? "");
    const claimed = new Set<string>();
    for (const group of [...groupsInSegment].sort((a, b) => a.forms.length - b.forms.length)) {
      const bucket = formsByGroup.get(group) ?? new Set<string>();
      for (const form of targetForms) {
        if (!group.forms.includes(form) || claimed.has(form)) continue;
        claimed.add(form);
        bucket.add(form);
      }
      formsByGroup.set(group, bucket);
    }
  }

  let variants = 0;
  for (const forms of formsByGroup.values()) {
    if (forms.size >= 2) variants += 1;
  }
  return variants;
}

// Third-person forms (他/她 groups) seen in the chapter — used for
// cross-chapter drift detection. One distinct form means the chapter is
// internally consistent.
export function collectThirdPersonForms(
  segments: ReadonlyArray<{ readonly source: string; readonly target: string }>,
): ReadonlyArray<string> {
  const forms = new Set<string>();
  for (const segment of segments) {
    const groups = PRONOUN_GROUPS.filter(
      (group) => group.sources.includes("他") || group.sources.includes("她"),
    ).filter(
      (group) => group.sources.some((source) => segment.source.includes(source)),
    );
    if (groups.length === 0) continue;
    for (const form of extractAddressForms(segment.target ?? "")) {
      if (groups.some((group) => group.forms.includes(form))) forms.add(form);
    }
  }
  return [...forms].sort();
}

function detectAddressDrift(
  segments: ReadonlyArray<{ readonly source: string; readonly target: string }>,
  previousChapterForms: ReadonlyArray<string> | undefined,
): boolean {
  if (!previousChapterForms) return false;
  const current = collectThirdPersonForms(segments);
  return current.length === 1
    && previousChapterForms.length === 1
    && current[0] !== previousChapterForms[0];
}

// Only proper nouns hallucinate dangerously (the R3 "đối thủ là Lục Cửu
// Xuyên" bug): a locked person/sect/place target appearing in the output
// while its source form (or alias) is absent from the same or adjacent
// source segment means an invented or swapped entity.
const HALLUCINATION_CATEGORIES: ReadonlySet<string> = new Set(["person", "sect", "place"]);

function findEntityHallucinations(
  segments: ReadonlyArray<{ readonly source: string; readonly target: string }>,
  glossary: ReadonlyArray<TranslationGlossaryTerm>,
): ReadonlyArray<string> {
  const flagged: string[] = [];
  const eligible = glossary.filter(
    (term) => term.category !== undefined && HALLUCINATION_CATEGORIES.has(term.category),
  );
  for (let index = 0; index < segments.length; index++) {
    const targetLower = (segments[index]!.target ?? "").toLowerCase();
    for (const term of eligible) {
      const targetForm = term.target.trim().toLowerCase();
      if (!targetForm || !targetLower.includes(targetForm)) continue;
      const sourceForms = [term.source, ...(term.aliases ?? [])].map((form) => form.trim()).filter(Boolean);
      const nearby = [-1, 0, 1].some((offset) => {
        const neighbor = segments[index + offset];
        return neighbor !== undefined && sourceForms.some((form) => neighbor.source.includes(form));
      });
      if (!nearby) flagged.push(`seg${index + 1} "${term.target}"`);
    }
  }
  return flagged;
}

const ALL_ADDRESS_FORMS: ReadonlySet<string> = new Set(
  PRONOUN_GROUPS.flatMap((group) => group.forms),
);

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
    if (ALL_ADDRESS_FORMS.has(tokens[i]!)) forms.add(tokens[i]!);
  }
  return forms;
}
