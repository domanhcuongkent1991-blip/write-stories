import type { WritingLanguage } from "@actalk/inkos-core";
import { translateAppString } from "../../lib/app-language";

export interface BookWritingLanguageSelectorProps {
  readonly value: WritingLanguage;
  readonly available: ReadonlyArray<WritingLanguage>;
  readonly disabled?: boolean;
  readonly onChange: (language: WritingLanguage) => void;
  readonly labels?: Readonly<Record<WritingLanguage, string>>;
}

export function BookWritingLanguageSelector({
  value,
  available,
  disabled = false,
  onChange,
  labels,
}: BookWritingLanguageSelectorProps) {
  const resolvedLabels = labels ?? {
    zh: translateAppString("create.writingLanguage.zh"),
    en: translateAppString("create.writingLanguage.en"),
    vi: translateAppString("create.writingLanguage.vi"),
  };
  return (
    <label className="flex min-w-[150px] flex-col gap-1 text-xs text-muted-foreground">
      <span className="font-medium">{resolvedLabels[value] ?? value}</span>
      <select
        aria-label={resolvedLabels[value] ?? value}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value as WritingLanguage)}
        className="h-8 rounded-lg border border-border/50 bg-background px-2 text-sm text-foreground outline-none focus:border-primary/50"
      >
        {available.map((language) => (
          <option key={language} value={language}>{resolvedLabels[language] ?? language}</option>
        ))}
      </select>
    </label>
  );
}
