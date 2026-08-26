import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const repoRoot = resolve(import.meta.dirname, "..");
const temporaryParent = await mkdtemp(join(tmpdir(), "inkos-i18n-package-"));
const npmCache = join(temporaryParent, "npm-cache");
const packages = [
  {
    label: "core",
    directory: resolve(repoRoot, "packages/core"),
    requiredEntries: ["package/dist/index.js"],
    requiresVietnameseMarker: false,
  },
  {
    label: "cli",
    directory: resolve(repoRoot, "packages/cli"),
    requiredEntries: [
      "package/dist/i18n/vi-messages.js",
      "package/dist/tui/vi-copy.js",
    ],
    requiresVietnameseMarker: true,
  },
  {
    label: "studio",
    directory: resolve(repoRoot, "packages/studio"),
    requiredEntries: [],
    requiresVietnameseMarker: true,
  },
];

try {
  await mkdir(npmCache);
  for (const packageSpec of packages) {
    const destination = join(temporaryParent, packageSpec.label);
    await mkdir(destination);
    await runNpmPack(packageSpec.directory, destination);

    const tarballPath = await onlyTarball(destination);
    const tarball = await readFile(tarballPath);
    const entries = readTarEntries(gunzipSync(tarball));
    verifyPackage(packageSpec, entries);

    process.stdout.write(
      `OK ${packageSpec.label}: ${basename(tarballPath)} entries=${entries.size} `
      + `bytes=${tarball.length} sha256=${sha256(tarball)} `
      + `marker=${packageSpec.requiresVietnameseMarker ? "Dự án" : "not-required"}\n`,
    );
  }
} finally {
  await rm(temporaryParent, { recursive: true, force: true });
  process.stdout.write(`cleaned temporary package directory: ${temporaryParent}\n`);
}

function verifyPackage(packageSpec, entries) {
  for (const requiredEntry of packageSpec.requiredEntries) {
    if (!entries.has(requiredEntry)) {
      throw new Error(`${packageSpec.label} tarball is missing ${requiredEntry}`);
    }
  }

  const packageJson = entries.get("package/package.json");
  if (!packageJson) throw new Error(`${packageSpec.label} tarball is missing package/package.json`);
  if (packageJson.includes('"workspace:')) {
    throw new Error(`${packageSpec.label} tarball still contains a workspace: dependency`);
  }

  if ([...entries.keys()].some((name) => name.endsWith("i18n-source-lock.json"))) {
    throw new Error(`${packageSpec.label} tarball contains the build-time source lock`);
  }

  const compiledJavaScript = [...entries]
    .filter(([name]) => name.startsWith("package/dist/") && name.endsWith(".js"))
    .map(([, content]) => content);
  if (compiledJavaScript.length === 0) {
    throw new Error(`${packageSpec.label} tarball has no compiled JavaScript under package/dist`);
  }
  if (
    packageSpec.requiresVietnameseMarker
    && packageSpec.label !== "studio"
    && !compiledJavaScript.some((content) => content.includes("Dự án"))
  ) {
    throw new Error(`${packageSpec.label} compiled output is missing the Vietnamese marker Dự án`);
  }

  if (packageSpec.label === "studio") {
    const clientAssets = [...entries]
      .filter(([name]) => name.startsWith("package/dist/assets/") && name.endsWith(".js"));
    if (clientAssets.length === 0) {
      throw new Error("studio tarball is missing the compiled client catalog asset");
    }
    if (!clientAssets.some(([, content]) => content.includes("Dự án"))) {
      throw new Error("studio client assets are missing the Vietnamese marker Dự án");
    }
  }
}

async function runNpmPack(packageDirectory, destination) {
  const packageJsonPath = join(packageDirectory, "package.json");
  const manifestBefore = await readFile(packageJsonPath, "utf8");
  const command = process.platform === "win32"
    ? process.env.ComSpec ?? "cmd.exe"
    : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm", "pack", "--pack-destination", destination]
    : ["pack", "--pack-destination", destination];
  let result;
  try {
    result = await runCommand(command, args, {
      cwd: packageDirectory,
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_cache: npmCache,
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      },
    });
  } finally {
    await restoreManifestIfNeeded(packageDirectory, packageJsonPath, manifestBefore);
  }
  if (result.code !== 0) {
    throw new Error(
      `npm pack failed in ${packageDirectory} with exit ${result.code}\n${result.stderr}`,
    );
  }
}

async function restoreManifestIfNeeded(packageDirectory, packageJsonPath, manifestBefore) {
  if (await readFile(packageJsonPath, "utf8") === manifestBefore) return;
  const restoreResult = await runCommand(
    process.execPath,
    [resolve(repoRoot, "scripts/restore-package-json.mjs")],
    { cwd: packageDirectory },
  );
  if (restoreResult.code !== 0 || await readFile(packageJsonPath, "utf8") !== manifestBefore) {
    throw new Error(`npm pack did not restore ${packageJsonPath}`);
  }
}

function runCommand(command, args, options) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
  });
}

async function onlyTarball(directory) {
  const tarballs = (await readdir(directory))
    .filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`Expected one tarball in ${directory}, found ${tarballs.length}`);
  }
  return join(directory, tarballs[0]);
}

function readTarEntries(archive) {
  const entries = new Map();
  let offset = 0;
  let pendingLongName;
  let pendingPaxPath;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const sizeText = tarString(header, 124, 12).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Invalid tar entry size for ${name}`);
    }

    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw new Error(`Truncated tar entry ${name}`);
    const content = archive.subarray(dataStart, dataEnd);
    const headerName = prefix ? `${prefix}/${name}` : name;

    if (type === "L") {
      pendingLongName = tarString(content, 0, content.length);
    } else if (type === "x") {
      pendingPaxPath = parsePaxPath(content.toString("utf8"));
    } else {
      const resolvedName = pendingPaxPath ?? pendingLongName ?? headerName;
      if (type === "0" || type === "\0") entries.set(resolvedName, content.toString("utf8"));
      pendingLongName = undefined;
      pendingPaxPath = undefined;
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

function parsePaxPath(text) {
  for (const record of text.split("\n")) {
    const separator = record.indexOf(" ");
    if (separator < 0) continue;
    const value = record.slice(separator + 1);
    if (value.startsWith("path=")) return value.slice("path=".length);
  }
  return undefined;
}

function tarString(buffer, offset, length) {
  const value = buffer.subarray(offset, offset + length);
  const terminator = value.indexOf(0);
  return value.subarray(0, terminator < 0 ? value.length : terminator).toString("utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
