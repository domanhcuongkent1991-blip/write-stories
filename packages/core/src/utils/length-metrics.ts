import type { LengthCountingMode, LengthSpec } from "../models/length-governance.js";
import type { WritingLanguage } from "../models/writing-language.js";
import { resolveWritingLanguageProfile } from "./language.js";

export type LengthLanguage = "zh" | "en";

const REFERENCE_TARGET = 2200;
const SOFT_RANGE_DELTA = 300;
const HARD_RANGE_DELTA = 600;

// Per-chapter length default in the book's native unit: Chinese counts characters (3000字),
// English counts words (~2000 ≈ a 3000-char chapter). One cross-language number would mis-scale —
// 3000 read as English words runs ~50% long, and the hard-range guard then force-expands correct chapters.
export const DEFAULT_CHAPTER_LENGTH_ZH = 3000;
export const DEFAULT_CHAPTER_LENGTH_EN = 2000;

const VI_WORDLIKE_TOKEN_RE =
  /[\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*/gu;

export function defaultChapterLength(language: WritingLanguage = "zh"): number {
  return resolveWritingLanguageProfile(language).defaultChapterLength;
}

export function countChapterLength(
  content: string,
  countingMode: LengthCountingMode,
): number {
  const normalized = stripMarkdownMetadata(content);

  if (countingMode === "en_words") {
    const words = normalized.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g);
    return words?.length ?? 0;
  }

  if (countingMode === "vi_wordlike_tokens_v1") {
    return normalized.normalize("NFC").match(VI_WORDLIKE_TOKEN_RE)?.length ?? 0;
  }

  return normalized.replace(/\s+/g, "").length;
}

export function resolveLengthCountingMode(
  language: WritingLanguage = "zh",
): LengthCountingMode {
  return resolveWritingLanguageProfile(language).countingMode;
}

export function formatLengthCount(
  count: number,
  countingMode: LengthCountingMode,
): string {
  if (countingMode === "zh_chars") return `${count}字`;
  if (countingMode === "vi_wordlike_tokens_v1") return `${count} từ`;
  return `${count} words`;
}

export function buildLengthSpec(
  target: number,
  language: WritingLanguage = "zh",
): LengthSpec {
  if (language === "vi" && target === 1150) {
    return {
      target,
      softMin: 1000,
      softMax: 1300,
      hardMin: 1000,
      hardMax: 1500,
      countingMode: "vi_wordlike_tokens_v1",
    };
  }

  const softDelta = scaleRangeDelta(target, SOFT_RANGE_DELTA);
  const hardDelta = Math.max(softDelta, scaleRangeDelta(target, HARD_RANGE_DELTA));
  const softMin = Math.max(1, target - softDelta);
  const softMax = target + softDelta;
  const hardMin = Math.max(1, target - hardDelta);
  const hardMax = target + hardDelta;

  return {
    target,
    softMin,
    softMax,
    hardMin,
    hardMax,
    countingMode: resolveLengthCountingMode(language),
  };
}

/**
 * Shared writing guidance for Vietnamese chapter generation.
 *
 * The audit policy deliberately remains broader (1000-1500 tokens). This
 * narrower target gives the writer room to finish a coherent chapter before
 * the hard safety gate is reached, while keeping the counting mode explicit.
 */
export function formatWriterPromptLengthGuidance(
  spec: LengthSpec,
  language: WritingLanguage,
): string | undefined {
  if (
    language !== "vi" ||
    spec.target !== 1150 ||
    spec.countingMode !== "vi_wordlike_tokens_v1"
  ) {
    return undefined;
  }

  return [
    "ĐỘ DÀI KHI VIẾT (BẮT BUỘC): chỉ tính phần CHAPTER_CONTENT theo vi_wordlike_tokens_v1.",
    "Mục tiêu viết: 1100-1300 từ tiếng Việt (mốc tham chiếu 1150 từ); hãy chủ động kết thúc trong khoảng này.",
    "Đây là mục tiêu viết, không phải gợi ý: không thêm câu hoặc cảnh đệm; khi gần 1300 từ hãy khép cảnh và kết thúc hook.",
    "Mọi hướng dẫn của chapter memo/context vẫn phải được đáp ứng. Nếu memo ghi khoảng khác, dùng mục tiêu viết 1100-1300 cho phần sáng tác.",
    "Audit safety range vẫn là 1000-1500: 1301-1500 chỉ cảnh báo nếu các gate khác đạt; dưới 1000 hoặc trên 1500 bị chặn.",
  ].join("\n");
}

function scaleRangeDelta(target: number, referenceDelta: number): number {
  return Math.max(1, Math.floor((target * referenceDelta) / REFERENCE_TARGET));
}

export function isOutsideSoftRange(
  count: number,
  spec: Pick<LengthSpec, "softMin" | "softMax">,
): boolean {
  return count < spec.softMin || count > spec.softMax;
}

export function isOutsideHardRange(
  count: number,
  spec: Pick<LengthSpec, "hardMin" | "hardMax">,
): boolean {
  return count < spec.hardMin || count > spec.hardMax;
}

function stripMarkdownMetadata(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "").split("\n");
  const proseLines: string[] = [];
  let index = 0;

  if (lines[index]?.trim() === "---") {
    index += 1;
    while (index < lines.length && lines[index]?.trim() !== "---") {
      index += 1;
    }
    if (index < lines.length) {
      index += 1;
    }
  }

  let inFence = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (/^#{1,6}\s+/.test(trimmed)) {
      continue;
    }
    if (trimmed === "---" || trimmed === "...") {
      continue;
    }

    proseLines.push(line);
  }

  return proseLines.join("\n");
}
