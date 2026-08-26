import { Command } from "commander";
import {
  FORECAST_DEFAULT_BRANCHES,
  FORECAST_DEFAULT_HORIZON,
  FORECAST_MAX_BRANCHES,
  FORECAST_MAX_HORIZON,
  FORECAST_MIN_BRANCHES,
  FORECAST_MIN_HORIZON,
  PipelineRunner,
  createNarrativeForecast,
  getNarrativeForecast,
  selectNarrativeBranch,
  type NarrativeForecast,
} from "@actalk/inkos-core";
import { buildPipelineConfig, findProjectRoot, loadConfig, log, logError, resolveBookId } from "../utils.js";
import { formatCurrentCliMessage, type CliMessageKey } from "../i18n/messages.js";

// CLI surface for RFC #342: create / show / select. All three operate only on
// story/runtime/narrative-forecasts/ artifacts; canonical files stay untouched.

export const forecastCommand = new Command("forecast")
  .description("Narrative forecast: compare non-canonical future branches before writing");

forecastCommand
  .command("create")
  .description("Create a narrative forecast (2-5 isolated candidate branches) from the current canon")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .requiredOption("--divergence <text>", "Divergence point to branch on, e.g. \"主角是否接受对手的合作提议\"")
  .option("--branches <n>", `Number of isolated candidate branches (${FORECAST_MIN_BRANCHES}-${FORECAST_MAX_BRANCHES})`, String(FORECAST_DEFAULT_BRANCHES))
  .option("--horizon <n>", `Future chapters each branch covers (${FORECAST_MIN_HORIZON}-${FORECAST_MAX_HORIZON})`, String(FORECAST_DEFAULT_HORIZON))
  .option("--model <model>", "Override the forecast model")
  .option("--llm-base-url <url>", "Override LLM base URL")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts: ForecastCreateOptions) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const branchCount = parseBoundedInteger(opts.branches, FORECAST_DEFAULT_BRANCHES, "branches", FORECAST_MIN_BRANCHES, FORECAST_MAX_BRANCHES);
      const horizon = parseBoundedInteger(opts.horizon, FORECAST_DEFAULT_HORIZON, "horizon", FORECAST_MIN_HORIZON, FORECAST_MAX_HORIZON);

      const config = await loadConfig({ projectRoot: root });
      if (opts.llmBaseUrl) config.llm.baseUrl = opts.llmBaseUrl;
      if (opts.model) config.llm.model = opts.model;
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, { quiet: Boolean(opts.json) }));

      const result = await createNarrativeForecast({
        projectRoot: root,
        bookId,
        divergence: opts.divergence,
        branchCount,
        horizon,
        runtime: pipeline.createAgentContext("forecast", bookId),
        // i18n-raw: workflow progress text is emitted by the forecast engine.
        onProgress: opts.json ? undefined : (message) => log(message),
      });

      if (opts.json) {
        // i18n-raw: structured forecast data must remain locale-independent.
        log(JSON.stringify({
          forecast: result.forecast,
          forecastJsonPath: result.forecastJsonPath,
          comparisonPath: result.comparisonPath,
        }, null, 2));
        return;
      }
      log(formatCurrentCliMessage("forecast.created", { forecastId: result.forecast.forecastId, chapter: result.forecast.baseChapter }));
      for (const line of formatBranchLines(result.forecast)) log(line);
      log(formatCurrentCliMessage("forecast.comparison", { path: result.comparisonPath }));
      log(formatCurrentCliMessage("forecast.selectHint", { bookId, forecastId: result.forecast.forecastId }));
    } catch (e) {
      failForecastCommand("Forecast create failed", "forecast.createFailure", e, opts.json);
    }
  });

forecastCommand
  .command("show")
  .description("Show a narrative forecast and re-check it against the current canon (marks it stale when canon changed)")
  .argument("<args...>", "[book-id] <forecast-id>")
  .option("--json", "Output JSON")
  .action(async (args: string[], opts: ForecastReadOptions) => {
    try {
      const { bookIdArg, forecastId } = parseForecastShowArgs(args);
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);

      const result = await getNarrativeForecast({ projectRoot: root, bookId, forecastId });

      if (opts.json) {
        // i18n-raw: structured forecast data must remain locale-independent.
        log(JSON.stringify({
          forecast: result.forecast,
          stale: result.stale,
          forecastJsonPath: result.forecastJsonPath,
          comparisonPath: result.comparisonPath,
        }, null, 2));
        return;
      }
      log(formatCurrentCliMessage("forecast.status", { forecastId: result.forecast.forecastId, status: result.stale ? "stale" : result.forecast.status }));
      log(formatCurrentCliMessage("forecast.divergence", { value: result.forecast.divergence }));
      log(formatCurrentCliMessage("forecast.horizon", { chapter: result.forecast.baseChapter, horizon: result.forecast.horizon }));
      if (result.stale) {
        log(formatCurrentCliMessage("forecast.staleWarning"));
      }
      for (const line of formatBranchLines(result.forecast)) log(line);
      log(formatCurrentCliMessage("forecast.comparison", { path: result.comparisonPath }));
    } catch (e) {
      failForecastCommand("Forecast show failed", "forecast.showFailure", e, opts.json);
    }
  });

forecastCommand
  .command("select")
  .description("Select a branch: writes only selected-branch-plan.md; canonical files are never modified")
  .argument("<args...>", "[book-id] <forecast-id> <branch-id>")
  .option("--json", "Output JSON")
  .action(async (args: string[], opts: ForecastReadOptions) => {
    try {
      const { bookIdArg, forecastId, branchId } = parseForecastSelectArgs(args);
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);

      const result = await selectNarrativeBranch({ projectRoot: root, bookId, forecastId, branchId });

      if (opts.json) {
        // i18n-raw: structured branch data must remain locale-independent.
        log(JSON.stringify({
          forecastId: result.forecast.forecastId,
          branchId: result.branch.branchId,
          branchTitle: result.branch.title,
          stale: result.stale,
          planPath: result.planPath,
        }, null, 2));
        return;
      }
      log(formatCurrentCliMessage("forecast.selected", { branchId: result.branch.branchId, title: result.branch.title, forecastId: result.forecast.forecastId }));
      if (result.stale) {
        log(formatCurrentCliMessage("forecast.selectedStale"));
      }
      log(formatCurrentCliMessage("forecast.plan", { path: result.planPath }));
      log(formatCurrentCliMessage("forecast.canonUntouched"));
    } catch (e) {
      failForecastCommand("Forecast select failed", "forecast.selectFailure", e, opts.json);
    }
  });

interface ForecastCreateOptions {
  readonly divergence: string;
  readonly branches?: string;
  readonly horizon?: string;
  readonly model?: string;
  readonly llmBaseUrl?: string;
  readonly json?: boolean;
}

interface ForecastReadOptions {
  readonly json?: boolean;
}

export function parseForecastShowArgs(args: ReadonlyArray<string>): {
  readonly bookIdArg?: string;
  readonly forecastId: string;
} {
  if (args.length === 1) return { forecastId: args[0]! };
  if (args.length === 2) return { bookIdArg: args[0]!, forecastId: args[1]! };
  throw new Error("Usage: inkos forecast show [book-id] <forecast-id>");
}

export function parseForecastSelectArgs(args: ReadonlyArray<string>): {
  readonly bookIdArg?: string;
  readonly forecastId: string;
  readonly branchId: string;
} {
  if (args.length === 2) return { forecastId: args[0]!, branchId: args[1]! };
  if (args.length === 3) return { bookIdArg: args[0]!, forecastId: args[1]!, branchId: args[2]! };
  throw new Error("Usage: inkos forecast select [book-id] <forecast-id> <branch-id>");
}

function formatBranchLines(forecast: NarrativeForecast): string[] {
  return forecast.branches.map((branch) =>
    formatCurrentCliMessage("forecast.branch", {
      branchId: branch.branchId,
      title: branch.title,
      score: branch.intentAlignment.score,
      risks: branch.risks.length,
    }));
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function failForecastCommand(prefix: string, key: CliMessageKey, error: unknown, json?: boolean): void {
  if (json) {
    // i18n-raw: structured JSON errors remain identical across locales.
    log(JSON.stringify({ error: `${prefix}: ${String(error)}` }, null, 2));
  } else {
    logError(formatCurrentCliMessage(key, { detail: String(error) }));
  }
  process.exitCode = 1;
}
