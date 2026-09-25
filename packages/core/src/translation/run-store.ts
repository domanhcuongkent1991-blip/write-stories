import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  TranslationChapterFile,
  TranslationGlossaryTerm,
  TranslationProjectManifest,
  TranslationTermCategory,
  TranslationTermOrigin,
} from "./types.js";
import { mergeGlossaryTermsV2 } from "./glossary-merge.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";

export function translationProjectDir(projectRoot: string, projectId: string): string {
  return join(projectRoot, "translations", projectId);
}

export function translationManifestPath(projectRoot: string, projectId: string): string {
  return join(translationProjectDir(projectRoot, projectId), "manifest.json");
}

export async function loadTranslationManifest(
  projectRoot: string,
  projectId: string,
): Promise<TranslationProjectManifest> {
  return JSON.parse(await readFile(translationManifestPath(projectRoot, projectId), "utf-8")) as TranslationProjectManifest;
}

export async function saveTranslationManifest(
  projectRoot: string,
  manifest: TranslationProjectManifest,
): Promise<void> {
  await writeFile(translationManifestPath(projectRoot, manifest.id), JSON.stringify(manifest, null, 2), "utf-8");
}

export async function loadTranslationChapter(
  projectRoot: string,
  chapterPath: string,
): Promise<TranslationChapterFile> {
  const raw = JSON.parse(await readFile(join(projectRoot, chapterPath), "utf-8")) as TranslationChapterFile;
  return {
    ...raw,
    segments: Array.isArray(raw.segments) ? raw.segments.map(normalizeLegacySegment) : raw.segments,
  };
}

export async function saveTranslationChapter(
  projectRoot: string,
  chapterPath: string,
  chapter: TranslationChapterFile,
): Promise<void> {
  await writeFile(join(projectRoot, chapterPath), JSON.stringify(chapter, null, 2), "utf-8");
}

export async function loadTranslationGlossary(
  projectRoot: string,
  projectId: string,
): Promise<ReadonlyArray<TranslationGlossaryTerm>> {
  try {
    const raw = JSON.parse(await readFile(join(translationProjectDir(projectRoot, projectId), "glossary.json"), "utf-8")) as {
      terms?: unknown;
    };
    return Array.isArray(raw.terms)
      ? raw.terms.flatMap((term) => {
          const normalized = normalizeGlossaryTerm(term);
          return normalized ? [normalized] : [];
        })
      : [];
  } catch {
    return [];
  }
}

export async function saveTranslationGlossary(
  projectRoot: string,
  projectId: string,
  terms: ReadonlyArray<TranslationGlossaryTerm>,
  meta?: { readonly prepCompletedAt?: string },
): Promise<void> {
  await writeFile(
    join(translationProjectDir(projectRoot, projectId), "glossary.json"),
    JSON.stringify({
      version: 2,
      terms: mergeGlossaryTerms(terms),
      ...(meta ? { meta } : {}),
    }, null, 2),
    "utf-8",
  );
}

export async function saveTranslationProgress(
  projectRoot: string,
  projectId: string,
  chapterPath: string,
  chapter: TranslationChapterFile,
  terms: ReadonlyArray<TranslationGlossaryTerm>,
): Promise<void> {
  await commitAtomicFileSet({
    rootDir: projectRoot,
    writes: [
      {
        relativePath: chapterPath,
        content: `${JSON.stringify(chapter, null, 2)}\n`,
      },
      {
        relativePath: join("translations", projectId, "glossary.json"),
        content: `${JSON.stringify({ version: 2, terms: mergeGlossaryTerms(terms) }, null, 2)}\n`,
      },
    ],
  });
}

export function mergeGlossaryTerms(terms: ReadonlyArray<TranslationGlossaryTerm>): ReadonlyArray<TranslationGlossaryTerm> {
  return mergeGlossaryTermsV2(terms, []).terms;
}

const TERM_CATEGORIES: ReadonlyArray<TranslationTermCategory> = [
  "person",
  "place",
  "organization",
  "sect",
  "technique",
  "item",
  "other",
];
const TERM_ORIGINS: ReadonlyArray<TranslationTermOrigin> = ["seed", "auto", "approved"];

// Legacy chapters stored a bare target with no stage: treat those segments
// as first-pass drafts so the refine pass can pick them up.
function normalizeLegacySegment<T extends { target?: string; stage?: string }>(segment: T): T {
  const hasTarget = typeof segment.target === "string" && segment.target.trim().length > 0;
  if (!hasTarget || segment.stage) return segment;
  return { ...segment, stage: "draft" };
}

function normalizeGlossaryTerm(value: unknown): TranslationGlossaryTerm | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.source !== "string" || typeof record.target !== "string") return undefined;
  const category = typeof record.category === "string" && TERM_CATEGORIES.includes(record.category as TranslationTermCategory)
    ? record.category as TranslationTermCategory
    : undefined;
  const origin = typeof record.origin === "string" && TERM_ORIGINS.includes(record.origin as TranslationTermOrigin)
    ? record.origin as TranslationTermOrigin
    : "auto";
  const aliases = Array.isArray(record.aliases)
    ? record.aliases.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0)
    : [];
  return {
    source: record.source,
    target: record.target,
    ...(typeof record.note === "string" && record.note.trim() ? { note: record.note } : {}),
    ...(category ? { category } : {}),
    aliases,
    origin,
    pinned: record.pinned === true,
  };
}
