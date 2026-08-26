import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_STRINGS } from "../packages/studio/src/i18n/catalog.js";
import { VI_CATALOG } from "../packages/studio/src/i18n/vi-catalog.js";
import { CLI_MESSAGES } from "../packages/cli/src/i18n/messages.js";
import { VI_MESSAGES } from "../packages/cli/src/i18n/vi-messages.js";
import { getTuiCopy } from "../packages/cli/src/tui/i18n.js";
import { VI_TUI_COPY } from "../packages/cli/src/tui/vi-copy.js";
import {
  checkI18nDrift,
  createSourceLock,
  type DriftCheckInput,
  type DriftCheckResult,
  type I18nSourceLock,
} from "./i18n-drift-lib.js";
import {
  CLI_ALLOWED_FALLBACK_KEYS,
  CLI_COMMAND_PATHS,
  STUDIO_REQUIRED_PREFIXES,
  TUI_COPY_LEAVES,
} from "./i18n-policy.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_LOCK_PATH = resolve(REPO_ROOT, "scripts/i18n-source-lock.json");
const EMPTY_SOURCE_LOCK: I18nSourceLock = { version: 1, studio: {}, cli: {}, tui: {} };

export async function collectCurrentDriftInput(
  repoRoot = REPO_ROOT,
  sourceLock: I18nSourceLock = EMPTY_SOURCE_LOCK,
): Promise<DriftCheckInput> {
  const [studioCallSites, cliCallSites, commandPaths] = await Promise.all([
    collectLiteralCallSiteKeys(resolve(repoRoot, "packages/studio/src"), "studio"),
    collectLiteralCallSiteKeys(resolve(repoRoot, "packages/cli/src"), "cli"),
    discoverCommandPaths(resolve(repoRoot, "packages/cli/src/commands")),
  ]);
  const tuiBase = flattenCopy(getTuiCopy("en"));
  const tuiVi = flattenCopy(VI_TUI_COPY);

  return {
    studio: {
      base: BASE_STRINGS,
      vi: VI_CATALOG,
      requiredPrefixes: STUDIO_REQUIRED_PREFIXES,
      allowedFallbackKeys: [],
    },
    cli: {
      base: CLI_MESSAGES,
      vi: VI_MESSAGES,
      requiredPrefixes: [],
      allowedFallbackKeys: CLI_ALLOWED_FALLBACK_KEYS,
    },
    tui: { base: tuiBase, vi: tuiVi },
    sourceLock,
    callSiteKeys: { studio: studioCallSites, cli: cliCallSites },
    commandPaths: { current: commandPaths, classified: CLI_COMMAND_PATHS },
    tuiLeaves: { current: Object.keys(tuiBase), classified: TUI_COPY_LEAVES },
  };
}

export function formatDriftReport(result: DriftCheckResult): string {
  const lines: string[] = ["errors"];
  lines.push(...formatIssues(result.errors));
  lines.push("", "warnings");
  lines.push(...formatIssues(result.warnings));
  lines.push("", "summary");
  lines.push(`errors: ${result.summary.errors}`);
  lines.push(`warnings: ${result.summary.warnings}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const writeLock = process.argv.slice(2).includes("--write-lock");
  const sourceLock = await readSourceLock(SOURCE_LOCK_PATH, writeLock);
  const input = await collectCurrentDriftInput(REPO_ROOT, sourceLock);
  const result = checkI18nDrift(input);
  process.stdout.write(`${formatDriftReport(result)}\n`);

  if (writeLock) {
    const nextLock = createSourceLock(input);
    await writeFile(SOURCE_LOCK_PATH, `${JSON.stringify(nextLock, null, 2)}\n`, "utf8");
    process.stdout.write(`source lock written: ${SOURCE_LOCK_PATH}\n`);
    return;
  }

  if (result.errors.length > 0) process.exitCode = 1;
}

async function readSourceLock(path: string, allowMissing: boolean): Promise<I18nSourceLock> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<I18nSourceLock>;
    if (parsed.version !== 1 || !parsed.studio || !parsed.cli || !parsed.tui) {
      throw new Error("expected version 1 with studio, cli, and tui sections");
    }
    return parsed as I18nSourceLock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return EMPTY_SOURCE_LOCK;
    throw new Error(`Invalid i18n source lock at ${path}: ${String(error)}`);
  }
}

function flattenCopy(value: unknown): Record<string, string> {
  const flattened: Array<[string, string]> = [];
  const visit = (current: unknown, path: string): void => {
    if (typeof current === "function") {
      const args = Array.from({ length: Math.max(1, current.length) }, (_, index) => `__ARG_${index}__`);
      flattened.push([path, String(Reflect.apply(current, undefined, args))]);
      return;
    }
    if (typeof current !== "object" || current === null) {
      if (path !== "locale") flattened.push([path, String(current)]);
      return;
    }
    for (const [key, child] of Object.entries(current).sort(([left], [right]) => left.localeCompare(right))) {
      visit(child, path ? `${path}.${key}` : key);
    }
  };
  visit(value, "");
  return Object.fromEntries(flattened.filter(([key]) => key && key !== "locale"));
}

async function collectLiteralCallSiteKeys(
  root: string,
  subsystem: "studio" | "cli",
): Promise<readonly string[]> {
  const keys = new Set<string>();
  for (const path of await sourceFiles(root)) {
    const source = await readFile(path, "utf8");
    const patterns = subsystem === "studio"
      ? [/\bt\(\s*["']([A-Za-z0-9_.-]+)["']/g]
      : [
          /\bformatCurrentCliMessage\(\s*["']([A-Za-z0-9_.-]+)["']/g,
          /\bformatCliMessage\(\s*[^,\n]+,\s*["']([A-Za-z0-9_.-]+)["']/g,
        ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        if (match[1]) keys.add(match[1]);
      }
    }
  }
  return [...keys].sort();
}

async function discoverCommandPaths(commandsRoot: string): Promise<readonly string[]> {
  const paths = new Set<string>(["inkos"]);
  for (const file of await sourceFiles(commandsRoot)) {
    const source = await readFile(file, "utf8");
    const roots = [...source.matchAll(/new Command\(\s*["']([^"']+)["']\s*\)/g)]
      .map((match) => commandName(match[1]!));
    const children = [...source.matchAll(/\.command\(\s*["']([^"']+)["']\s*\)/g)]
      .map((match) => commandName(match[1]!));
    for (const root of roots) {
      paths.add(`inkos ${root}`);
      for (const child of children) paths.add(`inkos ${root} ${child}`);
    }
  }
  return [...paths].sort();
}

async function sourceFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") await visit(path);
      } else if (
        [".ts", ".tsx"].includes(extname(entry.name))
        && !entry.name.includes(".test.")
        && !entry.name.includes(".spec.")
      ) {
        files.push(path);
      }
    }
  };
  await visit(root);
  return files.sort();
}

function commandName(definition: string): string {
  return definition.trim().split(/\s+/, 1)[0]!;
}

function formatIssues(issues: readonly { subsystem: string; code: string; key: string; message: string }[]): string[] {
  return issues.length === 0
    ? ["(none)"]
    : issues.map((issue) => `- [${issue.subsystem}] ${issue.code} ${issue.key}: ${issue.message}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
