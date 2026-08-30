import type { AuditIssue } from "../agents/continuity.js";
import type { HookOps, HookRecord } from "../models/runtime-state.js";

type HookAction = "upsert" | "mention" | "resolve" | "defer";

interface ExpectedHookAction {
  readonly hookId: string;
  readonly action: HookAction;
  readonly record?: HookRecord;
}

export function validateExpectedHookOps(input: {
  readonly expected: HookOps;
  readonly actual: HookOps;
  readonly runtimeHooks: ReadonlyArray<HookRecord>;
  readonly acceptanceCriteria: ReadonlyArray<string>;
  readonly contentHash: string;
}): ReadonlyArray<AuditIssue> {
  const actualActions = indexActualActions(input.actual);
  const runtimeById = new Map(input.runtimeHooks.map((hook) => [hook.hookId, hook]));
  const findings: AuditIssue[] = [];

  for (const expected of flattenExpectedActions(input.expected)) {
    const actual = actualActions.get(expected.hookId) ?? new Set<HookAction>();
    const runtimeHook = runtimeById.get(expected.hookId);
    const contradiction = contradictoryAction(expected, actual, runtimeHook);
    const acceptanceCriteria = relevantAcceptanceCriteria(
      input.acceptanceCriteria,
      expected.hookId,
    );
    if (contradiction) {
      findings.push({
        severity: "critical",
        category: "hook-runtime-contradiction",
        description: `Expected hook ${expected.hookId} to ${expected.action}, but runtime evidence records ${contradiction}.`,
        suggestion: `Settle hook ${expected.hookId} to the planned ${expected.action} action or update the chapter intent before accepting the chapter.`,
        ruleId: "hook.expected-operation",
        source: "state",
        verification: "verified",
        evidence: {
          contentHash: input.contentHash,
          stateRef: `runtime:hook:${expected.hookId}`,
          excerpt: `expected=${expected.action}; actual=${contradiction}`,
        },
        ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
        repairTarget: "runtime-state",
        lifecycle: "open",
      });
      continue;
    }
    if (operationSatisfied(expected, actual, runtimeHook)) continue;

    findings.push({
      severity: "warning",
      category: "hook-runtime-evidence-missing",
      description: `Expected hook ${expected.hookId} to ${expected.action}, but the typed runtime delta does not confirm that action.`,
      suggestion: `Review the settled runtime delta for hook ${expected.hookId}; add the planned action only when the chapter supports it.`,
      ruleId: "hook.expected-operation",
      source: "deterministic",
      verification: "unverified",
      evidence: { contentHash: input.contentHash },
      ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
      repairTarget: "runtime-state",
      lifecycle: "open",
    });
  }

  return findings;
}

function flattenExpectedActions(expected: HookOps): ExpectedHookAction[] {
  return [
    ...expected.upsert.map((record) => ({ hookId: record.hookId, action: "upsert" as const, record })),
    ...expected.mention.map((hookId) => ({ hookId, action: "mention" as const })),
    ...expected.resolve.map((hookId) => ({ hookId, action: "resolve" as const })),
    ...expected.defer.map((hookId) => ({ hookId, action: "defer" as const })),
  ];
}

function indexActualActions(actual: HookOps): Map<string, Set<HookAction>> {
  const result = new Map<string, Set<HookAction>>();
  const add = (hookId: string, action: HookAction) => {
    const actions = result.get(hookId) ?? new Set<HookAction>();
    actions.add(action);
    result.set(hookId, actions);
  };
  for (const record of actual.upsert) add(record.hookId, "upsert");
  for (const hookId of actual.mention) add(hookId, "mention");
  for (const hookId of actual.resolve) add(hookId, "resolve");
  for (const hookId of actual.defer) add(hookId, "defer");
  return result;
}

function operationSatisfied(
  expected: ExpectedHookAction,
  actual: ReadonlySet<HookAction>,
  runtimeHook?: HookRecord,
): boolean {
  if (expected.action === "mention") {
    return actual.has("mention") || actual.has("resolve") || actual.has("upsert");
  }
  if (expected.action === "resolve") {
    return actual.has("resolve") || runtimeHook?.status === "resolved";
  }
  if (expected.action === "defer") {
    return actual.has("defer") || runtimeHook?.status === "deferred";
  }
  const actualUpsert = actual.has("upsert");
  return actualUpsert && (
    expected.record === undefined
    || runtimeHook === undefined
    || runtimeHook.status === expected.record.status
  );
}

function contradictoryAction(
  expected: ExpectedHookAction,
  actual: ReadonlySet<HookAction>,
  runtimeHook?: HookRecord,
): string | undefined {
  if (expected.action === "resolve" && (actual.has("defer") || runtimeHook?.status === "deferred")) {
    return "defer";
  }
  if (expected.action === "defer" && (actual.has("resolve") || runtimeHook?.status === "resolved")) {
    return "resolve";
  }
  if (expected.action === "mention" && actual.has("defer")) {
    return "defer";
  }
  if (expected.action === "upsert" && expected.record && runtimeHook && runtimeHook.status !== expected.record.status) {
    return `upsert:${runtimeHook.status}`;
  }
  return undefined;
}

function relevantAcceptanceCriteria(
  criteria: ReadonlyArray<string>,
  hookId: string,
): string[] {
  const normalizedId = hookId.toLocaleLowerCase();
  return criteria.filter((criterion) => criterion.toLocaleLowerCase().includes(normalizedId));
}
