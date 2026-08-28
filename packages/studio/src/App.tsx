import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import { useHashRoute } from "./hooks/use-hash-route";
import type { HashRoute } from "./hooks/use-hash-route";
import { Sidebar } from "./components/Sidebar";
import { Dashboard } from "./pages/Dashboard";
import { ChatPage } from "./pages/ChatPage";
import { BookDetail } from "./pages/BookDetail";
import { ChapterReader } from "./pages/ChapterReader";
import { Analytics } from "./pages/Analytics";
import { ServiceListPage } from "./pages/ServiceListPage";
import { ServiceDetailPage } from "./pages/ServiceDetailPage";
import { ProjectSettings } from "./pages/ProjectSettings";
import { TruthFiles } from "./pages/TruthFiles";
import { DaemonControl } from "./pages/DaemonControl";
import { LogViewer } from "./pages/LogViewer";
import { GenreManager } from "./pages/GenreManager";
import { StyleManager } from "./pages/StyleManager";
import { TranslationManager } from "./pages/TranslationManager";
import { ImportManager } from "./pages/ImportManager";
import { RadarView } from "./pages/RadarView";
import { DoctorView } from "./pages/DoctorView";
import { StoryPlayer } from "./pages/StoryPlayer";
import { StoryGraphTree } from "./pages/StoryGraphTree";
const FlowView = lazy(() => import("./pages/FlowView"));
const FilmWizard = lazy(() => import("./pages/FilmWizard"));
import { LanguageSelector } from "./pages/LanguageSelector";
import { BookSidebar, BookSidebarToggle } from "./components/chat/BookSidebar";
import { useSSE } from "./hooks/use-sse";
import { useSessionEvents } from "./hooks/use-session-events";
import { useTheme } from "./hooks/use-theme";
import { useI18n } from "./hooks/use-i18n";
import { setAppLanguage } from "./lib/app-language";
import { getUiLocalePreference, type UiLocale } from "./lib/ui-locale";
import {
  resolveProjectWritingLanguage,
  setWritingLanguage,
  type WritingLanguage,
} from "./lib/writing-language";
import { postApi, useApi } from "./hooks/use-api";
import { Menu, Sun, Moon } from "lucide-react";
import { House } from "lucide-react";

export type { HashRoute as Route } from "./hooks/use-hash-route";

export function deriveActiveBookId(route: HashRoute): string | undefined {
  if ("bookId" in route) return route.bookId;
  return undefined;
}

export function isBookCreateChatRoute(route: HashRoute): boolean {
  return route.page === "book-create";
}

export function deriveStartupGate(input: {
  readonly ready: boolean;
  readonly projectError: string | null;
}): "ready" | "loading" | "error" {
  if (input.ready) return "ready";
  return input.projectError ? "error" : "loading";
}

export function createHeaderLocaleSelection(
  setLocale: (locale: UiLocale) => void,
): (locale: UiLocale) => void {
  return (locale) => setLocale(locale);
}

export function syncProjectWritingLanguage(language: unknown): WritingLanguage {
  const resolved = resolveProjectWritingLanguage(language);
  setWritingLanguage(resolved);
  return resolved;
}

export function shouldCloseMobileNavigation(input: {
  readonly key: string;
  readonly defaultPrevented?: boolean;
  readonly nestedDialogOpen?: boolean;
}): boolean {
  return input.key === "Escape" && !input.defaultPrevented && !input.nestedDialogOpen;
}

function getInitialDesktopState(): boolean {
  return typeof window !== "undefined"
    && Boolean(window.matchMedia?.("(min-width: 1024px)").matches);
}

export function App() {
  const { route, setRoute } = useHashRoute();
  const sse = useSSE();
  const { theme, setTheme } = useTheme();
  const { t, locale, setLocale } = useI18n();
  const { data: project, error: projectError, refetch: refetchProject } = useApi<{
    language: string;
    languageExplicit: boolean;
    writingLanguages?: ReadonlyArray<"zh" | "en" | "vi">;
    writingLanguageContractVersion?: string;
  }>("/project");
  const [showLanguageSelector, setShowLanguageSelector] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(getInitialDesktopState);
  const mobileNavOpenButtonRef = useRef<HTMLButtonElement>(null);
  const mobileNavCloseButtonRef = useRef<HTMLButtonElement>(null);
  const mobileNavWasOpen = useRef(false);
  const [ready, setReady] = useState(false);

  const isDark = theme === "dark";

  // Keep the display-only module locale current for helpers that cannot use the React hook.
  // Writing content is synchronized separately from /project.language below.
  setAppLanguage(locale);
  useEffect(() => {
    setAppLanguage(locale);
  }, [locale]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  useEffect(() => {
    if (project) {
      syncProjectWritingLanguage(project.language);
      if (!project.languageExplicit) {
        setShowLanguageSelector(true);
      }
      setReady(true);
    }
  }, [project]);

  const closeMobileNav = useCallback(() => {
    setMobileNavOpen(false);
  }, []);
  const navigate = useCallback((nextRoute: HashRoute) => {
    setMobileNavOpen(false);
    setRoute(nextRoute);
  }, [setRoute]);

  useSessionEvents(sse, route, navigate);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [route]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const desktopQuery = window.matchMedia("(min-width: 1024px)");
    const handleViewportChange = () => {
      setIsDesktop(desktopQuery.matches);
      if (desktopQuery.matches) {
        setMobileNavOpen(false);
      }
    };
    handleViewportChange();
    desktopQuery.addEventListener?.("change", handleViewportChange);
    return () => desktopQuery.removeEventListener?.("change", handleViewportChange);
  }, []);

  useEffect(() => {
    if (mobileNavOpen) {
      mobileNavWasOpen.current = true;
      mobileNavCloseButtonRef.current?.focus();
      return;
    }

    if (!mobileNavWasOpen.current) return;
    mobileNavWasOpen.current = false;
    if (typeof window !== "undefined" && window.matchMedia?.("(min-width: 1024px)").matches) return;
    const openButton = mobileNavOpenButtonRef.current;
    if (openButton?.isConnected) {
      openButton.focus();
    }
  }, [mobileNavOpen]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const nestedDialogOpen = typeof Element !== "undefined"
        && event.target instanceof Element
        && Boolean(event.target.closest('[data-slot="dialog-content"]'));
      const openDialog = typeof document !== "undefined"
        && Boolean(document.querySelector('[data-slot="dialog-content"][data-open]'));
      if (!shouldCloseMobileNavigation({
        key: event.key,
        defaultPrevented: event.defaultPrevented,
        nestedDialogOpen: nestedDialogOpen || openDialog,
      })) {
        return;
      }
      event.preventDefault();
      setMobileNavOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [mobileNavOpen]);

  const selectHeaderLocale = createHeaderLocaleSelection(setLocale);

  const nav = {
    toDashboard: () => navigate({ page: "dashboard" }),
    toChat: () => navigate({ page: "chat" }),
    toBook: (bookId: string) => navigate({ page: "book", bookId }),
    toBookSettings: (bookId: string) => navigate({ page: "book-settings", bookId }),
    toBookCreate: () => navigate({ page: "book-create" }),
    toChapter: (bookId: string, chapterNumber: number) =>
      navigate({ page: "chapter", bookId, chapterNumber }),
    toAnalytics: (bookId: string) => navigate({ page: "analytics", bookId }),
    toServices: () => navigate({ page: "services" }),
    toProjectSettings: () => navigate({ page: "project-settings" }),
    toServiceDetail: (id: string) => navigate({ page: "service-detail", serviceId: id }),
    toTruth: (bookId: string) => navigate({ page: "truth", bookId }),
    toDaemon: () => navigate({ page: "daemon" }),
    toLogs: () => navigate({ page: "logs" }),
    toGenres: () => navigate({ page: "genres" }),
    toStyle: () => navigate({ page: "style" }),
    toTranslation: () => navigate({ page: "translation" }),
    toImport: (tab?: "chapters" | "canon" | "fanfic" | "spinoff" | "imitation") => navigate({ page: "import", ...(tab ? { tab } : {}) }),
    toRadar: () => navigate({ page: "radar" }),
    toDoctor: () => navigate({ page: "doctor" }),
    toPlay: (projectId: string) => navigate({ page: "play", projectId }),
    toFilm: (projectId: string) => navigate({ page: "film", projectId }),
    toFlow: (projectId: string) => navigate({ page: "flow", projectId }),
    toFilmAuthor: (projectId: string) => navigate({ page: "film-author", projectId }),
    toFilmStudio: (projectId: string) => navigate({ page: "film-studio", projectId }),
  };

  const activeBookId = deriveActiveBookId(route);
  const activePage =
    activeBookId
      ? `book:${activeBookId}`
      : route.page === "service-detail"
        ? "services"
        : route.page;

  const startupGate = deriveStartupGate({ ready, projectError });

  if (startupGate === "error") {
    const startupLocale = getUiLocalePreference();
    const errorTitle = startupLocale === "zh"
      ? "无法加载项目配置"
      : startupLocale === "vi"
        ? "Không thể tải cấu hình dự án"
        : startupLocale === "en"
          ? "Failed to load project config"
          : "无法加载项目配置 / Failed to load project config";
    const errorInstruction = startupLocale === "zh"
      ? "请检查项目根目录下的 inkos.json 是否存在且为合法 JSON，然后重试。"
      : startupLocale === "vi"
        ? "Hãy kiểm tra inkos.json trong thư mục gốc của dự án có tồn tại và là JSON hợp lệ, rồi thử lại."
        : startupLocale === "en"
          ? "Check that inkos.json in the project root exists and is valid JSON, then retry."
          : null;
    const retryLabel = startupLocale === "zh"
      ? "重试"
      : startupLocale === "vi"
        ? "Thử lại"
        : startupLocale === "en"
          ? "Retry"
          : "重试 / Retry";

    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-2xl border border-destructive/30 bg-destructive/5 p-6 space-y-4">
          <div>
            <h1 className="text-lg font-semibold text-destructive">{errorTitle}</h1>
            <p className="mt-2 text-sm text-muted-foreground break-all">{projectError}</p>
          </div>
          <p className="text-sm text-muted-foreground">
            {errorInstruction ?? (
              <>
                请检查项目根目录下的 inkos.json 是否存在且为合法 JSON，然后重试。
                <br />
                Check that inkos.json in the project root exists and is valid JSON, then retry.
              </>
            )}
          </p>
          <button
            type="button"
            onClick={() => refetchProject()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            {retryLabel}
          </button>
        </div>
      </div>
    );
  }

  if (startupGate === "loading") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-12 h-12 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (showLanguageSelector) {
    return (
      <LanguageSelector
        uiLocale={locale}
        onUiLocaleChange={setLocale}
        onSelectWritingLanguage={async (lang) => {
          await postApi("/project/language", { language: lang });
          syncProjectWritingLanguage(lang);
          setShowLanguageSelector(false);
          refetchProject();
        }}
      />
    );
  }

  return (
    <div data-testid="app-shell" className="min-h-screen h-dvh bg-background text-foreground flex overflow-hidden font-sans">
      {/* Left Sidebar */}
      {mobileNavOpen && (
        <button
          type="button"
          data-testid="mobile-nav-overlay"
          aria-label={t("common.closeNavigation")}
          onClick={closeMobileNav}
          className="fixed inset-0 z-30 bg-background/50 backdrop-blur-sm lg:hidden"
        />
      )}
      <Sidebar
        nav={nav}
        activePage={activePage}
        sse={sse}
        t={t}
        isDesktop={isDesktop}
        mobileOpen={mobileNavOpen}
        onMobileClose={closeMobileNav}
        mobileCloseButtonRef={mobileNavCloseButtonRef}
      />

      {/* Center Content */}
      <div className="flex-1 flex flex-col min-w-0 bg-background/30 backdrop-blur-sm">
        {/* Header Strip */}
        <header className="h-14 shrink-0 flex items-center justify-between gap-3 px-4 sm:px-6 lg:px-8 border-b border-border/40">
          <div className="flex min-w-0 items-center gap-2">
             <button
               ref={mobileNavOpenButtonRef}
               type="button"
               data-testid="mobile-nav-open"
               aria-controls="app-sidebar"
               aria-expanded={mobileNavOpen}
               aria-label={t("common.openNavigation")}
               onClick={() => setMobileNavOpen(true)}
               className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-card/70 text-foreground hover:bg-secondary/50 transition-colors lg:hidden"
             >
               <Menu size={20} />
             </button>
             <button
               onClick={nav.toDashboard}
               className="inline-flex min-w-0 items-center gap-2 rounded-lg border border-border/50 bg-card/70 px-3.5 py-2 text-[17px] font-semibold text-foreground hover:bg-secondary/50 transition-colors"
             >
               <House size={18} />
               <span className="truncate">{t("bread.home")}</span>
               <span className="shrink-0 text-muted-foreground/70">/</span>
               <span className="truncate font-serif">InkOS Studio</span>
             </button>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <div className="flex gap-0.5 bg-muted/50 rounded-lg p-0.5">
              <button
                onClick={() => selectHeaderLocale("zh")}
                className={`px-2.5 py-1 text-[16px] font-medium rounded-md ${locale === "zh" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              >
                中
              </button>
              <button
                onClick={() => selectHeaderLocale("en")}
                className={`px-2.5 py-1 text-[16px] font-medium rounded-md ${locale === "en" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              >
                EN
              </button>
              <button
                onClick={() => selectHeaderLocale("vi")}
                className={`px-2.5 py-1 text-[16px] font-medium rounded-md ${locale === "vi" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              >
                VI
              </button>
            </div>

            <button
              onClick={() => setTheme(isDark ? "light" : "dark")}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              {isDark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </header>

        {/* Main Content Area */}
        <main className="flex-1 relative min-w-0 overflow-y-auto scroll-smooth">
          {route.page === "dashboard" && (
            <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
              <Dashboard nav={nav} sse={sse} theme={theme} t={t} />
            </div>
          )}
          {isBookCreateChatRoute(route) && (
            <div className="absolute inset-0 flex min-w-0">
              <ChatPage
                mode="book-create"
                nav={nav}
                theme={theme}
                t={t}
                sse={sse}
              />
            </div>
          )}
          {route.page === "chat" && (
            <div className="absolute inset-0 flex min-w-0">
              <ChatPage
                mode="project-chat"
                nav={nav}
                theme={theme}
                t={t}
                sse={sse}
              />
            </div>
          )}
          {route.page === "book" && (
            <div className="absolute inset-0 flex min-w-0">
              <ChatPage
                activeBookId={route.bookId}
                mode="book"
                nav={nav}
                theme={theme}
                t={t}
                sse={sse}
              />
              <BookSidebar bookId={route.bookId} theme={theme} t={t} sse={sse} />
              <BookSidebarToggle bookId={route.bookId} theme={theme} t={t} sse={sse} />
            </div>
          )}
          {route.page === "book-settings" && (
            <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
              <BookDetail bookId={route.bookId} nav={nav} theme={theme} t={t} sse={sse} />
            </div>
          )}
          {route.page === "chapter" && (
            <div className="mx-auto w-full max-w-[1400px] px-4 py-12 sm:px-6 lg:px-10 lg:py-16 2xl:px-12 fade-in">
              <ChapterReader bookId={route.bookId} chapterNumber={route.chapterNumber} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "analytics" && (
            <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
              <Analytics bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "services" && (
            <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
              <ServiceListPage nav={nav} />
            </div>
          )}
          {route.page === "project-settings" && (
            <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
              <ProjectSettings nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "service-detail" && (
            <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
              <ServiceDetailPage serviceId={route.serviceId} nav={nav} />
            </div>
          )}
          {route.page === "truth" && (
            <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
              <TruthFiles bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "daemon" && (
            <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
              <DaemonControl nav={nav} theme={theme} t={t} sse={sse} />
            </div>
          )}
          {route.page === "logs" && (
            <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
              <LogViewer nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "genres" && (
            <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
              <GenreManager nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "style" && (
            <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
              <StyleManager nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "translation" && (
            <div className="max-w-6xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
              <TranslationManager nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "import" && (
            <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
              <ImportManager nav={nav} theme={theme} t={t} initialTab={route.tab} />
            </div>
          )}
          {route.page === "radar" && (
            <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
              <RadarView nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "doctor" && (
            <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
              <DoctorView nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "play" && (
            <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
              <StoryPlayer projectId={route.projectId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "film" && (
            <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
              <StoryGraphTree projectId={route.projectId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "film-author" && (
            <div className="absolute inset-0 flex min-w-0">
              <ChatPage
                activeBookId={route.projectId}
                mode="interactive-film-authoring"
                nav={nav}
                theme={theme}
                t={t}
                sse={sse}
              />
            </div>
          )}
          {route.page === "film-studio" && (
            <Suspense fallback={<div className="p-6 text-sm">{t("workflow.app.loadingCreationWizard")}</div>}>
              <FilmWizard projectId={route.projectId} nav={nav} theme={theme} t={t} sse={sse} />
            </Suspense>
          )}
          {route.page === "flow" && (
            <Suspense fallback={<div className="p-6 text-sm">{t("workflow.app.loadingFlowView")}</div>}>
              <FlowView projectId={route.projectId} nav={nav} theme={theme} t={t} />
            </Suspense>
          )}
        </main>
      </div>
    </div>
  );
}
