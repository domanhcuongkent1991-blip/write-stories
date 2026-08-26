import { describe, expect, it } from "vitest";
import {
  checkI18nDrift,
  fingerprintBilingualSource,
  type DriftCheckInput,
} from "../../../../scripts/i18n-drift-lib.js";

function fixture(overrides: Partial<DriftCheckInput> = {}): DriftCheckInput {
  return {
    studio: {
      base: {
        "nav.open": { zh: "打开 {path}", en: "Open {path}" },
        "future.label": { zh: "未来", en: "Future" },
      },
      vi: {
        "nav.open": "Mở {path}",
        "future.label": "Tương lai",
      },
      requiredPrefixes: ["nav."],
      allowedFallbackKeys: [],
    },
    cli: {
      base: {
        "cli.hint": {
          zh: "使用 --json、/confirm 和 INKOS_LOCALE",
          en: "Use --json, /confirm, and INKOS_LOCALE",
        },
      },
      vi: {
        "cli.hint": "Dùng --json, /confirm và INKOS_LOCALE",
      },
      requiredPrefixes: [],
      allowedFallbackKeys: [],
    },
    tui: {
      base: { "labels.project": "Project" },
      vi: { "labels.project": "Dự án" },
    },
    sourceLock: {
      version: 1,
      studio: {},
      cli: {},
      tui: {},
    },
    callSiteKeys: { studio: [], cli: [] },
    commandPaths: { current: ["inkos"], classified: ["inkos"] },
    tuiLeaves: { current: ["labels.project"], classified: ["labels.project"] },
    ...overrides,
  };
}

describe("i18n drift policy", () => {
  it("reports a missing required Vietnamese key as an error", () => {
    const input = fixture();
    const result = checkI18nDrift({
      ...input,
      studio: { ...input.studio, vi: { "future.label": "Tương lai" } },
    });

    expect(result.errors.map((issue) => issue.code)).toContain("missing-required-vi-key");
  });

  it("reports a missing new non-critical key as a warning", () => {
    const input = fixture();
    const result = checkI18nDrift({
      ...input,
      studio: { ...input.studio, vi: { "nav.open": "Mở {path}" } },
    });

    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "missing-noncritical-vi-key",
      key: "future.label",
    }));
  });

  it("reports an extra Vietnamese key as an error", () => {
    const input = fixture();
    const result = checkI18nDrift({
      ...input,
      studio: { ...input.studio, vi: { ...input.studio.vi, "removed.key": "Dư" } },
    });

    expect(result.errors).toContainEqual(expect.objectContaining({
      code: "extra-vi-key",
      key: "removed.key",
    }));
  });

  it("reports changed placeholder names as an error", () => {
    const input = fixture();
    const result = checkI18nDrift({
      ...input,
      studio: { ...input.studio, vi: { ...input.studio.vi, "nav.open": "Mở {file}" } },
    });

    expect(result.errors).toContainEqual(expect.objectContaining({
      code: "protected-token-mismatch",
      key: "nav.open",
    }));
  });

  it.each(["--json", "/confirm", "INKOS_LOCALE"])(
    "reports a lost protected token: %s",
    (token) => {
      const input = fixture();
      const result = checkI18nDrift({
        ...input,
        cli: {
          ...input.cli,
          vi: { "cli.hint": input.cli.vi["cli.hint"]!.replace(token, "") },
        },
      });

      expect(result.errors).toContainEqual(expect.objectContaining({
        code: "protected-token-mismatch",
        key: "cli.hint",
      }));
    },
  );

  it("does not mistake a word-internal slash unit for a slash command", () => {
    const input = fixture();
    const result = checkI18nDrift({
      ...input,
      cli: {
        ...input.cli,
        base: { "cli.hint": { zh: "每章 {value}", en: "{value} avg/chapter" } },
        vi: { "cli.hint": "trung bình {value}/chương" },
      },
    });

    expect(result.errors).not.toContainEqual(expect.objectContaining({
      code: "protected-token-mismatch",
      key: "cli.hint",
    }));
  });

  it("reports a changed zh/en source fingerprint for the same key", () => {
    const input = fixture();
    const result = checkI18nDrift({
      ...input,
      sourceLock: {
        ...input.sourceLock,
        studio: {
          "nav.open": fingerprintBilingualSource({ zh: "旧", en: "Old" }),
        },
      },
    });

    expect(result.errors).toContainEqual(expect.objectContaining({
      code: "source-fingerprint-changed",
      key: "nav.open",
    }));
  });

  it("reports a call-site key absent from its base catalog", () => {
    const input = fixture();
    const result = checkI18nDrift({
      ...input,
      callSiteKeys: { studio: ["nav.missing"], cli: [] },
    });

    expect(result.errors).toContainEqual(expect.objectContaining({
      code: "callsite-key-missing",
      key: "nav.missing",
    }));
  });

  it("sorts errors and warnings deterministically", () => {
    const input = fixture();
    const result = checkI18nDrift({
      ...input,
      studio: { ...input.studio, vi: { "z.extra": "Z", "a.extra": "A" } },
      commandPaths: { current: ["inkos z", "inkos a"], classified: ["inkos"] },
      tuiLeaves: { current: ["z.leaf", "a.leaf"], classified: [] },
    });
    const serialize = (issue: { level: string; subsystem: string; code: string; key: string }) =>
      `${issue.level}:${issue.subsystem}:${issue.code}:${issue.key}`;

    expect(result.errors.map(serialize)).toEqual([...result.errors.map(serialize)].sort());
    expect(result.warnings.map(serialize)).toEqual([...result.warnings.map(serialize)].sort());
  });
});
