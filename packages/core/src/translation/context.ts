export interface BatchContext {
  readonly contextBefore: string;
  readonly contextAfter: string;
  readonly previousTargetTail: string;
}

export interface BuildBatchContextOptions {
  readonly beforeChars?: number;
  readonly afterChars?: number;
  readonly tailChars?: number;
}

const DEFAULT_BEFORE_CHARS = 600;
const DEFAULT_AFTER_CHARS = 400;
const DEFAULT_TAIL_CHARS = 120;

// Builds inter-batch context for a translation call: adjacent source text is
// labelled "understanding only, do not translate"; the previous target tail
// lets the model continue the translated voice of the chapter.
export function buildBatchContext(
  sourceSegments: ReadonlyArray<{ readonly index: number; readonly source: string }>,
  translatedByIndex: ReadonlyMap<number, string>,
  batch: ReadonlyArray<{ readonly index: number; readonly source: string }>,
  options: BuildBatchContextOptions = {},
): BatchContext {
  const beforeChars = options.beforeChars ?? DEFAULT_BEFORE_CHARS;
  const afterChars = options.afterChars ?? DEFAULT_AFTER_CHARS;
  const tailChars = options.tailChars ?? DEFAULT_TAIL_CHARS;
  if (batch.length === 0) {
    return { contextBefore: "", contextAfter: "", previousTargetTail: "" };
  }

  const ordered = [...batch].sort((a, b) => a.index - b.index);
  const firstIndex = ordered[0]!.index;
  const lastIndex = ordered.at(-1)!.index;

  const beforeSegment = sourceSegments.find((segment) => segment.index === firstIndex - 1);
  const afterSegment = sourceSegments.find((segment) => segment.index === lastIndex + 1);
  const previousTarget = translatedByIndex.get(firstIndex - 1);

  return {
    contextBefore: beforeSegment ? tail(beforeSegment.source, beforeChars) : "",
    contextAfter: afterSegment ? head(afterSegment.source, afterChars) : "",
    previousTargetTail: previousTarget ? tail(previousTarget, tailChars) : "",
  };
}

function tail(text: string, maxChars: number): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(trimmed.length - maxChars);
}

function head(text: string, maxChars: number): string {
  const trimmed = text.trimStart();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars);
}
