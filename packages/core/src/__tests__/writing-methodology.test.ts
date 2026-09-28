import { describe, expect, it } from "vitest";
import { buildWritingMethodologySection } from "../utils/writing-methodology.js";

describe("buildWritingMethodologySection", () => {
  it("returns the Chinese methodology for zh", () => {
    const section = buildWritingMethodologySection("zh");
    expect(section).toContain("写作方法论");
    expect(section).toContain("去AI味");
  });

  it("returns the English methodology for en", () => {
    const section = buildWritingMethodologySection("en");
    expect(section).toContain("Writing Methodology Reference");
    expect(section).not.toContain("写作方法论");
  });

  it("returns the Vietnamese methodology for vi", () => {
    const section = buildWritingMethodologySection("vi");
    expect(section).toContain("Phương pháp viết");
    expect(section).toContain("Bỏ giọng máy");
    expect(section).not.toContain("写作方法论");
    expect(section).not.toContain("Writing Methodology Reference");
  });
});
