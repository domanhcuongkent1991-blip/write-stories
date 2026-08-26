import { describe, expect, it } from "vitest";
import { formatModeLabel, getTuiCopy, normalizeStageLabel, resolveTuiLocale } from "../tui/i18n.js";

describe("tui i18n", () => {
  it("resolves UI locale independently with explicit and environment fallbacks", () => {
    expect(resolveTuiLocale({})).toBe("zh-CN");
    expect(resolveTuiLocale({ INKOS_TUI_LOCALE: "en" })).toBe("en");
    expect(resolveTuiLocale({ LANG: "en_US.UTF-8" })).toBe("en");
    expect(resolveTuiLocale({ INKOS_TUI_LOCALE: "vi_VN.UTF-8" })).toBe("vi");
    expect(resolveTuiLocale({ INKOS_TUI_LOCALE: "auto", INKOS_LOCALE: "en" })).toBe("en");
    expect(resolveTuiLocale({ INKOS_TUI_LOCALE: "xx", LANG: "vi_VN.UTF-8" })).toBe("vi");
  });

  it("merges partial Vietnamese copy over English", () => {
    const copy = getTuiCopy("vi");
    expect(copy.locale).toBe("vi");
    expect(copy.labels.project).toBe("Dự án");
    expect(copy.labels.messageCount(3)).toBe("3 msgs");
    expect(copy.labels.messageCount(3)).not.toBe("3 条消息");
  });

  it("normalizes common activity labels for Chinese chrome", () => {
    const copy = getTuiCopy("zh-CN");
    expect(normalizeStageLabel("writing chapter", copy)).toBe("写作中");
    expect(normalizeStageLabel("thinking ...", copy)).toBe("思考中");
    expect(normalizeStageLabel("idle", copy)).toBe("就绪");
    expect(normalizeStageLabel("waiting_human", copy)).toBe("等待你的决定");
    expect(normalizeStageLabel("completed", copy)).toBe("已完成");
    expect(formatModeLabel("semi", copy)).toBe("半自动");
    expect(formatModeLabel("auto", copy)).toBe("自动");
  });
});
