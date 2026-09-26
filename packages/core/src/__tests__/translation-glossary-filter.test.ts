import { describe, expect, it } from "vitest";
import { filterGlossaryForText } from "../translation/glossary-filter.js";
import type { TranslationGlossaryTerm } from "../translation/types.js";

describe("filterGlossaryForText", () => {
  const person: TranslationGlossaryTerm = { source: "李明", target: "Lý Minh", category: "person", aliases: ["小明"] };
  const sect: TranslationGlossaryTerm = { source: "青云门", target: "Thanh Vân Môn", category: "sect" };
  const fan: TranslationGlossaryTerm = { source: "Fan", target: "người hâm mộ" };
  const fantasy: TranslationGlossaryTerm = { source: "Fantasy", target: "kỳ ảo" };
  const pinned: TranslationGlossaryTerm = { source: "灵石", target: "linh thạch", pinned: true };

  it("matches CJK terms by substring", () => {
    const filtered = filterGlossaryForText([person, sect], "李明前往青云门。");
    expect(filtered.map((term) => term.source)).toContain("青云门");
    expect(filtered.map((term) => term.source)).toContain("李明");
  });

  it("matches Latin terms on word boundaries only", () => {
    const filtered = filterGlossaryForText([fan, fantasy], "Một Fan trung thành gửi thư.");
    const sources = filtered.map((term) => term.source);
    expect(sources).toContain("Fan");
    expect(sources).not.toContain("Fantasy");
  });

  it("does not match Latin terms embedded in longer words", () => {
    const filtered = filterGlossaryForText([fan, fantasy], "Thể loại Fantasy đang thịnh hành.");
    const sources = filtered.map((term) => term.source);
    expect(sources).toContain("Fantasy");
    expect(sources).not.toContain("Fan");
  });

  it("matches terms through their aliases", () => {
    const filtered = filterGlossaryForText([person], "小明笑了笑。");
    expect(filtered.map((term) => term.source)).toContain("李明");
  });

  it("always keeps person and pinned terms even when they do not appear", () => {
    const filtered = filterGlossaryForText([person, pinned, sect], "Một câu chuyện không liên quan.");
    const sources = filtered.map((term) => term.source);
    expect(sources).toContain("李明");
    expect(sources).toContain("灵石");
    expect(sources).not.toContain("青云门");
  });

  it("returns only person and pinned terms for empty text", () => {
    const filtered = filterGlossaryForText([person, pinned, sect], "");
    expect(filtered.map((term) => term.source)).toEqual(["李明", "灵石"]);
  });

  it("ranks remaining matches by descending source length when the cap cuts", () => {
    const ladder = ["甲", "甲乙", "甲乙丙", "甲乙丙丁", "甲乙丙丁戊", "甲乙丙丁戊己"];
    const ladderTerms: Array<TranslationGlossaryTerm> = ladder.map((source, index) => ({
      source,
      target: `t${index}`,
    }));
    const filtered = filterGlossaryForText(ladderTerms, ladder.join("") + "。", { maxTerms: 3 });
    expect(filtered.map((term) => term.source)).toEqual(["甲乙丙丁戊己", "甲乙丙丁戊", "甲乙丙丁"]);
  });

  it("keeps person and pinned terms ahead of capped matches", () => {
    const fillers: Array<TranslationGlossaryTerm> = Array.from({ length: 10 }, (_, index) => ({
      source: `甲乙丙丁${index}`,
      target: `t${index}`,
    }));
    const filtered = filterGlossaryForText([person, pinned, ...fillers], fillers.map((term) => term.source).join(""), { maxTerms: 5 });
    expect(filtered).toHaveLength(5);
    expect(filtered.map((term) => term.source).slice(0, 2)).toEqual(["李明", "灵石"]);
  });
});
