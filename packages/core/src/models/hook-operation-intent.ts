import { createHash } from "node:crypto";
import { z } from "zod";
import type { StoredHook } from "../state/memory-db.js";
import { normalizeStoredHookStatus } from "../utils/hook-lifecycle.js";

export const ExpectedHookOperationActionSchema = z.enum([
  "advance",
  "mention",
  "resolve",
  "defer",
]);
export type ExpectedHookOperationAction = z.infer<typeof ExpectedHookOperationActionSchema>;

export const ExpectedHookOperationV2Schema = z.object({
  hookId: z.string().trim().min(1),
  action: ExpectedHookOperationActionSchema,
  canonicalPayoffHash: z.string().regex(/^[a-f0-9]{64}$/u),
  canonicalExpectedPayoff: z.string().max(2_000),
  plannedEvidence: z.string().max(2_000),
}).strict().superRefine((operation, ctx) => {
  if (operation.action !== "resolve") return;
  if (operation.canonicalExpectedPayoff.trim().length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["canonicalExpectedPayoff"],
      message: "resolve requires a canonical expected payoff",
    });
  }
  if (operation.plannedEvidence.trim().length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["plannedEvidence"],
      message: "resolve requires planned evidence",
    });
  }
});

export type ExpectedHookOperationV2 = z.infer<typeof ExpectedHookOperationV2Schema>;

export const HookOperationIntentV2Schema = z.object({
  schemaVersion: z.literal(2),
  operations: z.array(ExpectedHookOperationV2Schema),
}).strict();

export type HookOperationIntentV2 = z.infer<typeof HookOperationIntentV2Schema>;

export class HookOperationContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookOperationContractError";
  }
}

export function hashCanonicalHookPayoff(hookId: string, expectedPayoff: string): string {
  return createHash("sha256")
    .update(JSON.stringify({
      hookId: hookId.trim(),
      expectedPayoff: expectedPayoff.normalize("NFC").trim(),
    }), "utf8")
    .digest("hex");
}

export function assertHookContractCurrent(
  contract: HookOperationIntentV2,
  activeHooks: ReadonlyArray<StoredHook>,
): void {
  const parsed = HookOperationIntentV2Schema.parse(contract);
  const hooksById = new Map(activeHooks.map((hook) => [hook.hookId, hook] as const));
  const seen = new Map<string, ExpectedHookOperationAction>();

  for (const operation of parsed.operations) {
    const previousAction = seen.get(operation.hookId);
    if (previousAction !== undefined) {
      // Models occasionally repeat the same op verbatim. A verbatim repeat is
      // idempotent, so skip it; only a genuinely contradictory action fails.
      if (previousAction === operation.action) continue;
      throw new HookOperationContractError(
        `contradictory hook operation for ${operation.hookId}: ${previousAction} and ${operation.action}`,
      );
    }
    seen.set(operation.hookId, operation.action);

    const hook = hooksById.get(operation.hookId);
    if (!hook) {
      throw new HookOperationContractError(`unknown stable hook ID ${operation.hookId}`);
    }
    assertLegalHookTransition(hook, operation.action);

    const currentHash = hashCanonicalHookPayoff(hook.hookId, hook.expectedPayoff ?? "");
    if (operation.canonicalPayoffHash !== currentHash) {
      throw new HookOperationContractError(
        `stale canonical payoff for hook ${operation.hookId}`,
      );
    }
    if (operation.canonicalExpectedPayoff !== (hook.expectedPayoff ?? "")) {
      throw new HookOperationContractError(
        `canonical payoff text mismatch for hook ${operation.hookId}`,
      );
    }
  }
}

export function getLegalHookActions(
  hook: Pick<StoredHook, "status">,
): ReadonlyArray<ExpectedHookOperationAction> {
  const status = normalizeStoredHookStatus(hook.status);
  if (status === "resolved") return [];
  if (status === "deferred") return ["advance", "mention", "defer"];
  return ["advance", "mention", "resolve", "defer"];
}

export function assertLegalHookTransition(
  hook: StoredHook,
  action: ExpectedHookOperationAction,
): void {
  const status = normalizeStoredHookStatus(hook.status);
  if (!getLegalHookActions(hook).includes(action)) {
    if (status === "resolved") {
      throw new HookOperationContractError(
        `illegal ${action} transition for resolved hook ${hook.hookId}`,
      );
    }
    throw new HookOperationContractError(
      `illegal resolve transition for deferred hook ${hook.hookId}`,
    );
  }
}
