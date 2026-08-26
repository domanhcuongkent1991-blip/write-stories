import { Command } from "commander";
import { Scheduler } from "@actalk/inkos-core";
import { loadConfig, findProjectRoot, buildPipelineConfig, log, logError } from "../utils.js";
import { createWriteStream, type WriteStream } from "node:fs";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { formatCurrentCliMessage } from "../i18n/messages.js";

const PID_FILE = "inkos.pid";

export const upCommand = new Command("up")
  .description("Start the InkOS daemon (autonomous mode)")
  .option("-q, --quiet", "Suppress console output")
  .action(async (opts) => {
    let logStream: WriteStream | undefined;
    let pidPath: string | undefined;
    try {
      const config = await loadConfig();
      const root = findProjectRoot();

      // Check if already running
      pidPath = join(root, PID_FILE);
      try {
        const existingPid = await readFile(pidPath, "utf-8");
        logError(formatCurrentCliMessage("daemon.alreadyRunning", { pid: existingPid.trim() }));
        process.exit(1);
      } catch {
        // No PID file, good
      }

      log(formatCurrentCliMessage("daemon.starting"));
      log(formatCurrentCliMessage("daemon.writeCycle", { schedule: config.daemon.schedule.writeCron }));
      log(formatCurrentCliMessage("daemon.radarScan", { schedule: config.daemon.schedule.radarCron }));
      log(formatCurrentCliMessage("daemon.maxBooks", { count: config.daemon.maxConcurrentBooks }));
      log(formatCurrentCliMessage("common.blank"));

      // Write PID file
      await writeFile(pidPath, String(process.pid), "utf-8");

      // File logging for daemon
      const logPath = join(root, "inkos.log");
      logStream = createWriteStream(logPath, { flags: "a" });

      const scheduler = new Scheduler({
        ...buildPipelineConfig(config, root, { logFile: logStream, quiet: opts.quiet }),
        radarCron: config.daemon.schedule.radarCron,
        writeCron: config.daemon.schedule.writeCron,
        maxConcurrentBooks: config.daemon.maxConcurrentBooks,
        chaptersPerCycle: config.daemon.chaptersPerCycle,
        retryDelayMs: config.daemon.retryDelayMs,
        cooldownAfterChapterMs: config.daemon.cooldownAfterChapterMs,
        maxChaptersPerDay: config.daemon.maxChaptersPerDay,
        onChapterComplete: (bookId, chapter, status) => {
          const icon = status === "ready-for-review"
            ? "+"
            : status === "state-degraded"
              ? "x"
              : "!";
          log(formatCurrentCliMessage("daemon.chapterEvent", { icon, bookId, chapter, status }));
        },
        onError: (bookId, error) => {
          logError(formatCurrentCliMessage("daemon.bookError", { bookId, detail: error.message }));
        },
      });

      // Handle shutdown
      const shutdown = async () => {
        log(formatCurrentCliMessage("daemon.shuttingDown"));
        scheduler.stop();
        logStream?.end();
        const currentPidPath = pidPath;
        if (currentPidPath !== undefined) {
          try {
            await unlink(currentPidPath);
          } catch {
            // ignore
          }
        }
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      await scheduler.start();
      log(formatCurrentCliMessage("daemon.running"));

      // Keep process alive
      await new Promise(() => {});
    } catch (e) {
      logStream?.end();
      if (pidPath !== undefined) {
        try {
          await unlink(pidPath);
        } catch {
          // ignore
        }
      }
      logError(formatCurrentCliMessage("daemon.startFailure", { detail: String(e) }));
      process.exit(1);
    }
  });

export const downCommand = new Command("down")
  .description("Stop the InkOS daemon")
  .action(async () => {
    const root = findProjectRoot();
    const pidPath = join(root, PID_FILE);

    try {
      const pid = (await readFile(pidPath, "utf-8")).trim();
      try {
        process.kill(parseInt(pid, 10), "SIGTERM");
        log(formatCurrentCliMessage("daemon.stopped", { pid }));
      } catch {
        log(formatCurrentCliMessage("daemon.notFound", { pid }));
      }
      try { await unlink(pidPath); } catch { /* already cleaned up by daemon */ }
    } catch {
      log(formatCurrentCliMessage("daemon.notRunning"));
    }
  });
