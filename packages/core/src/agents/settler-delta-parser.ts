import {
  RuntimeStateDeltaSchema,
  type RuntimeStateDelta,
} from "../models/runtime-state.js";
import { resolveHookStatusAlias } from "../utils/hook-lifecycle.js";

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
      runtimeStateDelta: RuntimeStateDeltaSchema.parse(
        normalizeHookStatusAliases(coerceRuntimeStateDelta(parsed)),
      ),
    };
  } catch (error) {
    throw new SettlerDeltaParseError(
      "schema-invalid",
      `runtime state delta failed schema validation: ${String(error)}`,
    );
  }
}

/**
 * Models repeatedly produce settlements whose content is right but whose
 * shape drifts from the schema in a few predictable ways (numeric chapter as
 * a string, hook-op arrays whose elements are objects carrying a hookId,
 * new-hook candidates as plain strings). Coerce those known drifts before
 * schema validation so an otherwise-correct candidate is not thrown away;
 * anything not recognized here still fails closed.
 */
function coerceRuntimeStateDelta(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const root = { ...(value as Record<string, unknown>) };

  if (typeof root.chapter === "string" && /^\d+$/u.test(root.chapter.trim())) {
    root.chapter = Number.parseInt(root.chapter.trim(), 10);
  }

  if (root.hookOps && typeof root.hookOps === "object" && !Array.isArray(root.hookOps)) {
    const hookOps = { ...(root.hookOps as Record<string, unknown>) };
    for (const key of ["mention", "resolve", "defer"] as const) {
      const list = hookOps[key];
      if (!Array.isArray(list)) continue;
      const coerced = list.map((entry) => {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const hookId = (entry as Record<string, unknown>).hookId;
          if (typeof hookId === "string" && hookId.trim().length > 0) return hookId.trim();
        }
        return entry;
      });
      if (JSON.stringify(coerced) !== JSON.stringify(list)) hookOps[key] = coerced;
    }
    root.hookOps = hookOps;
  }

  if (Array.isArray(root.newHookCandidates)) {
    root.newHookCandidates = root.newHookCandidates.map((entry) => {
      if (typeof entry === "string" && entry.trim().length > 0) {
        return { type: entry.trim() };
      }
      return entry;
    });
  }

  return root;
}

/**
 * Models sometimes use narrative hook-status aliases (for example,
 * "pressured" or "near_payoff") even though the persisted runtime schema
 * uses the canonical status "progressing". Normalize only aliases already
 * recognized by the hook lifecycle module; unknown values remain untouched so
 * schema validation still fails closed.
 */
function normalizeHookStatusAliases(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const root = value as Record<string, unknown>;
  const hookOps = root.hookOps;
  if (!hookOps || typeof hookOps !== "object" || Array.isArray(hookOps)) return value;

  const upsert = (hookOps as Record<string, unknown>).upsert;
  if (!Array.isArray(upsert)) return value;

  let changed = false;
  const normalizedUpsert = upsert.map((hook) => {
    if (!hook || typeof hook !== "object" || Array.isArray(hook)) return hook;

    const record = hook as Record<string, unknown>;
    if (typeof record.status !== "string") return hook;

    const normalized = resolveHookStatusAlias(record.status);
    if (!normalized || normalized === record.status) return hook;

    changed = true;
    return { ...record, status: normalized };
  });

  if (!changed) return value;
  return {
    ...root,
    hookOps: {
      ...(hookOps as Record<string, unknown>),
      upsert: normalizedUpsert,
    },
  };
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
