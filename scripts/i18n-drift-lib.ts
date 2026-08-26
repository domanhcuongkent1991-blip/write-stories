import { createHash } from "node:crypto";
import { PROTECTED_TOKEN_PATTERNS } from "./i18n-policy.js";

export interface BilingualSource {
  readonly zh: string;
  readonly en: string;
}

export interface CatalogDriftInput {
  readonly base: Readonly<Record<string, BilingualSource>>;
  readonly vi: Readonly<Record<string, string>>;
  readonly requiredPrefixes: readonly string[];
  readonly allowedFallbackKeys: readonly string[];
}

export interface TuiDriftInput {
  readonly base: Readonly<Record<string, string>>;
  readonly vi: Readonly<Record<string, string>>;
}

export interface I18nSourceLock {
  readonly version: 1;
  readonly studio: Readonly<Record<string, string>>;
  readonly cli: Readonly<Record<string, string>>;
  readonly tui: Readonly<Record<string, string>>;
}

export interface DriftCheckInput {
  readonly studio: CatalogDriftInput;
  readonly cli: CatalogDriftInput;
  readonly tui: TuiDriftInput;
  readonly sourceLock: I18nSourceLock;
  readonly callSiteKeys: {
    readonly studio: readonly string[];
    readonly cli: readonly string[];
  };
  readonly commandPaths: {
    readonly current: readonly string[];
    readonly classified: readonly string[];
  };
  readonly tuiLeaves: {
    readonly current: readonly string[];
    readonly classified: readonly string[];
  };
}

export type DriftIssueLevel = "error" | "warning";
export type DriftSubsystem = "studio" | "cli" | "tui" | "commands";

export interface DriftIssue {
  readonly level: DriftIssueLevel;
  readonly subsystem: DriftSubsystem;
  readonly code: string;
  readonly key: string;
  readonly message: string;
}

export interface DriftCheckResult {
  readonly errors: readonly DriftIssue[];
  readonly warnings: readonly DriftIssue[];
  readonly summary: {
    readonly errors: number;
    readonly warnings: number;
  };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function fingerprintBilingualSource(source: BilingualSource): string {
  return sha256(`${source.zh}\0${source.en}`);
}

export function fingerprintTuiSource(source: string): string {
  return sha256(source);
}

export function createSourceLock(input: Pick<DriftCheckInput, "studio" | "cli" | "tui">): I18nSourceLock {
  return {
    version: 1,
    studio: fingerprintCatalog(input.studio.base),
    cli: fingerprintCatalog(input.cli.base),
    tui: Object.fromEntries(
      Object.entries(input.tui.base)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, source]) => [key, fingerprintTuiSource(source)]),
    ),
  };
}

export function checkI18nDrift(input: DriftCheckInput): DriftCheckResult {
  const issues: DriftIssue[] = [];

  checkCatalog("studio", input.studio, input.sourceLock.studio, issues);
  checkCatalog("cli", input.cli, input.sourceLock.cli, issues);
  checkTui(input.tui, input.sourceLock.tui, issues);
  checkCallSites("studio", input.callSiteKeys.studio, input.studio.base, issues);
  checkCallSites("cli", input.callSiteKeys.cli, input.cli.base, issues);
  checkClassification("commands", input.commandPaths, issues);
  checkClassification("tui", input.tuiLeaves, issues);

  const sorted = [...issues].sort(compareIssues);
  const errors = sorted.filter((issue) => issue.level === "error");
  const warnings = sorted.filter((issue) => issue.level === "warning");
  return {
    errors,
    warnings,
    summary: { errors: errors.length, warnings: warnings.length },
  };
}

function fingerprintCatalog(
  catalog: Readonly<Record<string, BilingualSource>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(catalog)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, source]) => [key, fingerprintBilingualSource(source)]),
  );
}

function checkCatalog(
  subsystem: "studio" | "cli",
  catalog: CatalogDriftInput,
  lockedSources: Readonly<Record<string, string>>,
  issues: DriftIssue[],
): void {
  const baseKeys = new Set(Object.keys(catalog.base));
  const allowedFallbacks = new Set(catalog.allowedFallbackKeys);

  for (const key of [...baseKeys].sort()) {
    const source = catalog.base[key]!;
    const translated = catalog.vi[key];
    const lockedFingerprint = lockedSources[key];

    if (translated === undefined && !allowedFallbacks.has(key)) {
      const required = lockedFingerprint !== undefined
        || catalog.requiredPrefixes.some((prefix) => key.startsWith(prefix));
      addIssue(issues, required ? "error" : "warning", subsystem,
        required ? "missing-required-vi-key" : "missing-noncritical-vi-key",
        key,
        required ? "Required Vietnamese copy is missing." : "New non-critical copy falls back to English.");
    }

    if (translated !== undefined) {
      checkProtectedTokens(subsystem, key, source.en, translated, issues);
    }

    const currentFingerprint = fingerprintBilingualSource(source);
    if (lockedFingerprint === undefined) {
      addIssue(issues, "warning", subsystem, "unlocked-source-key", key,
        "Source key is not present in the reviewed source lock.");
    } else if (lockedFingerprint !== currentFingerprint) {
      addIssue(issues, "error", subsystem, "source-fingerprint-changed", key,
        "The zh/en source changed without a reviewed source-lock update.");
    }
  }

  for (const key of Object.keys(catalog.vi).sort()) {
    if (!baseKeys.has(key)) {
      addIssue(issues, "error", subsystem, "extra-vi-key", key,
        "Vietnamese copy has no matching base-catalog key.");
    }
  }

  for (const key of Object.keys(lockedSources).sort()) {
    if (!baseKeys.has(key)) {
      addIssue(issues, "error", subsystem, "locked-source-key-missing", key,
        "A reviewed source-lock key disappeared from the base catalog.");
    }
  }
}

function checkTui(
  tui: TuiDriftInput,
  lockedSources: Readonly<Record<string, string>>,
  issues: DriftIssue[],
): void {
  const baseKeys = new Set(Object.keys(tui.base));

  for (const key of [...baseKeys].sort()) {
    const source = tui.base[key]!;
    const translated = tui.vi[key];
    if (translated !== undefined) checkProtectedTokens("tui", key, source, translated, issues);

    const lockedFingerprint = lockedSources[key];
    const currentFingerprint = fingerprintTuiSource(source);
    if (lockedFingerprint === undefined) {
      addIssue(issues, "warning", "tui", "unlocked-source-key", key,
        "TUI source leaf is not present in the reviewed source lock.");
    } else if (lockedFingerprint !== currentFingerprint) {
      addIssue(issues, "error", "tui", "source-fingerprint-changed", key,
        "The English TUI fallback changed without a reviewed source-lock update.");
    }
  }

  for (const key of Object.keys(tui.vi).sort()) {
    if (!baseKeys.has(key) && key !== "locale") {
      addIssue(issues, "error", "tui", "extra-vi-key", key,
        "Vietnamese TUI copy has no matching English fallback leaf.");
    }
  }

  for (const key of Object.keys(lockedSources).sort()) {
    if (!baseKeys.has(key)) {
      addIssue(issues, "error", "tui", "locked-source-key-missing", key,
        "A reviewed TUI source leaf disappeared.");
    }
  }
}

function checkProtectedTokens(
  subsystem: "studio" | "cli" | "tui",
  key: string,
  source: string,
  translated: string,
  issues: DriftIssue[],
): void {
  const expected = protectedTokens(source);
  const expectedSlashTokens = new Set(expected.filter((token) => token.startsWith("/")));
  const actual = protectedTokens(translated, expectedSlashTokens);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    addIssue(issues, "error", subsystem, "protected-token-mismatch", key,
      `Protected tokens differ (expected: ${expected.join(", ") || "none"}; actual: ${actual.join(", ") || "none"}).`);
  }
}

function protectedTokens(
  value: string,
  expectedSlashTokens?: ReadonlySet<string>,
): readonly string[] {
  return PROTECTED_TOKEN_PATTERNS
    .flatMap((pattern, patternIndex) => [...value.matchAll(pattern)]
      .filter((match) => patternIndex !== 2
        || (isSlashCommandToken(value, match.index ?? 0)
          && (expectedSlashTokens === undefined || expectedSlashTokens.has(match[0]))))
      .map((match) => match[0]))
    .sort();
}

function isSlashCommandToken(value: string, index: number): boolean {
  if (index === 0) return true;
  return !/[\p{L}\p{N}_]/u.test(value[index - 1]!);
}

function checkCallSites(
  subsystem: "studio" | "cli",
  keys: readonly string[],
  base: Readonly<Record<string, unknown>>,
  issues: DriftIssue[],
): void {
  for (const key of [...new Set(keys)].sort()) {
    if (!(key in base)) {
      addIssue(issues, "error", subsystem, "callsite-key-missing", key,
        "A literal localization call-site key is absent from the base catalog.");
    }
  }
}

function checkClassification(
  subsystem: "commands" | "tui",
  values: { readonly current: readonly string[]; readonly classified: readonly string[] },
  issues: DriftIssue[],
): void {
  const current = new Set(values.current);
  const classified = new Set(values.classified);
  for (const key of [...current].sort()) {
    if (!classified.has(key)) {
      addIssue(issues, "warning", subsystem, "unclassified-path", key,
        `New ${subsystem === "commands" ? "Commander path" : "TUI copy leaf"} requires classification.`);
    }
  }
  for (const key of [...classified].sort()) {
    if (!current.has(key)) {
      addIssue(issues, "error", subsystem, "classified-path-missing", key,
        `A classified ${subsystem === "commands" ? "Commander path" : "TUI copy leaf"} disappeared.`);
    }
  }
}

function addIssue(
  issues: DriftIssue[],
  level: DriftIssueLevel,
  subsystem: DriftSubsystem,
  code: string,
  key: string,
  message: string,
): void {
  issues.push({ level, subsystem, code, key, message });
}

function compareIssues(left: DriftIssue, right: DriftIssue): number {
  return `${left.level}:${left.subsystem}:${left.code}:${left.key}`
    .localeCompare(`${right.level}:${right.subsystem}:${right.code}:${right.key}`);
}
