import { Command } from "commander";
import { PipelineRunner, runAgentSession } from "@actalk/inkos-core";
import { buildPipelineConfig, loadConfig, createClient, findProjectRoot, resolveBookId, resolveContext, log, logError } from "../utils.js";
import { formatCurrentCliMessage } from "../i18n/messages.js";

export const agentCommand = new Command("agent")
  .description("Natural language agent mode (LLM orchestrates via tool-use)")
  .argument("<instruction>", "Natural language instruction")
  .option("--book <bookId>", "Bind this request to an existing book")
  .option("--session <sessionId>", "Reuse an agent session id")
  .option("--context <text>", "Additional context (natural language)")
  .option("--context-file <path>", "Read additional context from file")
  .option("--json", "Output JSON (suppress progress messages)")
  .option("--quiet", "Suppress non-JSON console output")
  .action(async (instruction: string, opts) => {
    try {
      const config = await loadConfig();
      const client = createClient(config);
      const root = findProjectRoot();
      const context = await resolveContext(opts);

      const fullInstruction = context
        ? `${instruction}\n\n补充信息：${context}`
        : instruction;

      const bookId = opts.book ? await resolveBookId(opts.book, root) : null;
      const trimmed = fullInstruction.trim();
      const actionSource = trimmed.startsWith("/") ? "slash" : "free-text";
      const requestedIntent = bookId && trimmed === "/write"
        ? "write_next"
        : !bookId && trimmed === "/create"
          ? "create_book"
          : undefined;
      const sessionKind = bookId
        ? "book"
        : requestedIntent === "create_book"
          ? "book-create"
          : "chat";
      const sessionId = opts.session?.trim() || `cli-agent-${Date.now().toString(36)}`;
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, {
        externalContext: context,
        quiet: opts.quiet || opts.json,
      }));

      const result = await runAgentSession(
        {
          sessionId,
          bookId,
          sessionKind,
          actionSource,
          requestedIntent,
          language: config.language ?? "zh",
          pipeline,
          projectRoot: root,
          model: client._piModel
            ? client._piModel
            : { provider: config.llm.provider ?? "openai", modelId: config.llm.model },
          apiKey: client._apiKey,
        },
        fullInstruction,
      );

      if (opts.json) {
        // i18n-raw: structured JSON preserves agent output byte-for-byte.
        log(JSON.stringify({ result }));
      } else if (!opts.quiet && result.responseText.trim()) {
        // i18n-raw: agent response content must never be translated.
        log(result.responseText);
      }
    } catch (e) {
      if (opts.json) {
        // i18n-raw: structured JSON error values are locale-independent.
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(formatCurrentCliMessage("agent.failure", { detail: String(e) }));
      }
      process.exit(1);
    }
  });
