import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { LLMRetryCounts } from "./provider.js";

export const ProviderCallStageSchema = z.enum([
  "unscoped",
  "planner",
  "resolve-preflight",
  "writer-draft",
  "writer-format-repair",
  "writer-observer",
  "initial-settlement",
  "initial-state-validation",
  "local-repair",
  "structural-revision",
  "candidate-settlement",
  "settlement-recovery",
  "initial-auditor",
  "post-candidate-auditor",
  "re-audit",
  "auditor-verdict-repair",
]);
export type ProviderCallStage = z.infer<typeof ProviderCallStageSchema>;

export const ProviderCallTelemetrySchema = z.object({
  total: z.number().int().nonnegative(),
  byStage: z.record(ProviderCallStageSchema, z.number().int().nonnegative()),
  transportRetries: z.number().int().nonnegative(),
  outputRetries: z.number().int().nonnegative(),
}).strict();
export type ProviderCallTelemetry = z.infer<typeof ProviderCallTelemetrySchema>;

export interface ProviderCallCollector {
  total: number;
  readonly byStage: Partial<Record<ProviderCallStage, number>>;
  transportRetries: number;
  outputRetries: number;
}

interface ProviderCallContext {
  readonly collector?: ProviderCallCollector;
  readonly stage: ProviderCallStage;
}

const providerCallContext = new AsyncLocalStorage<ProviderCallContext>();

export function createProviderCallCollector(): ProviderCallCollector {
  return { total: 0, byStage: {}, transportRetries: 0, outputRetries: 0 };
}

export function runWithProviderCallTelemetry<T>(
  collector: ProviderCallCollector,
  task: () => T,
): T {
  return providerCallContext.run({ collector, stage: "unscoped" }, task);
}

export function runWithProviderCallStage<T>(stage: ProviderCallStage, task: () => T): T {
  const current = providerCallContext.getStore();
  ProviderCallStageSchema.parse(stage);
  return providerCallContext.run({
    ...(current?.collector ? { collector: current.collector } : {}),
    stage,
  }, task);
}

export function runWithProviderDefaultStage<T>(stage: ProviderCallStage, task: () => T): T {
  const current = providerCallContext.getStore();
  if (current && current.stage !== "unscoped") return task();
  return runWithProviderCallStage(stage, task);
}

export function readProviderCallStage(): ProviderCallStage {
  return providerCallContext.getStore()?.stage ?? "unscoped";
}

export function recordProviderPostAttempt(): void {
  const current = providerCallContext.getStore();
  if (!current?.collector) return;
  current.collector.total += 1;
  current.collector.byStage[current.stage] = (current.collector.byStage[current.stage] ?? 0) + 1;
}

export function recordProviderRetryCounts(counts: LLMRetryCounts): void {
  const current = providerCallContext.getStore();
  if (!current?.collector) return;
  current.collector.transportRetries += counts.transport;
  current.collector.outputRetries += counts.output;
}

export function snapshotProviderCallTelemetry(
  collector = providerCallContext.getStore()?.collector,
): ProviderCallTelemetry | undefined {
  if (!collector) return undefined;
  return ProviderCallTelemetrySchema.parse({
    total: collector.total,
    byStage: { ...collector.byStage },
    transportRetries: collector.transportRetries,
    outputRetries: collector.outputRetries,
  });
}
