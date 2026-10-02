import { readFile } from "node:fs/promises";
import { computeChapterContentHash } from "./chapter-audit-evaluator.js";

const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * Remove the title line of a persisted chapter markdown, mirroring the private
 * `readChapterContent` in `pipeline/runner.ts`: keep everything from the first
 * non-empty line after line 0. The blank lines between the title and the first
 * paragraph therefore leave the hashed text as well.
 */
export function stripChapterTitleLine(rawMarkdown: string): string {
  const lines = rawMarkdown.split("\n");
  const contentStart = lines.findIndex((line, index) => index > 0 && line.trim().length > 0);
  return contentStart >= 0 ? lines.slice(contentStart).join("\n") : rawMarkdown;
}

/**
 * Hash raw chapter markdown exactly the way the audit pipeline hashed it.
 *
 * The audit recorded `computeChapterContentHash(content)` on text that had already
 * been through `readChapterContent`, so a chapter file must be normalized the same
 * way before its hash can be compared with an audit run. Getting this wrong makes a
 * correct file look like it belongs to no run at all.
 */
export function computeChapterFileHashFromMarkdown(rawMarkdown: string): string {
  return computeChapterContentHash(stripChapterTitleLine(rawMarkdown));
}

/** Hash a chapter markdown file on disk with the audit canonicalization. */
export async function computeChapterFileHash(chapterFilePath: string): Promise<string> {
  let rawMarkdown: string;
  try {
    rawMarkdown = await readFile(chapterFilePath, "utf-8");
  } catch (error) {
    throw new Error(`Chapter file could not be read for hashing: ${chapterFilePath} (${(error as Error).message})`);
  }
  return computeChapterFileHashFromMarkdown(rawMarkdown);
}

/**
 * Read the `contentHash` an audit run recorded. Throws when the field is missing or
 * is not a 64-character lowercase hex digest, so a malformed run cannot silently be
 * treated as "no hash recorded".
 */
export async function readAuditRunContentHash(auditRunFilePath: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(auditRunFilePath, "utf-8");
  } catch (error) {
    throw new Error(`Audit run file could not be read: ${auditRunFilePath} (${(error as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Audit run file is not valid JSON: ${auditRunFilePath} (${(error as Error).message})`);
  }
  const contentHash = (parsed as { contentHash?: unknown } | null)?.contentHash;
  if (typeof contentHash !== "string" || !CONTENT_HASH_PATTERN.test(contentHash)) {
    throw new Error(`Audit run ${auditRunFilePath} has no usable contentHash field.`);
  }
  return contentHash;
}
