import { describe, expect, it } from "vitest";
import { sampleTranslationChapters } from "../translation/document-sampler.js";

function makeChapters(count: number, chapterLength = 40): Array<{ number: number; text: string }> {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    text: `nội dung chương ${index + 1} ${"x".repeat(Math.max(0, chapterLength - 18))}`,
  }));
}

describe("sampleTranslationChapters", () => {
  it("picks evenly distributed chapters across the book", () => {
    const samples = sampleTranslationChapters(makeChapters(10), { sampleCount: 3 });
    expect(samples.map((sample) => sample.number)).toEqual([1, 6, 10]);
  });

  it("defaults to 6 samples spanning the first and last chapters", () => {
    const samples = sampleTranslationChapters(makeChapters(10));
    expect(samples).toHaveLength(6);
    expect(samples[0]!.number).toBe(1);
    expect(samples.at(-1)!.number).toBe(10);
  });

  it("caps each sample at maxCharsPerSample preferring paragraph boundaries", () => {
    const longChapter = Array.from(
      { length: 10 },
      (_, index) => `đoạn ${index + 1} ${"a".repeat(90)}`,
    ).join("\n\n");
    const samples = sampleTranslationChapters(
      [{ number: 1, text: longChapter }],
      { sampleCount: 1, maxCharsPerSample: 250 },
    );
    expect(samples).toHaveLength(1);
    expect(samples[0]!.text.length).toBeLessThanOrEqual(250);
  });

  it("keeps a chapter intact when it is shorter than the cap", () => {
    const shortChapter = "một đoạn ngắn.";
    const samples = sampleTranslationChapters(
      [{ number: 3, text: shortChapter }],
      { sampleCount: 1, maxCharsPerSample: 3000 },
    );
    expect(samples).toEqual([{ number: 3, text: shortChapter }]);
  });

  it("returns one sample for a single-chapter book", () => {
    const samples = sampleTranslationChapters(makeChapters(1), { sampleCount: 6 });
    expect(samples).toEqual([{ number: 1, text: expect.any(String) }]);
  });

  it("clamps sampleCount to the number of chapters", () => {
    const samples = sampleTranslationChapters(makeChapters(10), { sampleCount: 50 });
    expect(samples).toHaveLength(10);
    expect(samples.map((sample) => sample.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("returns no samples for an empty book", () => {
    expect(sampleTranslationChapters([], { sampleCount: 3 })).toEqual([]);
  });
});
