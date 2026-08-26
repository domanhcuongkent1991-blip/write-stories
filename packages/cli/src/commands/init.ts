import { Command } from "commander";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { log, logError } from "../utils.js";
import { initializeProjectDirectory } from "../project-bootstrap.js";
import { resolveCliLocale } from "../locale.js";
import { formatCliMessage } from "../i18n/messages.js";

export const initCommand = new Command("init")
  .description("Initialize an InkOS project (current directory by default)")
  .argument("[name]", "Project name (creates subdirectory). Omit to init current directory.")
  .option("--lang <language>", "Default writing language: zh (Chinese) or en (English)", "zh")
  .action(async (name: string | undefined, opts: { lang?: string }) => {
    const locale = resolveCliLocale();
    const projectDir = name ? resolve(process.cwd(), name) : process.cwd();

    try {
      await mkdir(projectDir, { recursive: true });
      await initializeProjectDirectory(projectDir, {
        language: (opts.lang === "en" ? "en" : "zh"),
        overwriteSupportFiles: true,
      });

      log(formatCliMessage(locale, "init.initialized", { projectDir }));
      log(formatCliMessage(locale, "common.blank"));
      const isEnglish = (opts.lang ?? "zh") === "en";
      const exampleCreateLines = isEnglish
        ? ["  inkos book create --title 'My Novel' --genre progression --platform royalroad --lang en"]
        : [
          "  inkos book create --title '我的小说' --genre xuanhuan --platform tomato",
          formatCliMessage(locale, "init.englishHint"),
        ];
      if (global) {
        log(formatCliMessage(locale, "init.globalDetected"));
        log(formatCliMessage(locale, "common.blank"));
        log(formatCliMessage(locale, "init.nextSteps"));
        if (name) log(formatCliMessage(locale, "common.command", { command: `  cd ${name}` }));
        for (const line of exampleCreateLines) log(formatCliMessage(locale, "common.command", { command: line }));
      } else {
        log(formatCliMessage(locale, "init.nextSteps"));
        if (name) log(formatCliMessage(locale, "common.command", { command: `  cd ${name}` }));
        log(formatCliMessage(locale, "init.globalOption"));
        log(formatCliMessage(locale, "common.command", { command: "  inkos config set-global --provider openai --base-url <your-api-url> --api-key <your-key> --model <your-model>" }));
        log(formatCliMessage(locale, "init.projectOption"));
        log(formatCliMessage(locale, "common.blank"));
        for (const line of exampleCreateLines) log(formatCliMessage(locale, "common.command", { command: line }));
      }
      log(formatCliMessage(locale, "common.command", { command: "  inkos write next <book-id>" }));
    } catch (e) {
      logError(formatCliMessage(locale, "init.failure", { detail: String(e) }));
      process.exit(1);
    }
  });
