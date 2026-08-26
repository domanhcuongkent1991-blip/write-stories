import { Command } from "commander";
import { execSync } from "node:child_process";
import { log, logError } from "../utils.js";
import { formatCurrentCliMessage } from "../i18n/messages.js";

export const updateCommand = new Command("update")
  .description("Update InkOS to the latest version")
  .action(async () => {
    try {
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const { version: currentVersion } = require("../../package.json") as { version: string };

      log(formatCurrentCliMessage("update.current", { version: currentVersion }));
      log(formatCurrentCliMessage("update.checking"));

      const remoteVersion = execSync("npm view @actalk/inkos version", {
        encoding: "utf-8",
      }).trim();

      if (currentVersion === remoteVersion) {
        log(formatCurrentCliMessage("update.currentLatest", { version: currentVersion }));
        return;
      }

      // Don't downgrade development versions
      const current = currentVersion.split(".").map(Number);
      const remote = remoteVersion.split(".").map(Number);
      const isNewer = current[0]! > remote[0]! ||
        (current[0] === remote[0] && current[1]! > remote[1]!) ||
        (current[0] === remote[0] && current[1] === remote[1] && current[2]! > remote[2]!);

      if (isNewer) {
        log(formatCurrentCliMessage("update.newer", { current: currentVersion, remote: remoteVersion }));
        return;
      }

      log(formatCurrentCliMessage("update.updating", { current: currentVersion, remote: remoteVersion }));
      execSync("npm install -g @actalk/inkos@latest", { stdio: "inherit" });
      log(formatCurrentCliMessage("update.updated", { version: remoteVersion }));
    } catch (e) {
      logError(formatCurrentCliMessage("update.failure", { detail: String(e) }));
      log(formatCurrentCliMessage("update.manual"));
      process.exit(1);
    }
  });
