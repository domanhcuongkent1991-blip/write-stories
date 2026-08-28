const UNSAFE_BOOK_ID_RE = /[\u0000-\u001f\u007f/\\:*?"'`{}<>|]/u;

function foldVietnameseForBookId(value: string): string {
  return value
    .replace(/[đĐ]/g, (letter) => letter === "Đ" ? "D" : "d")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFC");
}

export function deriveBookIdFromTitle(title: string): string {
  return foldVietnameseForBookId(title.trim().toLowerCase())
    .replace(/[^a-z0-9\u4e00-\u9fff]/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

export function isSafeBookId(bookId: unknown): bookId is string {
  return (
    typeof bookId === "string"
    && bookId.length > 0
    && bookId.length <= 120
    && bookId.trim() === bookId
    && bookId !== "."
    && bookId !== ".."
    && !bookId.includes("..")
    && !UNSAFE_BOOK_ID_RE.test(bookId)
  );
}

export function assertSafeBookId(bookId: string, label = "bookId"): string {
  if (!isSafeBookId(bookId)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(bookId)}`);
  }
  return bookId;
}
