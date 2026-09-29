import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PostWriteViolation } from "./post-write-validator.js";
import { VIETNAMESE_SPELLING_CATALOG } from "./vietnamese-spelling-catalog.js";

const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;
const AGENT_NOTE_RE = /^\s*\[(?:writer|polisher|reviser|reviewer|写作|润色|修订|审稿)-note\]\s*/imu;
const REPEATED_WHITESPACE_RE = /[ \t]{2,}/u;
const REPEATED_PUNCTUATION_RE = /([!?;,。：；！？])\1+/u;

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
  options?: { readonly worldGlossaryTerms?: ReadonlyArray<string> },
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

  return violations;
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
  return [
    ...new Set(
      phrases.filter((phrase) => !known.has(phrase.normalize("NFC").toLocaleLowerCase("vi"))),
    ),
  ];
}

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
