import { Command } from "commander";
import { ConsolidatorAgent } from "@actalk/inkos-core";
import { loadConfig, buildPipelineConfig, findProjectRoot, resolveBookId, log, logError } from "../utils.js";
import { formatCurrentCliMessage } from "../i18n/messages.js";

export const consolidateCommand = new Command("consolidate")
  .description("Consolidate chapter summaries into volume-level summaries (reduces context for long books)")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const config = await loadConfig();
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);

      const pipelineConfig = buildPipelineConfig(config, root);
      const consolidator = new ConsolidatorAgent({
        client: pipelineConfig.client,
        model: pipelineConfig.model,
        projectRoot: root,
      });

      const { StateManager } = await import("@actalk/inkos-core");
      const state = new StateManager(root);
      const bookDir = state.bookDir(bookId);

      if (!opts.json) log(formatCurrentCliMessage("consolidate.start", { bookId }));

      const result = await consolidator.consolidate(bookDir);

      if (opts.json) {
        // i18n-raw: structured consolidation result must remain locale-independent.
        log(JSON.stringify(result, null, 2));
      } else {
        if (result.archivedVolumes === 0) {
          log(formatCurrentCliMessage("consolidate.empty"));
        } else {
          log(formatCurrentCliMessage("consolidate.volumes", { count: result.archivedVolumes }));
          log(formatCurrentCliMessage("consolidate.retained", { count: result.retainedChapters }));
          log(formatCurrentCliMessage("consolidate.saved"));
          log(formatCurrentCliMessage("consolidate.archived"));
        }
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON errors preserve the original detail.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCurrentCliMessage("consolidate.failure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });
