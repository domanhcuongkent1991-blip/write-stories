import { describe, expect, it } from "vitest";
import {
  HOOK_RESOLVE_PREFLIGHT_STRUCTURED_OUTPUT,
  HookResolvePreflightResultSchema,
} from "../agents/hook-resolve-preflight.js";

function walkSchemaNodes(node: unknown, visit: (schema: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const entry of node) walkSchemaNodes(entry, visit);
    return;
  }
  if (!node || typeof node !== "object") return;
  const schema = node as Record<string, unknown>;
  visit(schema);
  for (const value of Object.values(schema)) walkSchemaNodes(value, visit);
}

describe("hook resolve preflight structured output schema", () => {
  it("never uses const, which strict OpenAI-compatible providers reject", () => {
    walkSchemaNodes(HOOK_RESOLVE_PREFLIGHT_STRUCTURED_OUTPUT.schema, (schema) => {
      expect(Object.hasOwn(schema, "const")).toBe(false);
    });
  });

  it("gives every string enum node an explicit type key", () => {
    walkSchemaNodes(HOOK_RESOLVE_PREFLIGHT_STRUCTURED_OUTPUT.schema, (schema) => {
      if (Array.isArray(schema.enum) && schema.enum.every((entry) => typeof entry === "string")) {
        expect(schema.type).toBe("string");
      }
    });
  });

  it("keeps the decision enums aligned with the zod discriminated union literals", () => {
    const literals = HookResolvePreflightResultSchema.options.map(
      (option) => option.shape.decision.value,
    ).sort();
    const decisionEnums: string[][] = [];
    walkSchemaNodes(HOOK_RESOLVE_PREFLIGHT_STRUCTURED_OUTPUT.schema, (schema) => {
      const decision = (schema.properties as Record<string, Record<string, unknown>> | undefined)?.decision;
      if (
        decision
        && Array.isArray(decision.enum)
        && decision.enum.every((entry) => typeof entry === "string")
      ) {
        decisionEnums.push(decision.enum as string[]);
      }
    });
    const enumHeads = decisionEnums.map((values) => values[0]).sort();
    expect(enumHeads).toEqual(literals);
  });
});
