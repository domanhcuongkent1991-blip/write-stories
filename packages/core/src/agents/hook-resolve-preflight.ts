import { z } from "zod";
import { BaseAgent } from "./base.js";
import type { TokenUsage } from "../models/input-governance.js";
import type { HookOperationIntentV2 } from "../models/hook-operation-intent.js";
import type { LLMStructuredOutputSpec } from "../llm/provider.js";

export const HookResolvePreflightResultSchema = z.discriminatedUnion("decision", [
  z.object({
    hookId: z.string().min(1),
    decision: z.literal("pass"),
  }).strict(),
  z.object({
    hookId: z.string().min(1),
    decision: z.literal("repair-required"),
    code: z.enum(["payoff-mismatch", "insufficient-evidence"]),
    description: z.string().min(1).max(500),
  }).strict(),
  z.object({
    hookId: z.string().min(1),
    decision: z.literal("inconclusive"),
    description: z.string().min(1).max(500),
  }).strict(),
]);

export type HookResolvePreflightResult = z.infer<typeof HookResolvePreflightResultSchema>;

const HookResolvePreflightBatchSchema = z.object({
  results: z.array(HookResolvePreflightResultSchema).max(20),
}).strict();

export const HOOK_RESOLVE_PREFLIGHT_STRUCTURED_OUTPUT: LLMStructuredOutputSpec = {
  name: "hook_resolve_preflight",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        maxItems: 20,
        items: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["hookId", "decision"],
              properties: {
                hookId: { type: "string", minLength: 1 },
                decision: { const: "pass" },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["hookId", "decision", "code", "description"],
              properties: {
                hookId: { type: "string", minLength: 1 },
                decision: { const: "repair-required" },
                code: { enum: ["payoff-mismatch", "insufficient-evidence"] },
                description: { type: "string", minLength: 1, maxLength: 500 },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["hookId", "decision", "description"],
              properties: {
                hookId: { type: "string", minLength: 1 },
                decision: { const: "inconclusive" },
                description: { type: "string", minLength: 1, maxLength: 500 },
              },
            },
          ],
        },
      },
    },
  },
};

export class HookResolvePreflightError extends Error {
  constructor(
    readonly code: "PLANNER_CONTRACT_INVALID" | "INCONCLUSIVE_PROVIDER",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HookResolvePreflightError";
  }
}

export interface HookResolvePreflightOutput {
  readonly results: ReadonlyArray<HookResolvePreflightResult>;
  readonly tokenUsage?: TokenUsage;
}

export class HookResolvePreflightAgent extends BaseAgent {
  get name(): string {
    return "resolve-preflight";
  }

  async validate(input: {
    readonly contract: HookOperationIntentV2;
    readonly chapterGoal: string;
    readonly relevantMemoBeat: string;
  }): Promise<HookResolvePreflightOutput> {
    const resolves = input.contract.operations.filter((operation) => operation.action === "resolve");
    if (resolves.length === 0) return { results: [] };

    const systemPrompt = `You validate irreversible novel hook resolutions before chapter writing.

For each proposed resolution, decide whether the PLANNED EVIDENCE would actually satisfy the CANONICAL EXPECTED PAYOFF.
- PASS only when the evidence explicitly entails the canonical payoff.
- REPAIR-REQUIRED with payoff-mismatch when it proves a different fact.
- REPAIR-REQUIRED with insufficient-evidence when it is too weak or indirect.
- INCONCLUSIVE when the supplied fields are not enough to decide.

Do not infer identities, causes, or actors that are not stated. Return strict JSON only with this shape:
{"results":[{"hookId":"...","decision":"pass"}|{"hookId":"...","decision":"repair-required","code":"payoff-mismatch|insufficient-evidence","description":"..."}|{"hookId":"...","decision":"inconclusive","description":"..."}]}`;
    const userPrompt = JSON.stringify({
      chapterGoal: input.chapterGoal,
      resolves: resolves.map((operation) => ({
        hookId: operation.hookId,
        canonicalExpectedPayoff: operation.canonicalExpectedPayoff,
        plannedEvidence: operation.plannedEvidence,
        relevantMemoBeat: input.relevantMemoBeat,
      })),
    });

    try {
      const response = await this.chat([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ], {
        temperature: 0,
        structuredOutput: HOOK_RESOLVE_PREFLIGHT_STRUCTURED_OUTPUT,
      });
      const parsed = this.parseStrictResult(response.content);
      this.assertExactResultIds(parsed.results, resolves.map((operation) => operation.hookId));
      return {
        results: parsed.results,
        ...(response.usage ? { tokenUsage: response.usage } : {}),
      };
    } catch (error) {
      if (error instanceof HookResolvePreflightError) throw error;
      throw new HookResolvePreflightError(
        "INCONCLUSIVE_PROVIDER",
        `resolve preflight unavailable: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private parseStrictResult(content: string): z.infer<typeof HookResolvePreflightBatchSchema> {
    try {
      const trimmed = content.trim();
      // Gemini on the internal OpenAI-compatible gateway may wrap strict JSON
      // in one markdown JSON fence. Unwrap only an anchored, whole-response
      // fence; prose or trailing content remains invalid and fails closed.
      const fenced = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/u);
      const jsonText = fenced ? fenced[1].trim() : trimmed;
      const parsed: unknown = JSON.parse(jsonText);
      const batch = HookResolvePreflightBatchSchema.safeParse(parsed);
      if (batch.success) return batch.data;

      // Some OpenAI-compatible gateways wrap a one-item structured response
      // as the item itself and append transport metadata. Keep the governance
      // contract strict by allowing only those two documented metadata keys,
      // then normalize the single item into the required batch shape. Unknown
      // keys and multi-item shape mismatches still fail closed below.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const normalized = Object.fromEntries(
          Object.entries(parsed).filter(([key]) => key !== "status" && key !== "processed"),
        );
        const single = HookResolvePreflightResultSchema.safeParse(normalized);
        if (single.success) return { results: [single.data] };
      }

      throw new Error("structured output shape mismatch");
    } catch (error) {
      throw new HookResolvePreflightError(
        "INCONCLUSIVE_PROVIDER",
        "resolve preflight returned malformed structured output",
        { cause: error },
      );
    }
  }

  private assertExactResultIds(
    results: ReadonlyArray<HookResolvePreflightResult>,
    expectedIds: ReadonlyArray<string>,
  ): void {
    const actualIds = results.map((result) => result.hookId);
    const uniqueIds = new Set(actualIds);
    const expected = new Set(expectedIds);
    if (
      uniqueIds.size !== actualIds.length
      || actualIds.length !== expectedIds.length
      || actualIds.some((hookId) => !expected.has(hookId))
      || expectedIds.some((hookId) => !uniqueIds.has(hookId))
    ) {
      throw new HookResolvePreflightError(
        "INCONCLUSIVE_PROVIDER",
        "resolve preflight result IDs do not match the proposed resolve operations",
      );
    }
  }
}
