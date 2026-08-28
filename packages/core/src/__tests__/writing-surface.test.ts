import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriterAgent, type WriteChapterOutput } from "../agents/writer.js";
import {
  chapterHeading,
  chapterSummariesHeader,
  defaultChapterTitle,
  hooksPlaceholder,
  ledgerPlaceholder,
  stateDegradedDescription,
  stateDegradedSuggestion,
  statePlaceholder,
} from "../utils/writing-surface.js";

describe("writing surface", () => {
  it("renders explicit Vietnamese canonical labels", () => {
    expect(defaultChapterTitle(3, "vi")).toBe("Chương 3");
    expect(chapterHeading(3, "Mưa đêm", "vi")).toBe("# Chương 3: Mưa đêm");
    expect(statePlaceholder("vi")).toBe("(trạng thái chưa được cập nhật)");
    expect(ledgerPlaceholder("vi")).toBe("(sổ theo dõi chưa được cập nhật)");
    expect(hooksPlaceholder("vi")).toBe("(các tình tiết cài cắm chưa được cập nhật)");
    expect(chapterSummariesHeader("vi")).toContain("# Tóm tắt chương");
    expect(chapterSummariesHeader("vi")).toContain("| Chương | Tiêu đề | Nhân vật |");
    expect(stateDegradedDescription("vi")).toBe(
      "Xác thực trạng thái vẫn thất bại sau khi thử cập nhật lại.",
    );
    expect(stateDegradedSuggestion("vi")).toBe(
      "Hãy sửa trạng thái chương dựa trên nội dung đã lưu trước khi tiếp tục.",
    );
  });

  it("keeps legacy labels stable", () => {
    expect(defaultChapterTitle(3, "zh")).toBe("第3章");
    expect(defaultChapterTitle(3, "en")).toBe("Chapter 3");
    expect(chapterHeading(3, "雨夜", "zh")).toBe("# 第3章 雨夜");
    expect(chapterHeading(3, "Night Rain", "en")).toBe("# Chapter 3: Night Rain");
    expect(statePlaceholder("zh")).toBe("(状态卡未更新)");
    expect(statePlaceholder("en")).toBe("(state card not updated)");
    expect(ledgerPlaceholder("zh")).toBe("(账本未更新)");
    expect(ledgerPlaceholder("en")).toBe("(ledger not updated)");
    expect(hooksPlaceholder("zh")).toBe("(伏笔池未更新)");
    expect(hooksPlaceholder("en")).toBe("(hooks pool not updated)");
    expect(chapterSummariesHeader("zh")).toContain("# 章节摘要");
    expect(chapterSummariesHeader("en")).toContain("# Chapter Summaries");
    expect(stateDegradedDescription("zh")).toBe("状态结算重试后仍未通过校验。");
    expect(stateDegradedDescription("en")).toBe(
      "State validation still failed after settlement retry.",
    );
    expect(stateDegradedSuggestion("zh")).toBe(
      "请先基于已保存正文修复本章 state，再继续后续章节。",
    );
    expect(stateDegradedSuggestion("en")).toBe(
      "Repair chapter state from the persisted body before continuing.",
    );
  });
});

function createWriter(): WriterAgent {
  return new WriterAgent({
    client: {
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
    },
    model: "test-model",
    projectRoot: tmpdir(),
  });
}

function createOutput(overrides: Partial<WriteChapterOutput> = {}): WriteChapterOutput {
  return {
    chapterNumber: 3,
    title: "Mưa đêm",
    content: "Mưa rơi trên mái ngói cũ.",
    wordCount: 7,
    preWriteCheck: "",
    postSettlement: "",
    updatedState: "# Trạng thái hiện tại\n",
    updatedLedger: "# Sổ theo dõi\n",
    updatedHooks: "# Tình tiết cài cắm\n",
    chapterSummary: "| 3 | Mưa đêm | Lan | Trú mưa | Chờ đợi | H01 tiến triển | Lặng lẽ | Chuyển tiếp |",
    updatedSubplots: "",
    updatedEmotionalArcs: "",
    updatedCharacterMatrix: "",
    postWriteErrors: [],
    postWriteWarnings: [],
    ...overrides,
  };
}

describe("WriterAgent Vietnamese canonical persistence", () => {
  it("rejects missing structured runtime state before creating canonical files", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-writer-vi-preflight-"));
    const bookDir = join(root, "book");

    try {
      await expect(createWriter().saveChapter(bookDir, createOutput(), false, "vi"))
        .rejects.toMatchObject({
          name: "WritingLanguagePreflightError",
          code: "STATE_PREFLIGHT_FAILED",
        });
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists a Vietnamese heading when structured runtime state is complete", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-writer-vi-heading-"));
    const bookDir = join(root, "book");
    const output = createOutput({
      runtimeStateDelta: { chapter: 3 } as never,
      runtimeStateSnapshot: {
        manifest: {
          schemaVersion: 2,
          language: "vi",
          lastAppliedChapter: 3,
          projectionVersion: 1,
          migrationWarnings: [],
        },
        currentState: { chapter: 3, facts: [] },
        hooks: { hooks: [] },
        chapterSummaries: { rows: [] },
      },
      updatedChapterSummaries: chapterSummariesHeader("vi"),
    });

    try {
      await createWriter().saveChapter(bookDir, output, false, "vi");
      const chapter = await readFile(join(bookDir, "chapters", "0003_Mưa_đêm.md"), "utf-8");
      expect(chapter).toBe("# Chương 3: Mưa đêm\n\nMưa rơi trên mái ngói cũ.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders a Vietnamese summary header for a new summary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-writer-vi-summary-"));
    const renderSummary = createWriter() as unknown as {
      renderAppendedChapterSummary(
        bookDir: string,
        summary: string,
        language: "zh" | "en" | "vi",
      ): Promise<string | undefined>;
    };

    try {
      const markdown = await renderSummary.renderAppendedChapterSummary(
        join(root, "book"),
        "| 3 | Mưa đêm | Lan | Trú mưa | Chờ đợi | H01 tiến triển | Lặng lẽ | Chuyển tiếp |",
        "vi",
      );
      expect(markdown).toContain("# Tóm tắt chương");
      expect(markdown).toContain("| Chương | Tiêu đề | Nhân vật |");
      expect(markdown).toContain("| 3 | Mưa đêm |");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
