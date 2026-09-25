import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTranslationProjectFromFile, writeTranslationExport } from "../translation/index.js";
import type { TranslationProjectManifest } from "../translation/types.js";

describe("writeTranslationExport gate", () => {
  let root: string;
  let projectId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-translation-export-"));
    await mkdir(join(root, "inputs"), { recursive: true });
    await writeFile(join(root, "inputs", "book.md"), [
      "# 第一章 雨夜",
      "",
      "第一段。",
    ].join("\n"));
    const created = await createTranslationProjectFromFile(root, {
      filePath: "inputs/book.md",
      sourceLanguage: "zh",
      targetLanguage: "vi",
    });
    projectId = created.manifest.id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeChapterAndManifest(status: TranslationProjectManifest["chapters"][number]["status"], qaPassed: boolean): Promise<void> {
    const manifestPath = join(root, "translations", projectId, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as TranslationProjectManifest;
    await writeFile(join(root, manifest.chapters[0]!.translatedPath), JSON.stringify({
      number: 1,
      title: "雨夜",
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [
        { index: 1, source: "第一段。", target: "Bản dịch sạch.", draft: "Bản dịch sạch.", stage: "refined" },
      ],
    }, null, 2), "utf-8");
    const updated: TranslationProjectManifest = {
      ...manifest,
      chapters: manifest.chapters.map((chapter) => ({
        ...chapter,
        status,
        qa: { passed: qaPassed, reportPath: `translations/${projectId}/qa/chapter-0001.json` },
      })),
    };
    await writeFile(manifestPath, JSON.stringify(updated, null, 2), "utf-8");
  }

  it("blocks export when a chapter is still drafted", async () => {
    await writeChapterAndManifest("drafted", true);
    await expect(writeTranslationExport(root, projectId, { format: "md" }))
      .rejects.toThrow(/chapter 1/);
  });

  it("blocks export when a chapter failed qa and lists the chapter number", async () => {
    await writeChapterAndManifest("refined", false);
    await expect(writeTranslationExport(root, projectId, { format: "md" }))
      .rejects.toThrow(/chapter 1/);
  });

  it("exports with force despite gate failures", async () => {
    await writeChapterAndManifest("drafted", false);
    const result = await writeTranslationExport(root, projectId, { format: "md", force: true });
    expect(result.chaptersExported).toBe(1);
  });

  it("exports normally when chapters are refined with passing qa", async () => {
    await writeChapterAndManifest("refined", true);
    const result = await writeTranslationExport(root, projectId, { format: "md" });
    expect(result.chaptersExported).toBe(1);
  });

  it("allows reviewed chapters through the gate as well", async () => {
    await writeChapterAndManifest("reviewed", true);
    const result = await writeTranslationExport(root, projectId, { format: "md" });
    expect(result.chaptersExported).toBe(1);
  });
});
