export interface TranslationChapterSample {
  readonly number: number;
  readonly text: string;
}

export interface SampleTranslationChaptersOptions {
  readonly sampleCount?: number;
  readonly maxCharsPerSample?: number;
}

const DEFAULT_SAMPLE_COUNT = 6;
const DEFAULT_MAX_CHARS_PER_SAMPLE = 3000;

// Samples chapters spread from the beginning through the end of the book so
// glossary prep sees recurring entities in every part of the story.
export function sampleTranslationChapters(
  chapters: ReadonlyArray<{ readonly number: number; readonly text: string }>,
  options: SampleTranslationChaptersOptions = {},
): ReadonlyArray<TranslationChapterSample> {
  if (chapters.length === 0) return [];

  const sampleCount = Math.max(1, Math.min(options.sampleCount ?? DEFAULT_SAMPLE_COUNT, chapters.length));
  const maxChars = Math.max(1, options.maxCharsPerSample ?? DEFAULT_MAX_CHARS_PER_SAMPLE);

  const positions = new Set<number>();
  for (let index = 0; index < sampleCount; index++) {
    positions.add(
      sampleCount === 1 ? 0 : Math.round((index * (chapters.length - 1)) / (sampleCount - 1)),
    );
  }

  return [...positions].sort((a, b) => a - b).map((position) => {
    const chapter = chapters[position]!;
    return {
      number: chapter.number,
      text: clipToParagraphBoundary(chapter.text, maxChars),
    };
  });
}

function clipToParagraphBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const boundary = slice.lastIndexOf("\n\n");
  if (boundary >= Math.floor(maxChars / 2)) {
    return slice.slice(0, boundary).trim();
  }
  return slice.trim();
}
