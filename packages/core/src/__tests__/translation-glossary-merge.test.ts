import { describe, expect, it } from "vitest";
import { mergeGlossaryTermsV2 } from "../translation/glossary-merge.js";

describe("mergeGlossaryTermsV2", () => {
  it("keeps the existing auto term and records a conflict on same-rank target clash", () => {
    const result = mergeGlossaryTermsV2(
      [{ source: "李明", target: "Lý Minh" }],
      [{ source: "李明", target: "Lý Mạc" }],
    );
    expect(result.terms).toEqual([
      expect.objectContaining({ source: "李明", target: "Lý Minh" }),
    ]);
    expect(result.conflicts).toEqual([
      { source: "李明", keptTarget: "Lý Minh", rejectedTarget: "Lý Mạc" },
    ]);
  });

  it("lets an approved incoming term replace an auto existing term without a conflict", () => {
    const result = mergeGlossaryTermsV2(
      [{ source: "李明", target: "Lý Minh" }],
      [{ source: "李明", target: "Lý Mạc", origin: "approved" }],
    );
    expect(result.terms).toEqual([
      expect.objectContaining({ source: "李明", target: "Lý Mạc", origin: "approved" }),
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it("keeps a pinned existing term against any incoming term and records the conflict", () => {
    const result = mergeGlossaryTermsV2(
      [{ source: "李明", target: "Lý Minh", pinned: true, origin: "approved" }],
      [{ source: "李明", target: "Lý Mạc", origin: "approved" }],
    );
    expect(result.terms[0]).toMatchObject({ target: "Lý Minh", pinned: true });
    expect(result.conflicts).toHaveLength(1);
  });

  it("does not let an auto incoming term overwrite a seed existing term", () => {
    const result = mergeGlossaryTermsV2(
      [{ source: "李明", target: "Lý Minh", origin: "seed" }],
      [{ source: "李明", target: "Lý Mạc" }],
    );
    expect(result.terms[0]).toMatchObject({ target: "Lý Minh", origin: "seed" });
    expect(result.conflicts).toHaveLength(1);
  });

  it("dedupes identical targets into one entry and merges aliases, notes, and origin", () => {
    const result = mergeGlossaryTermsV2(
      [{ source: "李明", target: "Lý Minh", aliases: ["小明"], note: "protagonist" }],
      [{ source: "李明", target: "Lý Minh", aliases: ["小李"], origin: "approved" }],
    );
    expect(result.terms).toHaveLength(1);
    expect(result.terms[0]).toMatchObject({
      target: "Lý Minh",
      aliases: ["小明", "小李"],
      note: "protagonist",
      origin: "approved",
    });
    expect(result.conflicts).toEqual([]);
  });

  it("treats an incoming source that matches an existing alias as the same key", () => {
    const result = mergeGlossaryTermsV2(
      [{ source: "李明", target: "Lý Minh", aliases: ["小李"] }],
      [{ source: "小李", target: "Lý Minh" }],
    );
    expect(result.terms).toHaveLength(1);
    expect(result.terms[0]).toMatchObject({ source: "李明", target: "Lý Minh" });
    expect(result.conflicts).toEqual([]);
  });

  it("records a conflict when an alias-matching incoming term brings a different target", () => {
    const result = mergeGlossaryTermsV2(
      [{ source: "李明", target: "Lý Minh", aliases: ["小李"] }],
      [{ source: "小李", target: "Lý Mạc" }],
    );
    expect(result.terms[0]).toMatchObject({ target: "Lý Minh" });
    expect(result.conflicts).toEqual([
      { source: "小李", keptTarget: "Lý Minh", rejectedTarget: "Lý Mạc" },
    ]);
  });

  it("returns normalized legacy terms without conflicts when nothing incoming", () => {
    const result = mergeGlossaryTermsV2([{ source: "李明", target: "Lý Minh" }], []);
    expect(result.terms).toEqual([{
      source: "李明",
      target: "Lý Minh",
      aliases: [],
      origin: "auto",
      pinned: false,
    }]);
    expect(result.conflicts).toEqual([]);
  });
});
