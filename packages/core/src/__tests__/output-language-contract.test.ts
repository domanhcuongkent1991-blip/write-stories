import { describe, expect, it } from "vitest";
import { applyOutputLanguageContract } from "../agents/output-language-contract.js";
import { resolveWritingLanguageProfile } from "../utils/language.js";

describe("host-owned output language contract", () => {
  it("does nothing for legacy profiles", () => {
    const messages = [{ role: "system" as const, content: "legacy" }];

    expect(applyOutputLanguageContract(messages, resolveWritingLanguageProfile("en"))).toEqual(messages);
  });

  it("forbids copying verbatim English system text into VI narrative prose", () => {
    const messages = [{ role: "system" as const, content: "scaffold" }];

    const result = applyOutputLanguageContract(messages, resolveWritingLanguageProfile("vi"));
    const systemContent = result[0]?.content ?? "";

    // ch25 tran-giua: writer copied hook ledger English ("volume 5, immediately
    // before the repeal vote") into the prose — the contract must forbid it.
    expect(systemContent).toContain("Never copy an English sentence verbatim");
  });

  it("appends the VI contract once after custom guidance in the system message", () => {
    const messages = [
      { role: "system" as const, content: "custom project prompt: answer in English" },
      { role: "user" as const, content: "write chapter one" },
    ];

    const result = applyOutputLanguageContract(messages, resolveWritingLanguageProfile("vi"));
    const systemContent = result[0]?.content ?? "";
    const contractHeader = "HOST-ENFORCED VI OUTPUT CONTRACT";
    const contractStart = systemContent.indexOf(contractHeader);

    expect(systemContent).toContain("custom project prompt");
    expect(systemContent).toContain(contractHeader);
    expect(contractStart).toBeGreaterThan(systemContent.indexOf("custom project prompt"));
    expect(systemContent.slice(contractStart)).toContain("CHAPTER_CONTENT");
    expect((result.map((message) => message.content).join("\n").match(new RegExp(contractHeader, "g")) ?? [])).toHaveLength(1);
  });
});
