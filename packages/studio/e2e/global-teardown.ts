import { mkdirSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

/** Signals the dedicated web servers to terminate before Playwright tears them down. */
export default function globalTeardown(): void {
  const thisFile = fileURLToPath(import.meta.url);
  const workspaceRoot = path.resolve(path.dirname(thisFile), "../../../");
  const markerDirectory = path.resolve(workspaceRoot, "test-project", ".inkos");
  mkdirSync(markerDirectory, { recursive: true });
  writeFileSync(path.resolve(markerDirectory, "e2e-shutdown.sentinel"), "shutdown\n", "utf-8");
}
