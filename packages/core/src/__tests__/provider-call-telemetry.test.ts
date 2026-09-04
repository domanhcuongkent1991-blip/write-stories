import { describe, expect, it } from "vitest";
import {
  createProviderCallCollector,
  readProviderCallStage,
  ProviderCallTelemetrySchema,
  recordProviderPostAttempt,
  recordProviderRetryCounts,
  runWithProviderCallStage,
  runWithProviderCallTelemetry,
  snapshotProviderCallTelemetry,
} from "../llm/provider-call-telemetry.js";

describe("provider call telemetry", () => {
  it("exposes an explicit diagnostic stage even without a telemetry collector", async () => {
    expect(readProviderCallStage()).toBe("unscoped");
    await runWithProviderCallStage("writer-format-repair", async () => {
      expect(readProviderCallStage()).toBe("writer-format-repair");
    });
    expect(readProviderCallStage()).toBe("unscoped");
  });

  it("counts actual transport attempts by explicit stage and retry class", async () => {
    const collector = createProviderCallCollector();
    await runWithProviderCallTelemetry(collector, async () => {
      await runWithProviderCallStage("initial-auditor", async () => {
        recordProviderPostAttempt();
        recordProviderPostAttempt();
        recordProviderRetryCounts({ transport: 1, output: 0, quality: 0 });
      });
      await runWithProviderCallStage("post-candidate-auditor", async () => {
        recordProviderPostAttempt();
        recordProviderRetryCounts({ transport: 0, output: 1, quality: 0 });
      });
      await runWithProviderCallStage("local-repair", async () => undefined);
    });

    expect(snapshotProviderCallTelemetry(collector)).toEqual({
      total: 3,
      byStage: {
        "initial-auditor": 2,
        "post-candidate-auditor": 1,
      },
      transportRetries: 1,
      outputRetries: 1,
    });
  });

  it("rejects arbitrary or sensitive persisted fields", () => {
    expect(() => ProviderCallTelemetrySchema.parse({
      total: 1,
      byStage: { planner: 1 },
      transportRetries: 0,
      outputRetries: 0,
      prompt: "must not persist",
    })).toThrow();
    expect(() => ProviderCallTelemetrySchema.parse({
      total: 1,
      byStage: { "provider-secret": 1 },
      transportRetries: 0,
      outputRetries: 0,
    })).toThrow();
  });
});
