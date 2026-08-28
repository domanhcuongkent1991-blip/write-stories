import { z } from "zod";

export const WritingLanguageSchema = z.enum(["zh", "en", "vi"]);
export type WritingLanguage = z.infer<typeof WritingLanguageSchema>;

export const ScaffoldLanguageSchema = z.enum(["zh", "en"]);
export type ScaffoldLanguage = z.infer<typeof ScaffoldLanguageSchema>;

export const PromptStrategySchema = z.enum([
  "legacy-zh",
  "legacy-en",
  "en-scaffold-vi-contract",
]);
export type PromptStrategy = z.infer<typeof PromptStrategySchema>;
