import type { AuditIssue } from "../agents/continuity.js";
import type {
  ValidationResult,
  ValidationWarning,
} from "../agents/state-validator.js";
import type { StateValidatorAgent } from "../agents/state-validator.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import type { WriterAgent } from "../agents/writer.js";
import type { Logger } from "../utils/logger.js";
import type { BookConfig } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import type { ScaffoldLanguage, WritingLanguage } from "../models/writing-language.js";
import { WritingLanguagePreflightError } from "../state/writing-language-preflight.js";
import { resolveWritingLanguageProfile } from "../utils/language.js";
import {
  stateDegradedDescription,
  stateDegradedSuggestion,
} from "../utils/writing-surface.js";

export interface SettlementRetryParams {
  readonly writer: Pick<WriterAgent, "settleChapterState">;
  readonly validator: Pick<StateValidatorAgent, "validate">;
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly baselineChapter?: number;
  readonly allowNewHooks?: boolean;
  readonly title: string;
  readonly content: string;
  readonly reducedControlInput?: {
    chapterIntent: string;
    contextPackage: ContextPackage;
    ruleStack: RuleStack;
  };
  readonly oldState: string;
  readonly oldHooks: string;
  readonly originalValidation: ValidationResult;
  readonly language: ScaffoldLanguage;
  readonly logWarn?: (message: { zh: string; en: string }) => void;
  readonly logger?: Pick<Logger, "warn">;
}

export type SettlementRetryResult =
  | {
    readonly kind: "recovered";
    readonly output: WriteChapterOutput;
    readonly validation: ValidationResult;
  }
  | {
    readonly kind: "degraded";
    readonly issues: ReadonlyArray<AuditIssue>;
  };

export async function retrySettlementAfterValidationFailure(
  params: SettlementRetryParams,
): Promise<SettlementRetryResult> {
  const writingLanguage = params.book.language ?? params.language;
  const scaffoldLanguage = resolveWritingLanguageProfile(writingLanguage).scaffoldLanguage;
  params.logWarn?.({
    zh: `状态校验失败，正在仅重试结算层（第${params.chapterNumber}章）`,
    en: `State validation failed; retrying settlement only for chapter ${params.chapterNumber}`,
  });

  const retryOutput = await params.writer.settleChapterState({
    book: params.book,
    bookDir: params.bookDir,
    chapterNumber: params.chapterNumber,
    title: params.title,
    content: params.content,
    allowReapply: true,
    baselineChapter: params.baselineChapter,
    allowNewHooks: params.allowNewHooks,
    chapterIntent: params.reducedControlInput?.chapterIntent,
    contextPackage: params.reducedControlInput?.contextPackage,
    ruleStack: params.reducedControlInput?.ruleStack,
    validationFeedback: buildStateValidationFeedback(
      params.originalValidation.warnings,
      scaffoldLanguage,
    ),
  });

  if (
    writingLanguage === "vi"
    && (!retryOutput.runtimeStateDelta || !retryOutput.runtimeStateSnapshot)
  ) {
    throw new WritingLanguagePreflightError(
      "STATE_PREFLIGHT_FAILED",
      "Vietnamese chapter recovery requires an explicit runtime state delta and snapshot.",
    );
  }

  let retryValidation: ValidationResult;
  try {
    retryValidation = await params.validator.validate(
      params.content,
      params.chapterNumber,
      params.oldState,
      retryOutput.updatedState,
      params.oldHooks,
      retryOutput.updatedHooks,
      scaffoldLanguage,
    );
  } catch (error) {
    throw new Error(`State validation retry failed for chapter ${params.chapterNumber}: ${String(error)}`);
  }

  if (retryValidation.warnings.length > 0) {
    params.logWarn?.({
      zh: `状态校验重试后，第${params.chapterNumber}章仍有 ${retryValidation.warnings.length} 条警告`,
      en: `State validation retry still reports ${retryValidation.warnings.length} warning(s) for chapter ${params.chapterNumber}`,
    });
    for (const warning of retryValidation.warnings) {
      params.logger?.warn(`  [${warning.category}] ${warning.description}`);
    }
  }

  if (retryValidation.passed && !retryValidation.repairRequired) {
    return {
      kind: "recovered",
      output: retryOutput,
      validation: retryValidation,
    };
  }

  return {
    kind: "degraded",
    issues: buildStateDegradedIssues(retryValidation.warnings, writingLanguage),
  };
}

export function buildStateValidationFeedback(
  warnings: ReadonlyArray<ValidationWarning>,
  language: ScaffoldLanguage,
): string {
  if (warnings.length === 0) {
    return language === "en"
      ? "The previous settlement contradicted the chapter text. Reconcile truth files strictly to the body."
      : "上一次状态结算与正文矛盾。请严格以正文为准修正 truth files。";
  }

  if (language === "en") {
    return [
      "The previous settlement failed validation. Fix these contradictions against the chapter body:",
      ...warnings.map((warning) => `- [${warning.category}] ${warning.description}`),
    ].join("\n");
  }

  return [
    "上一次状态结算未通过校验。请对照正文修正以下矛盾：",
    ...warnings.map((warning) => `- [${warning.category}] ${warning.description}`),
  ].join("\n");
}

export function buildStateDegradedIssues(
  warnings: ReadonlyArray<ValidationWarning>,
  language: WritingLanguage,
): ReadonlyArray<AuditIssue> {
  if (warnings.length > 0) {
    return warnings.map((warning) => ({
      severity: "warning" as const,
      category: "state-validation",
      description: warning.description,
      suggestion: stateDegradedSuggestion(language),
    }));
  }

  return [{
    severity: "warning",
    category: "state-validation",
    description: stateDegradedDescription(language),
    suggestion: stateDegradedSuggestion(language),
  }];
}

export function buildStateDegradedPersistenceOutput(params: {
  readonly output: WriteChapterOutput;
  readonly oldState: string;
  readonly oldHooks: string;
  readonly oldLedger: string;
}): WriteChapterOutput {
  return {
    ...params.output,
    runtimeStateDelta: undefined,
    runtimeStateSnapshot: undefined,
    updatedState: params.oldState,
    updatedLedger: params.oldLedger,
    updatedHooks: params.oldHooks,
    updatedChapterSummaries: undefined,
  };
}

export interface StateDegradedReviewNote {
  readonly kind: "state-degraded";
  readonly baseStatus: "ready-for-review" | "audit-failed";
  readonly injectedIssues: ReadonlyArray<string>;
}

export function buildStateDegradedReviewNote(
  baseStatus: "ready-for-review" | "audit-failed",
  issues: ReadonlyArray<AuditIssue>,
): string {
  return JSON.stringify({
    kind: "state-degraded",
    baseStatus,
    injectedIssues: issues.map((issue) => `[${issue.severity}] ${issue.description}`),
  } satisfies StateDegradedReviewNote);
}

export function parseStateDegradedReviewNote(
  reviewNote?: string,
): StateDegradedReviewNote | null {
  if (!reviewNote) {
    return null;
  }

  try {
    const parsed = JSON.parse(reviewNote) as {
      kind?: unknown;
      baseStatus?: unknown;
      injectedIssues?: unknown;
    };
    if (
      parsed.kind !== "state-degraded"
      || (parsed.baseStatus !== "ready-for-review" && parsed.baseStatus !== "audit-failed")
      || !Array.isArray(parsed.injectedIssues)
    ) {
      return null;
    }

    return {
      kind: "state-degraded",
      baseStatus: parsed.baseStatus,
      injectedIssues: parsed.injectedIssues.filter((issue): issue is string => typeof issue === "string"),
    };
  } catch {
    return null;
  }
}

export function resolveStateDegradedBaseStatus(
  chapter: Pick<ChapterMeta, "reviewNote" | "auditIssues">,
): "ready-for-review" | "audit-failed" {
  const metadata = parseStateDegradedReviewNote(chapter.reviewNote);
  if (metadata) {
    return metadata.baseStatus;
  }

  return chapter.auditIssues.some((issue) => issue.startsWith("[critical]"))
    ? "audit-failed"
    : "ready-for-review";
}
