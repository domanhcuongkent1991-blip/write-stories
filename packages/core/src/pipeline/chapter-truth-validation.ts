import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { StateValidationAuthorityContext, ValidationResult, StateValidatorAgent } from "../agents/state-validator.js";
import type { WriteChapterOutput, WriterAgent } from "../agents/writer.js";
import type { BookConfig } from "../models/book.js";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import type { HookOps } from "../models/runtime-state.js";
import type { Logger } from "../utils/logger.js";
import type { ScaffoldLanguage } from "../models/writing-language.js";
import { computeChapterContentHash } from "../audit/chapter-audit-evaluator.js";
import { validateExpectedHookOps } from "../utils/hook-intent-validator.js";
import {
  buildStateDegradedIssues,
  buildStateDegradedPersistenceOutput,
  retrySettlementAfterValidationFailure,
} from "./chapter-state-recovery.js";

export async function validateChapterTruthPersistence(params: {
  readonly writer: Pick<WriterAgent, "settleChapterState">;
  readonly validator: Pick<StateValidatorAgent, "validate">;
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly persistenceOutput: WriteChapterOutput;
  readonly auditResult: AuditResult;
  readonly previousTruth: {
    readonly oldState: string;
    readonly oldHooks: string;
    readonly oldLedger: string;
  };
  readonly authorityContext?: StateValidationAuthorityContext;
  readonly expectedHookOps?: HookOps;
  readonly acceptanceCriteria?: ReadonlyArray<string>;
  readonly normalizeSettledOutput?: (
    output: WriteChapterOutput,
  ) => WriteChapterOutput | Promise<WriteChapterOutput>;
  readonly reducedControlInput?: {
    chapterIntent: string;
    contextPackage: ContextPackage;
    ruleStack: RuleStack;
  };
  readonly language: ScaffoldLanguage;
  readonly logWarn: (message: { zh: string; en: string }) => void;
  readonly logger?: Pick<Logger, "warn">;
}): Promise<{
  readonly validation: ValidationResult;
  readonly governedHookFindings: ReadonlyArray<AuditIssue>;
  readonly chapterStatus: "state-degraded" | null;
  readonly degradedIssues: ReadonlyArray<AuditIssue>;
  readonly persistenceOutput: WriteChapterOutput;
  readonly auditResult: AuditResult;
}> {
  let validation: ValidationResult;
  let chapterStatus: "state-degraded" | null = null;
  let degradedIssues: ReadonlyArray<AuditIssue> = [];
  let persistenceOutput = params.persistenceOutput;
  let auditResult = params.auditResult;
  let governedHookFindings = governedHookContradictions(params, persistenceOutput);

  try {
    validation = await params.validator.validate(
      params.content,
      params.chapterNumber,
      params.previousTruth.oldState,
      persistenceOutput.updatedState,
      params.previousTruth.oldHooks,
      persistenceOutput.updatedHooks,
      params.language,
      params.authorityContext,
    );
  } catch (error) {
    params.logger?.warn(`State validation error for chapter ${params.chapterNumber}: ${String(error)}`);
    const errorDescription = params.language === "en"
      ? `State validation unavailable: ${String(error)}`
      : `状态校验不可用：${String(error)}`;
    const errorIssue: AuditIssue = {
      severity: "warning",
      category: "state-validation",
      description: errorDescription,
      suggestion: params.language === "en"
        ? "Repair chapter state from the persisted body before continuing."
        : "请先基于已保存正文修复本章 state，再继续后续章节。",
    };
    return {
      validation: { passed: true, warnings: [] },
      governedHookFindings,
      chapterStatus: "state-degraded",
      degradedIssues: [errorIssue, ...governedHookFindings],
      persistenceOutput: buildStateDegradedPersistenceOutput({
        output: persistenceOutput,
        oldState: params.previousTruth.oldState,
        oldHooks: params.previousTruth.oldHooks,
        oldLedger: params.previousTruth.oldLedger,
      }),
      auditResult: {
        ...params.auditResult,
        issues: [...params.auditResult.issues, errorIssue, ...governedHookFindings],
      },
    };
  }

  if (validation.warnings.length > 0) {
    params.logWarn({
      zh: `状态校验：第${params.chapterNumber}章发现 ${validation.warnings.length} 条警告`,
      en: `State validation: ${validation.warnings.length} warning(s) for chapter ${params.chapterNumber}`,
    });
    for (const warning of validation.warnings) {
      params.logger?.warn(`  [${warning.category}] ${warning.description}`);
    }
  }

  validation = applyGovernedHookValidation(
    params,
    validation,
    persistenceOutput,
    governedHookFindings,
  );

  if (!validation.passed || validation.repairRequired) {
    const recovery = await retrySettlementAfterValidationFailure({
      writer: params.writer,
      validator: params.validator,
      book: params.book,
      bookDir: params.bookDir,
      chapterNumber: params.chapterNumber,
      title: params.title,
      content: params.content,
      reducedControlInput: params.reducedControlInput,
      oldState: params.previousTruth.oldState,
      oldHooks: params.previousTruth.oldHooks,
      originalValidation: validation,
      language: params.language,
      authorityContext: params.authorityContext,
      normalizeSettledOutput: params.normalizeSettledOutput,
      logWarn: params.logWarn,
      logger: params.logger,
    });

    if (recovery.kind === "recovered") {
      const recoveredHookContradictions = governedHookContradictions(
        params,
        recovery.output,
      );
      const recoveredValidation = applyGovernedHookValidation(
        params,
        recovery.validation,
        recovery.output,
        recoveredHookContradictions,
      );
      if (recoveredValidation.passed && !recoveredValidation.repairRequired) {
        persistenceOutput = recovery.output;
        validation = recoveredValidation;
        governedHookFindings = [];
      } else {
        governedHookFindings = recoveredHookContradictions;
        chapterStatus = "state-degraded";
        validation = recoveredValidation;
        degradedIssues = recoveredHookContradictions.length > 0
          ? recoveredHookContradictions
          : buildStateDegradedIssues(
            recoveredValidation.warnings,
            params.book.language ?? params.language,
          );
        persistenceOutput = buildStateDegradedPersistenceOutput({
          output: recovery.output,
          oldState: params.previousTruth.oldState,
          oldHooks: params.previousTruth.oldHooks,
          oldLedger: params.previousTruth.oldLedger,
        });
        auditResult = {
          ...auditResult,
          issues: [...auditResult.issues, ...degradedIssues],
        };
      }
    } else {
      chapterStatus = "state-degraded";
      degradedIssues = recovery.issues;
      persistenceOutput = buildStateDegradedPersistenceOutput({
        output: persistenceOutput,
        oldState: params.previousTruth.oldState,
        oldHooks: params.previousTruth.oldHooks,
        oldLedger: params.previousTruth.oldLedger,
      });
      auditResult = {
        ...auditResult,
        issues: [...auditResult.issues, ...recovery.issues],
      };
    }
  }

  return {
    validation,
    governedHookFindings,
    chapterStatus,
    degradedIssues,
    persistenceOutput,
    auditResult,
  };
}

function applyGovernedHookValidation(
  params: {
    readonly content: string;
    readonly expectedHookOps?: HookOps;
    readonly acceptanceCriteria?: ReadonlyArray<string>;
  },
  validation: ValidationResult,
  output: WriteChapterOutput,
  criticalContradictions = governedHookContradictions(params, output),
): ValidationResult {
  if (criticalContradictions.length === 0) return validation;

  return {
    passed: false,
    repairRequired: true,
    warnings: [
      ...validation.warnings,
      ...criticalContradictions.map((issue) => ({
        category: issue.category,
        description: issue.description,
      })),
    ],
  };
}

function governedHookContradictions(
  params: {
    readonly content: string;
    readonly expectedHookOps?: HookOps;
    readonly acceptanceCriteria?: ReadonlyArray<string>;
  },
  output: WriteChapterOutput,
): ReadonlyArray<AuditIssue> {
  if (!params.expectedHookOps) return [];
  return validateExpectedHookOps({
    expected: params.expectedHookOps,
    actual: output.runtimeStateDelta?.hookOps
      ?? { upsert: [], mention: [], resolve: [], defer: [] },
    runtimeHooks: output.runtimeStateSnapshot?.hooks.hooks ?? [],
    acceptanceCriteria: params.acceptanceCriteria ?? [],
    contentHash: computeChapterContentHash(params.content),
  }).filter((issue) => issue.severity === "critical" && issue.verification === "verified");
}
