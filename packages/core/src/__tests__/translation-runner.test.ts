import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTranslationProjectFromFile,
  loadTranslationChapter,
  loadTranslationGlossary,
  runTranslationProject,
  saveTranslationGlossary,
  writeTranslationExport,
  type TranslationModelPort,
} from "../translation/index.js";

describe("translation runner", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-translation-runner-"));
    await mkdir(join(root, "inputs"), { recursive: true });
    await writeFile(join(root, "inputs", "book.md"), [
      "# 第一章 雨夜",
      "",
      "第一段。",
      "",
      "第二段。",
    ].join("\n"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("translates pending segments, persists review report, and resumes without duplicate model calls", async () => {
    const created = await createTranslationProjectFromFile(root, {
      filePath: "inputs/book.md",
      sourceLanguage: "zh",
      targetLanguage: "en",
    });
    const translateSegments = vi.fn<TranslationModelPort["translateSegments"]>(async ({ segments }) => ({
      segments: segments.map((segment) => ({
        index: segment.index,
        target: `EN:${segment.source}`,
      })),
      glossary: [{ source: "雨夜", target: "rainy night", note: "chapter tone" }],
    }));
    const reviewChapter = vi.fn<NonNullable<TranslationModelPort["reviewChapter"]>>(async () => ({
      passed: true,
      summary: "ok",
      issues: [],
    }));

    const first = await runTranslationProject(root, created.manifest.id, {
      model: { translateSegments, reviewChapter },
      batchSize: 1,
    });
    expect(first.translatedSegments).toBe(2);
    expect(first.reviewedChapters).toBe(1);
    expect(translateSegments).toHaveBeenCalledTimes(2);

    const report = await readFile(join(root, first.reportPath), "utf-8");
    expect(report).toContain("ok");
    expect(report).toContain("雨夜");

    const second = await runTranslationProject(root, created.manifest.id, {
      model: { translateSegments, reviewChapter },
      batchSize: 1,
    });
    expect(second.translatedSegments).toBe(0);
    expect(translateSegments).toHaveBeenCalledTimes(2);

    const exported = await writeTranslationExport(root, created.manifest.id, { format: "md" });
    const markdown = await readFile(exported.outputPath, "utf-8");
    expect(markdown).toContain("EN:第一段。");
    expect(markdown).toContain("EN:第二段。");
    expect(markdown).not.toContain("\n第一段。\n");
  });

  it("normalizes glossary v1 files and preserves v2 fields", async () => {
    const created = await createTranslationProjectFromFile(root, {
      filePath: "inputs/book.md",
      sourceLanguage: "zh",
      targetLanguage: "en",
    });
    const glossaryPath = join(root, "translations", created.manifest.id, "glossary.json");

    await writeFile(glossaryPath, JSON.stringify({
      terms: [{ source: "雨夜", target: "rainy night" }],
    }), "utf-8");
    const legacy = await loadTranslationGlossary(root, created.manifest.id);
    expect(legacy[0]).toMatchObject({
      source: "雨夜",
      target: "rainy night",
      origin: "auto",
      pinned: false,
      aliases: [],
    });

    await writeFile(glossaryPath, JSON.stringify({
      version: 2,
      terms: [{
        source: "李明",
        target: "Lý Minh",
        category: "person",
        aliases: ["小明"],
        origin: "approved",
        pinned: true,
      }],
    }), "utf-8");
    const v2 = await loadTranslationGlossary(root, created.manifest.id);
    expect(v2).toEqual([{
      source: "李明",
      target: "Lý Minh",
      category: "person",
      aliases: ["小明"],
      origin: "approved",
      pinned: true,
    }]);
  });

  it("sends normalized language codes, batch context, and batch-filtered glossary", async () => {
    const created = await createTranslationProjectFromFile(root, {
      filePath: "inputs/book.md",
      sourceLanguage: "Chinese (Simplified)",
      targetLanguage: "Vietnamese",
    });
    await saveTranslationGlossary(root, created.manifest.id, [
      { source: "落霞城", target: "thành Lạc Hà", category: "place" },
      { source: "李明", target: "Lý Minh", category: "person" },
    ]);

    const translateSegments = vi.fn<TranslationModelPort["translateSegments"]>(async ({ segments }) => ({
      segments: segments.map((segment) => ({
        index: segment.index,
        target: `VI:${segment.source}`,
      })),
    }));

    await runTranslationProject(root, created.manifest.id, {
      model: { translateSegments },
      batchSize: 1,
    });

    expect(translateSegments).toHaveBeenCalledTimes(2);
    const first = translateSegments.mock.calls[0]![0]!;
    expect(first.sourceLanguage).toBe("zh");
    expect(first.targetLanguage).toBe("vi");
    expect(first.glossary.map((term) => term.source)).toEqual(["李明"]);
    expect(first.contextBefore).toBe("");
    expect(first.previousTargetTail).toBe("");

    const second = translateSegments.mock.calls[1]![0]!;
    expect(second.sourceLanguage).toBe("zh");
    expect(second.contextBefore).toBe("第一段。");
    expect(second.contextAfter).toBe("");
    expect(second.previousTargetTail).toBe("VI:第一段。");
    expect(second.glossary.map((term) => term.source)).toEqual(["李明"]);
  });

  it("normalizes legacy translated segments to the draft stage on load", async () => {
    const created = await createTranslationProjectFromFile(root, {
      filePath: "inputs/book.md",
      sourceLanguage: "zh",
      targetLanguage: "en",
    });
    const chapterInfo = created.manifest.chapters[0]!;
    await writeFile(join(root, chapterInfo.translatedPath), JSON.stringify({
      number: 1,
      title: "雨夜",
      sourceLanguage: "zh",
      targetLanguage: "en",
      segments: [
        { index: 1, source: "第一段。", target: "EN:第一段。" },
        { index: 2, source: "第二段。" },
      ],
    }, null, 2), "utf-8");

    const loaded = await loadTranslationChapter(root, chapterInfo.translatedPath);
    expect(loaded.segments[0]).toMatchObject({ target: "EN:第一段。", stage: "draft" });
    expect(loaded.segments[1]!.stage).toBeUndefined();
  });
});
