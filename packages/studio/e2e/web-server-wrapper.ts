import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const role = process.argv[2];
const shutdownFile = process.env.INKOS_E2E_SHUTDOWN_FILE;

if (role !== "api" && role !== "vite") {
  throw new Error(`Unknown E2E web-server role: ${role ?? "<missing>"}`);
}

const rolePort = (): number | undefined => {
  if (role === "api") {
    const port = Number(process.env.INKOS_STUDIO_PORT ?? 4581);
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
  }
  const portIndex = process.argv.findIndex((argument) => argument === "--port");
  const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : 4580);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
};

const isPortListening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (listening: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });

// Playwright starts webServer processes before globalSetup. A sentinel left by
// an earlier run must therefore be cleared here, but never while the dedicated
// role port is still serving an older run.
if (shutdownFile && existsSync(shutdownFile)) {
  const port = rolePort();
  if (!port || !(await isPortListening(port))) {
    try {
      unlinkSync(shutdownFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

const originalParentPid = process.ppid;
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
}
