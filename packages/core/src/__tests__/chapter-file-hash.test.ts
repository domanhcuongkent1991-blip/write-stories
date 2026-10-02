import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeChapterContentHash } from "../audit/chapter-audit-evaluator.js";
import {
  computeChapterFileHash,
  computeChapterFileHashFromMarkdown,
  readAuditRunContentHash,
  stripChapterTitleLine,
} from "../audit/chapter-file-hash.js";

// Self-contained fixture: a chapter file shaped exactly like a persisted one —
// heading line, blank line, then blank-line-separated Vietnamese paragraphs.
const CHAPTER_PARAGRAPHS = [
  "Cô gái đứng bên cửa sổ, ngón tay khẽ lật trang sách cũ phát ra tiếng sột soạt.",
  "Gió đêm thổi qua hành lang, mang theo mùi giấy ẩm mốc và một chút mùi muối.",
  "Trên bàn là một dòng số viết bằng mực xanh, đã nhòe đi ở góc phải.",
  "“Anh đã thấy con số này chưa?” — cô hỏi, giọng nhẹ như sợ kinh động ai.",
  "Anh lắc đầu, mắt vẫn dán vào dòng số mà không chớp.",
  "Ngoài đồng, đèn đường đã tắt ngúm từ lúc nào không ai nhớ.",
  "Cô đóng sách lại, cảm thấy một cơn ớn nóng chạy dọc sống lưng.",
  "Bàn tay anh đặt lên vai cô, ấm và vững, như thể sợ cô biến mất.",
  "Trong đầu cô, tiếng chuông chùa vọng xa vẫn chưa tắt hẳn.",
  "Cả hai đứng lặng, nhìn dòng số như nhìn một lời tử thần chưa nói thành.",
  "Rồi cô hiểu: con số này không phải mật mã, mà là một cách đếm ngược.",
  "Cánh cửa khép lại. Hành lang trở về với tiếng gió và mùi giấy ẩm.",
];

const CHAPTER_TITLE = "# Chương 1: Một Dòng Số Bị Buộc Trả Lời";

const CHAPTER_MARKDOWN = [
  CHAPTER_TITLE,
  "",
  ...CHAPTER_PARAGRAPHS.flatMap((paragraph, index) => (index === 0 ? [paragraph] : ["", paragraph])),
].join("\n");

/** Body as the audit sees it: paragraphs still separated by their blank lines. */
const CHAPTER_BODY_WITH_BLANKS = CHAPTER_PARAGRAPHS.join("\n\n");

/** Same prose with every blank line between paragraphs removed. */
const CHAPTER_BODY_WITHOUT_BLANKS = CHAPTER_PARAGRAPHS.join("\n");

/** Same markdown with the blank line removed between every paragraph pair. */
const CHAPTER_MARKDOWN_WITHOUT_BODY_BLANKS = [CHAPTER_TITLE, "", CHAPTER_BODY_WITHOUT_BLANKS].join("\n");

/**
 * Same markdown, but the heading is followed immediately by the first paragraph
 * instead of a blank line. Both shapes are the title layer, so they must hash alike.
 */
const CHAPTER_MARKDOWN_NO_BLANK_AFTER_HEADING = [CHAPTER_TITLE, ...CHAPTER_PARAGRAPHS.flatMap(
  (paragraph, index) => (index === 0 ? [paragraph] : ["", paragraph]),
)].join("\n");

/**
 * Hard-coded, computed once from the verified audit formula
 * computeChapterContentHash(stripChapterTitleLine(rawMarkdown)). Hard-coded on purpose:
 * re-deriving it in the test would be circular and would catch nothing.
 */
const CHAPTER_FILE_HASH = "3e216156aa181ed7e773c50fffe873ac278f2688979fd2a18b4677be661284ca";

const CHAPTER_MARKDOWN_WITHOUT_HEADING_BLANKS_HASH =
  "ccfd31557cd9906e2aaf412061bbdacee941d5a5ca9178f62166dc30d7ebdcfa";

function buildAuditRunFixture(contentHash: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "audit-run-v1",
    operationId: "6f1d0b4c-7c1e-4a4b-9a3e-2f6b0a1d5c77",
    attemptId: "b0f4a5d6-1e2f-4a3b-8c9d-0e1f2a3b4c5d",
    operation: "write",
    phase: "initial",
    bookId: "book-chapter-file-hash",
    chapterNumber: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    contentHash,
    decision: "pass",
    passed: true,
    parseFailed: false,
    overallScore: 92,
    findings: [],
    canonicalCommitOutcome: "terminal-commit",
  }, null, 2);
}

describe("chapter file hash helpers", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createFixtureDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "inkos-chapter-file-hash-"));
    roots.push(root);
    return root;
  }

  it("hashes a persisted chapter file with the exact audit canonicalization", async () => {
    const root = await createFixtureDir();
    const chapterPath = join(root, "0001_Một_Dòng_Số_Bị_Buộc_Trả_Lời.md");
    await writeFile(chapterPath, CHAPTER_MARKDOWN, "utf-8");

    expect(await computeChapterFileHash(chapterPath)).toBe(CHAPTER_FILE_HASH);
    expect(computeChapterFileHashFromMarkdown(CHAPTER_MARKDOWN)).toBe(CHAPTER_FILE_HASH);
  });

  it("strips only the title line and the blank lines that follow it", () => {
    expect(stripChapterTitleLine(CHAPTER_MARKDOWN)).toBe(CHAPTER_BODY_WITH_BLANKS);
    expect(stripChapterTitleLine(CHAPTER_MARKDOWN_NO_BLANK_AFTER_HEADING))
      .toBe(CHAPTER_BODY_WITH_BLANKS);
    expect(stripChapterTitleLine(CHAPTER_MARKDOWN_WITHOUT_BODY_BLANKS))
      .toBe(CHAPTER_BODY_WITHOUT_BLANKS);
  });

  // ---- Two-way architecture test ------------------------------------------
  // Direction A (file -> run): the hash computed from the .md file on disk is the
  // very hash the audit-run recorded. This is the link that used to be guessed.
  it("direction A (file -> audit-run): a chapter file hash equals the audit-run contentHash", async () => {
    const root = await createFixtureDir();
    const chapterPath = join(root, "0001_Một_Dòng_Số_Bị_Buộc_Trả_Lời.md");
    const runPath = join(root, "test-attempt.initial.audit-run-v1.json");
    await writeFile(chapterPath, CHAPTER_MARKDOWN, "utf-8");
    await writeFile(runPath, buildAuditRunFixture(CHAPTER_FILE_HASH), "utf-8");

    const fromFile = await computeChapterFileHash(chapterPath);
    const fromRun = await readAuditRunContentHash(runPath);

    expect(fromFile).toBe(CHAPTER_FILE_HASH);
    expect(fromRun).toBe(CHAPTER_FILE_HASH);
    expect(fromFile).toBe(fromRun);
  });

  // Direction B (run -> file): the hash follows the CONTENT, not the file name.
  it("direction B (audit-run -> file): renaming a chapter keeps the hash, editing it breaks the match", async () => {
    const root = await createFixtureDir();
    const originalPath = join(root, "0001_Một_Dòng_Số_Bị_Buộc_Trả_Lời.md");
    const renamedPath = join(root, "0001_ten_chuong_khac.md");
    const runPath = join(root, "test-attempt.initial.audit-run-v1.json");
    await writeFile(originalPath, CHAPTER_MARKDOWN, "utf-8");
    await writeFile(runPath, buildAuditRunFixture(CHAPTER_FILE_HASH), "utf-8");

    const runHash = await readAuditRunContentHash(runPath);

    // Same bytes under a different name still match the recorded run hash.
    await writeFile(renamedPath, await readFile(originalPath, "utf-8"), "utf-8");
    expect(await computeChapterFileHash(renamedPath)).toBe(runHash);

    // Once the prose on disk changes, the run hash no longer describes any file.
    await writeFile(originalPath, `${CHAPTER_MARKDOWN}\nMột câu đã được sửa thêm.`, "utf-8");
    expect(await computeChapterFileHash(originalPath)).not.toBe(runHash);
  });

  // ---- Regression guards for the normalization layers ---------------------
  // The blank line right after the heading belongs to the title layer: both
  // shapes must hash the same. A helper that dropped only line 0 would drift.
  it("regression: a blank line after the heading is a title-layer detail, not a body difference", async () => {
    const root = await createFixtureDir();
    const withBlankPath = join(root, "0001_co_dau_trong.md");
    const withoutBlankPath = join(root, "0001_khong_dau_trong.md");
    await writeFile(withBlankPath, CHAPTER_MARKDOWN, "utf-8");
    await writeFile(withoutBlankPath, CHAPTER_MARKDOWN_NO_BLANK_AFTER_HEADING, "utf-8");

    const withBlank = await computeChapterFileHash(withBlankPath);
    const withoutBlank = await computeChapterFileHash(withoutBlankPath);

    expect(withBlank).toBe(CHAPTER_FILE_HASH);
    expect(withoutBlank).toBe(CHAPTER_FILE_HASH);
    expect(withBlank).toBe(withoutBlank);

    // Sanity: the raw markdown including its heading hashes differently, which is
    // why skipping the title strip silently breaks every file/run comparison.
    expect(computeChapterContentHash(CHAPTER_MARKDOWN)).not.toBe(CHAPTER_FILE_HASH);
  });

  // The blank lines BETWEEN paragraphs are part of the body hash. A helper that
  // over-stripped empty lines would collapse this pair into one hash — the exact
  // confusion that made file hashes and audit-run hashes look incomparable.
  it("regression: removing blank lines between paragraphs changes the hash", async () => {
    const root = await createFixtureDir();
    const spacedPath = join(root, "0001_co_dau_trong_giua_doan.md");
    const packedPath = join(root, "0001_khong_co_dau_trong_giua_doan.md");
    await writeFile(spacedPath, CHAPTER_MARKDOWN, "utf-8");
    await writeFile(packedPath, CHAPTER_MARKDOWN_WITHOUT_BODY_BLANKS, "utf-8");

    const spaced = await computeChapterFileHash(spacedPath);
    const packed = await computeChapterFileHash(packedPath);

    expect(spaced).toBe(CHAPTER_FILE_HASH);
    expect(packed).toBe(CHAPTER_MARKDOWN_WITHOUT_HEADING_BLANKS_HASH);
    expect(spaced).not.toBe(packed);
  });

  it("fails loudly on a missing chapter file and on a malformed run hash", async () => {
    const root = await createFixtureDir();
    const badRunPath = join(root, "bad.audit-run-v1.json");
    await writeFile(badRunPath, buildAuditRunFixture("not-a-hash"), "utf-8");

    await expect(computeChapterFileHash(join(root, "missing.md")))
      .rejects.toThrow(/missing\.md/);
    await expect(readAuditRunContentHash(badRunPath))
      .rejects.toThrow(/contentHash/);
  });
});
