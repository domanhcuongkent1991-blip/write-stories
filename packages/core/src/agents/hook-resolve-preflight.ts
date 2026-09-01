import { z } from "zod";
import { BaseAgent } from "./base.js";
import type { TokenUsage } from "../models/input-governance.js";
import type { HookOperationIntentV2 } from "../models/hook-operation-intent.js";

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
        relevantMemoBeat: operation.plannedEvidence,
      })),
    });

    try {
      const response = await this.chat([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ], { temperature: 0 });
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
      return HookResolvePreflightBatchSchema.parse(JSON.parse(content.trim()));
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
