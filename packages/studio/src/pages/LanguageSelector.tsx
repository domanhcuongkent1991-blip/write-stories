import { useEffect, useRef, useState } from "react";
import { formatLocalizedString } from "../i18n/catalog";
import type { UiLocale } from "../lib/ui-locale";
import type { WritingLanguage } from "../lib/writing-language";

interface LanguageSelectorProps {
  readonly uiLocale: UiLocale;
  readonly onUiLocaleChange: (locale: UiLocale) => void;
  readonly onSelectWritingLanguage: (language: WritingLanguage) => void | Promise<void>;
}

export interface WritingLanguageSelectionController {
  select: (language: WritingLanguage) => void;
  updateOnSelect: (onSelect: (language: WritingLanguage) => void | Promise<void>) => void;
  activate: () => void;
  deactivate: () => void;
}

export function createWritingLanguageSelectionController(
  onSelect: (language: WritingLanguage) => void | Promise<void>,
  setSelected: (language: WritingLanguage | null) => void,
  setPending: (pending: boolean) => void,
  schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> = setTimeout,
  cancelScheduled: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout,
): WritingLanguageSelectionController {
  let currentOnSelect = onSelect;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = true;
  let lifecycle = 0;

  const deactivate = () => {
    if (timer !== null) cancelScheduled(timer);
    timer = null;
    active = false;
    lifecycle += 1;
    pending = false;
  };

  const activate = () => {
    active = true;
    lifecycle += 1;
  };

  const select = (language: WritingLanguage) => {
    if (pending || !active) return;
    pending = true;
    setPending(true);
    setSelected(language);
    const selectionLifecycle = lifecycle;
    timer = schedule(() => {
      timer = null;
      void Promise.resolve().then(() => currentOnSelect(language)).catch(() => {
        if (!active || lifecycle !== selectionLifecycle) return;
        pending = false;
        setPending(false);
        setSelected(null);
      });
    }, 400);
  };

  return { select, updateOnSelect: (next) => { currentOnSelect = next; }, activate, deactivate };
}

export function createWritingLanguageButtonProps(
  controller: WritingLanguageSelectionController,
  language: WritingLanguage,
) {
  return {
    "data-writing-language": language,
    onClick: () => controller.select(language),
  };
}

export function LanguageSelector({
  uiLocale,
  onUiLocaleChange,
  onSelectWritingLanguage,
}: LanguageSelectorProps) {
  const [hovering, setHovering] = useState<WritingLanguage | null>(null);
  const [selected, setSelected] = useState<WritingLanguage | null>(null);
  const [pending, setPending] = useState(false);
  const controllerRef = useRef<WritingLanguageSelectionController | null>(null);
  const t = (key: Parameters<typeof formatLocalizedString>[0]) => (
    formatLocalizedString(key, uiLocale)
  );

  if (controllerRef.current === null) {
    controllerRef.current = createWritingLanguageSelectionController(
      onSelectWritingLanguage,
      setSelected,
      setPending,
    );
  } else {
    controllerRef.current.updateOnSelect(onSelectWritingLanguage);
  }

  useEffect(() => {
    controllerRef.current?.activate();
    return () => {
      controllerRef.current?.deactivate();
    };
  }, []);

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
          {...createWritingLanguageButtonProps(controllerRef.current, "zh")}
          disabled={pending}
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
          {...createWritingLanguageButtonProps(controllerRef.current, "en")}
          disabled={pending}
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
