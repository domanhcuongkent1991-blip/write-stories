import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const originalParentPid = process.ppid;
const shutdownFile = process.env.INKOS_E2E_SHUTDOWN_FILE;
const shouldShutdown = (): boolean => Boolean(shutdownFile && existsSync(shutdownFile));
const parentMonitor = setInterval(() => {
  if (shouldShutdown()) {
    process.exit(0);
  }
  try {
    process.kill(originalParentPid, 0);
  } catch {
    process.exit(0);
  }
}, 250);
parentMonitor.unref();

const role = process.argv[2];

if (role === "api") {
  // The API entrypoint treats argv[2] as an optional project root. Remove the
  // wrapper role before importing it so INKOS_PROJECT_ROOT remains authoritative.
  process.argv = [process.argv[0]!, process.argv[1]!, ...process.argv.slice(3)];
  execFileSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", "pnpm.cmd", "--filter", "@actalk/inkos-core", "build"],
    { stdio: "inherit" },
  );
  await import("../src/api/index.ts");
} else if (role === "vite") {
  const viteCliUrl = new URL("../node_modules/vite/bin/vite.js", import.meta.url);
  process.argv = [process.execPath, fileURLToPath(viteCliUrl), ...process.argv.slice(3)];
  await import(viteCliUrl.href);
} else {
  throw new Error(`Unknown E2E web-server role: ${role ?? "<missing>"}`);
}
