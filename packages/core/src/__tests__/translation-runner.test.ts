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

    const exported = await writeTranslationExport(root, created.manifest.id, { format: "md", force: true });
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

  it("runs draft and refine passes, saves summaries, and resumes between passes", async () => {
    const created = await createTranslationProjectFromFile(root, {
      filePath: "inputs/book.md",
      sourceLanguage: "zh",
      targetLanguage: "vi",
    });
    const chapterInfo = created.manifest.chapters[0]!;

    const translateSegments = vi.fn<TranslationModelPort["translateSegments"]>(async ({ segments }) => ({
      segments: segments.map((segment) => ({
        index: segment.index,
        target: `DRAFT:${segment.source}`,
      })),
    }));
    const refineSegments = vi.fn<NonNullable<TranslationModelPort["refineSegments"]>>(async ({ segments }) => ({
      segments: segments.map((segment) => ({
        index: segment.index,
        target: `REFINED:${segment.source}`,
      })),
    }));
    const refineSegmentsFailing = vi.fn<NonNullable<TranslationModelPort["refineSegments"]>>(async ({ segments }) => {
      if (segments.some((segment) => segment.index === 2)) throw new Error("refine boom");
      return {
        segments: segments.map((segment) => ({
          index: segment.index,
          target: `REFINED:${segment.source}`,
        })),
      };
    });
    const summarizeChapter = vi.fn<NonNullable<TranslationModelPort["summarizeChapter"]>>(async () => ({
      summary: "tóm tắt chương một",
    }));

    await expect(runTranslationProject(root, created.manifest.id, {
      model: { translateSegments, refineSegments: refineSegmentsFailing, summarizeChapter },
      batchSize: 1,
    })).rejects.toThrow("refine boom");

    const afterCrash = await loadTranslationChapter(root, chapterInfo.translatedPath);
    expect(afterCrash.segments[0]).toMatchObject({
      draft: "DRAFT:第一段。",
      target: "REFINED:第一段。",
      stage: "refined",
    });
    expect(afterCrash.segments[1]).toMatchObject({
      draft: "DRAFT:第二段。",
      target: "DRAFT:第二段。",
      stage: "draft",
    });
    const manifestAfterCrash = await readFile(join(root, "translations", created.manifest.id, "manifest.json"), "utf-8");
    expect(manifestAfterCrash).toContain('"drafted"');
    expect(translateSegments).toHaveBeenCalledTimes(2);
    expect(summarizeChapter).not.toHaveBeenCalled();

    await runTranslationProject(root, created.manifest.id, {
      model: { translateSegments, refineSegments, summarizeChapter },
      batchSize: 1,
    });

    expect(translateSegments).toHaveBeenCalledTimes(2);
    expect(refineSegments).toHaveBeenCalledTimes(1);
    expect((refineSegments.mock.calls[0]![0] as { segments: ReadonlyArray<{ index: number }> }).segments.map((segment) => segment.index)).toEqual([2]);

    const finalChapter = await loadTranslationChapter(root, chapterInfo.translatedPath);
    expect(finalChapter.segments[1]).toMatchObject({ stage: "refined", target: "REFINED:第二段。" });

    const summaries = JSON.parse(
      await readFile(join(root, "translations", created.manifest.id, "summaries.json"), "utf-8"),
    ) as { summaries: Array<{ number: number; summary: string }> };
    expect(summaries.summaries).toEqual([{ number: 1, summary: "tóm tắt chương một" }]);
    expect(summarizeChapter).toHaveBeenCalledTimes(1);
  });

  it("writes a chapter qa report and records it in the manifest", async () => {
    const created = await createTranslationProjectFromFile(root, {
      filePath: "inputs/book.md",
      sourceLanguage: "zh",
      targetLanguage: "vi",
    });
    const projectId = created.manifest.id;

    await runTranslationProject(root, projectId, {
      model: {
        translateSegments: async ({ segments }) => ({
          segments: segments.map((segment) => ({
            index: segment.index,
            target: `clean target ${segment.index}`,
          })),
        }),
      },
      batchSize: 2,
    });

    const qaPath = join(root, "translations", projectId, "qa", "chapter-0001.json");
    const qaReport = JSON.parse(await readFile(qaPath, "utf-8")) as {
      number: number;
      passed: boolean;
      metrics: { adherence: number; cjkResidue: number };
    };
    expect(qaReport.number).toBe(1);
    expect(qaReport.passed).toBe(true);
    expect(qaReport.metrics.cjkResidue).toBe(0);
    expect(qaReport.metrics.adherence).toBe(1);

    const manifest = JSON.parse(
      await readFile(join(root, "translations", projectId, "manifest.json"), "utf-8"),
    ) as { chapters: Array<{ qa?: { passed: boolean; reportPath: string } }> };
    expect(manifest.chapters[0]!.qa).toEqual({
      passed: true,
      reportPath: `translations/${projectId}/qa/chapter-0001.json`,
    });

    const report = await readFile(join(root, "translations", projectId, "review-report.md"), "utf-8");
    expect(report).toContain("qa:");
  });

  it("keeps the draft as the final target when the model cannot refine", async () => {
    const created = await createTranslationProjectFromFile(root, {
      filePath: "inputs/book.md",
      sourceLanguage: "zh",
      targetLanguage: "vi",
    });

    const translateSegments = vi.fn<TranslationModelPort["translateSegments"]>(async ({ segments }) => ({
      segments: segments.map((segment) => ({
        index: segment.index,
        target: `DRAFT:${segment.source}`,
      })),
    }));

    await runTranslationProject(root, created.manifest.id, {
      model: { translateSegments },
      batchSize: 2,
    });

    const chapter = await loadTranslationChapter(root, created.manifest.chapters[0]!.translatedPath);
    expect(chapter.segments[0]).toMatchObject({
      draft: "DRAFT:第一段。",
      target: "DRAFT:第一段。",
      stage: "refined",
    });
    expect(chapter.segments[1]).toMatchObject({
      draft: "DRAFT:第二段。",
      target: "DRAFT:第二段。",
      stage: "refined",
    });
  });
});
