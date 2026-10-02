import { describe, it, expect } from "vitest";
import {
  assessMemoHookDebtGovernance,
  canonicalizeMemoHookIds,
  hookOpsFromLedger,
  parseHookLedger,
  removeHookResolveCommitments,
  validateHookLedger,
} from "../utils/hook-ledger-validator.js";
import type { StoredHook } from "../state/memory-db.js";

const ZH_MEMO = `## 当前任务
林秋潜入账房取回账册。

## 本章 hook 账
open:
- [new] 旧港眼线盯梢 || 理由：留给下一卷

advance:
- H007 "胖虎借条" → planted → pressured
- H012 "雷架焦痕" → pressured → near_payoff

resolve:
- H003 "杂役腰牌" → 林秋主动摘下

defer:
- H009 "守拙诀来历" → 本章不动

## 不要做
- 不要点破母亲身份`;

const EN_MEMO = `## Current task
Lin Qiu lifts the ledger from the Old Port accounting hall.

## Hook ledger for this chapter
open:
- [new] Old Port tail || reason: save for later arc

advance:
- H007 "Huzi's IOU" → planted → pressured

resolve:
- H003 "errand badge" → Lin Qiu unpins it himself

defer:
- H009 "Shou-Zhuo Jue origin" → timing not right

## Do not
- Do not reveal the mother's name`;

describe("parseHookLedger", () => {
  it("extracts all four sub-lists from a zh memo", () => {
    const ledger = parseHookLedger(ZH_MEMO);
    expect(ledger.advance.map((e) => e.id)).toEqual(["H007", "H012"]);
    expect(ledger.resolve.map((e) => e.id)).toEqual(["H003"]);
    expect(ledger.defer.map((e) => e.id)).toEqual(["H009"]);
    // open uses [new] so no hook_id is extracted
    expect(ledger.open).toEqual([]);
  });

  it("captures descriptor + keywords for each entry", () => {
    const ledger = parseHookLedger(ZH_MEMO);
    const h007 = ledger.advance[0]!;
    expect(h007.id).toBe("H007");
    expect(h007.descriptor).toContain("胖虎借条");
    expect(h007.keywords).toContain("胖虎");
    expect(h007.keywords).toContain("借条");

    const h003 = ledger.resolve[0]!;
    expect(h003.keywords).toContain("杂役");
    expect(h003.keywords).toContain("腰牌");
  });

  it("extracts all four sub-lists from an en memo", () => {
    const ledger = parseHookLedger(EN_MEMO);
    expect(ledger.advance.map((e) => e.id)).toEqual(["H007"]);
    expect(ledger.resolve.map((e) => e.id)).toEqual(["H003"]);
    expect(ledger.defer.map((e) => e.id)).toEqual(["H009"]);
  });

  it("returns empty lists when no ledger section is present", () => {
    const ledger = parseHookLedger("## 当前任务\n正文\n\n## 不要做\n- 无");
    expect(ledger).toEqual({ open: [], advance: [], resolve: [], defer: [], newOpenCount: 0 });
  });

  it("removes only unsafe resolve commitments while preserving the memo and other hook operations", () => {
    const repaired = removeHookResolveCommitments(ZH_MEMO, ["H003"]);
    const ledger = parseHookLedger(repaired);

    expect(ledger.resolve).toEqual([]);
    expect(ledger.advance.map((entry) => entry.id)).toEqual(["H007", "H012"]);
    expect(ledger.defer.map((entry) => entry.id)).toEqual(["H009"]);
    expect(repaired).toContain("## 当前任务");
    expect(repaired).toContain("## 不要做");
    expect(repaired).not.toContain('- H003 "杂役腰牌"');
  });

  it("counts [new] placeholder lines under open as new hooks opened", () => {
    const memo = `## 本章 hook 账
open:
- [new] 下一卷伏笔 || 理由
- [new] 第二条埋点 || 理由
advance:
- H001 "x" → y
`;
    const ledger = parseHookLedger(memo);
    expect(ledger.open).toEqual([]); // [new] lines have no id → not in .open
    expect(ledger.newOpenCount).toBe(2);
  });

  it("stops at the next H2 heading and does not pollute across sections", () => {
    const memo = `## 本章 hook 账
advance:
- H007 "xxx" → ...

## 不要做
- H999 looks-like-a-hook-but-its-under-do-not`;
    const ledger = parseHookLedger(memo);
    expect(ledger.advance.map((e) => e.id)).toEqual(["H007"]);
    expect(ledger.defer).toEqual([]);
  });

  it("ignores placeholder tokens like 无 / none / n/a under empty slots", () => {
    const memo = `## 本章 hook 账
advance:
- 无
- none
- H007 "真的钩子" → planted
resolve:
- 暂无
defer:
- n/a
`;
    const ledger = parseHookLedger(memo);
    expect(ledger.advance.map((e) => e.id)).toEqual(["H007"]);
    expect(ledger.resolve).toEqual([]);
    expect(ledger.defer).toEqual([]);
  });

  it("ignores Vietnamese negation placeholders under empty slots (luna-29 ch5)", () => {
    // The exact resolve: line that killed luna-29 ch5: the model wrote a full
    // Vietnamese sentence meaning "none" and the diacritic-truncating ID regex
    // collapsed "Không" to the bogus id "Kh".
    const memo = `## Hook ledger for this chapter
advance:
- H007 "胖虎借条" → planted
resolve:
- Không có hook nào được giải quyết hoàn toàn trong chương này.
defer:
- Chưa đến lúc
- ko
- Chẳng có gì để hoãn
`;
    const ledger = parseHookLedger(memo, new Set(["H007"]));
    expect(ledger.advance.map((e) => e.id)).toEqual(["H007"]);
    expect(ledger.resolve).toEqual([]);
    expect(ledger.defer).toEqual([]);
  });

  it("does not treat a real diacritic-free slug as a negation placeholder", () => {
    // A genuine hook slug that merely starts with the letters "khong"/"chua"
    // is one hyphenated token with no diacritics, so it must still parse as an
    // ID. The placeholder regex is anchored ^...$ on the whole token.
    const memo = `## Hook ledger for this chapter
advance:
- khong-co-nhan-chung "no witnesses" → pressured
- chua-ro-dong-co "unknown motive" → pressured
`;
    const ledger = parseHookLedger(memo, new Set(["khong-co-nhan-chung", "chua-ro-dong-co"]));
    expect(ledger.advance.map((e) => e.id)).toEqual(["khong-co-nhan-chung", "chua-ro-dong-co"]);
  });

  it("treats an entirely absent subsection as empty", () => {
    // A memo may simply omit a subsection; parseHookLedger must return it empty
    // rather than carrying entries across from a sibling subsection.
    const memo = `## Hook ledger for this chapter
open:
- [new] something new || reason
advance:
- H007 "胖虎借条" → planted
`;
    const ledger = parseHookLedger(memo, new Set(["H007"]));
    expect(ledger.resolve).toEqual([]);
    expect(ledger.defer).toEqual([]);
    expect(ledger.advance.map((e) => e.id)).toEqual(["H007"]);
    expect(ledger.newOpenCount).toBe(1);
  });

  it("reclassifies an unknown-ID open: line as a new hook when known IDs are supplied", () => {
    // The luna-28 ch5 failure: a Vietnamese prose lead "Khóa ..." under open:
    // parsed to a bogus truncated ID "Kh" and then failed the contract check.
    const memo = `## Hook ledger for this chapter
open:
- Khóa đường đi của trang hồ sơ bị thiếu || lý do: cần đối chiếu ở chương 6
advance:
- H007 "胖虎借条" → planted → pressured
`;
    const ledger = parseHookLedger(memo, new Set(["H007", "H012"]));
    // The bogus "Kh" open line is now counted as a brand-new hook, not an ID.
    expect(ledger.open).toEqual([]);
    expect(ledger.newOpenCount).toBe(1);
    expect(ledger.advance.map((e) => e.id)).toEqual(["H007"]);
  });

  it("keeps a genuine re-opened known hook under open: as an ID entry", () => {
    const memo = `## Hook ledger for this chapter
open:
- H012 re-opening a previously deferred hook || reason: payoff now due
advance:
- H007 "胖虎借条" → planted
`;
    const ledger = parseHookLedger(memo, new Set(["H007", "H012"]));
    expect(ledger.open.map((e) => e.id)).toEqual(["H012"]);
    expect(ledger.newOpenCount).toBe(0);
  });

  it("does NOT reclassify unknown open: IDs when no known-ID set is supplied", () => {
    // Backward-compatible default: without the authoritative snapshot the
    // parser cannot tell a truncated prose lead from a real re-open, so it
    // preserves the old behavior and leaves strict validation to fail closed.
    const memo = `## Hook ledger for this chapter
open:
- Khóa đường đi của trang hồ sơ
`;
    const ledger = parseHookLedger(memo);
    expect(ledger.open.map((e) => e.id)).toEqual(["Kh"]);
    expect(ledger.newOpenCount).toBe(0);
  });

  it("preserves the raw ledger line on each parsed entry for error feedback", () => {
    const ledger = parseHookLedger(ZH_MEMO);
    expect(ledger.advance[0]!.rawLine).toBe('H007 "胖虎借条" → planted → pressured');
  });
});

describe("validateHookLedger", () => {
  it("passes when draft echoes keyword from each committed ledger entry", () => {
    // Draft mentions 胖虎/借条 (→H007), 雷架 or 焦痕 (→H012), 杂役 or 腰牌 (→H003).
    const draft =
      "林秋在账房找到胖虎借条，又在后巷被雷架焦痕刮到眼角。他摘下杂役腰牌后退入暗处。";
    const violations = validateHookLedger(ZH_MEMO, draft);
    expect(violations).toEqual([]);
  });

  it("flags a warning for each un-echoed advance/resolve entry", () => {
    // Only 胖虎 (H007) present; 雷架/焦痕 (H012) and 杂役/腰牌 (H003) missing.
    const draft = "林秋只摸出胖虎借条，其他都没写。";
    const violations = validateHookLedger(ZH_MEMO, draft);
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.severity === "warning")).toBe(true);
    expect(violations.every((v) => v.verification === "unverified")).toBe(true);
    expect(violations.map((v) => v.description).join(" ")).toContain("H012");
    expect(violations.map((v) => v.description).join(" ")).toContain("H003");
  });

  it("does not turn semantic near-misses into critical failures", () => {
    const memo = `## 本章 hook 账
advance:
- H002 "读数差额" → 主角找到抄表本撕页残留和数字342
`;
    const draft = "我在配电房地板上拨开碎纸屑，背面露出一排数字的下半截：342。旁边还有抄表本撕下来的毛边。";
    const violations = validateHookLedger(memo, draft);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.severity).toBe("warning");
    expect(violations[0]!.verification).toBe("unverified");
    // Display text is Vietnamese, but ruleId MUST stay the historical Chinese
    // string: ruleId is the cross-run reconciliation key recorded on disk.
    expect(violations[0]!.ruleId).toBe("hook 账需语义复核");
    expect(violations[0]!.category).toBe("hook cần đối chiếu ngữ nghĩa");
    expect(violations[0]!.category).not.toMatch(/[一-鿿]/u);
  });

  it("emits Vietnamese description/suggestion with no CJK while pinning the legacy ruleId", () => {
    const memo = `## 本章 hook 账
advance:
- H002 "读数差额" → 主角找到抄表本撕页残留和数字342
`;
    const draft = "我在配电房地板上拨开碎纸屑，背面露出一排数字的下半截：342。旁边还有抄表本撕下来的毛边。";
    const violations = validateHookLedger(memo, draft);
    expect(violations).toHaveLength(1);
    const [issue] = violations;
    // The legacy string is frozen forever: persisted audit runs on disk key
    // findings by ruleId, so localizing it would orphan historical records.
    expect(issue!.ruleId).toBe("hook 账需语义复核");
    expect(issue!.description).not.toMatch(/[一-鿿]/u);
    expect(issue!.suggestion).not.toMatch(/[一-鿿]/u);
    // ...while still carrying the concrete hook id for the reviewer.
    expect(issue!.description).toContain("H002");
    expect(issue!.suggestion).toContain("H002");
  });

  it("does NOT flag hooks that are only under defer", () => {
    // H009 is deferred — keyword 守拙诀 absence is fine.
    const draft = "林秋翻出胖虎借条与雷架焦痕推进情节，随后摘下杂役腰牌。";
    const violations = validateHookLedger(ZH_MEMO, draft);
    expect(violations).toEqual([]);
  });

  it("does NOT flag [new] open entries (they have no pre-existing id)", () => {
    const memo = `## 本章 hook 账
open:
- [new] 新钩子 || 理由
advance:
- H001 "测试项" → x
`;
    const draft = "正文提到测试项的细节。";
    const violations = validateHookLedger(memo, draft);
    expect(violations).toEqual([]);
  });

  it("returns empty array when memo has no ledger section at all", () => {
    const violations = validateHookLedger("## 别的东西\n正文", "draft");
    expect(violations).toEqual([]);
  });

  it("falls back to strict ID match when ledger line has no descriptor", () => {
    const memo = `## 本章 hook 账
advance:
- H1
`;
    // Draft contains H12 — must NOT accidentally satisfy H1 commitment.
    const draft = "剧情涉及 H12 和 H123。";
    const violations = validateHookLedger(memo, draft);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.severity).toBe("warning");
    expect(violations[0]!.description).toContain("H1");
  });

  it("accepts english keyword match for en memos", () => {
    const draft =
      "Lin Qiu finds Huzi's IOU folded inside the ledger and tucks it away. Later he unpins the errand badge before slipping out.";
    const violations = validateHookLedger(EN_MEMO, draft);
    expect(violations).toEqual([]);
  });

  it("flags 揭 1 埋 1 violation when a chapter resolves hooks without opening any", () => {
    const memo = `## 本章 hook 账
advance:
- H007 "胖虎借条" → planted
resolve:
- H003 "杂役腰牌" → 林秋主动摘下
`;
    const draft = "林秋翻看胖虎借条，随后摘下杂役腰牌。";
    const violations = validateHookLedger(memo, draft);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.category).toContain("揭 1 埋 1");
    expect(violations[0]).toMatchObject({ severity: "warning", verification: "unverified" });
  });

  it("accepts 揭 1 埋 1 floor when a [new] line balances the resolved hook", () => {
    const memo = `## 本章 hook 账
open:
- [new] 母亲留下的半枚玉佩 || 理由：下一卷线索
advance:
- H007 "胖虎借条" → planted
resolve:
- H003 "杂役腰牌" → 林秋主动摘下
`;
    const draft = "林秋翻看胖虎借条，随后摘下杂役腰牌。";
    const violations = validateHookLedger(memo, draft);
    expect(violations).toEqual([]);
  });

  it("does not let placeholder 无 raise a false critical", () => {
    const memo = `## 本章 hook 账
open:
- [new] 下一卷伏笔 || 理由
advance:
- 无
resolve:
- H005 "通行印验号" → ok
`;
    const draft = "主峰的通行印验号按部就班完成。";
    const violations = validateHookLedger(memo, draft);
    expect(violations).toEqual([]);
  });

  it("accepts middle keywords from a longer Chinese hook name", () => {
    const memo = `## 本章 hook 账
advance:
- H007 "被定位的安全威胁" → evoked → pressured
`;
    const draft = "旧手机弹出定位结果，林知夏发现店外有人盯梢，安全空间塌了。";
    const violations = validateHookLedger(memo, draft);
    expect(violations).toEqual([]);
  });

  it("derives typed expected hook operations from stable memo hook IDs", () => {
    const activeHooks: StoredHook[] = [
      {
        hookId: "H007",
        startChapter: 1,
        type: "mystery",
        status: "open",
        lastAdvancedChapter: 3,
        expectedPayoff: "胖虎借条",
        notes: "",
      },
      {
        hookId: "H012",
        startChapter: 2,
        type: "mystery",
        status: "progressing",
        lastAdvancedChapter: 4,
        expectedPayoff: "雷架焦痕",
        notes: "",
      },
      {
        hookId: "H003",
        startChapter: 1,
        type: "mystery",
        status: "progressing",
        lastAdvancedChapter: 3,
        expectedPayoff: "杂役腰牌",
        notes: "",
      },
      {
        hookId: "H009",
        startChapter: 1,
        type: "mystery",
        status: "open",
        lastAdvancedChapter: 3,
        expectedPayoff: "守拙诀来历",
        notes: "",
      },
    ];
    const ops = hookOpsFromLedger(ZH_MEMO, { activeHooks, chapterNumber: 12 });
    expect(ops.upsert).toEqual([
      expect.objectContaining({ hookId: "H007", status: "progressing", lastAdvancedChapter: 12 }),
      expect.objectContaining({ hookId: "H012", status: "progressing", lastAdvancedChapter: 12 }),
    ]);
    expect(ops.mention).toEqual([]);
    expect(ops.resolve).toEqual(["H003"]);
    expect(ops.defer).toEqual(["H009"]);
  });

  it("rejects a stable hook ID that is not in the authoritative active snapshot", () => {
    expect(() => hookOpsFromLedger(`## 本章 hook 账\nadvance:\n- H999 fabricated hook`, {
      activeHooks: [],
      chapterNumber: 12,
    })).toThrow(/unknown.*H999/i);
  });

  it("quotes the offending raw line when an advance/defer ID is unknown", () => {
    // advance:/resolve:/defer: are NOT reclassified (they must reference real
    // hooks), so a Vietnamese prose lead there stays fail-closed — but the
    // error now quotes the full line so the correction retry and evidence are
    // diagnosable instead of showing only the truncated token.
    // Note: negation leads ("Không ...") are placeholders since the luna-29
    // fix, so this test uses a non-negation prose lead ("Truy ..." → "Truy").
    expect(() => hookOpsFromLedger(
      `## Hook ledger for this chapter\ndefer:\n- Truy dấu vết của hồ sơ bị thiếu`,
      { activeHooks: [], chapterNumber: 5 },
    )).toThrow(/line "Truy dấu vết của hồ sơ bị thiếu"/u);
  });

  it("keeps a generic advance note without a stable ID as an empty typed operation", () => {
    expect(hookOpsFromLedger(`## 本章 hook 账\nadvance: keep the current pressure moving without naming a stable hook`, {
      activeHooks: [],
      chapterNumber: 12,
    })).toEqual({
      upsert: [],
      mention: [],
      resolve: [],
      defer: [],
    });
  });

  it("does not crash on a Vietnamese prose lead under open: (the luna-28 ch5 'Kh' case)", () => {
    // Before the fix, "Khóa ..." under open: parsed to a bogus ID "Kh", which
    // then hit `knownHooks.get("Kh")!` in the upsert map and threw / produced
    // an unknown-ID error. With the authoritative snapshot supplied, the line
    // is reclassified as a new-hook declaration and simply dropped from ops.
    const ops = hookOpsFromLedger(
      `## Hook ledger for this chapter\nopen:\n- Khóa đường đi của trang hồ sơ || lý do\nadvance:\n- H007 "x" → y\n`,
      { activeHooks: [{ hookId: "H007", startChapter: 1, type: "mystery", status: "open", lastAdvancedChapter: 1, expectedPayoff: "x", notes: "" }], chapterNumber: 5 },
    );
    expect(ops.upsert.map((h) => h.hookId)).toEqual(["H007"]);
    expect(ops.defer).toEqual([]);
    expect(ops.resolve).toEqual([]);
  });
});

describe("assessMemoHookDebtGovernance", () => {
  const debtHook = (hookId: string, overrides: Partial<StoredHook> = {}): StoredHook => ({
    hookId,
    startChapter: 1,
    type: "mystery",
    status: "open",
    lastAdvancedChapter: 1,
    expectedPayoff: "payoff",
    notes: "",
    ...overrides,
  });

  const sixDebtHooks = (): StoredHook[] => [
    debtHook("H001", { payoffTiming: "near-term" }),
    debtHook("H002", { payoffTiming: "immediate" }),
    debtHook("H003", { payoffTiming: "mid-arc" }),
    debtHook("H004", { payoffTiming: "slow-burn" }),
    debtHook("H005"),
    debtHook("H006", { status: "progressing", payoffTiming: "endgame" }),
  ];

  it("stays hands-off below the debt floor", () => {
    const memo = `## Hook ledger for this chapter\nopen:\n- [new] a || reason\n- [new] b || reason\n- [new] c || reason\n- [new] d || reason\ndefer:\n- H001 "x" → not yet`;
    const assessment = assessMemoHookDebtGovernance(memo, {
      activeHooks: [debtHook("H001", { payoffTiming: "near-term" })],
      chapterNumber: 5,
    });
    expect(assessment).toEqual({ compliant: true, violations: [] });
  });

  it("rejects new opens beyond the remaining hook capacity", () => {
    const fullBookHooks = (): StoredHook[] =>
      Array.from({ length: 12 }, (_, index) => debtHook(`H${String(index + 1).padStart(3, "0")}`, { payoffTiming: "mid-arc" }));
    const memo = `## Hook ledger for this chapter\nopen:\n- [new] fresh thread one || reason\n- [new] fresh thread two || reason\nadvance:\n- H001 "x" → open → progressing`;
    const assessment = assessMemoHookDebtGovernance(memo, {
      activeHooks: fullBookHooks(),
      chapterNumber: 11,
      hookCapacity: 12,
    });
    expect(assessment.compliant).toBe(false);
    expect(assessment.violations.join(" ")).toContain("capacity");
  });

  it("allows new opens within the remaining hook capacity", () => {
    const fullBookHooks = (): StoredHook[] =>
      Array.from({ length: 11 }, (_, index) => debtHook(`H${String(index + 1).padStart(3, "0")}`, { payoffTiming: "mid-arc" }));
    const memo = `## Hook ledger for this chapter\nopen:\n- [new] fresh thread || reason\nadvance:\n- H001 "x" → open → progressing`;
    const assessment = assessMemoHookDebtGovernance(memo, {
      activeHooks: fullBookHooks(),
      chapterNumber: 11,
      hookCapacity: 12,
    });
    expect(assessment.compliant).toBe(true);
  });

  it("rejects a high-debt memo that defers every ready hook", () => {
    const memo = `## Hook ledger for this chapter\nopen:\n- [new] fresh mystery || reason\ndefer:\n- H001 "x" → not yet\n- H002 "y" → not yet`;
    const assessment = assessMemoHookDebtGovernance(memo, {
      activeHooks: sixDebtHooks(),
      chapterNumber: 7,
    });
    expect(assessment.compliant).toBe(false);
    expect(assessment.violations.join(" ")).toContain("H001");
  });

  it("accepts a high-debt memo that advances or resolves a ready hook", () => {
    const memo = `## Hook ledger for this chapter\nadvance:\n- H001 "x" → pressured\nresolve:\n- H002 "y" → dossier confirmed`;
    const assessment = assessMemoHookDebtGovernance(memo, {
      activeHooks: sixDebtHooks(),
      chapterNumber: 7,
    });
    expect(assessment).toEqual({ compliant: true, violations: [] });
  });

  it("accepts a promoted hook as ready debt even without near-term timing", () => {
    const memo = `## Hook ledger for this chapter\nadvance:\n- H004 "x" → pressured`;
    const activeHooks = sixDebtHooks().map((hook) =>
      hook.hookId === "H004" ? { ...hook, payoffTiming: "slow-burn", promoted: true } : hook);
    const assessment = assessMemoHookDebtGovernance(memo, {
      activeHooks,
      chapterNumber: 7,
    });
    expect(assessment.compliant).toBe(true);
  });

  it("caps brand-new opens on a high-debt chapter even when ready debt is serviced", () => {
    const memo = `## Hook ledger for this chapter\nopen:\n- [new] a || reason\n- [new] b || reason\n- [new] c || reason\nadvance:\n- H001 "x" → pressured`;
    const assessment = assessMemoHookDebtGovernance(memo, {
      activeHooks: sixDebtHooks(),
      chapterNumber: 7,
    });
    expect(assessment.compliant).toBe(false);
    expect(assessment.violations).toHaveLength(1);
    expect(assessment.violations[0]).toContain("brand-new");
  });

  it("ignores resolved and deferred hooks when counting debt", () => {
    const memo = `## Hook ledger for this chapter\nresolve:\n- H001 "x" → done`;
    const activeHooks = [
      ...sixDebtHooks().slice(0, 5),
      debtHook("H006", { status: "resolved" }),
    ];
    const assessment = assessMemoHookDebtGovernance(memo, {
      activeHooks,
      chapterNumber: 7,
    });
    expect(assessment).toEqual({ compliant: true, violations: [] });
  });
});

describe("canonicalizeMemoHookIds", () => {
  const hook = (hookId: string): StoredHook => ({
    hookId,
    startChapter: 1,
    type: "mystery",
    status: "open",
    lastAdvancedChapter: 1,
    expectedPayoff: "payoff",
    notes: "",
  });

  it("rewrites a uniquely truncated ledger ID to its canonical form", () => {
    const memo = `## Hook ledger for this chapter\nadvance:\n- operational-mystery-quy-khi "demon monkey" → pressured`;
    const canonical = canonicalizeMemoHookIds(memo, [hook("H001"), hook("operational-mystery-quy-khi-khi")]);
    expect(canonical).toContain('- operational-mystery-quy-khi-khi "demon monkey" → pressured');
  });

  it("leaves an ambiguous prefix untouched so strict validation fails closed", () => {
    const memo = `## Hook ledger for this chapter\nadvance:\n- operational-mystery "x" → pressured`;
    const canonical = canonicalizeMemoHookIds(memo, [
      hook("operational-mystery-quy-khi-khi"),
      hook("operational-mystery-gate"),
    ]);
    expect(canonical).toBe(memo);
  });

  it("leaves exact IDs and prose outside the ledger untouched", () => {
    const memo = `## Current task\nThe operational-mystery-quy-khi appears.\n\n## Hook ledger for this chapter\nadvance:\n- H001 "x" → pressured`;
    const canonical = canonicalizeMemoHookIds(memo, [hook("H001"), hook("operational-mystery-quy-khi-khi")]);
    expect(canonical).toBe(memo);
  });
});
