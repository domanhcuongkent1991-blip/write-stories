#!/usr/bin/env node
/**
 * Deterministic baseline qualification for the promotion gate.
 *
 * A gate run only measures the pipeline when the baseline book's outline
 * actually plans the depth under test. The luna-27 campaign burned a full
 * budget writing chapters 6-15 of a 5-chapter outline (root cause: outline
 * depth mismatch), so the runner now refuses such books outright. This script
 * validates a candidate baseline BEFORE any gate spend:
 *
 *   node qualification/qualify-baseline.mjs <bookDir> <targetChapters>
 *
 * Checks (all deterministic, no provider calls):
 *   1. book.json exists, language/target metadata sane
 *   2. outline/volume_map.md covers targetChapters (assessOutlineCoverage)
 *   3. hook payoff promises land inside targetChapters
 *   4. foundation files the runner resets from exist: story/snapshots/0/
 *      (character_matrix.md, current_state.md, emotional_arcs.md,
 *      pending_hooks.md) plus outline/, pending_hooks.md, author_intent.md
 *
 * Exit 0 = qualified, 1 = rejected with reasons, 2 = usage/IO error.
 */
import { readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [bookDirArg, targetArg] = process.argv.slice(2);
if (!bookDirArg || !targetArg) {
  console.error("usage: qualify-baseline.mjs <bookDir> <targetChapters>");
  process.exit(2);
}
const bookDir = resolve(bookDirArg);
const targetChapters = Number.parseInt(targetArg, 10);
if (!Number.isFinite(targetChapters) || targetChapters < 1) {
  console.error(`invalid targetChapters: ${targetArg}`);
  process.exit(2);
}

const core = await import(pathToFileURL(join(process.cwd(), "packages/core/dist/index.js")));
const { assessOutlineCoverage, parsePendingHooksMarkdown } = core;

const problems = [];
const notes = [];

async function readOrNull(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function requireFile(relative, label) {
  try {
    await access(join(bookDir, relative));
    notes.push(`ok: ${label ?? relative}`);
    return true;
  } catch {
    problems.push(`missing ${relative}`);
    return false;
  }
}

// 1. book.json
const bookJson = await readOrNull(join(bookDir, "book.json"));
if (!bookJson) {
  problems.push("missing book.json");
} else {
  const book = JSON.parse(bookJson);
  if (book.language !== "vi") problems.push(`book.language must be "vi", got ${JSON.stringify(book.language)}`);
  notes.push(`ok: book.json language=${book.language} targetChapters=${book.targetChapters}`);
}

// 2+3. outline coverage + hook payoff promises
const volumeMap = await readOrNull(join(bookDir, "story/outline/volume_map.md"))
  ?? await readOrNull(join(bookDir, "story/volume_outline.md"));
if (!volumeMap) {
  problems.push("missing outline/volume_map.md (and legacy volume_outline.md)");
} else {
  const hooksMarkdown = await readOrNull(join(bookDir, "story/pending_hooks.md"));
  const coverage = assessOutlineCoverage({
    volumeMapMarkdown: volumeMap,
    targetChapters,
    hooks: hooksMarkdown ? parsePendingHooksMarkdown(hooksMarkdown) : undefined,
  });
  for (const issue of coverage.issues) problems.push(issue);
  notes.push(`ok: outline covers ch1-${coverage.maxOutlinedChapter} in ${coverage.volumeCount} volume(s); unplanned=${coverage.unplannedChapters}`);
}

// 4. foundation files the runner resets from
const snapshotFiles = ["character_matrix.md", "current_state.md", "emotional_arcs.md", "pending_hooks.md"];
for (const file of snapshotFiles) {
  await requireFile(join("story/snapshots/0", file), `story/snapshots/0/${file}`);
  await requireFile(join("story", file), `story/${file}`);
}
await requireFile("story/author_intent.md");
await requireFile("story/outline/volume_map.md");
await requireFile("story/outline/story_frame.md");
await requireFile("story/book_rules.md");

const report = { bookDir, targetChapters, qualified: problems.length === 0, notes, problems };
console.log(JSON.stringify(report, null, 2));
process.exit(problems.length === 0 ? 0 : 1);
