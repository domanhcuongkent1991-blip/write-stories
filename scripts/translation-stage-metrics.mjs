#!/usr/bin/env node
// Measures translation QA metrics for a finished translation project and
// appends a stage record to docs/superpowers/baselines/translation/metrics.json.
//
// Usage:
//   node scripts/translation-stage-metrics.mjs --project <projectId> --stage <name> [--root <projectRoot>] [--out <metricsPath>]
//
// Requires the core package to be built first:
//   pnpm --filter @actalk/inkos-core build

import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    stage: { type: "string" },
    root: { type: "string" },
    out: { type: "string" },
    glossary: { type: "string" },
  },
});

if (!values.project || !values.stage) {
  console.error("Usage: node scripts/translation-stage-metrics.mjs --project <projectId> --stage <name> [--root <projectRoot>] [--out <metricsPath>] [--glossary <sharedGlossaryPath>]");
  process.exit(1);
}

const qaModulePath = join(repoRoot, "packages", "core", "dist", "translation", "qa.js");
if (!existsSync(qaModulePath)) {
  console.error(`Missing ${qaModulePath} — run: pnpm --filter @actalk/inkos-core build`);
  process.exit(1);
}
const { runChapterQa, collectThirdPersonForms } = await import(pathToFileURL(qaModulePath).href);

const projectRoot = values.root ? resolve(values.root) : repoRoot;
const projectDir = join(projectRoot, "translations", values.project);

const manifestPath = join(projectDir, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`Missing translation manifest: ${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));

let glossary = [];
if (values.glossary) {
  // Shared reference glossary: measures adherence fairly for ALL pipelines
  // (baseline self-generated glossaries would otherwise always self-match).
  const sharedPath = resolve(values.glossary);
  if (!existsSync(sharedPath)) {
    console.error(`Missing shared glossary: ${sharedPath}`);
    process.exit(1);
  }
  const shared = JSON.parse(await readFile(sharedPath, "utf-8"));
  glossary = Array.isArray(shared.terms) ? shared.terms : [];
} else {
  const glossaryPath = join(projectDir, "glossary.json");
  if (existsSync(glossaryPath)) {
    const raw = JSON.parse(await readFile(glossaryPath, "utf-8"));
    glossary = Array.isArray(raw.terms) ? raw.terms : [];
  }
}

const chapters = [];
let previousChapterForms;
for (const chapterInfo of manifest.chapters ?? []) {
  const chapterPath = join(projectRoot, chapterInfo.translatedPath);
  if (!existsSync(chapterPath)) {
    console.error(`Skipping missing chapter file: ${chapterPath}`);
    continue;
  }
  const chapter = JSON.parse(await readFile(chapterPath, "utf-8"));
  const segments = (chapter.segments ?? [])
    .filter((segment) => typeof segment.source === "string")
    .map((segment) => ({
      source: segment.source,
      target: typeof segment.target === "string" ? segment.target : "",
    }));
  const report = runChapterQa({
    sourceLanguage: manifest.sourceLanguage,
    targetLanguage: manifest.targetLanguage,
    segments,
    glossary,
    ...(previousChapterForms ? { previousChapterForms } : {}),
  });
  previousChapterForms = collectThirdPersonForms(segments);
  chapters.push({
    number: chapterInfo.number,
    metrics: {
      adherence: round(report.metrics.adherence),
      cjkResidue: report.metrics.cjkResidue,
      addressVariants: report.metrics.addressVariants,
      variants: report.metrics.variants,
    },
    passed: report.passed,
    ...(report.addressDrift ? { addressDrift: true } : {}),
  });
}

const outPath = values.out
  ? resolve(values.out)
  : join(repoRoot, "docs", "superpowers", "baselines", "translation", "metrics.json");

const records = [];
if (existsSync(outPath)) {
  const previous = JSON.parse(await readFile(outPath, "utf-8"));
  if (Array.isArray(previous)) records.push(...previous);
}
records.push({
  stage: values.stage,
  at: new Date().toISOString(),
  projectId: values.project,
  chapters,
});
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(records, null, 2)}\n`, "utf-8");

console.log(`translation stage metrics: ${values.stage} (project ${values.project})`);
console.log(
  "chapter | adherence | cjkResidue | addressVariants | variants | passed | addressDrift",
);
for (const chapter of chapters) {
  console.log(
    `${String(chapter.number).padStart(7)} | ${String(chapter.metrics.adherence).padStart(9)} | ${String(chapter.metrics.cjkResidue).padStart(10)} | ${String(chapter.metrics.addressVariants).padStart(15)} | ${String(chapter.metrics.variants).padStart(8)} | ${chapter.passed} | ${chapter.addressDrift ? "yes" : "-"}`,
  );
}
const meanAdherence = chapters.length > 0
  ? round(chapters.reduce((sum, chapter) => sum + chapter.metrics.adherence, 0) / chapters.length)
  : 1;
console.log(
  `chapters: ${chapters.length}, mean adherence: ${meanAdherence}, failed chapters: ${chapters.filter((chapter) => !chapter.passed).length}`,
);
console.log(`metrics appended to: ${outPath}`);

function round(value) {
  return Math.round(value * 1000) / 1000;
}
