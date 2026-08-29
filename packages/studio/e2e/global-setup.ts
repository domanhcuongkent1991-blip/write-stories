import { mkdirSync, unlinkSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

/** Creates the root-bound Vietnamese capability marker for the E2E project. */
export default function globalSetup(): void {
  const thisFile = fileURLToPath(import.meta.url);
  // From packages/studio/e2e: ../ = studio, ../../ = packages, ../../../ = the
  // worktree/workspace root (where the test project lives).
  const workspaceRoot = path.resolve(path.dirname(thisFile), "../../../");

  const projectRoot = path.resolve(workspaceRoot, "test-project");
  const markerDirectory = path.resolve(projectRoot, ".inkos");
  mkdirSync(markerDirectory, { recursive: true });
  try {
    unlinkSync(path.resolve(markerDirectory, "e2e-shutdown.sentinel"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  writeFileSync(
    path.resolve(markerDirectory, "vi-writing-v1.json"),
    `${JSON.stringify({ schemaVersion: 1, contractVersion: "vi-writing-v1", projectRoot }, null, 2)}\n`,
    "utf-8",
  );
}
