import {
  RuntimeStateDeltaSchema,
  type RuntimeStateDelta,
} from "../models/runtime-state.js";

export interface SettlerDeltaOutput {
  readonly postSettlement: string;
  readonly runtimeStateDelta: RuntimeStateDelta;
}

export type SettlerDeltaParseReason =
  | "missing-marker"
  | "invalid-json"
  | "schema-invalid";

/**
 * A deterministic parser failure that callers can report and, for Vietnamese
 * persistence, retry without confusing a malformed settlement with prose
 * quality or provider transport failure.
 */
export class SettlerDeltaParseError extends Error {
  readonly reason: SettlerDeltaParseReason;

  constructor(reason: SettlerDeltaParseReason, message: string) {
    super(message);
    this.name = "SettlerDeltaParseError";
    this.reason = reason;
  }
}

function sanitizeJSON(str: string): string {
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/,\s*([}\]])/g, "$1");
}

export function parseSettlerDeltaOutput(content: string): SettlerDeltaOutput {
  const extract = (tag: string): string => {
    const regex = new RegExp(
      `=== ${tag} ===\\s*([\\s\\S]*?)(?==== [A-Z_]+ ===|$)`,
    );
    const match = content.match(regex);
    return match?.[1]?.trim() ?? "";
  };

  const rawDelta = extract("RUNTIME_STATE_DELTA");
  if (!rawDelta) {
    throw new SettlerDeltaParseError(
      "missing-marker",
      "runtime state delta block is missing",
    );
  }

  let parsed: unknown;
  let parseError: unknown;
  for (const candidate of jsonCandidates(rawDelta)) {
    try {
      parsed = JSON.parse(sanitizeJSON(candidate));
      parseError = undefined;
      break;
    } catch (error) {
      parseError = error;
    }
  }
  if (parsed === undefined) {
    const error = parseError ?? new Error("no JSON object found");
    throw new SettlerDeltaParseError(
      "invalid-json",
      `runtime state delta is not valid JSON: ${String(error)}`,
    );
  }

  try {
    return {
      postSettlement: extract("POST_SETTLEMENT"),
      runtimeStateDelta: RuntimeStateDeltaSchema.parse(parsed),
    };
  } catch (error) {
    throw new SettlerDeltaParseError(
      "schema-invalid",
      `runtime state delta failed schema validation: ${String(error)}`,
    );
  }
}

function jsonCandidates(value: string): string[] {
  const trimmed = value.trim();
  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim();
  if (fenced) candidates.push(fenced);

  // Some gateways/models add a one-line explanation around an otherwise valid
  // object. Keep the recovery deliberately narrow: only the first `{` through
  // the last `}` is considered, and the schema remains the final authority.
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1).trim());
  }

  return [...new Set(candidates.filter(Boolean))];
}
