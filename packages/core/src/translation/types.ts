export type TranslationSourceKind = "text" | "markdown" | "pdf" | "epub";
export type TranslationExportFormat = "txt" | "md" | "epub";

export interface CreateTranslationProjectInput {
  readonly filePath: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly title?: string;
  readonly segmentMaxChars?: number;
}

export interface TranslationSourceManifest {
  readonly kind: TranslationSourceKind;
  readonly path: string;
  readonly charCount: number;
  readonly totalPages?: number;
}

export interface TranslationChapterManifest {
  readonly number: number;
  readonly title: string;
  readonly sourcePath: string;
  readonly translatedPath: string;
  readonly segmentCount: number;
  readonly charCount: number;
  readonly status: "pending" | "drafted" | "refined" | "reviewed" | "translated";
  readonly qa?: {
    readonly passed: boolean;
    readonly reportPath: string;
  };
}

export interface TranslationProjectManifest {
  readonly id: string;
  readonly title: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly source: TranslationSourceManifest;
  readonly chapters: ReadonlyArray<TranslationChapterManifest>;
}

export interface TranslationSegment {
  readonly index: number;
  readonly source: string;
  readonly target?: string;
  readonly notes?: string;
  readonly draft?: string;
  readonly stage?: "draft" | "refined";
}

export interface TranslationChapterFile {
  readonly number: number;
  readonly title: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly segments: ReadonlyArray<TranslationSegment>;
}

export interface TranslationProjectCreateResult {
  readonly projectDir: string;
  readonly manifestPath: string;
  readonly manifest: TranslationProjectManifest;
}

export type TranslationTermCategory =
  | "person"
  | "place"
  | "organization"
  | "sect"
  | "technique"
  | "item"
  | "other";
export type TranslationTermOrigin = "seed" | "auto" | "approved";

export interface TranslationGlossaryTerm {
  readonly source: string;
  readonly target: string;
  readonly note?: string;
  readonly category?: TranslationTermCategory;
  readonly aliases?: ReadonlyArray<string>;
  readonly origin?: TranslationTermOrigin;
  readonly pinned?: boolean;
}

export interface TranslationModelPort {
  readonly translateSegments: (input: {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly chapterTitle: string;
    readonly segments: ReadonlyArray<TranslationSegment>;
    readonly glossary: ReadonlyArray<TranslationGlossaryTerm>;
    readonly contextBefore?: string;
    readonly contextAfter?: string;
    readonly previousTargetTail?: string;
  }) => Promise<{
    readonly segments: ReadonlyArray<{
      readonly index: number;
      readonly target: string;
      readonly notes?: string;
    }>;
    readonly glossary?: ReadonlyArray<TranslationGlossaryTerm>;
  }>;
  readonly reviewChapter?: (input: {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly chapterTitle: string;
    readonly segments: ReadonlyArray<TranslationSegment>;
    readonly glossary: ReadonlyArray<TranslationGlossaryTerm>;
  }) => Promise<{
    readonly passed: boolean;
    readonly summary: string;
    readonly issues: ReadonlyArray<string>;
  }>;
  readonly extractGlossary?: (input: {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly namingPolicy: string;
    readonly samples: ReadonlyArray<{ readonly chapterNumber: number; readonly text: string }>;
  }) => Promise<{
    readonly terms: ReadonlyArray<TranslationGlossaryTerm>;
  }>;
  readonly refineSegments?: (input: {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly chapterTitle: string;
    readonly segments: ReadonlyArray<TranslationSegment>;
    readonly glossary: ReadonlyArray<TranslationGlossaryTerm>;
    readonly previousRefinedTail?: string;
    readonly styleContract?: string;
  }) => Promise<{
    readonly segments: ReadonlyArray<{
      readonly index: number;
      readonly target: string;
    }>;
  }>;
}

export interface RunTranslationProjectResult {
  readonly projectId: string;
  readonly translatedSegments: number;
  readonly reviewedChapters: number;
  readonly reportPath: string;
}

export interface TranslationExportResult {
  readonly outputPath: string;
  readonly format: TranslationExportFormat;
  readonly chaptersExported: number;
}
