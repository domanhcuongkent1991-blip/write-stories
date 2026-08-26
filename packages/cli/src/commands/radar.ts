import { Command } from "commander";
import { PipelineRunner } from "@actalk/inkos-core";
import { loadConfig, buildPipelineConfig, findProjectRoot, log, logError } from "../utils.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { formatCurrentCliMessage } from "../i18n/messages.js";

export const radarCommand = new Command("radar")
  .description("Market intelligence");

radarCommand
  .command("scan")
  .description("Scan market for opportunities")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      const config = await loadConfig();
      const root = findProjectRoot();

      const pipeline = new PipelineRunner(buildPipelineConfig(config, root));

      if (!opts.json) log(formatCurrentCliMessage("radar.scanning"));

      const result = await pipeline.runRadar();

      // Save radar result
      const radarDir = join(root, "radar");
      await mkdir(radarDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filePath = join(radarDir, `scan-${timestamp}.json`);
      await writeFile(
        filePath,
        JSON.stringify(result, null, 2),
        "utf-8",
      );

      if (opts.json) {
        // i18n-raw: structured radar output must remain locale-independent.
        log(JSON.stringify({ ...result, savedTo: filePath }, null, 2));
      } else {
        log(formatCurrentCliMessage("radar.summary", { summary: result.marketSummary }));
        log(formatCurrentCliMessage("radar.recommendations"));

        for (const rec of result.recommendations) {
          log(formatCurrentCliMessage("radar.item", { confidence: (rec.confidence * 100).toFixed(0), platform: rec.platform, genre: rec.genre }));
          log(formatCurrentCliMessage("radar.concept", { concept: rec.concept }));
          log(formatCurrentCliMessage("radar.reasoning", { reasoning: rec.reasoning }));
          log(formatCurrentCliMessage("radar.benchmarks", { titles: rec.benchmarkTitles.join(", ") }));
          log(formatCurrentCliMessage("common.blank"));
        }

        log(formatCurrentCliMessage("radar.saved", { timestamp }));
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCurrentCliMessage("radar.failure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });
