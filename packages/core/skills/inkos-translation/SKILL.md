---
name: inkos-translation
description: 长文任意语言互译、术语一致性、分段续跑与章节审校方法。Used by InkOS translation workers.
---
# Long-form translation

Apply this method during translation, glossary prep, refinement, and translation review.

- Preserve meaning, omissions, names, pronouns, chronology, paragraph order, dialogue ownership, formatting intent, tone, and register. Never summarize or expand to make the text easier.
- Translate for natural target-language reading without erasing the source voice. Resolve ambiguity conservatively and record a note when it materially affects meaning.
- Treat the project glossary as persistent authority. Glossary prep samples the head, middle, and tail of the book, extracts recurring entities with categories and aliases, and the owner approves entries in Studio. Locked targets and pinned/approved terms always win; conflicting merges are recorded, never silently overwritten.
- Pass 1 (draft) is a fidelity pass: honor the locked glossary targets, the CAST block (per-character address forms), the zh→vi style contract (consistent pronouns and address sets, selective Sino-Vietnamese renderings, natural Vietnamese cadence), and the inter-batch context (CONTEXT and PREVIOUS TRANSLATION TAIL blocks are for understanding only — never translate them). Glossary filtering keeps terms relevant to the current batch; person and pinned terms are always shown.
- Pass 2 (refine) is a fluency pass: polish the draft, fix address-form and terminology drift against the glossary, and keep the meaning untouched — do not re-translate from scratch, do not add or remove content.
- Keep segment boundaries operational, but read neighboring segments and chapter context as one passage so references and cadence survive batching. The rolling chapter summary connects a chapter to the previous one.
- After refinement, a deterministic QA pass measures glossary adherence (alias-aware), residual CJK characters, address-form consistency over sliding windows, and name variants. Chapter reports feed the Studio QA panel; a hard gate blocks export while residue or failed chapters remain, unless overridden deliberately.
- A parser or provider failure is not a translation-quality verdict. Preserve completed segments and resume from the first unfinished pass. Fix-loop retranslates only selected chapters against the current glossary.
