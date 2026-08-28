import { startStudioServer } from "./server.js";
import { resolve, join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeAllowedOrigins, type StudioAccessMode, type StudioAccessPolicy } from "./network-policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseHostname(value: string | undefined): string {
  const hostname = (value ?? "127.0.0.1").trim();
  if (!hostname || /\s/.test(hostname) || !/^[A-Za-z0-9.:-]+$/.test(hostname)) {
    throw new Error("INKOS_STUDIO_HOSTNAME must be a valid loopback hostname.");
  }
  const normalized = hostname.toLowerCase();
  if (normalized !== "127.0.0.1" && normalized !== "localhost" && normalized !== "::1") {
    throw new Error("INKOS_STUDIO_HOSTNAME must remain loopback; the API is never bound to the LAN.");
  }
  return hostname;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "4567");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("INKOS_STUDIO_PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function parseAccessPolicy(): StudioAccessPolicy {
  const rawMode = (process.env.INKOS_STUDIO_ACCESS_MODE ?? "local").trim();
  if (rawMode !== "local" && rawMode !== "trusted-lan") {
    throw new Error("INKOS_STUDIO_ACCESS_MODE must be local or trusted-lan.");
  }

  const rawOrigins = process.env.INKOS_STUDIO_ALLOWED_ORIGINS;
  const originValues = rawOrigins === undefined
    ? ["http://127.0.0.1:4567", "http://localhost:4567"]
    : rawOrigins.split(",").map((origin) => origin.trim());
  if (originValues.length === 0 || originValues.some((origin) => !origin)) {
    throw new Error("INKOS_STUDIO_ALLOWED_ORIGINS must contain valid HTTP(S) origins.");
  }
  const allowedOrigins = normalizeAllowedOrigins(originValues);
  if (allowedOrigins.length !== originValues.length) {
    throw new Error("INKOS_STUDIO_ALLOWED_ORIGINS contains an invalid origin.");
  }
  return { mode: rawMode as StudioAccessMode, allowedOrigins };
}

let root: string;
let port: number;
let hostname: string;
let accessPolicy: StudioAccessPolicy;
try {
  root = resolve(process.argv[2] ?? process.env.INKOS_PROJECT_ROOT ?? process.cwd());
  port = parsePort(process.env.INKOS_STUDIO_PORT);
  hostname = parseHostname(process.env.INKOS_STUDIO_HOSTNAME);
  accessPolicy = parseAccessPolicy();
} catch (error) {
  console.error(`Invalid Studio network configuration: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// Find studio package root (2 levels up from src/api/)
const studioRoot = resolve(__dirname, "../..");
const distDir = join(studioRoot, "dist");

// Auto-build frontend if dist/ doesn't exist
if (!existsSync(join(distDir, "index.html"))) {
  console.log("Building frontend...");
  try {
    execSync("npx vite build", { cwd: studioRoot, stdio: "inherit" });
  } catch {
    console.error("Failed to build frontend. Run 'cd packages/studio && pnpm build' manually.");
    process.exit(1);
  }
}

startStudioServer(root, port, {
  staticDir: distDir,
  hostname,
  accessPolicy,
}).catch((e) => {
  console.error("Failed to start studio:", e);
  process.exit(1);
});
