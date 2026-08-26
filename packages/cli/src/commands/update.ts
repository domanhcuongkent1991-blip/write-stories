import { Command } from "commander";
import { createRequire } from "node:module";
import type { CliLocale } from "../locale.js";
import { resolveCliLocale } from "../locale.js";
import { formatCliMessage } from "../i18n/messages.js";
import { log } from "../utils.js";

export interface SourceUpdateGuardResult {
  readonly exitCode: 2;
}

export function runSourceUpdateGuard(input: {
  readonly locale: CliLocale;
  readonly currentVersion: string;
  readonly writeLine: (line: string) => void;
}): SourceUpdateGuardResult {
  input.writeLine(formatCliMessage(input.locale, "update.current", { version: input.currentVersion }));
  input.writeLine(formatCliMessage(input.locale, "update.sourceBuild"));
  input.writeLine(formatCliMessage(input.locale, "update.reviewedGit"));
  return { exitCode: 2 };
}

export const updateCommand = new Command("update")
  .description("Show update guidance for source builds")
  .action(() => {
    const require = createRequire(import.meta.url);
    const { version: currentVersion } = require("../../package.json") as { version: string };
    const result = runSourceUpdateGuard({
      locale: resolveCliLocale(),
      currentVersion,
      writeLine: log,
    });
    process.exitCode = result.exitCode;
  });
