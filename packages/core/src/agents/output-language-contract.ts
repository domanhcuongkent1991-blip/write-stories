import type { LLMMessage } from "../llm/provider.js";
import type { WritingLanguageProfile } from "../utils/language.js";

export const VI_OUTPUT_CONTRACT = [
  "## HOST-ENFORCED VI OUTPUT CONTRACT",
  "English instructions are scaffolding only.",
  "Write all user-visible prose and output fields in natural Vietnamese, including narrative prose, chapter titles, summaries, state descriptions, audit explanations, and revisions.",
  "Keep required machine keys, markers, JSON keys, IDs, enum values, and file paths exactly unchanged.",
  "Required markers such as CHAPTER_TITLE, CHAPTER_CONTENT, UPDATED_STATE, UPDATED_LEDGER, and UPDATED_HOOKS must not be translated.",
  "Do not replace missing required output with Chinese or English prose.",
  "English text in planning documents (outline, hook ledger, payoff promises, notes) is scaffolding only: paraphrase it into natural Vietnamese in-world prose. Never copy an English sentence verbatim into the narrative unless that exact string was already established as a physical artifact in an approved earlier chapter.",
].join("\n");

export function applyOutputLanguageContract(
  messages: ReadonlyArray<LLMMessage>,
  profile: WritingLanguageProfile | undefined,
): ReadonlyArray<LLMMessage> {
  if (profile?.promptStrategy !== "en-scaffold-vi-contract") return messages;

  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex < 0) {
    return [{ role: "system", content: VI_OUTPUT_CONTRACT }, ...messages];
  }

  return messages.map((message, index) => index === systemIndex
    ? { ...message, content: `${message.content}\n\n${VI_OUTPUT_CONTRACT}` }
    : message);
}
