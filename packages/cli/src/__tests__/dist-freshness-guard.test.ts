import { describe, expect, it, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertFreshDist } from "../dist-freshness-guard.js";

let roots: string[] = [];
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots = [];
  delete process.env.INKOS_SKIP_DIST_GUARD;
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inkos-dist-guard-"));
  roots.push(root);
  await mkdir(join(root, "packages", "core", "src", "audit"), { recursive: true });
  await mkdir(join(root, "packages", "core", "dist", "audit"), { recursive: true });
  return root;
}

describe("assertFreshDist", () => {
  it("throws when a source file is newer than every dist file", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "packages", "core", "dist", "audit", "audit-policy.js"), "old");
    await writeFile(join(root, "packages", "core", "src", "audit", "audit-policy.ts"), "new");
    const old = new Date(Date.now() - 60_000);
    await utimes(join(root, "packages", "core", "dist", "audit", "audit-policy.js"), old, old);
    const fresh = new Date();
    await utimes(join(root, "packages", "core", "src", "audit", "audit-policy.ts"), fresh, fresh);

    expect(() => assertFreshDist(root)).toThrow(/pnpm -r build/u);
  });

  it("passes when dist is at least as fresh as src", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "packages", "core", "dist", "audit", "audit-policy.js"), "new");
    await writeFile(join(root, "packages", "core", "src", "audit", "audit-policy.ts"), "old");
    const fresh = new Date();
    await utimes(join(root, "packages", "core", "dist", "audit", "audit-policy.js"), fresh, fresh);
    const old = new Date(Date.now() - 60_000);
    await utimes(join(root, "packages", "core", "src", "audit", "audit-policy.ts"), old, old);

    expect(() => assertFreshDist(root)).not.toThrow();
  });

  it("skips when the package has no src tree (installed-only layout)", async () => {
    const root = await makeRoot();
    await rm(join(root, "packages", "core", "src"), { recursive: true, force: true });
    expect(() => assertFreshDist(root)).not.toThrow();
  });

  it("respects INKOS_SKIP_DIST_GUARD=1", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "packages", "core", "src", "audit", "audit-policy.ts"), "new");
    process.env.INKOS_SKIP_DIST_GUARD = "1";
    expect(() => assertFreshDist(root)).not.toThrow();
  });

  it("ignores node_modules when scanning", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "packages", "core", "dist", "audit", "audit-policy.js"), "new");
    const fresh = new Date();
    await utimes(join(root, "packages", "core", "dist", "audit", "audit-policy.js"), fresh, fresh);
    await mkdir(join(root, "packages", "core", "node_modules", ".pnpm"), { recursive: true });
    await writeFile(join(root, "packages", "core", "node_modules", ".pnpm", "x.js"), "old");
    const old = new Date(Date.now() - 60_000);
    await utimes(join(root, "packages", "core", "node_modules", ".pnpm", "x.js"), old, old);
    expect(() => assertFreshDist(root)).not.toThrow();
  });
});
