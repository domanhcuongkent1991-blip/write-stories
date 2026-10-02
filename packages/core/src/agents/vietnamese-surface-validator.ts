import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AuditIssue } from "./continuity.js";
import type { PostWriteViolation } from "./post-write-validator.js";
import { VIETNAMESE_SPELLING_CATALOG } from "./vietnamese-spelling-catalog.js";

export interface CharacterPronounRule {
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly allowed: ReadonlyArray<string>;
  readonly denied: ReadonlyArray<string>;
}

export interface VietnameseSurfaceOptions {
  readonly worldGlossaryTerms?: ReadonlyArray<string>;
  readonly characterPronouns?: ReadonlyArray<CharacterPronounRule>;
  readonly plannerHookLabels?: ReadonlyArray<string>;
}

const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;
const AGENT_NOTE_RE = /^\s*\[(?:writer|polisher|reviser|reviewer|写作|润色|修订|审稿)-note\]\s*/imu;
const REPEATED_WHITESPACE_RE = /[ \t]{2,}/u;
const REPEATED_PUNCTUATION_RE = /([!?;,。：；！？])\1+/u;
const LATIN_LETTER_RE = /[A-Za-z\u00C0-\u1EF9]/g;
const VI_MARKED_CHAR_RE =
  /[ăâêôơưđáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/gi;

const DELIMITER_PAIRS = [
  { open: "“", close: "”", label: "dấu ngoặc kép cong" },
  { open: "‘", close: "’", label: "dấu nháy đơn cong" },
  { open: "(", close: ")", label: "ngoặc tròn" },
  { open: "[", close: "]", label: "ngoặc vuông" },
  { open: "{", close: "}", label: "ngoặc nhọn" },
  { open: "「", close: "」", label: "ngoặc thoại" },
  { open: "『", close: "』", label: "ngoặc thoại kép" },
] as const;

export function validateVietnameseSurface(
  content: string,
  options?: VietnameseSurfaceOptions,
): ReadonlyArray<PostWriteViolation> {
  const violations: PostWriteViolation[] = [];

  for (const entry of VIETNAMESE_SPELLING_CATALOG) {
    let from = 0;
    let occurrence = 0;
    while (true) {
      const index = content.indexOf(entry.wrong, from);
      if (index < 0) break;
      occurrence += 1;
      const contextStart = Math.max(0, index - 40);
      const contextEnd = Math.min(content.length, index + entry.wrong.length + 40);
      violations.push({
        rule: "vi-known-spelling",
        severity: "error",
        description: `Phát hiện lỗi chính tả đã biết: "${entry.wrong}".`,
        suggestion: `Thay bằng "${entry.right}".`,
        repairScope: "local",
        repairTarget: "prose",
        verification: "verified",
        repairHint: {
          kind: "exact-replacement",
          targetText: entry.wrong,
          replacementText: entry.right,
          occurrenceIndexes: [occurrence],
          context: content.slice(contextStart, contextEnd),
        },
      });
      from = index + entry.wrong.length;
    }
  }

  if (CJK_RE.test(content)) {
    violations.push({
      rule: "vi-cjk-leak",
      severity: "error",
      description: "Nội dung tiếng Việt chứa ký tự CJK ngoài ý muốn.",
      suggestion: "Thay ký tự CJK bằng nội dung tiếng Việt tương ứng.",
    });
  }

  // Output-language guard: a Vietnamese book whose prose is almost entirely
  // unmarked Latin (e.g. English) must not pass the surface gate.
  {
    const latinChars = countMatches(content, LATIN_LETTER_RE);
    const markedChars = countMatches(content, VI_MARKED_CHAR_RE);
    if (latinChars >= 400 && markedChars / latinChars < 0.02) {
      violations.push({
        rule: "vi-output-language-mismatch",
        severity: "error",
        description:
          "Chương gần như không chứa ký tự tiếng Việt có dấu — nghi ngờ văn bản bị viết bằng ngôn ngữ khác (ví dụ tiếng Anh) thay vì tiếng Việt.",
        suggestion:
          "Viết lại toàn bộ nội dung bằng tiếng Việt theo hợp đồng ngôn ngữ xuất (writingLanguage = vi) trước khi chốt chương.",
      });
    }
  }

  if (AGENT_NOTE_RE.test(content)) {
    violations.push({
      rule: "vi-agent-note-leak",
      severity: "error",
      description: "Nội dung chứa ghi chú nội bộ của agent.",
      suggestion: "Xóa dòng ghi chú nội bộ trước khi chốt chương.",
    });
  }

  if (REPEATED_WHITESPACE_RE.test(content)) {
    violations.push({
      rule: "vi-repeated-whitespace",
      severity: "warning",
      description: "Nội dung chứa khoảng trắng ngang lặp lại.",
      suggestion: "Chuẩn hóa khoảng trắng giữa các từ.",
    });
  }

  if (REPEATED_PUNCTUATION_RE.test(content)) {
    violations.push({
      rule: "vi-repeated-punctuation",
      severity: "warning",
      description: "Nội dung chứa dấu câu lặp lại bất thường.",
      suggestion: "Rà soát và giữ lại dấu câu cần thiết.",
    });
  }

  for (const pair of DELIMITER_PAIRS) {
    const openCount = countOccurrences(content, pair.open);
    const closeCount = countOccurrences(content, pair.close);
    if (openCount !== closeCount) {
      violations.push({
        rule: "vi-unbalanced-delimiter",
        severity: "warning",
        description: `${pair.label} không cân bằng (${openCount}/${closeCount}).`,
        suggestion: `Kiểm tra lại cặp ${pair.open}${pair.close}.`,
      });
    }
  }

  const straightQuoteCount = countOccurrences(content, '"');
  if (straightQuoteCount % 2 !== 0) {
    violations.push({
      rule: "vi-unbalanced-delimiter",
      severity: "warning",
      description: "Dấu ngoặc kép thẳng không cân bằng.",
      suggestion: "Đóng dấu ngoặc kép còn thiếu hoặc đổi sang cặp dấu phù hợp.",
    });
  }

  const machinePhraseCount = countMatches(content, VI_MACHINE_PHRASE_RE);
  if (machinePhraseCount >= 3) {
    violations.push({
      rule: "vi-prose-machine-phrase",
      severity: "warning",
      description: `Phát hiện ${machinePhraseCount} cụm từ dẫn đường kiểu máy (khung "không chỉ… mà", "từ đó phản ánh", "nhìn chung", "có thể nói"…).`,
      suggestion: "Chuyển các cụm này thành hành động, thoại hoặc ý nói trực tiếp của nhân vật; giữ tối đa 1-2 lần trong toàn chương.",
    });
  }

  if ((options?.worldGlossaryTerms?.length ?? 0) > 0) {
    const known = new Set(
      (options?.worldGlossaryTerms ?? []).map((term) => term.normalize("NFC").toLocaleLowerCase("vi")),
    );
    const unknownForeign = collectUnknownForeignNames(content, known);
    if (unknownForeign.length > 0) {
      violations.push({
        rule: "vi-world-glossary-unknown-name",
        severity: "warning",
        description: `Tên riêng ngoại văn chưa có trong sổ tay: ${unknownForeign.join(", ")}.`,
        suggestion:
          "Bổ sung cách viết tiếng Việt chuẩn vào story/world_glossary.md cho các tên trên, rồi dùng đúng cách viết đã ghi trong sổ.",
      });
    }
  }

  if (options?.characterPronouns?.length) {
    violations.push(...checkPronounMismatches(content, options.characterPronouns));
  }

  if (options?.plannerHookLabels?.length) {
    const leak = checkPlannerLabelLeak(content, options.plannerHookLabels);
    if (leak) violations.push(leak);
  }

  return violations;
}

/**
 * Deterministic surface findings must keep their repair target when they cross
 * into the audit pipeline: decideAudit refuses to route a chapter to the
 * reviser when a verified critical blocker has no repairTarget, so dropping
 * the field here silently turns every surface error into an unrepairable fail.
 */
export function toAuditIssuesFromSurface(
  violations: ReadonlyArray<PostWriteViolation>,
  options?: { readonly includeSource?: boolean },
): ReadonlyArray<AuditIssue> {
  return violations.map((violation) => ({
    severity: violation.severity === "error" ? "critical" as const : "warning" as const,
    category: violation.rule,
    ruleId: violation.rule,
    verification: "verified" as const,
    description: violation.description,
    suggestion: violation.suggestion,
    ...(options?.includeSource ? { source: "deterministic" as const } : {}),
    ...(violation.repairScope ? { repairScope: violation.repairScope } : {}),
    ...(violation.repairTarget ? { repairTarget: violation.repairTarget } : {}),
    ...(violation.repairHint ? {
      repairScope: violation.repairScope ?? "local",
      repairTarget: violation.repairTarget ?? "prose",
      verification: "verified" as const,
      repairHint: violation.repairHint,
    } : {}),
  }));
}

// ---------------------------------------------------------------------------
// vi-pronoun-mismatch — narrative pronouns must honor story/roles/ locks.
// Only pronoun positions that read as the SUBJECT of their clause are judged;
// mid-sentence object uses ("nhìn hắn") stay untouched because they may refer
// to someone else entirely.
// ---------------------------------------------------------------------------

const QUOTED_SPEECH_RE = /[“][^“”]*[”]|"[^"]*"/gu;
const NARRATIVE_PRONOUN_VARIANTS = [
  "hắn ta", "nàng ta", "bà ta", "ông ta", "cô ta", "anh ta", "lão ta", "gã ta",
  "hắn", "nàng", "bà", "ông", "anh", "cô", "lão", "cậu", "gã", "mụ", "nó", "y", "ta", "họ", "chúng",
];
const PRONOUN_CONNECTOR_RE = /^(?:rồi|và|nhưng|bèn|liền|vẫn|lại|thế|thế là|sau đó|cuối cùng)\s+/iu;
const CLAUSE_SPLIT_RE = /[;:—–,]\s*|\n+/u;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function viWordRegExp(phrase: string, flags = "u"): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{M}])${escapeRegExp(phrase)}(?![\\p{L}\\p{M}])`, flags);
}

function stripQuotedSpeech(content: string): string {
  return content.replace(QUOTED_SPEECH_RE, " ");
}

function splitNarrativeSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function beginsWithNarrativePronoun(clause: string): string | undefined {
  const stripped = clause.replace(PRONOUN_CONNECTOR_RE, "");
  const variants = [...NARRATIVE_PRONOUN_VARIANTS].sort((a, b) => b.length - a.length);
  for (const variant of variants) {
    const match = stripped.match(
      new RegExp(`^${escapeRegExp(variant)}(?![\\p{L}\\p{M}])`, "iu"),
    );
    if (match) return variant.replace(/\s+ta$/u, "");
  }
  return undefined;
}

// "Triệu Mẫn đã tỉnh." — a proper-noun subject the role ledger does not know
// about takes over the narration; the anaphora chain must sever here or the
// next "hắn/nàng" gets blamed on the previous (wrong) character.
function opensWithUnknownProperNoun(clause: string): boolean {
  const match = clause.match(/^([\p{Lu}][\p{L}\p{M}'’-]*)(?:\s+[\p{Lu}][\p{L}\p{M}'’-]*)?/u);
  if (!match) return false;
  return isUnknownProperToken(match[1]!);
}

// “Ngụy Vinh nhìn Triệu Mẫn. Hắn lập tức cúi đầu.” — once an unknown proper
// noun is on stage the pronoun reference is ambiguous, so the chain severs
// even when the sentence opens with a locked character (who may be the object).
function sentenceContainsUnknownProperNoun(sentence: string, rules: ReadonlyArray<CharacterPronounRule>): boolean {
  for (const match of sentence.matchAll(/[\p{Lu}][\p{L}\p{M}'’-]*(?:\s+[\p{Lu}][\p{L}\p{M}'’-]*)?/gu)) {
    const token = match[0]!;
    if (token.length < 2) continue;
    if (!isUnknownProperToken(token)) continue;
    if (rules.some((rule) => rule.aliases.some((alias) => viWordRegExp(alias).test(token)))) continue;
    return true;
  }
  return false;
}

function isUnknownProperToken(token: string): boolean {
  if (token.length < 2) return false;
  const first = token.split(/\s+/u)[0]!.toLocaleLowerCase("vi");
  if (COMMON_VI_SENTENCE_WORDS.has(first)) return false;
  if (NARRATIVE_PRONOUN_VARIANTS.some((variant) => variant.toLocaleLowerCase("vi") === first)) return false;
  if (PRONOUN_CONNECTOR_RE.test(token)) return false;
  return true;
}

function beginsWithAlias(
  clause: string,
  rules: ReadonlyArray<CharacterPronounRule>,
): CharacterPronounRule | undefined {
  const aliases = rules
    .flatMap((rule) => rule.aliases.map((alias) => ({ alias, rule })))
    .sort((a, b) => b.alias.length - a.alias.length);
  for (const { alias, rule } of aliases) {
    if (viWordRegExp(alias).test(clause.slice(0, alias.length + 1))) {
      return rule;
    }
  }
  return undefined;
}

function mentionsAnyAlias(sentence: string, rules: ReadonlyArray<CharacterPronounRule>): boolean {
  return rules.some((rule) => rule.aliases.some((alias) => viWordRegExp(alias).test(sentence)));
}

function checkPronounMismatches(
  content: string,
  rules: ReadonlyArray<CharacterPronounRule>,
): ReadonlyArray<PostWriteViolation> {
  const usable = rules.filter((rule) => rule.denied.length > 0);
  if (usable.length === 0) return [];

  const narration = stripQuotedSpeech(content);
  const sentences = splitNarrativeSentences(narration);
  const counts = new Map<string, { rule: CharacterPronounRule; pronoun: string; count: number }>();

  let subject: CharacterPronounRule | null = null;
  for (const sentence of sentences) {
    // An unknown proper noun on stage makes every pronoun reference in the
    // sentence ambiguous — the chain severs and stays severed for this
    // sentence, even when the sentence opens with a locked character (who may
    // well be the object, not the subject).
    const unknownProperInSentence = sentenceContainsUnknownProperNoun(sentence, usable);
    const clauses = sentence.split(CLAUSE_SPLIT_RE);
    for (let index = 0; index < clauses.length; index += 1) {
      const clause = clauses[index]?.trim() ?? "";
      if (!clause) continue;
      const pronoun = beginsWithNarrativePronoun(clause);
      if (index === 0) {
        const aliasRule = beginsWithAlias(clause, usable);
        if (unknownProperInSentence) {
          subject = null;
        } else if (aliasRule) {
          subject = aliasRule;
        } else if (mentionsAnyAlias(sentence, usable)) {
          subject = null;
        } else if (!pronoun && opensWithUnknownProperNoun(clause)) {
          subject = null;
        }
      } else if (!unknownProperInSentence) {
        const aliasRule = beginsWithAlias(clause, usable);
        if (aliasRule) subject = aliasRule;
      }
      if (index === 0 && pronoun && subject) {
        // A denied pronoun still names the tracked subject (record it);
        // a pronoun outside the lock only severs the anaphora chain.
        if (!subject.denied.includes(pronoun) && !subject.allowed.includes(pronoun)) {
          subject = null;
        }
      }
      if (pronoun && subject && subject.denied.includes(pronoun)) {
        const key = `${subject.name}\u0000${pronoun}`;
        const entry = counts.get(key);
        if (entry) entry.count += 1;
        else counts.set(key, { rule: subject, pronoun, count: 1 });
      }
    }
  }

  return [...counts.values()].map(({ rule, pronoun, count }) => ({
    rule: "vi-pronoun-mismatch",
    severity: "error" as const,
    description: `Nhân vật "${rule.name}" bị cấm đại từ trần thuật "${pronoun}" (sổ vai trong story/roles/) nhưng văn dùng ${count} chỗ ở vị trí chủ ngữ mệnh đề.`,
    suggestion: rule.allowed[0]
      ? `Đổi các chỗ trần thuật nói về "${rule.name}" sang đại từ "${rule.allowed[0]}"; giữ nguyên đại từ trong thoại.`
      : `Gọi tên "${rule.name}" thay vì dùng đại từ trần thuật "${pronoun}".`,
    repairScope: "local",
    repairTarget: "prose",
  }));
}

// ---------------------------------------------------------------------------
// vi-planner-label-leak — hook-type labels from pending_hooks must never
// reach the prose surface (they read like system jargon inside the story).
// ---------------------------------------------------------------------------

function checkPlannerLabelLeak(
  content: string,
  labels: ReadonlyArray<string>,
): PostWriteViolation | undefined {
  const narration = stripQuotedSpeech(content);
  const found = [...new Set(
    labels.filter((label) => label.trim().length >= 4 && /[a-z]/i.test(label))
      .map((label) => label.trim())
      .filter((label) => viWordRegExp(label, "giu").test(narration)),
  )];
  if (found.length === 0) return undefined;
  return {
    rule: "vi-planner-label-leak",
    severity: "error",
    description: `Nhãn hệ thống planner lộ vào văn: ${found.join(", ")}.`,
    suggestion:
      "Nén các nhãn hệ thống (loại hook, trạng thái kế hoạch) thành văn thường — không đưa thuật ngữ planner vào truyện.",
    repairScope: "local",
    repairTarget: "prose",
  };
}

// ---------------------------------------------------------------------------
// story/roles/ parsing — Vietnamese_Pronoun section is the authority for
// which narrative pronoun each character locks to.
// ---------------------------------------------------------------------------

const HONORIFIC_PRONOUN_TOKENS = new Set(["ta", "chúng ta", "ngươi", "tôi", "mình"]);

function extractMarkdownSection(markdown: string, heading: string): string | undefined {
  const pattern = new RegExp(`^##\\s*${escapeRegExp(heading)}\\s*$`, "im");
  const start = markdown.search(pattern);
  if (start < 0) return undefined;
  const bodyStart = markdown.indexOf("\n", start);
  if (bodyStart < 0) return "";
  const rest = markdown.slice(bodyStart + 1);
  const nextHeading = rest.search(/^##\s/m);
  return (nextHeading < 0 ? rest : rest.slice(0, nextHeading)).trim();
}

function extractQuotedTokens(text: string): string[] {
  return [...text.matchAll(/[“']([^“”']+)[”']|["]([^"]+)["]/gu)]
    .map((match) => match[1] ?? match[2] ?? "")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function addPronounToken(
  target: Set<string>,
  raw: string,
  name: string,
  nameTokens: ReadonlySet<string>,
): void {
  const base = raw.trim().replace(/\s+ta$/u, "");
  const lowered = base.toLocaleLowerCase("vi");
  if (!lowered) return;
  if (HONORIFIC_PRONOUN_TOKENS.has(lowered)) return;
  if (lowered === name.toLocaleLowerCase("vi")) return;
  if (nameTokens.has(lowered)) return;
  target.add(base);
}

export function parseCharacterPronounRule(
  roleFileName: string,
  markdown: string,
): CharacterPronounRule | undefined {
  const section = extractMarkdownSection(markdown, "Vietnamese_Pronoun");
  if (section === undefined) return undefined;

  const displayName = roleFileName.replace(/\s*[(（][^)）]*[)）]\s*$/u, "").trim();
  const nameTokens = new Set(displayName.split(/\s+/).map((token) => token.toLocaleLowerCase("vi")));
  const allowed = new Set<string>();
  const denied = new Set<string>();

  for (const sentence of splitNarrativeSentences(section.replace(/\n+/u, " "))) {
    const deniedIndex = sentence.search(/(?:CẤM|KHÔNG|không)\s+dùng/iu);
    const before = deniedIndex >= 0 ? sentence.slice(0, deniedIndex) : sentence;
    const after = deniedIndex >= 0 ? sentence.slice(deniedIndex) : "";
    if (/đại từ/iu.test(before)) {
      for (const token of extractQuotedTokens(before)) addPronounToken(allowed, token, displayName, nameTokens);
    }
    for (const token of extractQuotedTokens(after)) addPronounToken(denied, token, displayName, nameTokens);
    for (const paren of [...after.matchAll(/[(（]([^()（）]+)[)）]/gu)].map((match) => match[1] ?? "")) {
      if (!paren.includes("/")) continue;
      for (const item of paren.split("/")) addPronounToken(denied, item, displayName, nameTokens);
    }
  }

  return { name: roleFileName, aliases: [], allowed: [...allowed], denied: [...denied] };
}

export function parsePendingHookTypeLabels(pendingHooksMarkdown: string): string[] {
  const rows = pendingHooksMarkdown
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|"));
  if (rows.length === 0) return [];

  const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  const headerIndex = rows.findIndex((line) => cells(line).some((cell) => cell.toLocaleLowerCase("vi") === "loại"));
  if (headerIndex < 0) return [];
  const typeColumn = cells(rows[headerIndex]!).findIndex((cell) => cell.toLocaleLowerCase("vi") === "loại");

  const labels = new Set<string>();
  for (const line of rows.slice(headerIndex + 1)) {
    const value = cells(line)[typeColumn] ?? "";
    if (!value || /^[-\s]*$/.test(value)) continue;
    labels.add(value);
  }
  return [...labels];
}

// ---------------------------------------------------------------------------
// bookDir readers — thin IO wrappers over the parsers above.
// ---------------------------------------------------------------------------

export async function readCharacterPronounRules(bookDir: string): Promise<CharacterPronounRule[]> {
  const rolesDir = join(bookDir, "story", "roles");
  let entries: string[] = [];
  try {
    entries = await collectRoleFiles(rolesDir);
  } catch {
    return [];
  }
  const rules: CharacterPronounRule[] = [];
  for (const filePath of entries) {
    try {
      const markdown = await readFile(filePath, "utf-8");
      const rule = parseCharacterPronounRule(
        filePath.replace(/\\/gu, "/").split("/").pop()?.replace(/\.md$/u, "") ?? "",
        markdown,
      );
      if (rule) rules.push(rule);
    } catch {
      // Unreadable role file must never break the write pipeline.
    }
  }
  return attachCharacterAliases(rules);
}

async function collectRoleFiles(dir: string): Promise<string[]> {
  const collected: string[] = [];
  const dirents = await readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    const path = join(dir, dirent.name);
    if (dirent.isDirectory()) collected.push(...await collectRoleFiles(path));
    else if (dirent.isFile() && dirent.name.endsWith(".md")) collected.push(path);
  }
  return collected;
}

function attachCharacterAliases(rules: ReadonlyArray<CharacterPronounRule>): CharacterPronounRule[] {
  const displayNameOf = (name: string) => name.replace(/\s*[(（][^)）]*[)）]\s*$/u, "").trim();
  const tokenOwners = new Map<string, number>();
  for (const rule of rules) {
    for (const token of displayNameOf(rule.name).split(/\s+/)) {
      if (token.length < 2) continue;
      const lowered = token.toLocaleLowerCase("vi");
      tokenOwners.set(lowered, (tokenOwners.get(lowered) ?? 0) + 1);
    }
  }
  return rules.map((rule) => {
    const displayName = displayNameOf(rule.name);
    const aliases = new Set<string>([displayName]);
    for (const token of displayName.split(/\s+/)) {
      if (!/^\p{Lu}/u.test(token) || token.length < 2) continue;
      if ((tokenOwners.get(token.toLocaleLowerCase("vi")) ?? 0) > 1) continue;
      aliases.add(token);
    }
    return { ...rule, aliases: [...aliases] };
  });
}

export async function readPlannerHookLabels(bookDir: string): Promise<string[]> {
  try {
    const markdown = await readFile(join(bookDir, "story", "pending_hooks.md"), "utf-8");
    return parsePendingHookTypeLabels(markdown);
  } catch {
    return [];
  }
}

const VI_MACHINE_PHRASE_RE =
  /không chỉ[^.!?]{0,60}?(?:mà (?:còn|là)|mà còn)|từ đó (?:phản ánh|cho thấy)|nhìn chung|có thể nói|đáng để (?:nói|bàn)|quả thật vậy|không thể phủ nhận/giu;

function countMatches(content: string, pattern: RegExp): number {
  return [...content.matchAll(pattern)].length;
}

const FOREIGN_NAME_RE = /[A-Za-z][A-Za-z'’-]{3,}/gu;

function collectUnknownForeignNames(
  content: string,
  known: ReadonlySet<string>,
): string[] {
  const tokens = [...content.matchAll(FOREIGN_NAME_RE)].map((match) => ({
    value: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  const phrases: string[] = [];
  let current: { value: string; start: number; end: number } | null = null;
  for (const token of tokens) {
    if (current && token.start - current.end === 1 && content[current.end] === " ") {
      current = {
        value: `${current.value} ${token.value}`,
        start: current.start,
        end: token.end,
      };
    } else {
      if (current) phrases.push(current.value);
      current = { ...token };
    }
  }
  if (current) phrases.push(current.value);

  const knownTokens = new Set(
    [...known].flatMap((name) => name.split(" ")),
  );
  return [
    ...new Set(
      phrases.filter((phrase) => {
        if (known.has(phrase.normalize("NFC").toLocaleLowerCase("vi"))) {
          return false;
        }
        const words = phrase.split(" ");
        // Token lẻ của tên đã biết trong sổ tay ("Rowan" ⊂ "Rowan Vale").
        if (words.every((w) => knownTokens.has(w.toLocaleLowerCase("vi")))) {
          return false;
        }
        // Cụm thuần từ tiếng Việt thuần ASCII ("rung thanh", "Không quanh"...).
        if (words.every((w) => COMMON_VI_SENTENCE_WORDS.has(w.toLocaleLowerCase("vi")))) {
          return false;
        }
        return true;
      }),
    ),
  ];
}

// Từ tiếng Việt thuần ASCII hay đứng đầu câu — không phải tên riêng ngoại văn.
const COMMON_VI_SENTENCE_WORDS = new Set<string>([
  "tôi", "chúng", "hắn", "cô", "ông", "bà", "anh", "em", "không", "chưa",
  "nhưng", "khi", "nếu", "đó", "đây", "nó", "và", "còn", "đã", "sẽ", "thì",
  "trong", "ngoài", "trên", "dưới", "quanh", "sau", "trước", "vậy", "thật",
  "rồi", "mỗi", "như", "tất", "mọi", "người", "ngay", "chính", "lần",
  "tiếng", "hai", "ba", "bốn", "năm", "điều", "cách", "lúc", "chỗ", "đang",
  "cũng", "một", "những", "các", "con", "cái", "việc", "tranh", "thanh",
  "rung", "trong", "phải", "cần", "làm", "nói", "nhìn", "nghe", "đem",
  "bước", "giữa", "theo", "cho", "của", "với", "từ", "này", "kia", "ấy",
] as const);

export async function readWorldGlossaryTerms(bookDir: string): Promise<string[]> {
  try {
    const markdown = await readFile(join(bookDir, "story", "world_glossary.md"), "utf-8");
    return parseWorldGlossaryTerms(markdown);
  } catch {
    return [];
  }
}

export function parseWorldGlossaryTerms(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|"))
    .map((line) => line.trim().replace(/^\|/, "").split("|")[0]?.trim() ?? "")
    .filter((cell) => cell && cell !== "Tên nguyên bản" && !/^[^A-Za-z0-9À-ỹ]+$/.test(cell));
}

function countOccurrences(content: string, needle: string): number {
  return [...content].filter((character) => character === needle).length;
}
