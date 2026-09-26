import type { TranslationGlossaryTerm } from "./types.js";

export interface GlossaryMergeConflict {
  readonly source: string;
  readonly keptTarget: string;
  readonly rejectedTarget: string;
}

export interface GlossaryMergeResult {
  readonly terms: ReadonlyArray<TranslationGlossaryTerm>;
  readonly conflicts: ReadonlyArray<GlossaryMergeConflict>;
}

interface MutableGlossaryTerm {
  source: string;
  target: string;
  note?: string;
  category?: TranslationGlossaryTerm["category"];
  aliases: ReadonlyArray<string>;
  origin: NonNullable<TranslationGlossaryTerm["origin"]>;
  pinned: boolean;
}

// Conflict resolution priority: pinned > approved/seed > auto. Same-rank
// clashes keep the existing term so the locked translation stays stable.
export function mergeGlossaryTermsV2(
  existing: ReadonlyArray<TranslationGlossaryTerm>,
  incoming: ReadonlyArray<TranslationGlossaryTerm>,
): GlossaryMergeResult {
  const terms: MutableGlossaryTerm[] = existing.flatMap((term) => {
    const normalized = normalizeTerm(term);
    return normalized ? [normalized] : [];
  });
  const index = new Map<string, MutableGlossaryTerm>();
  for (const term of terms) {
    for (const key of indexKeys(term)) index.set(key, term);
  }

  const conflicts: GlossaryMergeConflict[] = [];

  for (const rawIncoming of incoming) {
    const candidate = normalizeTerm(rawIncoming);
    if (!candidate) continue;
    const keys = indexKeys(candidate);
    const matchKey = keys.find((key) => index.has(key));
    if (matchKey === undefined) {
      terms.push(candidate);
      for (const key of keys) index.set(key, candidate);
      continue;
    }

    const current = index.get(matchKey)!;
    if (current.target === candidate.target) {
      mergeInto(current, candidate);
      for (const key of keys) index.set(key, current);
      continue;
    }

    if (rank(candidate) > rank(current)) {
      const position = terms.indexOf(current);
      const promoted: MutableGlossaryTerm = {
        ...candidate,
        aliases: unionAliases(current.aliases, candidate.aliases),
        note: candidate.note ?? current.note,
        category: candidate.category ?? current.category,
      };
      terms[position] = promoted;
      for (const key of [...indexKeys(current), ...keys]) index.set(key, promoted);
      continue;
    }

    conflicts.push({
      source: candidate.source,
      keptTarget: current.target,
      rejectedTarget: candidate.target,
    });
  }

  return { terms, conflicts };
}

function normalizeTerm(value: TranslationGlossaryTerm): MutableGlossaryTerm | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = typeof value.source === "string" ? value.source.trim() : "";
  const target = typeof value.target === "string" ? value.target.trim() : "";
  if (!source || !target) return undefined;
  const aliases = dedupeAliases(value.aliases ?? []);
  return {
    source,
    target,
    ...(value.note?.trim() ? { note: value.note.trim() } : {}),
    ...(value.category ? { category: value.category } : {}),
    aliases,
    origin: value.origin ?? "auto",
    pinned: value.pinned === true,
  };
}

function dedupeAliases(aliases: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const alias of aliases) {
    const trimmed = alias.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function indexKeys(term: MutableGlossaryTerm): ReadonlyArray<string> {
  return [
    term.source.trim().toLowerCase(),
    ...term.aliases.map((alias) => alias.trim().toLowerCase()).filter(Boolean),
  ];
}

function rank(term: MutableGlossaryTerm): number {
  if (term.pinned) return 3;
  return term.origin === "approved" || term.origin === "seed" ? 2 : 1;
}

function sameTarget(a: MutableGlossaryTerm, b: MutableGlossaryTerm): boolean {
  return a.target === b.target;
}

function mergeInto(current: MutableGlossaryTerm, candidate: MutableGlossaryTerm): void {
  current.aliases = unionAliases(current.aliases, candidate.aliases);
  if (!current.note && candidate.note) current.note = candidate.note;
  if (!current.category && candidate.category) current.category = candidate.category;
  current.origin = rank(candidate) > rank(current) ? candidate.origin : current.origin;
  current.pinned = current.pinned || candidate.pinned;
}

function unionAliases(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return dedupeAliases([...a, ...b]);
}
