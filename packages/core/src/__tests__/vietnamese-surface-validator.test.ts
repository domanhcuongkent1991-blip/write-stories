import { describe, expect, it } from "vitest";
import { validateVietnameseSurface } from "../agents/vietnamese-surface-validator.js";

describe("Vietnamese surface validator", () => {
  it("reports each known spelling occurrence with an exact repair hint", () => {
    const issues = validateVietnameseSurface("mười mốn và dry khốc. Sound tivi; mười mốn.");
    const spelling = issues.filter((issue) => issue.rule === "vi-known-spelling");
    expect(spelling).toHaveLength(4);
    expect(spelling[0]).toMatchObject({ severity: "error", repairScope: "local", repairTarget: "prose", verification: "verified" });
    expect(spelling[0]?.repairHint).toMatchObject({ kind: "exact-replacement", targetText: "mười mốn", replacementText: "mười bốn", occurrenceIndexes: [1] });
    expect(spelling[1]?.repairHint?.occurrenceIndexes).toEqual([2]);
    expect(validateVietnameseSurface("mười bốn, khô khốc, Âm thanh tivi").filter((issue) => issue.rule === "vi-known-spelling")).toEqual([]);
  });
  it("accepts clean Vietnamese prose", () => {
    expect(validateVietnameseSurface("Trời mưa. Cô bước qua sân ga và nhìn về phía bắc.")).toEqual([]);
  });

  it("blocks accidental CJK leakage", () => {
    expect(validateVietnameseSurface("Anh nói: 你好")).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "vi-cjk-leak", severity: "error" }),
    ]));
  });

  it("warns about leaked agent notes", () => {
    expect(validateVietnameseSurface("Cô quay đi.\n[writer-note] cần thêm cảnh hành động")).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "vi-agent-note-leak", severity: "error" }),
    ]));
  });

  it("warns about surface punctuation and delimiter defects", () => {
    const issues = validateVietnameseSurface("Cô nói: “Đợi tôi!!  Sau đó (quay lại.");

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "vi-repeated-whitespace", severity: "warning" }),
      expect.objectContaining({ rule: "vi-repeated-punctuation", severity: "warning" }),
      expect.objectContaining({ rule: "vi-unbalanced-delimiter", severity: "warning" }),
    ]));
  });
});
