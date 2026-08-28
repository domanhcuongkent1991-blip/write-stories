import {
  defaultChapterLength,
  deriveBookIdFromTitle,
  normalizePlatformOrOther,
  type Platform,
} from "@actalk/inkos-core";
export { waitForStudioBookReady } from "../lib/book-ready.js";
export type { StudioBookDetail, WaitForStudioBookReadyOptions } from "../lib/book-ready.js";

type WritingLanguage = "zh" | "en" | "vi";

export interface StudioCreateBookBody {
  readonly title: string;
  readonly genre: string;
  readonly language?: WritingLanguage;
  readonly platform?: string;
  readonly chapterWordCount?: number;
  readonly targetChapters?: number;
  readonly blurb?: string;
}

export interface StudioBookConfigDraft {
  readonly id: string;
  readonly title: string;
  readonly platform: Platform;
  readonly genre: string;
  readonly status: "outlining";
  readonly targetChapters: number;
  readonly chapterWordCount: number;
  readonly language?: WritingLanguage;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function normalizeStudioPlatform(platform?: string): Platform {
  return normalizePlatformOrOther(platform);
}

export function buildStudioBookConfig(body: StudioCreateBookBody, now: string): StudioBookConfigDraft {
  return {
    id: deriveBookIdFromTitle(body.title),
    title: body.title,
    platform: normalizeStudioPlatform(body.platform),
    genre: body.genre,
    status: "outlining",
    targetChapters: body.targetChapters ?? 200,
    chapterWordCount: body.chapterWordCount ?? defaultChapterLength(body.language ?? "zh"),
    ...(body.language ? { language: body.language } : {}),
    createdAt: now,
    updatedAt: now,
  };
}
