import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  WritingLanguagePreflightError,
  preflightWritingLanguage,
  resolveViWritingCapability,
} from "../state/writing-language-preflight.js";

describe("VI writing preflight", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "inkos-vi-preflight-"));
    roots.push(root);
    await writeFile(join(root, "inkos.json"), "{}");
    return root;
  }

  it("keeps zh/en enabled without an experimental marker", async () => {
    const root = await fixture();

    await expect(preflightWritingLanguage({
      projectRoot: root,
      language: "en",
      operation: "write",
      env: {},
    })).resolves.toMatchObject({ language: "en" });
    await expect(preflightWritingLanguage({
      projectRoot: root,
      language: "zh",
      operation: "write",
      env: {},
    })).resolves.toMatchObject({ language: "zh" });
  });

  it("maps an unreadable VI project root to a stable preflight failure", async () => {
    const root = await fixture();
    const missingProjectRoot = join(root, "missing-root");
    const env = { INKOS_EXPERIMENTAL_WRITING_VI: "1" };

    await expect(resolveViWritingCapability({
      projectRoot: missingProjectRoot,
      env,
    })).resolves.toMatchObject({ enabled: false, reason: "STATE_PREFLIGHT_FAILED" });
    await expect(preflightWritingLanguage({
      projectRoot: missingProjectRoot,
      language: "vi",
      operation: "write",
      env,
    })).rejects.toBeInstanceOf(WritingLanguagePreflightError);
    await expect(preflightWritingLanguage({
      projectRoot: missingProjectRoot,
      language: "vi",
      operation: "write",
      env,
    })).rejects.toMatchObject({ code: "STATE_PREFLIGHT_FAILED" });
  });

  it("rejects VI before creating any state directory", async () => {
    const root = await fixture();

    await expect(preflightWritingLanguage({
      projectRoot: root,
      language: "vi",
      operation: "write",
      env: {},
    })).rejects.toMatchObject({ code: "WRITING_LANGUAGE_DISABLED" });
    expect(await readdir(root)).toEqual(["inkos.json"]);
  });

  it("blocks en on an incomplete canonical transaction without a marker", async () => {
    const root = await fixture();
    const bookDir = join(root, "books", "demo");
    const transactionName = ".inkos-file-txn-stale";
    await mkdir(join(bookDir, transactionName, "backup"), { recursive: true });

    await expect(preflightWritingLanguage({
      projectRoot: root,
      bookDir,
      language: "en",
      operation: "write",
      env: {},
    })).rejects.toMatchObject({ code: "CANONICAL_TRANSACTION_INCOMPLETE" });
    expect(await readdir(bookDir)).toContain(transactionName);
  });

  it("accepts a root-bound marker", async () => {
    const root = await fixture();
    await mkdir(join(root, ".inkos"));
    await writeFile(join(root, ".inkos", "vi-writing-v1.json"), JSON.stringify({
      schemaVersion: 1,
      contractVersion: "vi-writing-v1",
      projectRoot: resolve(root),
    }));

    await expect(resolveViWritingCapability({
      projectRoot: root,
      env: { INKOS_EXPERIMENTAL_WRITING_VI: "1" },
    })).resolves.toMatchObject({ enabled: true });
  });

  it("rejects a copied marker", async () => {
    const root = await fixture();
    await mkdir(join(root, ".inkos"));
    await writeFile(join(root, ".inkos", "vi-writing-v1.json"), JSON.stringify({
      schemaVersion: 1,
      contractVersion: "vi-writing-v1",
      projectRoot: resolve(root, "other"),
    }));

    await expect(resolveViWritingCapability({
      projectRoot: root,
      env: { INKOS_EXPERIMENTAL_WRITING_VI: "1" },
    })).resolves.toMatchObject({ enabled: false, reason: "PROJECT_ROOT_MISMATCH" });
  });

  it("fails closed and preserves an incomplete canonical transaction", async () => {
    const root = await fixture();
    await mkdir(join(root, ".inkos"));
    await writeFile(join(root, ".inkos", "vi-writing-v1.json"), JSON.stringify({
      schemaVersion: 1,
      contractVersion: "vi-writing-v1",
      projectRoot: resolve(root),
    }));
    const bookDir = join(root, "books", "demo");
    const transactionName = ".inkos-file-txn-stale";
    await mkdir(join(bookDir, transactionName, "backup"), { recursive: true });

    await expect(preflightWritingLanguage({
      projectRoot: root,
      bookDir,
      language: "vi",
      operation: "write",
      env: { INKOS_EXPERIMENTAL_WRITING_VI: "1" },
    })).rejects.toMatchObject({ code: "CANONICAL_TRANSACTION_INCOMPLETE" });
    expect(await readdir(bookDir)).toContain(transactionName);
  });

  it("rejects VI when an existing manifest has language en without changing it", async () => {
    const root = await fixture();
    await mkdir(join(root, ".inkos"));
    await writeFile(join(root, ".inkos", "vi-writing-v1.json"), JSON.stringify({
      schemaVersion: 1,
      contractVersion: "vi-writing-v1",
      projectRoot: resolve(root),
    }));
    const bookDir = join(root, "books", "demo");
    await mkdir(join(bookDir, "story", "state"), { recursive: true });
    const manifestPath = join(bookDir, "story", "state", "manifest.json");
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 2,
      language: "en",
      lastAppliedChapter: 0,
      projectionVersion: 1,
      migrationWarnings: [],
    }));
    const before = await readFile(manifestPath, "utf-8");

    await expect(preflightWritingLanguage({
      projectRoot: root,
      bookDir,
      language: "vi",
      operation: "write",
      env: { INKOS_EXPERIMENTAL_WRITING_VI: "1" },
    })).rejects.toMatchObject({ code: "STATE_LANGUAGE_MISMATCH" });
    expect(await readFile(manifestPath, "utf-8")).toBe(before);
  });

  it("accepts VI with a valid VI manifest without rewriting it", async () => {
    const root = await fixture();
    await mkdir(join(root, ".inkos"));
    await writeFile(join(root, ".inkos", "vi-writing-v1.json"), JSON.stringify({
      schemaVersion: 1,
      contractVersion: "vi-writing-v1",
      projectRoot: resolve(root),
    }));
    const bookDir = join(root, "books", "demo");
    await mkdir(join(bookDir, "story", "state"), { recursive: true });
    const manifestPath = join(bookDir, "story", "state", "manifest.json");
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 2,
      language: "vi",
      lastAppliedChapter: 0,
      projectionVersion: 1,
      migrationWarnings: [],
    }));
    const before = await readFile(manifestPath, "utf-8");

    await expect(preflightWritingLanguage({
      projectRoot: root,
      bookDir,
      language: "vi",
      operation: "write",
      env: { INKOS_EXPERIMENTAL_WRITING_VI: "1" },
    })).resolves.toMatchObject({ language: "vi" });
    expect(await readFile(manifestPath, "utf-8")).toBe(before);
  });

  it("rejects VI telemetry without the VI language or counting mode", async () => {
    const root = await fixture();
    await mkdir(join(root, ".inkos"));
    await writeFile(join(root, ".inkos", "vi-writing-v1.json"), JSON.stringify({
      schemaVersion: 1,
      contractVersion: "vi-writing-v1",
      projectRoot: resolve(root),
    }));
    const telemetry = {
      target: 2200,
      softMin: 1900,
      softMax: 2500,
      hardMin: 1600,
      hardMax: 2800,
      countingMode: "vi_wordlike_tokens_v1",
      writerCount: 2400,
      postReviseCount: 2300,
      finalCount: 2300,
      repairApplied: false,
      lengthWarning: false,
    } as const;

    await expect(preflightWritingLanguage({
      projectRoot: root,
      language: "vi",
      operation: "write",
      telemetry,
      env: { INKOS_EXPERIMENTAL_WRITING_VI: "1" },
    })).rejects.toMatchObject({ code: "STATE_LANGUAGE_MISMATCH" });
    await expect(preflightWritingLanguage({
      projectRoot: root,
      language: "vi",
      operation: "write",
      telemetry: { ...telemetry, language: "vi", countingMode: "en_words" },
      env: { INKOS_EXPERIMENTAL_WRITING_VI: "1" },
    })).rejects.toMatchObject({ code: "STATE_LANGUAGE_MISMATCH" });
  });

  it("fails closed for an invalid VI manifest without rebuilding it", async () => {
    const root = await fixture();
    await mkdir(join(root, ".inkos"));
    await writeFile(join(root, ".inkos", "vi-writing-v1.json"), JSON.stringify({
      schemaVersion: 1,
      contractVersion: "vi-writing-v1",
      projectRoot: resolve(root),
    }));
    const bookDir = join(root, "books", "demo");
    await mkdir(join(bookDir, "story", "state"), { recursive: true });
    const manifestPath = join(bookDir, "story", "state", "manifest.json");
    await writeFile(manifestPath, "{bad json");
    const before = await readFile(manifestPath, "utf-8");

    await expect(preflightWritingLanguage({
      projectRoot: root,
      bookDir,
      language: "vi",
      operation: "write",
      env: { INKOS_EXPERIMENTAL_WRITING_VI: "1" },
    })).rejects.toBeInstanceOf(WritingLanguagePreflightError);
    expect(await readFile(manifestPath, "utf-8")).toBe(before);
  });
});
