import { Command } from "commander";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  listAvailableGenres,
  readGenreProfile,
  getBuiltinGenresDir,
  type WritingLanguage,
} from "@actalk/inkos-core";
import { findProjectRoot, log, logError } from "../utils.js";
import { resolveWritingLanguage } from "../locale.js";
import { formatCurrentCliMessage } from "../i18n/messages.js";

export function buildGenreTemplate(
  params: {
    readonly id: string;
    readonly name: string;
    readonly numerical: boolean;
    readonly power: boolean;
    readonly era: boolean;
  },
  writingLanguage: WritingLanguage,
): string {
  if (writingLanguage !== "zh") {
    return `---
name: ${params.name}
id: ${params.id}
chapterTypes: ["progression", "setup", "transition", "payoff"]
fatigueWords: ["shocked", "unbelievable", "incredible"]
numericalSystem: ${params.numerical}
powerScaling: ${params.power}
eraResearch: ${params.era}
pacingRule: "A clear advance or payoff every 2-3 chapters"
satisfactionTypes: ["goal achieved", "obstacle overcome", "truth revealed"]
auditDimensions: [1,2,3,6,7,8,9,10,13,14,15,16,17,18,19]
---

## Genre Taboos

- (add taboos for this genre)

## Narrative Guidance

(describe the narrative focus and style requirements for this genre)
`;
  }

  return `---
name: ${params.name}
id: ${params.id}
chapterTypes: ["推进章", "布局章", "过渡章", "回收章"]
fatigueWords: ["震惊", "不可思议", "难以置信"]
numericalSystem: ${params.numerical}
powerScaling: ${params.power}
eraResearch: ${params.era}
pacingRule: "每2-3章有一个明确的进展或反馈"
satisfactionTypes: ["目标达成", "困难克服", "真相揭示"]
auditDimensions: [1,2,3,6,7,8,9,10,13,14,15,16,17,18,19]
---

## 题材禁忌

- (根据题材添加禁忌)

## 叙事指导

(根据题材描述叙事重心和风格要求)
`;
}

export const genreCommand = new Command("genre")
  .description("Manage genre profiles");

genreCommand
  .command("list")
  .description("List all available genre profiles (built-in + project)")
  .action(async () => {
    try {
      const root = findProjectRoot();
      const genres = await listAvailableGenres(root);

      if (genres.length === 0) {
        log(formatCurrentCliMessage("genre.empty"));
        return;
      }

      log(formatCurrentCliMessage("genre.available"));
      for (const g of genres) {
        const tag = g.source === "project" ? "[project]" : "[builtin]";
        log(formatCurrentCliMessage("genre.row", { id: g.id.padEnd(12), name: g.name.padEnd(8), source: tag }));
      }
      log(formatCurrentCliMessage("genre.total", { count: genres.length }));
    } catch (e) {
      logError(formatCurrentCliMessage("genre.listFailure", { detail: String(e) }));
      process.exit(1);
    }
  });

genreCommand
  .command("show")
  .description("Display a genre profile")
  .argument("<id>", "Genre ID (e.g. xuanhuan, urban, horror)")
  .action(async (id: string) => {
    try {
      const root = findProjectRoot();
      const genres = await listAvailableGenres(root);
      const exactMatch = genres.some(g => g.id === id);
      if (!exactMatch) {
        logError(formatCurrentCliMessage("genre.notFound", { id, available: genres.map(g => g.id).join(", ") }));
        process.exit(1);
      }
      const { profile, body } = await readGenreProfile(root, id);

      log(formatCurrentCliMessage("genre.header", { name: profile.name, id: profile.id }));
      log(formatCurrentCliMessage("genre.chapterTypes", { value: profile.chapterTypes.join(", ") }));
      log(formatCurrentCliMessage("genre.fatigueWords", { value: profile.fatigueWords.join(", ") }));
      log(formatCurrentCliMessage("genre.numerical", { value: profile.numericalSystem }));
      log(formatCurrentCliMessage("genre.power", { value: profile.powerScaling }));
      log(formatCurrentCliMessage("genre.era", { value: profile.eraResearch }));
      log(formatCurrentCliMessage("genre.pacing", { value: profile.pacingRule }));
      log(formatCurrentCliMessage("genre.satisfaction", { value: profile.satisfactionTypes.join(", ") }));
      log(formatCurrentCliMessage("genre.audit", { value: profile.auditDimensions.join(", ") }));

      if (body) {
        log(formatCurrentCliMessage("genre.body", { body }));
      }
    } catch (e) {
      logError(formatCurrentCliMessage("genre.showFailure", { detail: String(e) }));
      process.exit(1);
    }
  });

genreCommand
  .command("create")
  .description("Scaffold a new genre profile in the project genres/ directory")
  .argument("<id>", "Genre ID (e.g. scifi, wuxia, romance)")
  .option("--name <name>", "Genre display name", "")
  .option("--numerical", "Enable numerical system", false)
  .option("--power", "Enable power scaling", false)
  .option("--era", "Enable era research", false)
  .option("--lang <language>", "Template language: zh, en, or vi (Vietnamese uses the English scaffold)")
  .action(async (id: string, opts) => {
    try {
      const root = findProjectRoot();
      const genresDir = join(root, "genres");
      const filePath = join(genresDir, `${id}.md`);

      // Check if already exists
      try {
        await readFile(filePath, "utf-8");
        logError(formatCurrentCliMessage("genre.exists", { path: filePath }));
        process.exit(1);
      } catch { /* file doesn't exist, good */ }

      await mkdir(genresDir, { recursive: true });

      const name = opts.name || id;
      const template = buildGenreTemplate(
        {
          id,
          name,
          numerical: opts.numerical,
          power: opts.power,
          era: opts.era,
        },
        resolveWritingLanguage(opts.lang),
      );

      await writeFile(filePath, template, "utf-8");
      log(formatCurrentCliMessage("genre.created", { path: filePath }));
      log(formatCurrentCliMessage("genre.editHint"));
    } catch (e) {
      logError(formatCurrentCliMessage("genre.createFailure", { detail: String(e) }));
      process.exit(1);
    }
  });

genreCommand
  .command("copy")
  .description("Copy a built-in genre profile to project for customization")
  .argument("<id>", "Genre ID to copy (e.g. xuanhuan)")
  .action(async (id: string) => {
    try {
      const root = findProjectRoot();
      const builtinDir = getBuiltinGenresDir();
      const srcPath = join(builtinDir, `${id}.md`);
      const genresDir = join(root, "genres");
      const destPath = join(genresDir, `${id}.md`);

      // Check if project override already exists
      try {
        await readFile(destPath, "utf-8");
        logError(formatCurrentCliMessage("genre.projectExists", { path: destPath }));
        process.exit(1);
      } catch { /* doesn't exist, good */ }

      let content: string;
      try {
        content = await readFile(srcPath, "utf-8");
      } catch {
        logError(formatCurrentCliMessage("genre.builtinMissing", { id }));
        process.exit(1);
        return;
      }

      await mkdir(genresDir, { recursive: true });
      await writeFile(destPath, content, "utf-8");
      log(formatCurrentCliMessage("genre.copied", { path: destPath }));
      log(formatCurrentCliMessage("genre.overrideHint"));
    } catch (e) {
      logError(formatCurrentCliMessage("genre.copyFailure", { detail: String(e) }));
      process.exit(1);
    }
  });
