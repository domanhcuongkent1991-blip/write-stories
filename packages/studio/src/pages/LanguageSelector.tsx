import { useState } from "react";
import { formatLocalizedString } from "../i18n/catalog";
import type { UiLocale } from "../lib/ui-locale";
import type { WritingLanguage } from "../lib/writing-language";

interface LanguageSelectorProps {
  readonly uiLocale: UiLocale;
  readonly onUiLocaleChange: (locale: UiLocale) => void;
  readonly onSelectWritingLanguage: (language: WritingLanguage) => void | Promise<void>;
}

export function LanguageSelector({
  uiLocale,
  onUiLocaleChange,
  onSelectWritingLanguage,
}: LanguageSelectorProps) {
  const [hovering, setHovering] = useState<WritingLanguage | null>(null);
  const [selected, setSelected] = useState<WritingLanguage | null>(null);
  const t = (key: Parameters<typeof formatLocalizedString>[0]) => (
    formatLocalizedString(key, uiLocale)
  );

  const handleWritingLanguageSelect = (language: WritingLanguage) => {
    setSelected(language);
    // Brief pause for the selection animation before transitioning
    setTimeout(() => void onSelectWritingLanguage(language), 400);
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-8">
      {/* Logo — cinematic scale */}
      <div className="mb-16 text-center">
        <div className="flex items-baseline justify-center gap-1.5 mb-4">
          <span className="font-serif text-6xl italic text-primary">Ink</span>
          <span className="text-5xl font-semibold tracking-tight text-foreground">OS</span>
        </div>
        <div className="text-base text-muted-foreground tracking-widest uppercase">Studio</div>
      </div>

      <div className="mb-8 flex gap-0.5 rounded-lg bg-muted/50 p-0.5" aria-label={t("languageSelector.interfaceLanguage")}>
        {(["zh", "en", "vi"] as const).map((locale) => (
          <button
            key={locale}
            type="button"
            onClick={() => onUiLocaleChange(locale)}
            className={`rounded-md px-3 py-1.5 text-base font-medium transition-colors ${
              uiLocale === locale
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {locale === "zh" ? "中" : locale.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Language cards — generous, distinct, immersive */}
      <div className="flex gap-8 mb-16">
        <button
          data-writing-language="zh"
          onClick={() => handleWritingLanguageSelect("zh")}
          onMouseEnter={() => setHovering("zh")}
          onMouseLeave={() => setHovering(null)}
          className={`group w-80 border rounded-lg p-10 text-left transition-all duration-300 ${
            selected === "zh"
              ? "border-primary bg-primary/10 scale-[1.02]"
              : hovering === "zh"
                ? "border-primary/50 bg-card"
                : "border-border bg-card/50"
          }`}
        >
          <div className="font-serif text-3xl mb-4 text-foreground">{t("languageSelector.chineseTitle")}</div>
          <div className="text-base text-foreground/70 leading-relaxed mb-6">
            {t("languageSelector.chineseGenres")}
          </div>
          <div className="text-sm text-muted-foreground">
            {t("languageSelector.chinesePlatforms")}
          </div>
        </button>

        <button
          data-writing-language="en"
          onClick={() => handleWritingLanguageSelect("en")}
          onMouseEnter={() => setHovering("en")}
          onMouseLeave={() => setHovering(null)}
          className={`group w-80 border rounded-lg p-10 text-left transition-all duration-300 ${
            selected === "en"
              ? "border-primary bg-primary/10 scale-[1.02]"
              : hovering === "en"
                ? "border-primary/50 bg-card"
                : "border-border bg-card/50"
          }`}
        >
          <div className="font-serif text-3xl italic mb-4 text-foreground">{t("languageSelector.englishTitle")}</div>
          <div className="text-base text-foreground/70 leading-relaxed mb-6">
            {t("languageSelector.englishGenres")}
          </div>
          <div className="text-sm text-muted-foreground">
            {t("languageSelector.englishPlatforms")}
          </div>
        </button>
      </div>

      <div className="text-sm text-muted-foreground">
        {t("languageSelector.footer")}
      </div>
    </div>
  );
}
