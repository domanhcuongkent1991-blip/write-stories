import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BaseAgent } from "./base.js";
import type { BookConfig } from "../models/book.js";
import type { LengthSpec } from "../models/length-governance.js";
import type { ScaffoldLanguage, WritingLanguage } from "../models/writing-language.js";
import { buildLengthSpec } from "../utils/length-metrics.js";
import {
  acceptanceCriteriaFromHookContractV2,
  bindExpectedHookOperationsV2,
  hookOpsFromLedger,
  parseHookLedger,
  removeHookResolveCommitments,
} from "../utils/hook-ledger-validator.js";
import { resolveWritingLanguageProfile } from "../utils/language.js";
import { readBookRules as readAuthoritativeBookRules } from "./rules-reader.js";
import {
  ChapterIntentSchema,
  PacingCodeSchema,
  type ChapterIntent,
  type ChapterMemo,
  type TokenUsage,
} from "../models/input-governance.js";
import {
  renderHookSnapshot,
  renderSummarySnapshot,
} from "../utils/memory-retrieval.js";
import {
  gatherPlanningMaterials,
  loadPlanningSeedMaterials,
} from "../utils/planning-materials.js";
import { parseMemo, PlannerParseError } from "../utils/chapter-memo-parser.js";
import {
  buildPlannerUserMessage,
  getPlannerMemoSystemPrompt,
} from "./planner-prompts.js";
import {
  composeCurrentArcProse,
  extractCollaboratorRows,
  extractOpponentRows,
  extractProtagonistRow,
  formatRelevantThreads,
  formatRecentSummaries,
  formatRecyclableHooks,
  readBookRules,
  readCharacterMatrix,
  readEmotionalArcs,
  readSubplotBoard,
} from "./planner-context.js";
import type { StoredHook } from "../state/memory-db.js";
import {
  HookResolvePreflightAgent,
  HookResolvePreflightError,
  type HookResolvePreflightOutput,
  type HookResolvePreflightResult,
} from "./hook-resolve-preflight.js";
import type { HookOperationIntentV2 } from "../models/hook-operation-intent.js";

export interface PlanChapterInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly externalContext?: string;
  /** Preview callers may keep intent and search projections in memory only. */
  readonly persistRuntimeArtifacts?: boolean;
}

export interface PlanChapterOutput {
  readonly intent: ChapterIntent;
  readonly memo: ChapterMemo;
  readonly intentMarkdown: string;
  readonly plannerInputs: ReadonlyArray<string>;
  readonly runtimePath: string;
  readonly tokenUsage?: TokenUsage;
}

const MEMO_RETRY_LIMIT = 2;
const MEMO_TEMPERATURE = 0.2;

interface MemoGenerationPolicy {
  readonly parseAttemptLimit: number;
  readonly allowFallback: boolean;
  readonly semanticCorrectionFeedback?: string;
}

function addTokenUsage(left?: TokenUsage, right?: TokenUsage): TokenUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function buildSemanticCorrectionFeedback(
  contract: HookOperationIntentV2,
  preflight: HookResolvePreflightOutput,
): string {
  const operations = new Map(contract.operations.map((operation) => [operation.hookId, operation] as const));
  const failures = preflight.results.filter((result): result is Extract<HookResolvePreflightResult, { decision: "repair-required" }> =>
    result.decision === "repair-required");
  return failures.map((failure) => {
    const operation = operations.get(failure.hookId);
    return [
      `Hook ID: ${failure.hookId}`,
      `Canonical expected payoff: ${operation?.canonicalExpectedPayoff ?? "(missing canonical payoff)"}`,
      `Failure code: ${failure.code}`,
      `Failure: ${failure.description}`,
      "Correct the ledger once: remove this resolve or replace it only with a hook whose canonical payoff the planned evidence explicitly satisfies. Do not invent the payoff.",
    ].join("\n");
  }).join("\n\n");
}

/**
 * Phase 3 planner.
 *
 * Produces:
 *   - a simplified ChapterIntent (goal + outline + keep/avoid/style) —
 *     still deterministic, used for retrieval hints and the intent markdown.
 *   - a full ChapterMemo (plain markdown sections) via LLM call + strict
 *     parser.
 *
 * Retry policy: up to 2 attempts. Each failed parse appends an error
 * feedback block to the user message and re-invokes the LLM. If all attempts
 * fail, the planner emits a degraded but valid memo with an explicit warning
 * instead of crashing the whole chapter pipeline.
 */
export class PlannerAgent extends BaseAgent {
  get name(): string {
    return "planner";
  }

  async planChapter(input: PlanChapterInput): Promise<PlanChapterOutput> {
    const storyDir = join(input.bookDir, "story");
    const runtimeDir = join(storyDir, "runtime");
    if (input.persistRuntimeArtifacts !== false) {
      await mkdir(runtimeDir, { recursive: true });
    }

    const seedMaterials = await loadPlanningSeedMaterials({
      bookDir: input.bookDir,
      chapterNumber: input.chapterNumber,
    });
    const outlineNode = this.findOutlineNode(seedMaterials.volumeOutline, input.chapterNumber);
    const goal = this.deriveGoal(
      input.externalContext,
      seedMaterials.currentFocus,
      seedMaterials.authorIntent,
      outlineNode,
      input.chapterNumber,
    );
    // Phase hotfix 5: read structured rules through the Phase 5 authoritative
    // loader. It prefers outline/story_frame.md frontmatter, falls back to
    // legacy book_rules.md, and refuses to silently zero out rules when the
    // legacy file is just a compat shim. Reading raw bookRulesRaw via
    // parseBookRules() bypassed all of that.
    const parsedRules = await readAuthoritativeBookRules(input.bookDir);
    const prohibitions = parsedRules?.rules.prohibitions ?? [];
    const mustKeep = this.collectMustKeep(seedMaterials.currentState, seedMaterials.storyBible);
    const mustAvoid = this.collectMustAvoid(seedMaterials.currentFocus, prohibitions);
    const styleEmphasis = this.collectStyleEmphasis(seedMaterials.authorIntent, seedMaterials.currentFocus);
    const materials = await gatherPlanningMaterials({
      bookDir: input.bookDir,
      chapterNumber: input.chapterNumber,
      goal,
      outlineNode,
      mustKeep,
      seed: seedMaterials,
      persistProjections: input.persistRuntimeArtifacts,
    });
    const memorySelection = materials.memorySelection;
    // The memo may reference any authoritative hook that retrieval explicitly
    // exposed to it, including a dormant architect seed selected for this
    // chapter. Active hooks alone are too narrow and make a visible valid ID
    // fail governance as "unknown".
    const authoritativeMemoHooks = [...new Map([
      ...memorySelection.activeHooks,
      ...memorySelection.hooks,
    ].map((hook) => [hook.hookId, hook] as const)).values()];
    const activeHookCount = memorySelection.activeHooks.filter(
      (hook) => hook.status !== "resolved" && hook.status !== "deferred",
    ).length;
    const writingLanguage = input.book.language ?? "zh";
    const scaffoldLanguage = resolveWritingLanguageProfile(
      writingLanguage,
    ).scaffoldLanguage;

    const arcContext = this.buildArcContext(
      scaffoldLanguage,
      seedMaterials.volumeOutline,
      outlineNode,
    );

    const intent = ChapterIntentSchema.parse({
      chapter: input.chapterNumber,
      goal,
      outlineNode,
      arcContext,
      mustKeep,
      mustAvoid,
      styleEmphasis,
    });

    const isGoldenOpening = this.isGoldenOpeningChapter(writingLanguage, input.chapterNumber);
    const lengthSpec = buildLengthSpec(
      input.book.chapterWordCount,
      writingLanguage,
    );
    const memoInput = {
      storyDir,
      bookDir: input.bookDir,
      chapterNumber: input.chapterNumber,
      isGoldenOpening,
      fallbackGoal: goal,
      chapterSummariesRaw: seedMaterials.chapterSummariesRaw,
      previousEndingExcerpt: seedMaterials.previousEndingExcerpt,
      brief: seedMaterials.brief,
      chapterContext: input.externalContext,
      relevantHooks: memorySelection.hooks,
      recyclableHooks: memorySelection.recyclableHooks,
      authoritativeActiveHooks: authoritativeMemoHooks,
      // Phase hotfix 4: thread book language through so the planner uses
      // English prompts (system + user template + golden opening guidance)
      // for English books instead of always-Chinese.
      language: scaffoldLanguage,
      includeAllowedHookActions: writingLanguage === "vi",
      lengthSpec,
    } as const;
    let memoResult = await this.planChapterMemoWithUsage(memoInput);
    let memo = memoResult.memo;
    let expectedHookContract = bindExpectedHookOperationsV2(memo.body, {
      activeHooks: authoritativeMemoHooks,
      chapterNumber: input.chapterNumber,
    });

    if (writingLanguage === "vi" && expectedHookContract.operations.some((operation) => operation.action === "resolve")) {
      const preflight = new HookResolvePreflightAgent(this.ctx);
      const firstPreflight = await preflight.validate({
        contract: expectedHookContract,
        chapterGoal: memo.goal,
        relevantMemoBeat: memo.body,
      });
      memoResult = {
        ...memoResult,
        tokenUsage: addTokenUsage(memoResult.tokenUsage, firstPreflight.tokenUsage),
      };
      const firstFailure = firstPreflight.results.find((result) => result.decision !== "pass");
      if (firstFailure?.decision === "inconclusive") {
        throw new HookResolvePreflightError(
          "INCONCLUSIVE_PROVIDER",
          `planner contract preflight inconclusive for ${firstFailure.hookId}: ${firstFailure.description}`,
        );
      }
      if (firstFailure?.decision === "repair-required") {
        const feedback = buildSemanticCorrectionFeedback(expectedHookContract, firstPreflight);
        let correctedMemoResult: { memo: ChapterMemo; tokenUsage?: TokenUsage };
        try {
          correctedMemoResult = await this.planChapterMemoWithUsage(memoInput, {
            parseAttemptLimit: 1,
            allowFallback: false,
            semanticCorrectionFeedback: feedback,
          });
        } catch (error) {
          throw new HookResolvePreflightError(
            "PLANNER_CONTRACT_INVALID",
            `semantic correction parse failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        memo = correctedMemoResult.memo;
        expectedHookContract = bindExpectedHookOperationsV2(memo.body, {
          activeHooks: authoritativeMemoHooks,
          chapterNumber: input.chapterNumber,
        });
        const secondPreflight = await preflight.validate({
          contract: expectedHookContract,
          chapterGoal: memo.goal,
          relevantMemoBeat: memo.body,
        });
        memoResult = {
          memo,
          tokenUsage: addTokenUsage(
            addTokenUsage(memoResult.tokenUsage, correctedMemoResult.tokenUsage),
            secondPreflight.tokenUsage,
          ),
        };
        const secondInconclusive = secondPreflight.results.find((result) => result.decision === "inconclusive");
        if (secondInconclusive) {
          throw new HookResolvePreflightError(
            "INCONCLUSIVE_PROVIDER",
            `planner contract preflight remained inconclusive for ${secondInconclusive.hookId}: ${secondInconclusive.description}`,
          );
        }
        const unsafeResolveIds = secondPreflight.results
          .filter((result) => result.decision === "repair-required")
          .map((result) => result.hookId);
        if (unsafeResolveIds.length > 0) {
          memo = {
            ...memo,
            body: removeHookResolveCommitments(memo.body, unsafeResolveIds),
          };
          expectedHookContract = bindExpectedHookOperationsV2(memo.body, {
            activeHooks: authoritativeMemoHooks,
            chapterNumber: input.chapterNumber,
          });
          const unsafeResolveStillPresent = expectedHookContract.operations.some((operation) =>
            operation.action === "resolve" && unsafeResolveIds.includes(operation.hookId));
          if (unsafeResolveStillPresent) {
            throw new HookResolvePreflightError(
              "PLANNER_CONTRACT_INVALID",
              "planner could not remove an unsafe hook resolve commitment after semantic correction",
            );
          }
          memoResult = { ...memoResult, memo };
          this.log?.warn(`[planner] removed unsafe hook resolve commitments after bounded semantic correction: ${unsafeResolveIds.join(", ")}`);
        }
      }
    }

    intent.expectedHookContract = expectedHookContract;
    intent.expectedHookOps = hookOpsFromLedger(memo.body, {
      activeHooks: authoritativeMemoHooks,
      chapterNumber: input.chapterNumber,
    });
    intent.acceptanceCriteria = acceptanceCriteriaFromHookContractV2(
      expectedHookContract,
      scaffoldLanguage,
    );
    intent.pacingCode = pacingCodeFromMemo(memo.body);

    // memo.goal is LLM-produced and specific (<=50 chars, validated).
    // Overwrite intent.goal so downstream composer/retrieval gets the
    // concrete task statement instead of the outline-derived fallback.
    intent.goal = memo.goal;

    const runtimePath = join(runtimeDir, `chapter-${String(input.chapterNumber).padStart(4, "0")}.intent.md`);
    const intentMarkdown = this.renderIntentMarkdown(
      intent,
      memo,
      scaffoldLanguage,
      renderHookSnapshot(memorySelection.hooks, scaffoldLanguage),
      renderSummarySnapshot(memorySelection.summaries, scaffoldLanguage),
      activeHookCount,
    );
    if (input.persistRuntimeArtifacts !== false) {
      await writeFile(runtimePath, intentMarkdown, "utf-8");
    }

    return {
      intent,
      memo,
      intentMarkdown,
      plannerInputs: materials.plannerInputs,
      runtimePath,
      ...(memoResult.tokenUsage ? { tokenUsage: memoResult.tokenUsage } : {}),
    };
  }

  /**
   * Invoke the LLM to produce a 7-section memo and parse it. Retries up to
   * 3 times on parse failure, injecting the error message back into the user
   * prompt so the LLM can correct itself.
   */
  async planChapterMemo(input: {
    readonly storyDir: string;
    readonly bookDir: string;
    readonly chapterNumber: number;
    readonly isGoldenOpening: boolean;
    readonly fallbackGoal: string;
    readonly chapterSummariesRaw: string;
    readonly previousEndingExcerpt?: string;
    readonly brief?: string;
    readonly chapterContext?: string;
    readonly relevantHooks?: ReadonlyArray<StoredHook>;
    readonly recyclableHooks?: ReadonlyArray<StoredHook>;
    readonly authoritativeActiveHooks?: ReadonlyArray<StoredHook>;
    readonly language?: ScaffoldLanguage;
    readonly includeAllowedHookActions?: boolean;
    readonly lengthSpec: LengthSpec;
  }): Promise<ChapterMemo> {
    const result = await this.planChapterMemoWithUsage(input);
    return result.memo;
  }

  private async planChapterMemoWithUsage(input: {
    readonly storyDir: string;
    readonly bookDir: string;
    readonly chapterNumber: number;
    readonly isGoldenOpening: boolean;
    readonly fallbackGoal: string;
    readonly chapterSummariesRaw: string;
    readonly previousEndingExcerpt?: string;
    readonly brief?: string;
    readonly chapterContext?: string;
    readonly relevantHooks?: ReadonlyArray<StoredHook>;
    readonly recyclableHooks?: ReadonlyArray<StoredHook>;
    readonly authoritativeActiveHooks?: ReadonlyArray<StoredHook>;
    readonly language?: ScaffoldLanguage;
    readonly includeAllowedHookActions?: boolean;
    readonly lengthSpec: LengthSpec;
  }, policy: MemoGenerationPolicy = {
    parseAttemptLimit: MEMO_RETRY_LIMIT,
    allowFallback: true,
  }): Promise<{ memo: ChapterMemo; tokenUsage?: TokenUsage }> {
    const [characterMatrix, subplotBoard, emotionalArcs, bookRulesRaw] = await Promise.all([
      readCharacterMatrix(input.storyDir),
      readSubplotBoard(input.storyDir),
      readEmotionalArcs(input.storyDir),
      readBookRules(input.storyDir),
    ]);

    const language = input.language ?? "zh";
    const noPriorChapter = language === "en"
      ? "(this is the opening chapter — no prior chapter)"
      : "（本章为起始章，无前章）";
    const noBookRules = language === "en"
      ? "(no book_rules entries)"
      : "（暂无 book_rules 条目）";
    const retryFeedbackHeader = language === "en"
      ? "## Error from previous output"
      : "## 上次输出的错误";
    const retryFeedbackTrailer = language === "en"
      ? "Fix and re-emit."
      : "请修正后重新输出。";

    const userMessage = buildPlannerUserMessage({
      chapterNumber: input.chapterNumber,
      previousChapterEndingExcerpt: input.previousEndingExcerpt?.trim()
        ? input.previousEndingExcerpt.trim()
        : noPriorChapter,
      recentSummaries: formatRecentSummaries(input.chapterSummariesRaw, input.chapterNumber, 3),
      currentArcProse: composeCurrentArcProse(subplotBoard, emotionalArcs, input.chapterNumber),
      protagonistMatrixRow: extractProtagonistRow(characterMatrix),
      opponentRows: extractOpponentRows(characterMatrix, 3),
      collaboratorRows: extractCollaboratorRows(characterMatrix, 3),
      relevantThreads: formatRelevantThreads(
        input.relevantHooks ?? [],
        subplotBoard,
        language,
        { includeAllowedActions: input.includeAllowedHookActions === true },
      ),
      recyclableHooks: formatRecyclableHooks(
        input.recyclableHooks ?? [],
        input.chapterNumber,
        language,
      ),
      isGoldenOpening: input.isGoldenOpening,
      bookRulesRelevant: bookRulesRaw.trim().length > 0 ? bookRulesRaw.trim() : noBookRules,
      lengthBudget: {
        target: input.lengthSpec.target,
        softMin: input.lengthSpec.softMin,
        softMax: input.lengthSpec.softMax,
        hardMin: input.lengthSpec.hardMin,
        hardMax: input.lengthSpec.hardMax,
        unit: input.lengthSpec.countingMode === "en_words"
          ? "words"
          : input.lengthSpec.countingMode === "vi_wordlike_tokens_v1"
            ? "từ"
            : "字",
      },
      brief: input.brief ?? "",
      chapterContext: input.chapterContext ?? "",
      language,
    });

    const systemPrompt = getPlannerMemoSystemPrompt(language);

    let currentUserMessage = policy.semanticCorrectionFeedback
      ? `${userMessage}\n\n## Governed hook-contract correction\n${policy.semanticCorrectionFeedback}`
      : userMessage;
    let lastError: PlannerParseError | undefined;
    let tokenUsage: TokenUsage | undefined;

    for (let attempt = 0; attempt < policy.parseAttemptLimit; attempt += 1) {
      const response = await this.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: currentUserMessage },
        ],
        { temperature: MEMO_TEMPERATURE },
      );
      if (response.usage) {
        tokenUsage = {
          promptTokens: (tokenUsage?.promptTokens ?? 0) + response.usage.promptTokens,
          completionTokens: (tokenUsage?.completionTokens ?? 0) + response.usage.completionTokens,
          totalTokens: (tokenUsage?.totalTokens ?? 0) + response.usage.totalTokens,
        };
      }

      try {
        const memo = parseMemo(response.content, input.chapterNumber, input.isGoldenOpening);
        assertFreshMemoGovernance(memo.body, input.authoritativeActiveHooks);
        return { memo, ...(tokenUsage ? { tokenUsage } : {}) };
      } catch (error) {
        if (!(error instanceof PlannerParseError)) {
          throw error;
        }
        lastError = error;
        this.log?.warn(`[planner] memo parse failed (attempt ${attempt + 1}/${policy.parseAttemptLimit}): ${error.message}`);
        currentUserMessage = `${userMessage}${policy.semanticCorrectionFeedback ? `\n\n## Governed hook-contract correction\n${policy.semanticCorrectionFeedback}` : ""}\n\n${retryFeedbackHeader}\n${error.message}\n${retryFeedbackTrailer}`;
      }
    }

    const fallbackError = lastError ?? new PlannerParseError("memo planner exhausted retries without a specific error");
    if (!policy.allowFallback) throw fallbackError;
    this.log?.warn(`[planner] memo planner fell back after ${policy.parseAttemptLimit} attempts: ${fallbackError.message}`);
    return { memo: parseMemo(
      this.buildFallbackMemoMarkdown({
        chapterNumber: input.chapterNumber,
        isGoldenOpening: input.isGoldenOpening,
        fallbackGoal: input.fallbackGoal,
        errorMessage: fallbackError.message,
        language,
        lengthSpec: input.lengthSpec,
      }),
      input.chapterNumber,
      input.isGoldenOpening,
    ), ...(tokenUsage ? { tokenUsage } : {}) };
  }

  private buildFallbackMemoMarkdown(input: {
    readonly chapterNumber: number;
    readonly isGoldenOpening: boolean;
    readonly fallbackGoal: string;
    readonly errorMessage: string;
    readonly language: ScaffoldLanguage;
    readonly lengthSpec: LengthSpec;
  }): string {
    const sceneOneBudget = Math.round(input.lengthSpec.target * 0.3);
    const sceneTwoBudget = Math.round(input.lengthSpec.target * 0.4);
    const sceneThreeBudget = Math.max(
      1,
      input.lengthSpec.target - sceneOneBudget - sceneTwoBudget,
    );
    if (input.language === "en") {
      return [
        `# Chapter ${input.chapterNumber} memo`,
        "",
        "## Chapter goal",
        input.fallbackGoal || `Continue chapter ${input.chapterNumber} according to the current outline`,
        "",
        "## Thread refs",
        "none",
        "",
        "## Scene and length budget",
        `Plan three concrete scenes whose combined draft length stays within ${input.lengthSpec.hardMin}-${input.lengthSpec.hardMax} words and aims for ${input.lengthSpec.target} words: Scene 1 (${sceneOneBudget} words) establishes the immediate action; Scene 2 (${sceneTwoBudget} words) forces a consequential choice; Scene 3 (${sceneThreeBudget} words) closes on a concrete change.`,
        "",
        "## Current task",
        `Use the current chapter goal and authoritative book context to continue chapter ${input.chapterNumber} without inventing a new direction.`,
        "",
        "## Pacing Code",
        "bridge",
        "",
        "## What the reader is waiting for right now",
        "Keep the reader's active expectation from the outline and previous chapter in focus; do not replace it with a generic scene.",
        "",
        "## To pay off / to keep buried",
        "Pay off only the near-term promises already supported by context; keep larger secrets buried unless the outline explicitly asks for them.",
        "",
        "## What the slow / transitional beats carry",
        "If a slower beat is needed, make it carry pressure, evidence, relationship movement, or a concrete setup for the next action.",
        "",
        "## Three-question check on the key choice",
        "The protagonist's main choice must have a reason, match current interest, and stay consistent with the established persona.",
        "",
        "## Required end-of-chapter change",
        "End with a concrete change in information, pressure, relationship, objective, or risk so the chapter is not only summary.",
        "",
        "## Hook ledger for this chapter",
        "advance: keep the active promise moving; resolve: only settle what has evidence; defer: preserve larger threads for later chapters.",
        "",
        "## Do not",
        "Do not contradict established facts, ignore the user's current instruction, or turn the fallback memo into a new outline.",
        "",
        "## Planner warning",
        `The model failed to produce a valid chapter memo after ${MEMO_RETRY_LIMIT} attempts. Last parser error: ${input.errorMessage}`,
      ].join("\n");
    }

    return [
      `# 第 ${input.chapterNumber} 章 memo`,
      "",
      "## 本章目标",
      input.fallbackGoal || `按当前大纲继续推进第 ${input.chapterNumber} 章`,
      "",
      "## 关联线索",
      "无",
      "",
      "## 场景与篇幅预算",
      `规划三个有明确行动与后果的真实场景，总篇幅控制在 ${input.lengthSpec.hardMin}-${input.lengthSpec.hardMax} 字，目标约 ${input.lengthSpec.target} 字：场景一（${sceneOneBudget} 字）建立眼前行动；场景二（${sceneTwoBudget} 字）迫使人物作出带后果的选择；场景三（${sceneThreeBudget} 字）以信息、压力、关系、目标或风险的明确变化收束。不靠总结和重复内心戏凑字数。`,
      "",
      "## 当前任务",
      `沿用当前章节目标和权威设定推进第 ${input.chapterNumber} 章，不临时改方向，也不把章节写成泛泛过渡。`,
      "",
      "## 节奏代码",
      "bridge",
      "",
      "## 读者此刻在等什么",
      "延续大纲和上一章形成的读者期待，优先回应当前已经建立的压力、证据、关系或目标变化。",
      "",
      "## 该兑现的 / 暂不掀的",
      "只兑现已有上下文支撑的近端承诺；更大的秘密、身份、幕后主使或终局信息，除非大纲明确要求，否则继续压住。",
      "",
      "## 日常/过渡承担什么任务",
      "如果需要日常或过渡，它必须承担压力、证据、人物关系、目标变化或下一步行动铺垫，不能只是闲聊和气氛。",
      "",
      "## 关键抉择过三连问",
      "主角本章的关键选择必须有原因、符合当前利益，并且不背离已经建立的人设和行为逻辑。",
      "",
      "## 章尾必须发生的改变",
      "章尾至少要在信息、压力、关系、目标或风险上发生一个明确变化，避免只有剧情摘要没有推进。",
      "",
      "## 本章 hook 账",
      "advance: 推进当前活跃承诺；resolve: 只结清已有证据支撑的线索；defer: 大线继续保留到更合适的位置。",
      "",
      "## 不要做",
      "不要违背既成事实，不要无视用户当前指令，不要把 fallback memo 当成新大纲重写整本书。",
      "",
      "## Planner warning",
      `模型连续 ${MEMO_RETRY_LIMIT} 次没有产出合格章节 memo。最后一次解析错误：${input.errorMessage}`,
    ].join("\n");
  }

  private isGoldenOpeningChapter(language: WritingLanguage | undefined, chapterNumber: number): boolean {
    // Vietnamese books use the same three-chapter opening discipline as the
    // Chinese policy. The scaffold language is English for VI, so deriving
    // this from ScaffoldLanguage would incorrectly widen the opening window
    // to five chapters.
    if (language === "vi" || language === "zh") return chapterNumber <= 3;
    return chapterNumber <= 5;
  }

  private buildArcContext(
    language: ScaffoldLanguage | undefined,
    volumeOutline: string,
    outlineNode: string | undefined,
  ): string | undefined {
    if (!outlineNode) return undefined;
    if (volumeOutline === "(文件尚未创建)") return undefined;
    return this.isChineseLanguage(language)
      ? `卷纲节点：${outlineNode}`
      : `Outline node: ${outlineNode}`;
  }

  private deriveGoal(
    externalContext: string | undefined,
    currentFocus: string,
    authorIntent: string,
    outlineNode: string | undefined,
    chapterNumber: number,
  ): string {
    const first = this.extractFirstDirective(externalContext);
    if (first) return first;
    const localOverride = this.extractLocalOverrideGoal(currentFocus);
    if (localOverride) return localOverride;
    const outline = this.extractFirstDirective(outlineNode);
    if (outline) return outline;
    const focus = this.extractFocusGoal(currentFocus);
    if (focus) return focus;
    const author = this.extractFirstDirective(authorIntent);
    if (author) return author;
    return `Advance chapter ${chapterNumber} with clear narrative focus.`;
  }

  private collectMustKeep(currentState: string, storyBible: string): string[] {
    return this.unique([
      ...this.extractListItems(currentState, 2),
      ...this.extractListItems(storyBible, 2),
    ]).slice(0, 4);
  }

  private collectMustAvoid(currentFocus: string, prohibitions: ReadonlyArray<string>): string[] {
    const avoidSection = this.extractSection(currentFocus, [
      "avoid",
      "must avoid",
      "禁止",
      "避免",
      "避雷",
    ]);
    const focusAvoids = avoidSection
      ? this.extractListItems(avoidSection, 10)
      : currentFocus
        .split("\n")
        .map((line) => line.trim())
        .filter((line) =>
          line.startsWith("-") &&
          /avoid|don't|do not|不要|别|禁止/i.test(line),
        )
        .map((line) => this.cleanListItem(line))
        .filter((line): line is string => Boolean(line));

    return this.unique([...focusAvoids, ...prohibitions]).slice(0, 6);
  }

  private collectStyleEmphasis(authorIntent: string, currentFocus: string): string[] {
    return this.unique([
      ...this.extractFocusStyleItems(currentFocus),
      ...this.extractListItems(authorIntent, 2),
    ]).slice(0, 4);
  }

  private extractFirstDirective(content?: string): string | undefined {
    if (!content) return undefined;
    return content
      .split("\n")
      .map((line) => line.trim())
      .find((line) =>
        line.length > 0
        && !line.startsWith("#")
        && !line.startsWith("-")
        && !this.isTemplatePlaceholder(line),
      );
  }

  private extractListItems(content: string, limit: number): string[] {
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("-"))
      .map((line) => this.cleanListItem(line))
      .filter((line): line is string => Boolean(line))
      .slice(0, limit);
  }

  private extractFocusGoal(currentFocus: string): string | undefined {
    const focusSection = this.extractSection(currentFocus, [
      "active focus",
      "focus",
      "当前聚焦",
      "当前焦点",
      "近期聚焦",
    ]) ?? currentFocus;
    const directives = this.extractFocusStyleItems(focusSection, 3);
    if (directives.length === 0) {
      return this.extractFirstDirective(focusSection);
    }
    return directives.join(this.containsChinese(focusSection) ? "；" : "; ");
  }

  private extractLocalOverrideGoal(currentFocus: string): string | undefined {
    const overrideSection = this.extractSection(currentFocus, [
      "local override",
      "explicit override",
      "chapter override",
      "local task override",
      "局部覆盖",
      "本章覆盖",
      "临时覆盖",
      "当前覆盖",
    ]);
    if (!overrideSection) {
      return undefined;
    }

    const directives = this.extractListItems(overrideSection, 3);
    if (directives.length > 0) {
      return directives.join(this.containsChinese(overrideSection) ? "；" : "; ");
    }

    return this.extractFirstDirective(overrideSection);
  }

  private extractFocusStyleItems(currentFocus: string, limit = 3): string[] {
    const focusSection = this.extractSection(currentFocus, [
      "active focus",
      "focus",
      "当前聚焦",
      "当前焦点",
      "近期聚焦",
    ]) ?? currentFocus;
    return this.extractListItems(focusSection, limit);
  }

  private renderHookBudget(activeCount: number, language: ScaffoldLanguage): string {
    const cap = 12;
    if (activeCount < 10) {
      return language === "en"
        ? `### Hook Budget\n- ${activeCount} active hooks (capacity: ${cap})`
        : `### 伏笔预算\n- 当前 ${activeCount} 条活跃伏笔（容量：${cap}）`;
    }
    const remaining = Math.max(0, cap - activeCount);
    return language === "en"
      ? `### Hook Budget\n- ${activeCount} active hooks — approaching capacity (${cap}). Only ${remaining} new hook(s) allowed. Prioritize resolving existing debt over opening new threads.`
      : `### 伏笔预算\n- 当前 ${activeCount} 条活跃伏笔——接近容量上限（${cap}）。仅剩 ${remaining} 个新坑位。优先回收旧债，不要轻易开新线。`;
  }

  private extractSection(content: string, headings: ReadonlyArray<string>): string | undefined {
    const targets = headings.map((heading) => this.normalizeHeading(heading));
    const lines = content.split("\n");
    let buffer: string[] | null = null;
    let sectionLevel = 0;

    for (const line of lines) {
      const headingMatch = line.match(/^(#+)\s*(.+?)\s*$/);
      if (headingMatch) {
        const level = headingMatch[1]!.length;
        const heading = this.normalizeHeading(headingMatch[2]!);

        if (buffer && level <= sectionLevel) {
          break;
        }

        if (targets.includes(heading)) {
          buffer = [];
          sectionLevel = level;
          continue;
        }
      }

      if (buffer) {
        buffer.push(line);
      }
    }

    const section = buffer?.join("\n").trim();
    return section && section.length > 0 ? section : undefined;
  }

  private normalizeHeading(heading: string): string {
    return heading
      .toLowerCase()
      .replace(/[*_`:#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private cleanListItem(line: string): string | undefined {
    const cleaned = line.replace(/^-\s*/, "").trim();
    if (cleaned.length === 0) return undefined;
    if (/^[-|]+$/.test(cleaned)) return undefined;
    if (this.isTemplatePlaceholder(cleaned)) return undefined;
    return cleaned;
  }

  private isTemplatePlaceholder(line: string): boolean {
    const normalized = line.trim();
    if (!normalized) return false;

    return (
      /^\((describe|briefly describe|write)\b[\s\S]*\)$/i.test(normalized)
      || /^（(?:在这里描述|描述|填写|写下)[\s\S]*）$/u.test(normalized)
    );
  }

  private containsChinese(content: string): boolean {
    return /[\u4e00-\u9fff]/.test(content);
  }

  private findOutlineNode(volumeOutline: string, chapterNumber: number): string | undefined {
    const lines = volumeOutline.split("\n").map((line) => line.trim()).filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const match = this.matchExactOutlineLine(line, chapterNumber);
      if (!match) continue;

      const inlineContent = this.cleanOutlineContent(match[1]);
      if (inlineContent) {
        return inlineContent;
      }

      const nextContent = this.findNextOutlineContent(lines, index + 1);
      if (nextContent) {
        return nextContent;
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const match = this.matchRangeOutlineLine(line, chapterNumber);
      if (!match) continue;

      const inlineContent = this.cleanOutlineContent(match[3]);
      if (inlineContent) {
        return inlineContent;
      }

      const rangeStart = Number(match[1]);
      const sectionContent = this.extractSectionAroundRange(lines, index);
      if (sectionContent) {
        const beatIndex = chapterNumber - rangeStart;
        const specificBeat = this.extractNumberedBeat(sectionContent, beatIndex);
        return specificBeat ?? sectionContent;
      }

      const nextContent = this.findNextOutlineContent(lines, index + 1);
      if (nextContent) {
        return nextContent;
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!this.isOutlineAnchorLine(line)) continue;

      const exactMatch = this.matchAnyExactOutlineLine(line);
      if (exactMatch) {
        const inlineContent = this.cleanOutlineContent(exactMatch[1]);
        if (inlineContent) {
          return inlineContent;
        }
      }

      const rangeMatch = this.matchAnyRangeOutlineLine(line);
      if (rangeMatch) {
        const inlineContent = this.cleanOutlineContent(rangeMatch[3]);
        if (inlineContent) {
          return inlineContent;
        }
      }

      const nextContent = this.findNextOutlineContent(lines, index + 1);
      if (nextContent) {
        return nextContent;
      }

      break;
    }

    return this.extractFirstDirective(volumeOutline);
  }

  private cleanOutlineContent(content?: string): string | undefined {
    const cleaned = content?.trim();
    if (!cleaned) return undefined;
    if (/^[*_`~:：-]+$/.test(cleaned)) return undefined;
    return cleaned;
  }

  private extractSectionAroundRange(lines: ReadonlyArray<string>, rangeLineIndex: number): string | undefined {
    let headingIndex = -1;
    for (let i = rangeLineIndex - 1; i >= 0; i--) {
      if (lines[i]!.startsWith("#")) {
        headingIndex = i;
        break;
      }
      if (this.matchAnyRangeOutlineLine(lines[i]!) || this.matchAnyExactOutlineLine(lines[i]!)) {
        break;
      }
    }

    if (headingIndex < 0) {
      return undefined;
    }

    const headingLine = lines[headingIndex]!;
    const headingLevel = headingLine.match(/^(#+)/)?.[1]?.length ?? 3;

    const sectionLines: string[] = [];
    for (let i = headingIndex; i < lines.length; i++) {
      if (i > headingIndex) {
        const nextHeadingMatch = lines[i]!.match(/^(#+)/);
        if (nextHeadingMatch && (nextHeadingMatch[1]?.length ?? 0) <= headingLevel) {
          break;
        }
      }
      sectionLines.push(lines[i]!);
    }

    const content = sectionLines.join("\n").trim();
    return content.length > 0 ? content : undefined;
  }

  private extractNumberedBeat(section: string, beatIndex: number): string | undefined {
    if (beatIndex < 0) return undefined;

    const beats: string[] = [];
    for (const line of section.split("\n")) {
      const trimmed = line.trim();
      if (/^\d+[.)]\s/.test(trimmed)) {
        beats.push(trimmed.replace(/^\d+[.)]\s*/, ""));
      }
    }

    if (beats.length === 0 || beatIndex >= beats.length) return undefined;
    return beats[beatIndex];
  }

  private findNextOutlineContent(lines: ReadonlyArray<string>, startIndex: number): string | undefined {
    for (let index = startIndex; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line) {
        continue;
      }

      if (this.isOutlineAnchorLine(line)) {
        return undefined;
      }

      if (line.startsWith("#")) {
        continue;
      }

      const cleaned = this.cleanOutlineContent(line);
      if (cleaned) {
        return cleaned;
      }
    }

    return undefined;
  }

  private matchExactOutlineLine(line: string, chapterNumber: number): RegExpMatchArray | undefined {
    const patterns = [
      new RegExp(`^(?:#+\\s*)?(?:[-*]\\s+)?(?:\\*\\*)?Chapter\\s*${chapterNumber}(?!\\d|\\s*[-~–—]\\s*\\d)(?:[:：-])?(?:\\*\\*)?\\s*(.*)$`, "i"),
      new RegExp(`^(?:#+\\s*)?(?:[-*]\\s+)?(?:\\*\\*)?第\\s*${chapterNumber}\\s*章(?!\\d|\\s*[-~–—]\\s*\\d)(?:[:：-])?(?:\\*\\*)?\\s*(.*)$`),
    ];

    return patterns
      .map((pattern) => line.match(pattern))
      .find((result): result is RegExpMatchArray => Boolean(result));
  }

  private matchAnyExactOutlineLine(line: string): RegExpMatchArray | undefined {
    const patterns = [
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?Chapter\s*\d+(?!\s*[-~–—]\s*\d)(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?第\s*\d+\s*章(?!\s*[-~–—]\s*\d)(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
    ];

    return patterns
      .map((pattern) => line.match(pattern))
      .find((result): result is RegExpMatchArray => Boolean(result));
  }

  private matchRangeOutlineLine(line: string, chapterNumber: number): RegExpMatchArray | undefined {
    const match = this.matchAnyRangeOutlineLine(line);
    if (!match) return undefined;
    if (this.isChapterWithinRange(match[1], match[2], chapterNumber)) {
      return match;
    }

    return undefined;
  }

  private matchAnyRangeOutlineLine(line: string): RegExpMatchArray | undefined {
    const patterns = [
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?Chapter\s*(\d+)\s*[-~–—]\s*(\d+)\b(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?Volume\s+\d+\s*\(\s*Chapters?\s*(\d+)\s*[-~–—]\s*(\d+)\s*\)(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?第\s*(\d+)\s*[-~–—]\s*(\d+)\s*章(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
      /^(?:[-*]\s+)?(?:\*\*)?章节范围(?:\*\*)?[：:]\s*(\d+)\s*[-~–—]\s*(\d+)\s*章\s*(.*)$/,
      /^(?:[-*]\s+)?(?:\*\*)?Chapter\s*[Rr]ange(?:\*\*)?[：:]\s*(\d+)\s*[-~–—]\s*(\d+)\b\s*(.*)$/i,
    ];

    return patterns
      .map((pattern) => line.match(pattern))
      .find((result): result is RegExpMatchArray => Boolean(result));
  }

  private isOutlineAnchorLine(line: string): boolean {
    return this.matchAnyExactOutlineLine(line) !== undefined
      || this.matchAnyRangeOutlineLine(line) !== undefined;
  }

  private isChapterWithinRange(startText: string | undefined, endText: string | undefined, chapterNumber: number): boolean {
    const start = Number.parseInt(startText ?? "", 10);
    const end = Number.parseInt(endText ?? "", 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    const lower = Math.min(start, end);
    const upper = Math.max(start, end);
    return chapterNumber >= lower && chapterNumber <= upper;
  }

  private renderIntentMarkdown(
    intent: ChapterIntent,
    memo: ChapterMemo,
    language: ScaffoldLanguage,
    pendingHooks: string,
    chapterSummaries: string,
    activeHookCount: number,
  ): string {
    const mustKeep = intent.mustKeep.length > 0
      ? intent.mustKeep.map((item) => `- ${item}`).join("\n")
      : "- none";

    const mustAvoid = intent.mustAvoid.length > 0
      ? intent.mustAvoid.map((item) => `- ${item}`).join("\n")
      : "- none";

    const styleEmphasis = intent.styleEmphasis.length > 0
      ? intent.styleEmphasis.map((item) => `- ${item}`).join("\n")
      : "- none";

    const memoBody = memo.body.trim();
    const threadRefsLine = memo.threadRefs.length > 0
      ? memo.threadRefs.map((id) => `- ${id}`).join("\n")
      : "- (none)";

    return [
      "# Chapter Intent",
      "",
      "## Goal",
      intent.goal,
      "",
      "## Outline Node",
      intent.outlineNode ?? "(not found)",
      "",
      "## Arc Context",
      intent.arcContext ?? "(none)",
      "",
      "## Must Keep",
      mustKeep,
      "",
      "## Must Avoid",
      mustAvoid,
      "",
      "## Style Emphasis",
      styleEmphasis,
      "",
      "## Chapter Memo",
      `- isGoldenOpening: ${memo.isGoldenOpening ? "true" : "false"}`,
      "",
      "### Thread Refs",
      threadRefsLine,
      "",
      "### Body",
      memoBody,
      "",
      this.renderHookBudget(activeHookCount, language),
      "",
      "## Pending Hooks Snapshot",
      pendingHooks,
      "",
      "## Chapter Summaries Snapshot",
      chapterSummaries,
      "",
    ].join("\n");
  }

  private unique(values: ReadonlyArray<string>): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }

  private isChineseLanguage(language: ScaffoldLanguage | undefined): boolean {
    return (language ?? "zh").toLowerCase().startsWith("zh");
  }

  // Kept for potential subclasses reading seed files directly.
  protected async readFileOrDefault(path: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "(文件尚未创建)";
    }
  }
}

function pacingCodeFromMemo(memoBody: string): ChapterIntent["pacingCode"] {
  const match = memoBody.match(
    /^##\s*(?:节奏代码|Pacing Code)\s*\r?\n\s*([^\r\n]+?)\s*$/imu,
  );
  const parsed = PacingCodeSchema.safeParse(match?.[1]?.toLocaleLowerCase());
  return parsed.success && parsed.data !== "unknown" ? parsed.data : "unknown";
}

function assertFreshMemoGovernance(
  memoBody: string,
  authoritativeActiveHooks?: ReadonlyArray<StoredHook>,
): void {
  const match = memoBody.match(
    /^##\s*(?:节奏代码|Pacing Code)\s*\r?\n\s*([^\r\n]+?)\s*$/imu,
  );
  const pacing = PacingCodeSchema.safeParse(match?.[1]?.toLocaleLowerCase());
  if (!pacing.success || pacing.data === "unknown") {
    throw new PlannerParseError(
      "fresh memo must contain one canonical pacing code (setup|escalation|reveal|reversal|payoff|aftermath|bridge)",
      );
  }

  if (authoritativeActiveHooks === undefined) return;
  const knownIds = new Set(authoritativeActiveHooks.map((hook) => hook.hookId));
  const ledger = parseHookLedger(memoBody);
  for (const entry of [...ledger.open, ...ledger.advance, ...ledger.resolve, ...ledger.defer]) {
    if (!knownIds.has(entry.id)) {
      throw new PlannerParseError(`unknown stable hook ID ${entry.id} in fresh memo`);
    }
  }
}
