import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTranslationProjectFromFile,
  loadTranslationGlossary,
  prepareTranslationGlossary,
  saveTranslationGlossary,
  type TranslationGlossaryTerm,
  type TranslationModelPort,
} from "../translation/index.js";

const FIXTURE_TEXT = readFileSync(
  fileURLToPath(new URL("./fixtures/translation-zh-sample.txt", import.meta.url)),
  "utf-8",
);

function mockModel(terms: ReadonlyArray<TranslationGlossaryTerm>): Pick<TranslationModelPort, "extractGlossary"> {
  return {
    extractGlossary: vi.fn(async () => ({ terms: [...terms] })),
  };
}

describe("prepareTranslationGlossary", () => {
  let root: string;
  let projectId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-translation-prep-"));
    await mkdir(join(root, "inputs"), { recursive: true });
    await writeFile(join(root, "inputs", "book.txt"), FIXTURE_TEXT, "utf-8");
    const created = await createTranslationProjectFromFile(root, {
      filePath: "inputs/book.txt",
      sourceLanguage: "zh",
      targetLanguage: "vi",
    });
    projectId = created.manifest.id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("calls extractGlossary once with evenly distributed samples", async () => {
    const model = mockModel([
      { source: "李明", target: "Lý Minh", category: "person", aliases: ["小明"] },
    ]);
    const result = await prepareTranslationGlossary(root, projectId, { model: model as TranslationModelPort });

    expect(model.extractGlossary).toHaveBeenCalledTimes(1);
    const request = (model.extractGlossary as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      samples: Array<{ chapterNumber: number; text: string }>;
      namingPolicy: string;
      sourceLanguage: string;
      targetLanguage: string;
    };
    expect(request.samples.map((sample) => sample.chapterNumber)).toEqual([1, 2, 3]);
    expect(request.samples.every((sample) => sample.text.includes("李明") || sample.text.length > 0)).toBe(true);
    expect(request.namingPolicy).toContain("Sino-Vietnamese");
    expect(request.sourceLanguage).toBe("zh");
    expect(request.targetLanguage).toBe("vi");
    expect(result.sampleCount).toBe(3);
  });

  it("stores extracted terms with origin auto, category, and aliases in glossary v2", async () => {
    await prepareTranslationGlossary(root, projectId, {
      model: mockModel([
        { source: "李明", target: "Lý Minh", category: "person", aliases: ["小明"] },
      ]) as TranslationModelPort,
    });

    const glossary = await loadTranslationGlossary(root, projectId);
    expect(glossary).toEqual([{
      source: "李明",
      target: "Lý Minh",
      category: "person",
      aliases: ["小明"],
      origin: "auto",
      pinned: false,
    }]);

    const raw = JSON.parse(
      await readFile(join(root, "translations", projectId, "glossary.json"), "utf-8"),
    ) as { version: number; meta?: { prepCompletedAt?: string } };
    expect(raw.version).toBe(2);
    expect(typeof raw.meta?.prepCompletedAt).toBe("string");
  });

  it("keeps pre-existing seed terms when merging extracted ones", async () => {
    await saveTranslationGlossary(root, projectId, [
      { source: "灵石", target: "linh thạch", origin: "seed" },
    ]);

    await prepareTranslationGlossary(root, projectId, {
      model: mockModel([{ source: "李明", target: "Lý Minh" }]) as TranslationModelPort,
    });

    const glossary = await loadTranslationGlossary(root, projectId);
    expect(glossary).toHaveLength(2);
    expect(glossary).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "灵石", target: "linh thạch", origin: "seed" }),
      expect.objectContaining({ source: "李明", target: "Lý Minh", origin: "auto" }),
    ]));
  });

  it("re-preps without dropping approved terms and reports conflicts instead of overwriting", async () => {
    await prepareTranslationGlossary(root, projectId, {
      model: mockModel([{ source: "李明", target: "Lý Minh" }]) as TranslationModelPort,
    });
    await saveTranslationGlossary(root, projectId, [
      { source: "李明", target: "Lý Minh", origin: "approved" },
    ]);

    const result = await prepareTranslationGlossary(root, projectId, {
      model: mockModel([{ source: "李明", target: "Lý Mạc" }]) as TranslationModelPort,
    });

    const glossary = await loadTranslationGlossary(root, projectId);
    expect(glossary).toEqual([{
      source: "李明",
      target: "Lý Minh",
      aliases: [],
      origin: "approved",
      pinned: false,
    }]);
    expect(result.conflicts).toEqual([
      { source: "李明", keptTarget: "Lý Minh", rejectedTarget: "Lý Mạc" },
    ]);
  });

  it("throws a named error when the model cannot extract a glossary", async () => {
    await expect(prepareTranslationGlossary(root, projectId, {
      model: {} as TranslationModelPort,
    })).rejects.toThrow(/extractGlossary/);
  });
});
