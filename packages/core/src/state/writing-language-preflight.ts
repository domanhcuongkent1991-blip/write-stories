import { readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { LengthTelemetry } from "../models/length-governance.js";
import { StateManifestSchema } from "../models/runtime-state.js";
import {
  WritingLanguageSchema,
  type WritingLanguage,
} from "../models/writing-language.js";
import {
  resolveWritingLanguageProfile,
  type WritingLanguageProfile,
} from "../utils/language.js";

export const VI_WRITING_CONTRACT_VERSION = "vi-writing-v1";
export const VI_WRITING_MARKER_RELATIVE_PATH = ".inkos/vi-writing-v1.json";

export type LongFictionOperation =
  | "create"
  | "plan"
  | "compose"
  | "write"
  | "audit"
  | "revise"
  | "read";

export type WritingLanguagePreflightCode =
  | "INVALID_WRITING_LANGUAGE"
  | "WRITING_LANGUAGE_DISABLED"
  | "WRITING_LANGUAGE_MODE_UNSUPPORTED"
  | "PROJECT_ROOT_MISMATCH"
  | "CANONICAL_TRANSACTION_INCOMPLETE"
  | "STATE_LANGUAGE_MISMATCH"
  | "STATE_PREFLIGHT_FAILED";

export class WritingLanguagePreflightError extends Error {
  constructor(
    readonly code: WritingLanguagePreflightCode,
    message: string,
  ) {
    super(message);
    this.name = "WritingLanguagePreflightError";
  }
}

export interface ViWritingCapability {
  readonly contractVersion: typeof VI_WRITING_CONTRACT_VERSION;
  readonly enabled: boolean;
  readonly writingLanguages: ReadonlyArray<WritingLanguage>;
  readonly reason?: WritingLanguagePreflightCode | "ENV_DISABLED" | "MARKER_MISSING";
}

const ViWritingMarkerSchema = z.object({
  schemaVersion: z.literal(1),
  contractVersion: z.literal(VI_WRITING_CONTRACT_VERSION),
  projectRoot: z.string().min(1),
});

const LONG_FICTION_OPERATIONS = new Set<LongFictionOperation>([
  "create",
  "plan",
  "compose",
  "write",
  "audit",
  "revise",
  "read",
]);

const LEGACY_WRITING_LANGUAGES: ReadonlyArray<WritingLanguage> = ["zh", "en"];
const ALL_WRITING_LANGUAGES: ReadonlyArray<WritingLanguage> = ["zh", "en", "vi"];
const TRANSACTION_DIR_PREFIX = ".inkos-file-txn-";

export async function resolveViWritingCapability(input: {
  readonly projectRoot: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<ViWritingCapability> {
  if (input.env?.INKOS_EXPERIMENTAL_WRITING_VI !== "1") {
    return disabledCapability("ENV_DISABLED");
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await canonicalProjectRoot(input.projectRoot);
  } catch {
    return disabledCapability("STATE_PREFLIGHT_FAILED");
  }
  const markerPath = join(input.projectRoot, VI_WRITING_MARKER_RELATIVE_PATH);
  let marker: z.infer<typeof ViWritingMarkerSchema>;
  try {
    marker = ViWritingMarkerSchema.parse(JSON.parse(await readFile(markerPath, "utf-8")));
  } catch (error) {
    if (isNotFoundError(error)) {
      return disabledCapability("MARKER_MISSING");
    }
    return disabledCapability("STATE_PREFLIGHT_FAILED");
  }

  let canonicalMarkerRoot: string;
  try {
    canonicalMarkerRoot = await canonicalProjectRoot(marker.projectRoot);
  } catch {
    return disabledCapability("PROJECT_ROOT_MISMATCH");
  }

  if (canonicalMarkerRoot !== canonicalRoot) {
    return disabledCapability("PROJECT_ROOT_MISMATCH");
  }

  return {
    contractVersion: VI_WRITING_CONTRACT_VERSION,
    enabled: true,
    writingLanguages: ALL_WRITING_LANGUAGES,
  };
}

export async function preflightWritingLanguage(input: {
  readonly projectRoot: string;
  readonly bookDir?: string;
  readonly language: WritingLanguage;
  readonly operation: LongFictionOperation;
  readonly telemetry?: LengthTelemetry;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<WritingLanguageProfile> {
  const language = parseWritingLanguage(input.language);
  assertSupportedOperation(input.operation);

  if (input.bookDir) {
    await assertNoIncompleteTransaction(input.bookDir);
  }

  if (language !== "vi") {
    return resolveWritingLanguageProfile(language);
  }

  const capability = await resolveViWritingCapability({
    projectRoot: input.projectRoot,
    env: input.env,
  });
  if (!capability.enabled) {
    if (capability.reason === "PROJECT_ROOT_MISMATCH" || capability.reason === "STATE_PREFLIGHT_FAILED") {
      throw preflightError(capability.reason, "Vietnamese writing capability validation failed.");
    }
    throw preflightError("WRITING_LANGUAGE_DISABLED", "Vietnamese writing is not enabled for this project.");
  }

  if (input.bookDir) {
    await assertViManifestMatches(input.bookDir);
  }
  assertViTelemetryMatches(input.telemetry);

  return resolveWritingLanguageProfile(language);
}

function parseWritingLanguage(value: unknown): WritingLanguage {
  const parsed = WritingLanguageSchema.safeParse(value);
  if (!parsed.success) {
    throw preflightError("INVALID_WRITING_LANGUAGE", "Writing language must be zh, en, or vi.");
  }
  return parsed.data;
}

function assertSupportedOperation(value: unknown): asserts value is LongFictionOperation {
  if (typeof value !== "string" || !LONG_FICTION_OPERATIONS.has(value as LongFictionOperation)) {
    throw preflightError("WRITING_LANGUAGE_MODE_UNSUPPORTED", "Unsupported long-fiction operation.");
  }
}

async function assertNoIncompleteTransaction(bookDir: string): Promise<void> {
  try {
    const entries = await readdir(bookDir, { withFileTypes: true });
    if (entries.some((entry) => entry.isDirectory() && entry.name.startsWith(TRANSACTION_DIR_PREFIX))) {
      throw preflightError(
        "CANONICAL_TRANSACTION_INCOMPLETE",
        "An incomplete canonical file transaction requires recovery before writing.",
      );
    }
  } catch (error) {
    if (error instanceof WritingLanguagePreflightError) {
      throw error;
    }
    if (isNotFoundError(error)) {
      return;
    }
    throw preflightError("STATE_PREFLIGHT_FAILED", "Unable to inspect the book directory.");
  }
}

async function assertViManifestMatches(bookDir: string): Promise<void> {
  const manifestPath = join(bookDir, "story", "state", "manifest.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw preflightError("STATE_PREFLIGHT_FAILED", "Unable to read the runtime state manifest.");
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw preflightError("STATE_PREFLIGHT_FAILED", "Runtime state manifest is not valid JSON.");
  }

  const parsed = StateManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw preflightError("STATE_PREFLIGHT_FAILED", "Runtime state manifest is invalid.");
  }
  const manifestLanguage: string = parsed.data.language;
  if (manifestLanguage !== "vi") {
    throw preflightError("STATE_LANGUAGE_MISMATCH", "Runtime state manifest language does not match Vietnamese writing.");
  }
}

function assertViTelemetryMatches(telemetry: LengthTelemetry | undefined): void {
  if (!telemetry) {
    return;
  }
  if (telemetry.language !== "vi" || telemetry.countingMode !== "vi_wordlike_tokens_v1") {
    throw preflightError("STATE_LANGUAGE_MISMATCH", "Length telemetry does not match Vietnamese writing.");
  }
}

async function canonicalProjectRoot(projectRoot: string): Promise<string> {
  const canonical = await realpath(projectRoot);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function disabledCapability(reason: ViWritingCapability["reason"]): ViWritingCapability {
  return {
    contractVersion: VI_WRITING_CONTRACT_VERSION,
    enabled: false,
    writingLanguages: LEGACY_WRITING_LANGUAGES,
    reason,
  };
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function preflightError(
  code: WritingLanguagePreflightCode,
  message: string,
): WritingLanguagePreflightError {
  return new WritingLanguagePreflightError(code, message);
}
