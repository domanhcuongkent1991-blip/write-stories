export interface VietnameseSpellingCatalogEntry {
  readonly id: string;
  readonly wrong: string;
  readonly right: string;
}

export const VIETNAMESE_SPELLING_CATALOG: ReadonlyArray<VietnameseSpellingCatalogEntry> = Object.freeze([
  { id: "vi-spelling-muoi-bon", wrong: "mười mốn", right: "mười bốn" },
  { id: "vi-spelling-kho-khoc", wrong: "dry khốc", right: "khô khốc" },
  { id: "vi-spelling-am-thanh", wrong: "Sound tivi", right: "Âm thanh tivi" },
  { id: "vi-spelling-niem-phong", wrong: "xé niêm phong niêm nhựa", right: "xé niêm phong nhựa" },
]);
