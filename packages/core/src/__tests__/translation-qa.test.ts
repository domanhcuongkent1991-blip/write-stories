import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runChapterQa } from "../translation/qa.js";

describe("runChapterQa", () => {
  it("flags CJK residue in zh->vi targets and counts Han characters", () => {
    const report = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [{ source: "李明走进落霞城。", target: "Lý Minh bước vào 落霞城。" }],
      glossary: [],
    });
    expect(report.metrics.cjkResidue).toBe(3);
    expect(report.passed).toBe(false);
    expect(report.issues.length).toBeGreaterThan(0);
  });

  it("skips the CJK residue check for non-Vietnamese targets", () => {
    const report = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "en",
      segments: [{ source: "李明走进落霞城。", target: "Li Ming walks into the city. 落霞" }],
      glossary: [],
    });
    expect(report.metrics.cjkResidue).toBe(0);
  });

  it("scores adherence 1 when every source-present glossary term has its locked target", () => {
    const report = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [{ source: "李明是青云门的弟子。", target: "Lý Minh là đệ tử Thanh Vân Môn." }],
      glossary: [
        { source: "李明", target: "Lý Minh" },
        { source: "青云门", target: "Thanh Vân Môn" },
        { source: "灵石", target: "linh thạch" },
      ],
    });
    expect(report.metrics.adherence).toBe(1);
  });

  it("matches locked targets case-insensitively (sentence-initial capitalization)", () => {
    const report = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [{ source: "他参悟御剑诀。", target: "Hắn ngẫm ra Ngự Kiếm Quyết, ngự khí tăng lên." }],
      glossary: [
        { source: "御剑诀", target: "Ngự Kiếm Quyết" },
        { source: "御气", target: "ngự khí" },
      ],
    });
    expect(report.metrics.adherence).toBe(1);
  });

  it("reports partial adherence when a locked term is missing from the target", () => {
    const report = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [{ source: "李明是青云门的弟子。", target: "Lý Minh là đệ tử môn phái." }],
      glossary: [
        { source: "李明", target: "Lý Minh" },
        { source: "青云门", target: "Thanh Vân Môn" },
      ],
    });
    expect(report.metrics.adherence).toBe(0.5);
  });

  // Legacy window heuristic replaced by alignment-aware counting: 他 here
  // maps to {hắn, y} from the alignment table ("gã" is not a locked form), so
  // the group still counts as one variant.
  it("flags address variants when 他 maps to multiple Vietnamese forms from the alignment table", () => {
    const report = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [
        { source: "他说要走。", target: "Hắn nói rồi đi." },
        { source: "他摇头。", target: "Y lắc đầu." },
        { source: "他笑。", target: "Gã cười lạnh." },
        { source: "他转身离开。", target: "Hắn quay người rời đi." },
      ],
      glossary: [],
    });
    expect(report.metrics.addressVariants).toBe(1);
    // P5: addressVariants is informational on multi-character novels — it no longer fails the gate.
    expect(report.passed).toBe(true);
  });

  it("keeps address consistency when one source pronoun keeps one Vietnamese form", () => {
    const report = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [
        { source: "他说要走。", target: "Hắn nói rồi đi." },
        { source: "他摇头。", target: "Hắn lắc đầu." },
        { source: "他笑。", target: "Hắn cười lạnh." },
        { source: "他转身离开。", target: "Hắn quay người rời đi." },
      ],
      glossary: [],
    });
    expect(report.metrics.addressVariants).toBe(0);
  });

  it("detects name variants when the glossary carries two targets for one source", () => {
    const report = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [{ source: "李明到了。", target: "Ai đó đã đến." }],
      glossary: [
        { source: "李明", target: "Lý Minh" },
        { source: "李明", target: "Lý Mạc" },
      ],
    });
    expect(report.metrics.variants).toBe(1);
    expect(report.passed).toBe(false);
  });

  it("passes a clean chapter with no issues", () => {
    const report = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [
        { source: "李明说：他要走了。", target: "Lý Minh nói hắn phải đi rồi." },
        { source: "落霞城外，灵石铺子开张。", target: "Ngoài thành Lạc Hà, cửa hàng linh thạch mở bán." },
      ],
      glossary: [{ source: "李明", target: "Lý Minh" }],
    });
    expect(report.passed).toBe(true);
    expect(report.metrics.cjkResidue).toBe(0);
    expect(report.metrics.addressVariants).toBe(0);
    expect(report.metrics.variants).toBe(0);
    expect(report.metrics.adherence).toBe(1);
  });

  it("treats an alias occurrence as a glossary hit for alias-aware adherence", () => {
    const report = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [{ source: "小明走进落霞城。", target: "小明 bước vào thành Lạc Hà." }],
      glossary: [{ source: "李明", target: "Lý Minh", aliases: ["小明"] }],
    });
    expect(report.metrics.adherence).toBe(1);
  });

  it("scores alias-aware adherence against the locked target when only the source alias appears", () => {
    const report = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [{ source: "小明走进落霞城。", target: "Lý Minh bước vào thành Lạc Hà." }],
      glossary: [{ source: "李明", target: "Lý Minh", aliases: ["小明"] }],
    });
    expect(report.metrics.adherence).toBe(1);
  });

  it("lists variant glossary keys when one source resolves to two targets", () => {
    const report = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [{ source: "李明到了。", target: "Lý Mạc đã đến." }],
      glossary: [
        { source: "李明", target: "Lý Minh" },
        { source: "李明", target: "Lý Mạc" },
      ],
    });
    expect(report.metrics.variants).toBe(1);
    expect(report.passed).toBe(false);
    expect(report.issues.join("\n")).toContain("李明");
  });

  it("passes an empty chapter", () => {
    const report = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [],
      glossary: [],
    });
    expect(report.passed).toBe(true);
    expect(report.metrics.adherence).toBe(1);
  });
});

describe("translation-stage-metrics script", () => {
  const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
  const distQaPath = join(repoRoot, "packages", "core", "dist", "translation", "qa.js");
  let root: string;
  let projectId: string;
  let outPath: string;

  beforeAll(function buildCoreIfNeeded() {
    if (!existsSync(distQaPath)) {
      execFileSync("pnpm", ["--filter", "@actalk/inkos-core", "build"], {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: "pipe",
        shell: true,
      });
    }
  }, 300_000);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-translation-metrics-"));
    projectId = "metrics-fixture";
    const projectDir = join(root, "translations", projectId);
    await mkdir(join(projectDir, "translated"), { recursive: true });
    const chapter = {
      number: 1,
      title: "入门",
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [
        { index: 1, source: "李明走进落霞城。", target: "Lý Minh bước vào thành Lạc Hà." },
        { index: 2, source: "他要买十块灵石。", target: "Hắn muốn mua mười viên linh thạch." },
      ],
    };
    await writeFile(join(projectDir, "translated", "chapter-0001.json"), JSON.stringify(chapter, null, 2), "utf-8");
    await writeFile(join(projectDir, "manifest.json"), JSON.stringify({
      id: projectId,
      title: "fixture",
      sourceLanguage: "zh",
      targetLanguage: "vi",
      createdAt: "2026-09-25T00:00:00.000Z",
      updatedAt: "2026-09-25T00:00:00.000Z",
      source: { kind: "text", path: "inputs/book.txt", charCount: 128 },
      chapters: [{
        number: 1,
        title: "入门",
        sourcePath: `translations/${projectId}/sources/chapter-0001.json`,
        translatedPath: `translations/${projectId}/translated/chapter-0001.json`,
        segmentCount: 2,
        charCount: 128,
        status: "translated",
      }],
    }, null, 2), "utf-8");
    await writeFile(
      join(projectDir, "glossary.json"),
      JSON.stringify({ terms: [{ source: "李明", target: "Lý Minh" }] }, null, 2),
      "utf-8",
    );
    outPath = join(root, "metrics.json");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("appends a stage record with per-chapter metrics", async () => {
    const stdout = execFileSync(process.execPath, [
      join(repoRoot, "scripts", "translation-stage-metrics.mjs"),
      "--project", projectId,
      "--stage", "test-fixture",
      "--root", root,
      "--out", outPath,
    ], { encoding: "utf-8" });

    expect(stdout).toContain("test-fixture");
    const records = JSON.parse(await readFile(outPath, "utf-8")) as Array<{
      stage: string;
      at: string;
      chapters: Array<{ number: number; metrics: { adherence: number; cjkResidue: number; addressVariants: number; variants: number }; passed: boolean }>;
    }>;
    expect(records).toHaveLength(1);
    expect(records[0]!.stage).toBe("test-fixture");
    expect(records[0]!.chapters[0]!.number).toBe(1);
    expect(records[0]!.chapters[0]!.metrics.cjkResidue).toBe(0);
    expect(records[0]!.chapters[0]!.metrics.adherence).toBe(1);
    expect(records[0]!.chapters[0]!.passed).toBe(true);
  });

  it("appends a new record on every run instead of overwriting", async () => {
    for (let run = 0; run < 2; run++) {
      execFileSync(process.execPath, [
        join(repoRoot, "scripts", "translation-stage-metrics.mjs"),
        "--project", projectId,
        "--stage", "test-fixture",
        "--root", root,
        "--out", outPath,
      ], { encoding: "utf-8" });
    }

    const records = JSON.parse(await readFile(outPath, "utf-8")) as Array<{ stage: string }>;
    expect(records).toHaveLength(2);
  });
});
