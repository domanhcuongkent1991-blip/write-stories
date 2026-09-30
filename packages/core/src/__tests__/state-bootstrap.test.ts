import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapStructuredStateFromMarkdown } from "../state/state-bootstrap.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function acceptedEntry(number: number): Record<string, unknown> {
  return { number, title: `Chapter ${number}`, status: "approved", auditDecision: "pass" };
}

async function writeBookFixture(bookDir: string, indexEntries: ReadonlyArray<unknown>): Promise<void> {
  await mkdir(bookDir, { recursive: true });
  await writeFile(join(bookDir, "book.json"), JSON.stringify({ language: "vi" }), "utf-8");
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await mkdir(join(bookDir, "story", "state"), { recursive: true });
  await writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify(indexEntries), "utf-8");
  await writeFile(join(bookDir, "story", "current_state.md"), "# Trạng thái hiện tại\n", "utf-8");
  await writeFile(join(bookDir, "story", "pending_hooks.md"), "# Tình tiết cài cắm\n", "utf-8");
}

describe("bootstrapStructuredStateFromMarkdown manifest progress", () => {
  it("keeps the manifest at the applied chapter when persisted current_state.json is ahead of durable vi progress", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-bootstrap-ahead-"));
    roots.push(root);
    const bookDir = join(root, "book");
    await writeBookFixture(bookDir, [
      acceptedEntry(1),
      acceptedEntry(2),
      acceptedEntry(3),
      acceptedEntry(4),
      { number: 5, title: "Chương 5", status: "audit-failed" },
    ]);
    await writeFile(
      join(bookDir, "story", "state", "manifest.json"),
      JSON.stringify({
        schemaVersion: 2,
        language: "vi",
        lastAppliedChapter: 5,
        projectionVersion: 1,
        migrationWarnings: [],
      }),
      "utf-8",
    );
    await writeFile(
      join(bookDir, "story", "state", "current_state.json"),
      JSON.stringify({ chapter: 5, facts: [] }),
      "utf-8",
    );
    await writeFile(
      join(bookDir, "story", "state", "hooks.json"),
      JSON.stringify({ hooks: [] }),
      "utf-8",
    );
    await writeFile(
      join(bookDir, "story", "state", "chapter_summaries.json"),
      JSON.stringify({ rows: [] }),
      "utf-8",
    );

    const result = await bootstrapStructuredStateFromMarkdown({ bookDir });

    expect(result.manifest.lastAppliedChapter).toBe(5);
    expect(result.warnings.join("\n")).not.toContain("normalized from 5 to 4");
  });

  it("still bootstraps the manifest from durable progress when no persisted state json exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-bootstrap-durable-"));
    roots.push(root);
    const bookDir = join(root, "book");
    await writeBookFixture(bookDir, [acceptedEntry(1), acceptedEntry(2)]);

    const result = await bootstrapStructuredStateFromMarkdown({ bookDir });

    expect(result.manifest.lastAppliedChapter).toBe(2);
  });
});
