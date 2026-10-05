import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCharacterPronounRule,
  parsePendingHookTypeLabels,
  parseWorldGlossaryTerms,
  readCharacterPronounRules,
  readPlannerHookLabels,
  toAuditIssuesFromSurface,
  validateVietnameseSurface,
} from "../agents/vietnamese-surface-validator.js";

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

  it("flags long chapters written in a non-Vietnamese language", () => {
    const text = `The slope behind Frostwall fell into a white ravine. ${"He counted the marks on the ledger and wrote the entry before the ink dried. ".repeat(9)}`;
    const findings = validateVietnameseSurface(text);
    const mismatch = findings.find((f) => f.rule === "vi-output-language-mismatch");
    expect(mismatch?.severity).toBe("error");
    expect(mismatch?.suggestion).toMatch(/tiếng Việt/);
  });

  it("does not flag Vietnamese prose as a language mismatch", () => {
    const text = "Sườn núi sau Frostwall đổ xuống một khe trắng. Hắn đếm các vạch trên sổ và ghi dòng mới trước khi mực khô. Ký ức trong tủy vẫn còn nguyên, nhưng giá của nó đã đổi chủ.";
    const findings = validateVietnameseSurface(text);
    expect(findings.find((f) => f.rule === "vi-output-language-mismatch")).toBeUndefined();
  });
});

const TRAN_GIUA_PRONOUNS = [
  { name: "Lâm Hàn", aliases: ["Lâm Hàn", "Lâm"], allowed: ["anh"], denied: ["hắn", "cậu"] },
  { name: "Ngụy Vinh", aliases: ["Ngụy Vinh", "Ngụy"], allowed: ["ông"], denied: ["hắn", "lão"] },
  { name: "Tề Dực", aliases: ["Tề Dực", "Tề"], allowed: ["ông"], denied: ["hắn"] },
] as const;

describe("validateVietnameseSurface — vi-pronoun-mismatch", () => {
  it("flags a denied narrative pronoun opening the sentence right after the character's name", () => {
    const text = "Lâm Hàn đứng dậy. Hắn nhìn ra cửa rồi đóng lại.";
    const findings = validateVietnameseSurface(text, { characterPronouns: TRAN_GIUA_PRONOUNS });
    const mismatch = findings.find((f) => f.rule === "vi-pronoun-mismatch");
    expect(mismatch?.severity).toBe("error");
    expect(mismatch?.description).toContain("Lâm Hàn");
    expect(mismatch?.description).toContain("hắn");
    expect(mismatch?.suggestion).toContain("anh");
  });

  it("flags a denied pronoun opening the clause after a colon following the character's name", () => {
    const text = "Ngụy Vinh không giúp anh miễn phí: hắn buộc mình vào chuỗi, nhưng để lại đường lối.";
    const findings = validateVietnameseSurface(text, { characterPronouns: TRAN_GIUA_PRONOUNS });
    const mismatch = findings.find((f) => f.rule === "vi-pronoun-mismatch");
    expect(mismatch?.severity).toBe("error");
    expect(mismatch?.description).toContain("Ngụy Vinh");
  });

  it("does not flag a denied pronoun used as a mid-sentence object", () => {
    const text = "Lâm Hàn đến cách hắn mười bước thì dừng lại, giữ khoảng cách nói chuyện.";
    const findings = validateVietnameseSurface(text, { characterPronouns: TRAN_GIUA_PRONOUNS });
    expect(findings.find((f) => f.rule === "vi-pronoun-mismatch")).toBeUndefined();
  });

  it("does not flag when the character name itself appears as an object of another subject", () => {
    const text = "Hắn không nhìn Lâm Hàn, chỉ nhìn túi vải xát trên vai.";
    const findings = validateVietnameseSurface(text, { characterPronouns: TRAN_GIUA_PRONOUNS });
    expect(findings.find((f) => f.rule === "vi-pronoun-mismatch")).toBeUndefined();
  });

  it("stops the chain when a new subject opens the next sentence", () => {
    const text = "Lâm Hàn đặt chén xuống. Bà quay đi về phía bếp. Hắn đứng dậy khỏi ghế.";
    const findings = validateVietnameseSurface(text, { characterPronouns: TRAN_GIUA_PRONOUNS });
    expect(findings.find((f) => f.rule === "vi-pronoun-mismatch")).toBeUndefined();
  });

  it("resets the tracked subject when an unknown proper-noun subject opens the sentence", () => {
    // “Hắn” here narrates Triệu Mẫn (a supporting cast member without a role
    // lock), not Lâm Hàn — the chain must sever when a new proper-noun subject
    // takes over, otherwise the deterministic check blames the wrong character.
    const text = "Lâm Hàn đặt chén xuống. Triệu Mẫn đã tỉnh. Hắn đang đập vai vào cửa.";
    const findings = validateVietnameseSurface(text, { characterPronouns: TRAN_GIUA_PRONOUNS });
    expect(findings.find((f) => f.rule === "vi-pronoun-mismatch")).toBeUndefined();
  });

  it("severs the chain when an unknown proper noun is mentioned in the previous sentence", () => {
    // “Ngụy Vinh nhìn Triệu Mẫn. Hắn lập tức cúi đầu.” — “Hắn” most plausibly
    // names Triệu Mẫn; with an unknown proper noun in play the reference is
    // ambiguous, so the deterministic check must stay silent instead of
    // blaming the previous locked character.
    const text = "Lâm Hàn đặt chén xuống. Ngụy Vinh nhìn Triệu Mẫn. Hắn lập tức cúi đầu.";
    const findings = validateVietnameseSurface(text, { characterPronouns: TRAN_GIUA_PRONOUNS });
    expect(findings.find((f) => f.rule === "vi-pronoun-mismatch")).toBeUndefined();
  });

  it("keeps tracking across sentences that open with common words", () => {
    const text = "Lâm Hàn đặt chén xuống. Rồi hắn đứng dậy khỏi ghế.";
    const findings = validateVietnameseSurface(text, { characterPronouns: TRAN_GIUA_PRONOUNS });
    expect(findings.find((f) => f.rule === "vi-pronoun-mismatch")).toBeDefined();
  });

  it("ignores quoted speech when tracking subjects", () => {
    const text = "Lâm Hàn hỏi: “Hắn ta là ai mà đến được đây?” Rồi anh khép cuốn sổ lại.";
    const findings = validateVietnameseSurface(text, { characterPronouns: TRAN_GIUA_PRONOUNS });
    expect(findings.find((f) => f.rule === "vi-pronoun-mismatch")).toBeUndefined();
  });

  it("normalizes the “hắn ta” variant before checking", () => {
    const text = "Lâm Hàn quay lưng lại. Hắn ta không nhìn ai cả.";
    const findings = validateVietnameseSurface(text, { characterPronouns: TRAN_GIUA_PRONOUNS });
    const mismatch = findings.find((f) => f.rule === "vi-pronoun-mismatch");
    expect(mismatch?.severity).toBe("error");
    expect(mismatch?.description).toContain("Lâm Hàn");
  });

  it("keeps the allowed narrative pronoun unflagged", () => {
    const text = "Lâm Hàn đứng dậy. Anh nhìn ra cửa rồi đóng lại.";
    const findings = validateVietnameseSurface(text, { characterPronouns: TRAN_GIUA_PRONOUNS });
    expect(findings.find((f) => f.rule === "vi-pronoun-mismatch")).toBeUndefined();
  });

  it("does nothing when characterPronouns option is absent", () => {
    const text = "Lâm Hàn đứng dậy. Hắn nhìn ra cửa rồi đóng lại.";
    const findings = validateVietnameseSurface(text);
    expect(findings.find((f) => f.rule === "vi-pronoun-mismatch")).toBeUndefined();
  });
});

describe("validateVietnameseSurface — vi-planner-label-leak", () => {
  const labels = ["resource hook", "antagonist program", "mystery", "initial-state"] as const;

  it("flags planner hook-type labels leaked into prose", () => {
    const text = "Mọi thứ về lô hàng này là resource hook/antagonist program/mystery/initial-state trong bản kế hoạch.";
    const findings = validateVietnameseSurface(text, { plannerHookLabels: labels });
    const leak = findings.find((f) => f.rule === "vi-planner-label-leak");
    expect(leak?.severity).toBe("error");
    expect(leak?.description).toContain("resource hook");
    expect(leak?.description).toContain("initial-state");
  });

  it("ignores labels inside quoted speech", () => {
    const text = "Rowan nói: “Cái này là resource hook à?” rồi cất giấy.";
    const findings = validateVietnameseSurface(text, { plannerHookLabels: labels });
    expect(findings.find((f) => f.rule === "vi-planner-label-leak")).toBeUndefined();
  });

  it("does nothing when plannerHookLabels option is absent", () => {
    const text = "Mọi thứ về lô hàng này là resource hook trong bản kế hoạch.";
    const findings = validateVietnameseSurface(text);
    expect(findings.find((f) => f.rule === "vi-planner-label-leak")).toBeUndefined();
  });
});

describe("parseCharacterPronounRule", () => {
  it("parses allowed and denied pronouns from a Vietnamese role file", () => {
    const markdown = [
      "## Core_Tags",
      "Cautious, watchful.",
      "",
      "## Vietnamese_Pronoun",
      "Đại từ trần thuật dùng nhất quán trong toàn bộ chương tiếng Việt: “anh”. CẤM dùng “hắn” hoặc “cậu” khi trần thuật về nhân vật này, kể cả khi đứng đầu câu (chương 5 đã lộ lỗi dùng “hắn”). Trong đối thoại, nhân vật vẫn xưng “ta” như chương 3-4 — đây là xưng hô, không phải đại từ trần thuật, KHÔNG được đổi.",
      "",
      "## Growth_Arc",
      "He grows.",
    ].join("\n");
    const rule = parseCharacterPronounRule("Lâm Hàn", markdown);
    expect(rule?.name).toBe("Lâm Hàn");
    expect([...rule?.allowed ?? []]).toEqual(["anh"]);
    expect([...rule?.denied ?? []]).toEqual(["hắn", "cậu"]);
  });

  it("does not treat the character's own name as a pronoun", () => {
    const markdown = [
      "## Vietnamese_Pronoun",
      "Đại từ trần thuật: gọi tên “Ngụy Vinh”; nếu cần đại từ thì dùng “ông” — KHÔNG dùng “hắn” hoặc “lão”. Trong đối thoại, nhân vật xưng “ta”.",
    ].join("\n");
    const rule = parseCharacterPronounRule("Ngụy Vinh", markdown);
    expect([...rule?.allowed ?? []]).toEqual(["ông"]);
    expect([...rule?.denied ?? []]).toEqual(["hắn", "lão"]);
  });

  it("parses parenthesized forbidden pronouns for non-person presences", () => {
    const markdown = [
      "## Vietnamese_Pronoun",
      "Không dùng đại từ cá nhân (hắn/nó/ông) cho hiện diện này; gọi theo danh xưng được dùng trong sách.",
    ].join("\n");
    const rule = parseCharacterPronounRule("The Patriarch", markdown);
    expect([...rule?.allowed ?? []]).toEqual([]);
    expect([...rule?.denied ?? []]).toEqual(["hắn", "nó", "ông"]);
  });

  it("returns undefined when the role file has no Vietnamese_Pronoun section", () => {
    const rule = parseCharacterPronounRule("Mara Quill", "## Core_Tags\nNothing here.");
    expect(rule).toBeUndefined();
  });
});

describe("parsePendingHookTypeLabels", () => {
  it("collects the distinct hook-type column values", () => {
    const markdown = [
      "| Hook | Chương | Loại | Trạng thái |",
      "|---|---|---|---|",
      "| H001 | 0 | initial-state | progressing |",
      "| H005 | 0 | supernatural mystery | progressing |",
      "| H003 | 0 | antagonist program | progressing |",
      "| H006 | 0 | resource hook | progressing |",
      "| X | 1 | mystery | progressing |",
      "| Y | 2 | mystery | progressing |",
    ].join("\n");
    const labels = parsePendingHookTypeLabels(markdown);
    expect(labels).toContain("initial-state");
    expect(labels).toContain("supernatural mystery");
    expect(labels).toContain("antagonist program");
    expect(labels).toContain("resource hook");
    expect(labels).toContain("mystery");
    expect(labels.filter((l) => l === "mystery")).toHaveLength(1);
  });
});

describe("toAuditIssuesFromSurface", () => {
  it("maps surface violations to audit issues and preserves the repair target", () => {
    const text = "Lâm Hàn đứng dậy. Hắn nhìn ra cửa rồi đóng lại.";
    const violations = validateVietnameseSurface(text, {
      characterPronouns: [
        { name: "Lâm Hàn", aliases: ["Lâm Hàn", "Lâm"], allowed: ["anh"], denied: ["hắn", "cậu"] },
      ],
    });
    const mismatch = violations.find((v) => v.rule === "vi-pronoun-mismatch");
    expect(mismatch).toBeDefined();
    const issues = toAuditIssuesFromSurface([mismatch!], { includeSource: true });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("critical");
    expect(issues[0]!.category).toBe("vi-pronoun-mismatch");
    expect(issues[0]!.ruleId).toBe("vi-pronoun-mismatch");
    expect(issues[0]!.verification).toBe("verified");
    expect(issues[0]!.source).toBe("deterministic");
    expect(issues[0]!.repairTarget).toBe("prose");
    expect(issues[0]!.repairScope).toBe("local");
  });

  it("keeps exact-replacement hints intact for spelling-style violations", () => {
    const hintViolation = {
      rule: "vi-known-spelling",
      severity: "error" as const,
      description: "lỗi chính tả",
      suggestion: "thay bằng",
      repairScope: "local" as const,
      repairTarget: "prose" as const,
      verification: "verified" as const,
      repairHint: {
        kind: "exact-replacement" as const,
        targetText: "aaa",
        replacementText: "bbb",
        occurrenceIndexes: [1],
        context: "ctx",
      },
    };
    const issues = toAuditIssuesFromSurface([hintViolation]);
    expect(issues[0]!.severity).toBe("critical");
    expect(issues[0]!.repairTarget).toBe("prose");
    expect(issues[0]!.repairHint?.kind).toBe("exact-replacement");
  });

  it("maps warnings without a repair target untouched", () => {
    const warningViolation = {
      rule: "vi-repeated-whitespace",
      severity: "warning" as const,
      description: "khoảng trắng lặp",
      suggestion: "chuẩn hóa",
    };
    const issues = toAuditIssuesFromSurface([warningViolation], { includeSource: true });
    expect(issues[0]!.severity).toBe("warning");
    expect(issues[0]!.repairTarget).toBeUndefined();
    expect(issues[0]!.source).toBe("deterministic");
  });
});

describe("readCharacterPronounRules / readPlannerHookLabels", () => {
  it("collects pronoun rules from nested role directories with aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-pronoun-rules-"));
    try {
      const major = join(root, "story", "roles", "主要角色");
      await mkdir(major, { recursive: true });
      await writeFile(join(major, "Lâm Hàn.md"), [
        "## Vietnamese_Pronoun",
        "Đại từ trần thuật dùng nhất quán trong toàn bộ chương tiếng Việt: “anh”. CẤM dùng “hắn” hoặc “cậu” khi trần thuật về nhân vật này.",
        "",
      ].join("\n"));
      await writeFile(join(major, "Hàn Đức.md"), [
        "## Vietnamese_Pronoun",
        "Đại từ dùng nhất quán trong toàn bộ chương tiếng Việt: “lão”.",
        "",
      ].join("\n"));
      const rules = await readCharacterPronounRules(root);
      const lamHan = rules.find((rule) => rule.name === "Lâm Hàn");
      expect(lamHan?.allowed).toEqual(["anh"]);
      expect(lamHan?.denied).toEqual(["hắn", "cậu"]);
      expect(lamHan?.aliases).toContain("Lâm Hàn");
      expect(lamHan?.aliases).toContain("Lâm");
      expect(lamHan?.aliases).not.toContain("Hàn");
      const hanDuc = rules.find((rule) => rule.name === "Hàn Đức");
      expect(hanDuc?.allowed).toEqual(["lão"]);
      expect(hanDuc?.aliases).toContain("Đức");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns an empty list when the book has no roles directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-pronoun-empty-"));
    try {
      expect(await readCharacterPronounRules(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads hook-type labels from pending_hooks.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-hook-labels-"));
    try {
      await mkdir(join(root, "story"), { recursive: true });
      await writeFile(join(root, "story", "pending_hooks.md"), [
        "# Tình tiết cài cắm đang chờ",
        "| mã_tình_tiết | chương_bắt_đầu | loại | trạng_thái |",
        "| --- | --- | --- | --- |",
        "| H001 | 0 | initial-state | progressing |",
        "| H005 | 0 | supernatural mystery | progressing |",
        "| H006 | 0 | resource hook | progressing |",
        "",
      ].join("\n"));
      const labels = await readPlannerHookLabels(root);
      expect(labels).toContain("initial-state");
      expect(labels).toContain("supernatural mystery");
      expect(labels).toContain("resource hook");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("parseCharacterPronounRule — speech self-address", () => {
  it("extracts speechSelf from the dialogue sentence", () => {
    const markdown = [
      "## Vietnamese_Pronoun",
      "Đại từ trần thuật: gọi tên “Ngụy Vinh”; nếu cần đại từ thì dùng “ông” — KHÔNG dùng “hắn” hoặc “lão”. Trong đối thoại, nhân vật xưng “ta” và gọi Lâm Hàn là “ngươi” như chương 3-5 — giữ nguyên.",
      "",
    ].join("\n");
    const rule = parseCharacterPronounRule("Ngụy Vinh", markdown);
    expect(rule?.speechSelf).toEqual(["ta"]);
    expect(rule?.denied).toContain("hắn");
    expect(rule?.denied).toContain("lão");
  });

  it("returns empty speechSelf when no dialogue sentence exists", () => {
    const markdown = [
      "## Vietnamese_Pronoun",
      "Đại từ dùng nhất quán trong toàn bộ chương tiếng Việt: “hắn”.",
      "",
    ].join("\n");
    const rule = parseCharacterPronounRule("Rowan Vale", markdown);
    expect(rule?.speechSelf).toEqual([]);
  });
});

describe("validateVietnameseSurface — speech self-address locks (vi-speech-self-address)", () => {
  const NGUY_VINH = {
    name: "Ngụy Vinh",
    aliases: ["Ngụy Vinh", "Ngụy"],
    allowed: ["ông"],
    denied: ["hắn", "lão"],
    speechSelf: ["ta"],
  };
  const LAM_HAN = {
    name: "Lâm Hàn",
    aliases: ["Lâm Hàn", "Lâm"],
    allowed: ["anh"],
    denied: ["hắn", "cậu"],
    speechSelf: ["ta"],
  };
  const NO_LOCK = {
    name: "Tề Dực",
    aliases: ["Tề Dực"],
    allowed: ["ông"],
    denied: [],
    speechSelf: [],
  };

  it("flags “tôi” self-address in the dialogue of a character locked to “ta”", () => {
    const text = "Ngụy Vinh khoanh tay. “Tôi đã nói rồi, ngươi không nên quay lại đây.”";
    const findings = validateVietnameseSurface(text, { characterPronouns: [NGUY_VINH] });
    const violation = findings.find((f) => f.rule === "vi-speech-self-address");
    expect(violation?.severity).toBe("error");
    expect(violation?.description).toContain("Ngụy Vinh");
    expect(violation?.description).toContain("tôi");
    expect(violation?.suggestion).toContain("ta");
  });

  it("keeps a correct “ta” self-address unflagged", () => {
    const text = "Ngụy Vinh khoanh tay. “Ta đã nói rồi, ngươi không nên quay lại đây.”";
    const findings = validateVietnameseSurface(text, { characterPronouns: [NGUY_VINH] });
    expect(findings.find((f) => f.rule === "vi-speech-self-address")).toBeUndefined();
  });

  it("ignores self-address for characters without a speech lock", () => {
    const text = "Tề Dực lắc đầu. “Tôi không biết gì cả.”";
    const findings = validateVietnameseSurface(text, { characterPronouns: [NO_LOCK, NGUY_VINH] });
    expect(findings.find((f) => f.rule === "vi-speech-self-address")).toBeUndefined();
  });

  it("ignores “tôi” in narration outside quotes", () => {
    const text = "Ngụy Vinh nhìn xuống biển hồ. Cánh cửa khép lại sau lưng hắn.";
    const findings = validateVietnameseSurface(text, { characterPronouns: [NGUY_VINH] });
    expect(findings.find((f) => f.rule === "vi-speech-self-address")).toBeUndefined();
  });

  it("does not flag forms of addressing others inside dialogue", () => {
    const text = "Ngụy Vinh gật đầu. “Ngươi cứ đi. Ta đợi tin.”";
    const findings = validateVietnameseSurface(text, { characterPronouns: [NGUY_VINH] });
    expect(findings.find((f) => f.rule === "vi-speech-self-address")).toBeUndefined();
  });

  it("attributes the dialogue to the nearest alias when several characters share the line", () => {
    const text = "Lâm Hàn bước vào. Ngụy Vinh gượng cười. “Tôi tự có phép của mình.”";
    const findings = validateVietnameseSurface(text, { characterPronouns: [LAM_HAN, NGUY_VINH] });
    const violation = findings.find((f) => f.rule === "vi-speech-self-address");
    expect(violation).toBeDefined();
    expect(violation?.description).toContain("Ngụy Vinh");
  });

  it("skips a dialogue with no attributable speaker on the line", () => {
    const text = "“Tôi tự có phép.” Cánh cửa đóng lại sau đó.";
    const findings = validateVietnameseSurface(text, { characterPronouns: [NGUY_VINH] });
    expect(findings.find((f) => f.rule === "vi-speech-self-address")).toBeUndefined();
  });
});

describe("parseWorldGlossaryTerms — 4-column Vietnamese glossary", () => {
  it("collects both the original and the Vietnamese name columns", () => {
    const markdown = [
      "# Sổ tay thế giới",
      "",
      "| Tên nguyên bản | Cách viết tiếng Việt | loại | ghi chú |",
      "| --- | --- | --- | --- |",
      "| Six Realms | Lục Cảnh | thuật ngữ | Sáu cảnh giới của thế giới |",
      "| Frostwall | Tường Sương | địa danh | Bức tường băng phía bắc |",
      "",
    ].join("\n");
    const terms = parseWorldGlossaryTerms(markdown);
    expect(terms).toContain("Six Realms");
    expect(terms).toContain("Lục Cảnh");
    expect(terms).toContain("Frostwall");
    expect(terms).toContain("Tường Sương");
    // Header cells never leak into the known-name set.
    expect(terms).not.toContain("Cách viết tiếng Việt");
    expect(terms).not.toContain("loại");
  });
});
