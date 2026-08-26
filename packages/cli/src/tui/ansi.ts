/* ── ANSI terminal helpers ── zero dependencies ── */

export const reset = "\x1b[0m";
export const bold = "\x1b[1m";
export const dim = "\x1b[2m";
export const italic = "\x1b[3m";

export const red = "\x1b[31m";
export const green = "\x1b[32m";
export const yellow = "\x1b[33m";
export const blue = "\x1b[34m";
export const magenta = "\x1b[35m";
export const cyan = "\x1b[36m";
export const white = "\x1b[37m";
export const gray = "\x1b[90m";
export const brightRed = "\x1b[91m";
export const brightGreen = "\x1b[92m";
export const brightYellow = "\x1b[93m";
export const brightBlue = "\x1b[94m";
export const brightMagenta = "\x1b[95m";
export const brightCyan = "\x1b[96m";
export const brightWhite = "\x1b[97m";

export const bgCyan = "\x1b[46m";
export const bgBlue = "\x1b[44m";
export const bgMagenta = "\x1b[45m";
export const bgGreen = "\x1b[42m";
export const bgYellow = "\x1b[43m";
export const bgRed = "\x1b[41m";
export const bgGray = "\x1b[100m";

export const clearScreen = "\x1b[2J\x1b[H";
export const showCursor = "\x1b[?25h";
export const hideCursor = "\x1b[?25l";
export const clearLine = "\x1b[2K\r";
export const saveCursor = "\x1b[s";
export const restoreCursor = "\x1b[u";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const csiPattern = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const oscPattern = /\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/g;
const zeroWidthCodePointPattern = /^[\p{M}\p{Cc}\p{Cf}]+$/u;
const emojiPattern = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F|\u20E3/u;

export function c(text: string, ...codes: string[]): string {
  return `${codes.join("")}${text}${reset}`;
}

export function termWidth(): number {
  return normalizeTerminalWidth(process.stdout.columns);
}

export function stripAnsi(s: string): string {
  return s.replace(oscPattern, "").replace(csiPattern, "");
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(stripAnsi(text))) {
    if (zeroWidthCodePointPattern.test(segment)) continue;
    if (emojiPattern.test(segment) || [...segment].some((character) => isWideCodePoint(character.codePointAt(0)!))) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

export function normalizeTerminalWidth(value: number | undefined, fallback = 80): number {
  const normalizedFallback = Number.isFinite(fallback) && fallback > 0 ? Math.floor(fallback) : 80;
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : normalizedFallback;
}

export function contentWidth(
  columns: number | undefined,
  reserved: number,
  fallback = 80,
  maximum?: number,
): number {
  const terminal = normalizeTerminalWidth(columns, fallback);
  const bounded = Number.isFinite(maximum) && maximum! > 0
    ? Math.min(terminal, Math.floor(maximum!))
    : terminal;
  const safeReserved = Number.isFinite(reserved) && reserved > 0 ? Math.floor(reserved) : 0;
  return Math.max(1, bounded - safeReserved);
}

export function padToDisplayWidth(text: string, targetWidth: number, minimumGap = 0): string {
  const safeTarget = Number.isFinite(targetWidth) ? Math.max(0, Math.floor(targetWidth)) : 0;
  const safeMinimumGap = Number.isFinite(minimumGap) ? Math.max(0, Math.floor(minimumGap)) : 0;
  const gap = Math.max(safeMinimumGap, safeTarget - displayWidth(text));
  return `${text}${" ".repeat(gap)}`;
}

export function hr(char = "─"): string {
  return char.repeat(contentWidth(termWidth(), 0, 80, 60));
}

export function box(lines: string[], width = 56): string {
  const requestedWidth = Math.max(2, normalizeTerminalWidth(width, 56));
  const renderedWidth = Math.max(requestedWidth, ...lines.map((line) => displayWidth(line) + 2));
  const innerWidth = renderedWidth - 2;
  const top = `╭${"─".repeat(innerWidth)}╮`;
  const bot = `╰${"─".repeat(innerWidth)}╯`;
  const rows = lines.map((line) => `│${padToDisplayWidth(line, innerWidth)}│`);
  return [top, ...rows, bot].join("\n");
}

export function badge(text: string, bg: string, fg: string = brightWhite): string {
  return `${bg}${fg}${bold} ${text} ${reset}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWideCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1b000 && codePoint <= 0x1b001)
    || (codePoint >= 0x1f200 && codePoint <= 0x1f251)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}
