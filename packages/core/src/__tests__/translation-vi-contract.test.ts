import { describe, expect, it } from "vitest";
import { normalizeLanguageCode, resolveStyleContract } from "../translation/vi-contract.js";

describe("resolveStyleContract", () => {
  it("returns the zh->vi style contract with Vietnamese anchors", () => {
    const contract = resolveStyleContract("zh", "vi");
    expect(contract).toBeDefined();
    expect(contract).toContain("xưng hô");
    expect(contract).toContain("Hán-Việt");
    expect(contract).toContain("không dịch từng chữ");
  });

  it("returns no contract for the vi->zh direction", () => {
    expect(resolveStyleContract("vi", "zh")).toBeUndefined();
  });

  it("returns no contract for other language pairs", () => {
    expect(resolveStyleContract("en", "vi")).toBeUndefined();
    expect(resolveStyleContract("zh", "en")).toBeUndefined();
    expect(resolveStyleContract("ja", "ko")).toBeUndefined();
  });

  it("resolves the contract from human-readable language names", () => {
    expect(resolveStyleContract("Chinese (Simplified)", "Vietnamese")).toBeDefined();
    expect(resolveStyleContract("简体中文", "越南语")).toBeDefined();
  });
});

describe("normalizeLanguageCode", () => {
  it("passes through ISO codes in lowercase", () => {
    expect(normalizeLanguageCode("zh")).toBe("zh");
    expect(normalizeLanguageCode("VI")).toBe("vi");
    expect(normalizeLanguageCode("en")).toBe("en");
  });

  it("maps human-readable names to ISO codes", () => {
    expect(normalizeLanguageCode("Chinese (Simplified)")).toBe("zh");
    expect(normalizeLanguageCode("Chinese")).toBe("zh");
    expect(normalizeLanguageCode("中文")).toBe("zh");
    expect(normalizeLanguageCode("简体中文")).toBe("zh");
    expect(normalizeLanguageCode("Vietnamese")).toBe("vi");
    expect(normalizeLanguageCode("tiếng Việt")).toBe("vi");
    expect(normalizeLanguageCode("越南语")).toBe("vi");
    expect(normalizeLanguageCode("English")).toBe("en");
    expect(normalizeLanguageCode("Japanese")).toBe("ja");
    expect(normalizeLanguageCode("Korean")).toBe("ko");
  });

  it("returns undefined for undetermined or unknown languages", () => {
    expect(normalizeLanguageCode("auto")).toBeUndefined();
    expect(normalizeLanguageCode("自动识别")).toBeUndefined();
    expect(normalizeLanguageCode("")).toBeUndefined();
    expect(normalizeLanguageCode("  ")).toBeUndefined();
    expect(normalizeLanguageCode("klingon")).toBeUndefined();
  });
});
