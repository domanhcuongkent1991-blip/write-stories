import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createProjectSession,
  loadProjectSession,
  persistProjectSession,
} from "../interaction/project-session-store.js";
import { processProjectInteractionRequest } from "../interaction/project-control.js";
import { createInteractionToolsFromDeps } from "../interaction/project-tools.js";
import type { BookConfig } from "../models/book.js";

let projectRoot: string;

describe("project interaction control", () => {
  beforeAll(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-project-control-"));
    await mkdir(join(projectRoot, "books", "harbor"), { recursive: true });
    await writeFile(join(projectRoot, "books", "harbor", "book.json"), "{}", "utf-8");
  });

  afterAll(async () => {
    // tmpdir cleanup omitted
  });

  it("persists structured create_book requests into the shared project session", async () => {
    await persistProjectSession(projectRoot, createProjectSession(projectRoot));

    const tools = {
      listBooks: vi.fn(async () => ["harbor"]),
      createBook: vi.fn(async () => ({
        bookId: "night-harbor",
        title: "Night Harbor",
        __interaction: {
          responseText: "Created Night Harbor.",
        },
      })),
      exportBook: vi.fn(async () => ({ ok: true })),
      writeNextChapter: vi.fn(async () => ({ ok: true })),
      reviseDraft: vi.fn(async () => ({ ok: true })),
      patchChapterText: vi.fn(async () => ({ ok: true })),
      replaceChapterText: vi.fn(async () => ({ ok: true })),
      renameEntity: vi.fn(async () => ({ ok: true })),
      updateCurrentFocus: vi.fn(async () => ({ ok: true })),
      updateAuthorIntent: vi.fn(async () => ({ ok: true })),
      writeTruthFile: vi.fn(async () => ({ ok: true })),
    };

    const result = await processProjectInteractionRequest({
      projectRoot,
      request: {
        intent: "create_book",
        title: "Night Harbor",
        genre: "urban",
        platform: "tomato",
        chapterWordCount: 2800,
        targetChapters: 120,
      },
      tools,
    });

    expect(tools.createBook).toHaveBeenCalledWith({
      title: "Night Harbor",
      genre: "urban",
      platform: "tomato",
      chapterWordCount: 2800,
      targetChapters: 120,
    });
    expect(result.session.activeBookId).toBe("night-harbor");

    const persisted = await loadProjectSession(projectRoot);
    expect(persisted.activeBookId).toBe("night-harbor");
  });

  it("passes explicit Vietnamese through the create-book request path", async () => {
    await persistProjectSession(projectRoot, createProjectSession(projectRoot));
    await writeFile(
      join(projectRoot, "inkos.json"),
      JSON.stringify({ language: "en" }),
      "utf-8",
    );
    const createBook = vi.fn(async () => ({
      bookId: "dem-trang",
      title: "Đêm Trắng",
    }));
    const tools = {
      listBooks: vi.fn(async () => ["harbor"]),
      createBook,
      exportBook: vi.fn(async () => ({ ok: true })),
      writeNextChapter: vi.fn(async () => ({ ok: true })),
      reviseDraft: vi.fn(async () => ({ ok: true })),
      patchChapterText: vi.fn(async () => ({ ok: true })),
      replaceChapterText: vi.fn(async () => ({ ok: true })),
      renameEntity: vi.fn(async () => ({ ok: true })),
      updateCurrentFocus: vi.fn(async () => ({ ok: true })),
      updateAuthorIntent: vi.fn(async () => ({ ok: true })),
      writeTruthFile: vi.fn(async () => ({ ok: true })),
    };

    const result = await processProjectInteractionRequest({
      projectRoot,
      request: {
        intent: "create_book",
        title: "Đêm Trắng",
        genre: "urban",
        platform: "other",
        language: "vi",
      },
      tools,
    });

    expect(createBook).toHaveBeenCalledWith(expect.objectContaining({
      title: "Đêm Trắng",
      language: "vi",
    }));
    expect(result.responseText).toBe("Created dem-trang.");
  });

  it("builds Vietnamese book config with canonical defaults and deterministic id", async () => {
    const initBook = vi.fn(async (_book: BookConfig) => undefined);
    const tools = createInteractionToolsFromDeps({
      initBook,
      writeNextChapter: vi.fn(async () => ({ ok: true })),
      reviseDraft: vi.fn(async () => ({ ok: true })),
    } as never, {} as never);

    await tools.createBook?.({
      title: "Đêm Trắng",
      genre: "urban",
      language: "vi",
    });

    const book = initBook.mock.calls[0]?.[0];
    expect(book).toMatchObject({
      id: "dem-trang",
      language: "vi",
      chapterWordCount: 1150,
    });
  });

  it("rejects an empty derived book id before initialization side effects", async () => {
    const initBook = vi.fn(async () => undefined);
    const tools = createInteractionToolsFromDeps({
      initBook,
      writeNextChapter: vi.fn(async () => ({ ok: true })),
      reviseDraft: vi.fn(async () => ({ ok: true })),
    } as never, {} as never);

    await expect(tools.createBook?.({ title: "!!!", language: "vi" }))
      .rejects.toMatchObject({ code: "INVALID_BOOK_ID" });
    expect(initBook).not.toHaveBeenCalled();
  });

});
