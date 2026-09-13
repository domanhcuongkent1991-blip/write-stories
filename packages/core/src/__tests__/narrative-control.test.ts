import { describe, expect, it } from "vitest";
import {
  extractVerbatimEvidenceQuotes,
  renderMemoAsNarrativeBlock,
  sanitizeNarrativeControlText,
} from "../utils/narrative-control.js";
import type { ChapterIntent } from "../models/input-governance.js";

describe("sanitizeNarrativeControlText", () => {
  it("preserves double-quoted evidence verbatim while sanitizing surrounding text", () => {
    const line = `- H004 "admin procedure: pre-processing" -> proceeding to next observation`;
    const sanitized = sanitizeNarrativeControlText(line, "en");
    expect(sanitized).toContain('"admin procedure: pre-processing"');
    expect(sanitized).not.toContain("H004");
    expect(sanitized).toContain("this thread");
    expect(sanitized).not.toContain("proceeding-to-next");
  });

  it("preserves curly-quoted zh spans and still rewrites kebab slugs outside them", () => {
    const line = `- 推进 sync-log-rewrite；现场记录为“admin procedure: pre-processing”`;
    const sanitized = sanitizeNarrativeControlText(line, "zh");
    expect(sanitized).toContain("“admin procedure: pre-processing”");
    expect(sanitized).not.toContain("sync-log-rewrite");
    expect(sanitized).toContain("这条线索");
  });

  it("still rewrites hook ids and slugs when no quotes are present", () => {
    const sanitized = sanitizeNarrativeControlText("- H007 mystery-kho-quy-truy-sau planted", "en");
    expect(sanitized).not.toContain("H007");
    expect(sanitized).not.toContain("mystery-kho-quy-truy-sau");
    expect(sanitized).toContain("this thread");
  });
});

describe("extractVerbatimEvidenceQuotes", () => {
  it("collects unique quoted strings from planned evidence in order", () => {
    const quotes = extractVerbatimEvidenceQuotes([
      { plannedEvidence: `"phiên 02:07:19" -> Minh đối chiếu với "UDC-ADMIN-04"` },
      { plannedEvidence: `"phiên 02:07:19" lặp lại và "tệp tạm 04:51" mới` },
    ]);
    expect(quotes).toEqual(["phiên 02:07:19", "UDC-ADMIN-04", "tệp tạm 04:51"]);
  });

  it("supports curly quotes and enforces the limit", () => {
    const quotes = extractVerbatimEvidenceQuotes(
      [
        { plannedEvidence: `“một” và "hai"` },
        { plannedEvidence: `"ba"` },
        { plannedEvidence: `"bốn"` },
      ],
      2,
    );
    expect(quotes).toEqual(["một", "hai"]);
  });

  it("returns nothing when evidence carries no quotes", () => {
    expect(extractVerbatimEvidenceQuotes([{ plannedEvidence: "Minh kiểm tra bản sao" }])).toEqual([]);
  });
});

describe("renderMemoAsNarrativeBlock verbatim evidence", () => {
  const baseMemo = {
    goal: "Deliver the log review scene.",
    body: "## 当前任务\n- inspect the server copy",
    threadRefs: [],
    isGoldenOpening: false,
  } as never;

  const intent = {
    arcContext: "Volume arc",
    expectedHookContract: {
      schemaVersion: 2,
      operations: [
        {
          hookId: "H004",
          action: "advance",
          canonicalExpectedPayoff: "payoff",
          plannedEvidence: `"admin procedure: pre-processing" -> copy shows the procedure touched the telemetry package`,
        },
      ],
    },
  } as unknown as ChapterIntent;

  it("appends an unsanitized verbatim evidence section for quoted planned evidence", () => {
    const block = renderMemoAsNarrativeBlock(baseMemo, intent, "en");
    expect(block).toContain("## Verbatim Evidence (must appear exactly)");
    expect(block).toContain('- "admin procedure: pre-processing"');
  });

  it("does not sanitize the evidence quote into this-thread form", () => {
    const block = renderMemoAsNarrativeBlock(baseMemo, intent, "en");
    expect(block).toContain("admin procedure: pre-processing");
  });

  it("omits the section when no quotes or no contract exist", () => {
    expect(renderMemoAsNarrativeBlock(baseMemo, undefined, "en")).not.toContain("Verbatim Evidence");
    const noQuotes = {
      arcContext: "Volume arc",
      expectedHookContract: { schemaVersion: 2, operations: [{ plannedEvidence: "plain text" }] },
    } as unknown as ChapterIntent;
    expect(renderMemoAsNarrativeBlock(baseMemo, noQuotes, "en")).not.toContain("Verbatim Evidence");
  });
});
