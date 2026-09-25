import { describe, expect, it } from "vitest";
import { collectThirdPersonForms, runChapterQa } from "../translation/qa.js";

// Alignment-aware address-variant cases. The heuristic only counts a source
// pronoun group when the segment itself contains that pronoun, and only
// Vietnamese forms from the locked alignment table for that group.
describe("alignment-aware addressVariants", () => {
  it("scores 0 when 他 maps consistently to one Vietnamese form", () => {
    const report = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [
        { source: "他走了。", target: "Hắn bỏ đi." },
        { source: "他摇头。", target: "Hắn lắc đầu." },
      ],
      glossary: [],
    });
    expect(report.metrics.addressVariants).toBe(0);
    expect(report.passed).toBe(true);
  });

  it("scores 1 when one segment mixes two forms of 他", () => {
    const report = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [
        { source: "他说他不知道这件事。", target: "Hắn nhìn y, hắn bảo y im lặng." },
      ],
      glossary: [],
    });
    expect(report.metrics.addressVariants).toBe(1);
    expect(report.passed).toBe(false);
  });

  it("keeps 0 across chapters with one form each but records address drift", () => {
    const chapterOneSegments = [
      { source: "他走了。", target: "Hắn bỏ đi." },
      { source: "他回头看了一眼。", target: "Hắn quay đầu nhìn lại." },
    ];
    const chapterOne = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: chapterOneSegments,
      glossary: [],
    });
    expect(chapterOne.metrics.addressVariants).toBe(0);
    expect(chapterOne.addressDrift).toBeUndefined();
    expect(collectThirdPersonForms(chapterOneSegments)).toEqual(["hắn"]);

    const chapterTwo = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [{ source: "他停下了。", target: "Y dừng lại." }],
      glossary: [],
      previousChapterForms: ["hắn"],
    });
    expect(chapterTwo.metrics.addressVariants).toBe(0);
    expect(chapterTwo.addressDrift).toBe(true);
    expect(chapterTwo.passed).toBe(true);
  });

  it("ignores targets of segments that carry no source pronoun", () => {
    const report = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [
        { source: "山门在望，晨钟悠悠。", target: "Hắn y nó cùng nhau đi lên." },
      ],
      glossary: [],
    });
    expect(report.metrics.addressVariants).toBe(0);
    expect(report.passed).toBe(true);
  });

  it("flags 她 mixing nàng and cô, and passes consistent nàng", () => {
    const mixed = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [{ source: "她说她累了。", target: "Nàng nói cô mệt rồi." }],
      glossary: [],
    });
    expect(mixed.metrics.addressVariants).toBe(1);

    const consistent = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [{ source: "她说她累了。", target: "Nàng nói nàng mệt rồi." }],
      glossary: [],
    });
    expect(consistent.metrics.addressVariants).toBe(0);
  });

  it("counts one group when 他 mixes but 我 stays consistent, and zero when both are consistent", () => {
    const oneGroup = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [
        { source: "他和我说了这件事。", target: "Hắn nói với ta về chuyện này." },
        { source: "他又说了一遍，我听着。", target: "Y nhắc lại một lần, ta lắng nghe." },
      ],
      glossary: [],
    });
    expect(oneGroup.metrics.addressVariants).toBe(1);

    const consistent = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [
        { source: "他和我说了这件事。", target: "Hắn nói với ta về chuyện này." },
        { source: "他又说了一遍，我听着。", target: "Hắn nhắc lại một lần, ta lắng nghe." },
      ],
      glossary: [],
    });
    expect(consistent.metrics.addressVariants).toBe(0);
    expect(consistent.passed).toBe(true);
  });

  it("treats 它 as consistent nó, and flags nó+hắn mixing for 他", () => {
    const consistent = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [{ source: "它蹲在门口。", target: "Nó ngồi trước cửa." }],
      glossary: [],
    });
    expect(consistent.metrics.addressVariants).toBe(0);

    const mixed = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [{ source: "他低头看着脚边的猫。", target: "Hắn cúi nhìn con mèo dưới chân, nó đang rửa mặt." }],
      glossary: [],
    });
    expect(mixed.metrics.addressVariants).toBe(1);
  });

  it("accumulates per pronoun group over the chapter when segments each keep one form but differ", () => {
    const report = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [
        { source: "他拔剑出鞘。", target: "Hắn rút kiếm khỏi vỏ." },
        { source: "他一步一步逼近。", target: "Y từng bước đến gần." },
      ],
      glossary: [],
    });
    expect(report.metrics.addressVariants).toBe(1);
    expect(report.passed).toBe(false);
  });

  // Ngọc and đệ are polysemous nouns (ngọc linh = 灵玉's translation, sư đệ =
  // a seniority title), not address pronouns — they must not be counted.
  it("does not count đệ in sư đệ or ngọc in ngọc linh as address forms", () => {
    const report = runChapterQa({
      sourceLanguage: "zh",
      targetLanguage: "vi",
      segments: [
        { source: "我和你一起守着这枚灵玉。", target: "Ta cùng ngươi giữ ngọc linh này, sư đệ bình tâm." },
        { source: "你不要多想。", target: "Ngươi đừng suy nghĩ nhiều, ta tin ngươi." },
      ],
      glossary: [],
    });
    expect(report.metrics.addressVariants).toBe(0);
    expect(report.passed).toBe(true);
  });
});
