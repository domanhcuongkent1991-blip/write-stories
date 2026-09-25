// Human-readable language names -> ISO codes. Unknown or undetermined
// languages normalize to undefined so style contracts simply stay off.
const LANGUAGE_ALIASES: ReadonlyMap<string, string> = new Map([
  ["chinese (simplified)", "zh"],
  ["chinese (traditional)", "zh"],
  ["chinese", "zh"],
  ["中文", "zh"],
  ["汉语", "zh"],
  ["漢語", "zh"],
  ["简体中文", "zh"],
  ["繁體中文", "zh"],
  ["simplified chinese", "zh"],
  ["vietnamese", "vi"],
  ["viet", "vi"],
  ["tiếng việt", "vi"],
  ["越南语", "vi"],
  ["越南文", "vi"],
  ["english", "en"],
  ["英语", "en"],
  ["英文", "en"],
  ["japanese", "ja"],
  ["日语", "ja"],
  ["日文", "ja"],
  ["日本語", "ja"],
  ["korean", "ko"],
  ["韩语", "ko"],
  ["韩文", "ko"],
  ["한국어", "ko"],
]);

const UNDETERMINED_LANGUAGES: ReadonlySet<string> = new Set(["auto", "自动识别", "autodetect", "undetermined"]);

export function normalizeLanguageCode(value: string): string | undefined {
  const key = value.trim().toLowerCase();
  if (!key || UNDETERMINED_LANGUAGES.has(key)) return undefined;
  if (/^[a-z]{2}(?:-[a-z0-9-]+)?$/.test(key)) return key.slice(0, 2);
  return LANGUAGE_ALIASES.get(key);
}

const ZH_VI_STYLE_CONTRACT = [
  "# STYLE INSTRUCTIONS (zh -> vi)",
  "1. Xưng hô nhất quán: mỗi nhân vật giữ một bộ xưng hô cố định theo quan hệ tôn ti (đệ, sư phụ, hắn, nàng, ta, quý tộc dùng trọng xưng...) xuyên suốt chương; khi glossary note khóa bộ xưng hô thì phải dùng đúng như ghi chú, không đổi theo từng đoạn.",
  "2. Tên riêng theo chính sách Hán-Việt có chọn lọc: tên người và tên môn phái/giáo phái đọc theo âm Hán-Việt (Lý Minh, Thanh Vân Môn); địa danh quen thuộc dùng âm Hán-Việt đã phổ biến, còn lại dịch nghĩa; thuật ngữ và vật phẩm ưu tiên từ Việt tự nhiên (linh thạch, luyện đan...), chỉ Hán-Việt khi không có từ Việt tương ứng.",
  "3. Câu tiếng Việt tự nhiên: không dịch từng chữ, tránh calque trật tự tiếng Trung, tránh lặp trơ 'đã... đã', giữ nhịp câu hội thoại sống động, lời nói của nhân vật dùng cách nói của người Việt.",
  "4. Sát nghĩa nhưng không cứng nhắc: được phép thay đổi cấu trúc câu và lựa chọn từ để câu đọc mượt, miễn không thêm hay bớt ý, không diễn giải thêm, không tóm tắt.",
].join("\n");

// v1 ships only the zh->vi contract; other directions keep the generic prompt.
export function resolveStyleContract(source: string, target: string): string | undefined {
  const from = normalizeLanguageCode(source);
  const to = normalizeLanguageCode(target);
  if (from === "zh" && to === "vi") return ZH_VI_STYLE_CONTRACT;
  return undefined;
}
