import { describe, expect, it } from "vitest";
import {
  contentWidth,
  displayWidth,
  normalizeTerminalWidth,
  padToDisplayWidth,
} from "../tui/ansi.js";

describe("tui terminal display width", () => {
  it("measures Vietnamese, decomposed marks, CJK, emoji, and ANSI", () => {
    expect(displayWidth("Tiếng")).toBe(5);
    expect(displayWidth("Tiếng")).toBe(5);
    expect(displayWidth("中文")).toBe(4);
    expect(displayWidth("✅")).toBe(2);
    expect(displayWidth("\u001b[31mTiếng\u001b[0m")).toBe(5);
    expect(displayWidth("\u001b]8;;https://example.test\u001b\\Tiếng\u001b]8;;\u001b\\")).toBe(5);
    expect(displayWidth("👨‍👩‍👧‍👦")).toBe(2);
    expect(displayWidth("\u0301")).toBe(0);
  });

  it("normalizes narrow or invalid terminal dimensions without negative padding", () => {
    expect(normalizeTerminalWidth(undefined, 40)).toBe(40);
    expect(normalizeTerminalWidth(Number.NaN, 20)).toBe(20);
    expect(contentWidth(3, 8, 40)).toBe(1);
    expect(contentWidth(80, 8, 40, 60)).toBe(52);
    expect(padToDisplayWidth("中文", 3, 1)).toBe("中文 ");
    expect(displayWidth(padToDisplayWidth("Tiếng", 8))).toBe(8);
  });
});
