import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GUARDED_PACKAGES = ["core", "cli"] as const;
const MTIME_TOLERANCE_MS = 2_000;
const SKIP_ENV_VAR = "INKOS_SKIP_DIST_GUARD";

function newestMtime(dir: string, depth: number): number {
  let newest = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) newest = Math.max(newest, newestMtime(path, depth - 1));
    } else if (entry.isFile()) {
      try {
        newest = Math.max(newest, statSync(path).mtimeMs);
      } catch {
        // A file that vanished between readdir and stat cannot make dist stale.
      }
    }
  }
  return newest;
}

/**
 * Dev-workspace guard: when package sources exist next to the running CLI,
 * the compiled dist must not be older than them. G1 ran a 42-minute-old
 * audit policy against live chapters because the build was forgotten after
 * an edit; the build is the fix, this guard makes forgetting it loud.
 * Installed-only layouts (no src tree beside dist) are skipped naturally,
 * and INKOS_SKIP_DIST_GUARD=1 bypasses the check for exceptional runs.
 */
export function assertFreshDist(root: string): void {
  if (process.env[SKIP_ENV_VAR] === "1") return;
  const stale: string[] = [];
  for (const pkg of GUARDED_PACKAGES) {
    const src = join(root, "packages", pkg, "src");
    const dist = join(root, "packages", pkg, "dist");
    if (!existsSync(src) || !existsSync(dist)) continue;
    const srcNewest = newestMtime(src, 8);
    const distNewest = newestMtime(dist, 8);
    if (srcNewest > distNewest + MTIME_TOLERANCE_MS) stale.push(pkg);
  }
  if (stale.length > 0) {
    throw new Error(
      `dist is older than src for: ${stale.join(", ")}. `
      + "Run `pnpm -r build` before running the CLI, "
      + `or set ${SKIP_ENV_VAR}=1 to bypass this guard.`,
    );
  }
}

/** Locate the monorepo root from this module's compiled location. */
export function inferRepoRoot(moduleUrl: string): string {
  const distDir = dirname(fileURLToPath(moduleUrl));
  return dirname(dirname(dirname(distDir)));
}
