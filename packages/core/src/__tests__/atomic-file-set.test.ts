import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";

describe("commitAtomicFileSet", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createBookFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "inkos-file-set-"));
    roots.push(root);
    await Promise.all([
      mkdir(join(root, "chapters"), { recursive: true }),
      mkdir(join(root, "story"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, "chapters", "0001_old.md"), "old chapter", "utf-8"),
      writeFile(join(root, "story", "current_state.md"), "old state", "utf-8"),
      writeFile(join(root, "story", "pending_hooks.md"), "old hooks", "utf-8"),
    ]);
    return root;
  }

  it("commits the complete file set and removes superseded files", async () => {
    const root = await createBookFixture();

    await commitAtomicFileSet({
      rootDir: root,
      writes: [
        { relativePath: "chapters/0001_new.md", content: "new chapter" },
        { relativePath: "story/current_state.md", content: "new state" },
        { relativePath: "story/pending_hooks.md", content: "new hooks" },
      ],
      deletes: ["chapters/0001_old.md"],
    });

    await expect(readFile(join(root, "chapters", "0001_new.md"), "utf-8")).resolves.toBe("new chapter");
    await expect(readFile(join(root, "story", "current_state.md"), "utf-8")).resolves.toBe("new state");
    await expect(readFile(join(root, "story", "pending_hooks.md"), "utf-8")).resolves.toBe("new hooks");
    await expect(readdir(join(root, "chapters"))).resolves.toEqual(["0001_new.md"]);
    expect((await readdir(root)).some((entry) => entry.startsWith(".inkos-file-txn-"))).toBe(false);
  });

  it("restores every original file when commit fails after the first replacement", async () => {
    const root = await createBookFixture();
    let stagedRenameCount = 0;

    await expect(commitAtomicFileSet({
      rootDir: root,
      writes: [
        { relativePath: "chapters/0001_new.md", content: "new chapter" },
        { relativePath: "story/current_state.md", content: "new state" },
        { relativePath: "story/pending_hooks.md", content: "new hooks" },
      ],
      deletes: ["chapters/0001_old.md"],
      renameFile: async (from, to) => {
        if (from.includes(`${sep}staged${sep}`)) {
          stagedRenameCount += 1;
          if (stagedRenameCount === 2) {
            throw new Error("injected commit failure");
          }
        }
        await rename(from, to);
      },
    })).rejects.toThrow("injected commit failure");

    await expect(readFile(join(root, "chapters", "0001_old.md"), "utf-8")).resolves.toBe("old chapter");
    await expect(readFile(join(root, "story", "current_state.md"), "utf-8")).resolves.toBe("old state");
    await expect(readFile(join(root, "story", "pending_hooks.md"), "utf-8")).resolves.toBe("old hooks");
    await expect(readdir(join(root, "chapters"))).resolves.toEqual(["0001_old.md"]);
    expect((await readdir(root)).some((entry) => entry.startsWith(".inkos-file-txn-"))).toBe(false);
  });

  it("restores chapter, truth, runtime manifest and index bytes after a partial canonical commit", async () => {
    const root = await createBookFixture();
    await mkdir(join(root, "story", "state"), { recursive: true });
    await Promise.all([
      writeFile(
        join(root, "chapters", "index.json"),
        "[{\"number\":1,\"title\":\"Old\"}]",
        "utf-8",
      ),
      writeFile(
        join(root, "story", "state", "manifest.json"),
        "{\"language\":\"vi\",\"revision\":1}",
        "utf-8",
      ),
    ]);
    let stagedRenameCount = 0;

    await expect(commitAtomicFileSet({
      rootDir: root,
      writes: [
        { relativePath: "chapters/0001_old.md", content: "new chapter" },
        { relativePath: "story/current_state.md", content: "new truth" },
        {
          relativePath: "story/state/manifest.json",
          content: "{\"language\":\"vi\",\"revision\":2}",
        },
        {
          relativePath: "chapters/index.json",
          content: "[{\"number\":1,\"title\":\"New\"}]",
        },
      ],
      renameFile: async (from, to) => {
        if (from.includes(`${sep}staged${sep}`)) {
          stagedRenameCount += 1;
          if (stagedRenameCount === 3) {
            throw new Error("injected canonical failure");
          }
        }
        await rename(from, to);
      },
    })).rejects.toThrow("injected canonical failure");

    await expect(readFile(join(root, "chapters", "0001_old.md")))
      .resolves.toEqual(Buffer.from("old chapter"));
    await expect(readFile(join(root, "story", "current_state.md")))
      .resolves.toEqual(Buffer.from("old state"));
    await expect(readFile(join(root, "story", "state", "manifest.json")))
      .resolves.toEqual(Buffer.from("{\"language\":\"vi\",\"revision\":1}"));
    await expect(readFile(join(root, "chapters", "index.json")))
      .resolves.toEqual(Buffer.from("[{\"number\":1,\"title\":\"Old\"}]"));
  });

  it("preserves the transaction backup when rollback is incomplete", async () => {
    const root = await createBookFixture();
    let commitFailed = false;
    let restoreFailed = false;

    await expect(commitAtomicFileSet({
      rootDir: root,
      writes: [
        { relativePath: "chapters/0001_old.md", content: "new chapter" },
        { relativePath: "story/current_state.md", content: "new state" },
      ],
      renameFile: async (from, to) => {
        if (!commitFailed && from.includes(`${sep}staged${sep}`)) {
          commitFailed = true;
          throw new Error("injected commit failure");
        }
        if (commitFailed && !restoreFailed && from.includes(`${sep}backup${sep}`)) {
          restoreFailed = true;
          throw new Error("injected rollback failure");
        }
        await rename(from, to);
      },
    })).rejects.toBeInstanceOf(AggregateError);

    const entries = await readdir(root);
    expect(entries.some((entry) => entry.startsWith(".inkos-file-txn-"))).toBe(true);
  });
});
