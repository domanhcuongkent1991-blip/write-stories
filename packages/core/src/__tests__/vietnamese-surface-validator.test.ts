import { describe, expect, it } from "vitest";
import { validateVietnameseSurface } from "../agents/vietnamese-surface-validator.js";

describe("validateVietnameseSurface — world glossary + machine prose", () => {
  it("flags unknown foreign tokens as glossary violations", () => {
    const text = "Người của Harvest Bureau đang thu marrow. Hắn giữ chặt marrow trong hộp sắt.";
    const findings = validateVietnameseSurface(text, { worldGlossaryTerms: ["Cục Thu Hoạch", "tủy"] });
    const glossary = findings.find((f) => f.rule === "vi-world-glossary-unknown-name");
    expect(glossary?.severity).toBe("warning");
    expect(glossary?.description).toContain("Harvest Bureau");
    expect(glossary?.description).toContain("marrow");
    expect(glossary?.suggestion).toContain("world_glossary.md");
  });

  it("accepts names covered by the world glossary", () => {
    const text = "Cục Thu Hoạch thu tủy. Hắn đứng cạnh Cục Thu Hoạch, cầm tủy trên tay.";
    const findings = validateVietnameseSurface(text, { worldGlossaryTerms: ["Cục Thu Hoạch", "tủy"] });
    expect(findings.find((f) => f.rule === "vi-world-glossary-unknown-name")).toBeUndefined();
  });

  it("flags dense machine-prose tell phrases", () => {
    const text = "Đây không chỉ là một cuốn sổ, mà là biên bản nhân sinh. Nó không chỉ đo ký ức, mà còn định giá con người. Từ đó phản ánh một sự thật: ký ức là tài sản. Nhìn chung, đây là một hệ thống đầy tham vọng. Có thể nói, không ai thoát khỏi nó.";
    const findings = validateVietnameseSurface(text);
    const machine = findings.find((f) => f.rule === "vi-prose-machine-phrase");
    expect(machine?.severity).toBe("warning");
    expect(machine?.description).toMatch(/[3-9]/);
  });

  it("keeps sparse tell phrases unflagged", () => {
    const text = "Nó không chỉ là một cuốn sổ, mà là biên bản nhân sinh. Mọi thứ khác đã nói hết ý.";
    const findings = validateVietnameseSurface(text);
    expect(findings.find((f) => f.rule === "vi-prose-machine-phrase")).toBeUndefined();
  });
});
