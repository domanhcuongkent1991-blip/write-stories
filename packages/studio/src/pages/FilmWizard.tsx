import { useState, useMemo, useEffect, useCallback } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import type { StringKey } from "../i18n/catalog";
import type { SSEMessage } from "../hooks/use-sse";
import { useNewSSEMessages } from "../hooks/use-sse";
import { useColors } from "../hooks/use-colors";
import { translateAppString } from "../lib/app-language";
import { useApi } from "../hooks/use-api";
import { AnalysisPanel } from "../components/film/AnalysisPanel";
import { ExportBar } from "../components/film/ExportBar";
import {
  WIZARD_PHASES,
  computePhaseProgress,
  computeStaleFlags,
} from "../lib/film-wizard-progress";
import type { Phase, PhaseStatus } from "../lib/film-wizard-progress";
import type { StoryGraph } from "@actalk/inkos-core/interactive-film/graph-schema";
import { ChatPage } from "./ChatPage";
import { StoryGraphTree } from "./StoryGraphTree";
import { StoryPlayer } from "./StoryPlayer";
import FlowView from "./FlowView";

const t = translateAppString;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Superset of all sub-component Nav interfaces.
interface Nav {
  toDashboard: () => void;
  toPlay: (id: string) => void;
  toFlow: (id: string) => void;
  toFilmAuthor: (id: string) => void;
  toFilm: (projectId: string) => void;
  toFilmStudio: (projectId: string) => void;
  toBook: (id: string) => void;
  toServices: () => void;
  toImport: (tab?: "chapters" | "canon" | "fanfic" | "spinoff" | "imitation") => void;
  toStyle: () => void;
}

interface FilmWizardProps {
  projectId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
  sse: { messages: ReadonlyArray<SSEMessage>; connected: boolean };
}

type Colors = ReturnType<typeof useColors>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PHASE_LABEL_KEYS: Record<Phase, StringKey> = {
  world: "workflow.film.world",
  scale: "workflow.film.scale",
  structure: "workflow.film.structure",
  workshop: "workflow.film.nodes",
  validate: "workflow.film.validate",
};


const DEFAULT_SUBVIEW: Record<Phase, string> = {
  world: "chat",
  scale: "scale",
  structure: "flow",
  workshop: "tree",
  validate: "validate",
};

const PHASE_SUBVIEWS: Record<Phase, ReadonlyArray<{ key: string; labelKey: StringKey }>> = {
  world: [
    { key: "chat", labelKey: "workflow.film.chat" },
    { key: "anchor", labelKey: "workflow.film.worldAnchor" },
  ],
  scale: [],
  structure: [
    { key: "flow", labelKey: "workflow.film.flow" },
    { key: "tree", labelKey: "workflow.film.tree" },
  ],
  workshop: [
    { key: "tree", labelKey: "workflow.film.tree" },
    { key: "chat", labelKey: "workflow.film.chat" },
  ],
  validate: [],
};

const EMPTY_PROGRESS: Record<Phase, PhaseStatus> = {
  world: "empty",
  scale: "empty",
  structure: "empty",
  workshop: "empty",
  validate: "empty",
};

const EMPTY_STALE: Record<Phase, boolean> = {
  world: false,
  scale: false,
  structure: false,
  workshop: false,
  validate: false,
};

const FILM_WIZARD_ROOT_CLASS_NAME = "flex h-full min-h-0 flex-col bg-background text-foreground";
const FILM_WIZARD_TOP_BAR_CLASS_NAME = "flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 shrink-0";
const FILM_WIZARD_PHASE_GROUP_CLASS_NAME = "flex w-full min-w-0 flex-wrap items-center gap-3 sm:w-auto sm:flex-1";
const FILM_WIZARD_SUBVIEW_BAR_CLASS_NAME = "flex flex-wrap items-center gap-1 border-b border-border px-4 py-1.5 shrink-0";

export function getFilmWizardRootClassName(): string {
  return FILM_WIZARD_ROOT_CLASS_NAME;
}

export function getFilmWizardTopBarClassName(): string {
  return FILM_WIZARD_TOP_BAR_CLASS_NAME;
}

export function getFilmWizardPhaseGroupClassName(): string {
  return FILM_WIZARD_PHASE_GROUP_CLASS_NAME;
}

export function getFilmWizardSubviewBarClassName(): string {
  return FILM_WIZARD_SUBVIEW_BAR_CLASS_NAME;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function WorldAnchorView({
  graph,
  c,
}: {
  graph: StoryGraph | null;
  c: Colors;
}) {
  if (!graph?.worldAnchor) {
    return (
      <div className={`p-6 text-sm ${c.muted}`}>
        {t("workflow.film.noWorldAnchor")}
      </div>
    );
  }

  const { worldAnchor } = graph;
  return (
    <div className="p-4 space-y-3 text-sm" data-testid="film-world">
      <div>
        <div className={`text-xs font-medium mb-1 ${c.muted}`}>{t("workflow.film.storyCore")}</div>
        <div className="text-foreground">{worldAnchor.storyCore || "—"}</div>
      </div>
      <div className="flex gap-6">
        <div>
          <div className={`text-xs font-medium mb-1 ${c.muted}`}>{t("workflow.film.theme")}</div>
          <div>{worldAnchor.theme || "—"}</div>
        </div>
        <div>
          <div className={`text-xs font-medium mb-1 ${c.muted}`}>{t("workflow.film.genre")}</div>
          <div>{worldAnchor.genre || "—"}</div>
        </div>
        {worldAnchor.durationMinutes > 0 && (
          <div>
            <div className={`text-xs font-medium mb-1 ${c.muted}`}>{t("workflow.film.duration")}</div>
            <div>{worldAnchor.durationMinutes} {t("workflow.film.minutes")}</div>
          </div>
        )}
      </div>
      {worldAnchor.worldRules && (
        <div>
          <div className={`text-xs font-medium mb-1 ${c.muted}`}>{t("workflow.film.worldRules")}</div>
          <div className="whitespace-pre-wrap">{worldAnchor.worldRules}</div>
        </div>
      )}
      {graph.characters.length > 0 && (
        <div>
          <div className={`text-xs font-medium mb-2 ${c.muted}`}>{t("workflow.film.mainCharacters")}</div>
          <ul className="space-y-2">
            {graph.characters.map((ch) => (
              <li key={ch.id} className="flex items-start gap-2">
                <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded border border-border ${c.muted}`}>
                  {ch.role}
                </span>
                <span>
                  <span className="font-medium text-foreground">{ch.name}</span>
                  {ch.motivation && (
                    <span className={` ml-2 ${c.muted}`}>{ch.motivation}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ScalePlaceholderView({ c }: { c: Colors }) {
  return (
    <div className={`p-6 text-sm ${c.muted}`} data-testid="film-scale-placeholder">
      {t("workflow.film.scaleHint")}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main wizard component
// ---------------------------------------------------------------------------

export default function FilmWizard({
  projectId,
  nav,
  theme,
  t,
  sse,
}: FilmWizardProps) {
  const c = useColors(theme);
  const [phase, setPhase] = useState<Phase>("world");
  const [subViews, setSubViews] = useState<Record<Phase, string>>({ ...DEFAULT_SUBVIEW });
  const [showPreview, setShowPreview] = useState(false);

  const { data: graph, refetch: refetchGraph } = useApi<StoryGraph>(`/projects/${projectId}/story-graph`);

  useEffect(() => {
    void refetchGraph();
  }, [phase, refetchGraph]);

  const handleSseMessage = useCallback((msg: SSEMessage) => {
    if (msg.event !== "agent:complete") return;
    const data = msg.data as { activeBookId?: string } | null;
    if (data?.activeBookId !== projectId) return;
    void refetchGraph();
  }, [projectId, refetchGraph]);

  useNewSSEMessages(sse.messages, handleSseMessage);

  const progress = useMemo<Record<Phase, PhaseStatus>>(
    () => (graph ? computePhaseProgress(graph) : EMPTY_PROGRESS),
    [graph],
  );

  const stale = useMemo<Record<Phase, boolean>>(
    () => (graph ? computeStaleFlags(graph, undefined, 0) : EMPTY_STALE),
    [graph],
  );

  const currentSubView = subViews[phase];
  const subviews = PHASE_SUBVIEWS[phase];

  function handlePhaseClick(p: Phase) {
    setShowPreview(false);
    setPhase(p);
  }

  function handleSubViewClick(key: string) {
    setSubViews({ ...subViews, [phase]: key });
  }

  function handlePreviewToggle() {
    setShowPreview((v) => !v);
  }

  return (
    <div data-testid="film-wizard" className={getFilmWizardRootClassName()}>

      {/* ── Phase stepper top bar ── */}
      <div className={getFilmWizardTopBarClassName()}>
        <div className={getFilmWizardPhaseGroupClassName()}>
          <button
            type="button"
            data-testid="wizard-exit"
            onClick={nav.toDashboard}
            className={c.link}
          >
            ← {t("workflow.film.interactiveFilms")}
          </button>
          <div className="flex min-w-0 flex-wrap items-center gap-1">
          {WIZARD_PHASES.map((p, i) => {
            const isActive = phase === p && !showPreview;
            const status = progress[p];
            return (
              <button
                key={p}
                type="button"
                data-testid={`wizard-step-${p}`}
                onClick={() => handlePhaseClick(p)}
                className={[
                  "relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-all",
                  isActive ? c.btnPrimary : c.btnSecondary,
                ].join(" ")}
              >
                {stale[p] && (
                  <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-destructive" />
                )}
                <span
                  className={[
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold tabular-nums",
                    status === "done"
                      ? "border-current bg-current/25"
                      : status === "partial"
                        ? "border-current/80"
                        : "border-current/40 opacity-70",
                  ].join(" ")}
                >
                  {i + 1}
                </span>
                <span>{t(PHASE_LABEL_KEYS[p])}</span>
              </button>
            );
          })}
          </div>
        </div>

        <button
          type="button"
          data-testid="wizard-preview"
          onClick={handlePreviewToggle}
          className={[
            "ml-auto shrink-0 flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium",
            showPreview ? c.btnPrimary : c.btnSecondary,
          ].join(" ")}
        >
          {t("workflow.film.play")}
        </button>
      </div>

      {/* ── Sub-view switch bar ── */}
      {!showPreview && subviews.length > 0 && (
        <div className={getFilmWizardSubviewBarClassName()}>
          {subviews.map((sv) => (
            <button
              key={sv.key}
              type="button"
              data-testid={`wizard-subview-${sv.key}`}
              onClick={() => handleSubViewClick(sv.key)}
              className={[
                "rounded px-3 py-1 text-sm font-medium transition-colors",
                currentSubView === sv.key ? c.btnPrimary : c.btnSecondary,
              ].join(" ")}
            >
              {t(sv.labelKey)}
            </button>
          ))}
        </div>
      )}

      {/* ── Main content area ── */}
      <div className="flex-1 min-h-0 overflow-auto">
        <MainArea
          showPreview={showPreview}
          phase={phase}
          subView={currentSubView}
          projectId={projectId}
          nav={nav}
          theme={theme}
          t={t}
          sse={sse}
          graph={graph}
          c={c}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main area switcher (extracted to keep FilmWizard clean)
// ---------------------------------------------------------------------------

interface MainAreaProps {
  showPreview: boolean;
  phase: Phase;
  subView: string;
  projectId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
  sse: { messages: ReadonlyArray<SSEMessage>; connected: boolean };
  graph: StoryGraph | null;
  c: Colors;
}

function MainArea({
  showPreview,
  phase,
  subView,
  projectId,
  nav,
  theme,
  t,
  sse,
  graph,
  c,
}: MainAreaProps) {
  // Content-type views need the same comfortable padding the standalone routes
  // get from App's page wrapper; the wizard's main area is full-bleed, so embed
  // them in a centered, padded column. Canvas (flow) and full-bleed (chat) opt out.
  const contentWrap = "mx-auto w-full max-w-4xl px-6 py-6";

  if (showPreview) {
    return (
      <div className={contentWrap}>
        <StoryPlayer projectId={projectId} nav={nav} theme={theme} t={t} embedded />
      </div>
    );
  }

  if (phase === "world" && subView === "chat") {
    return (
      <div className="h-full relative overflow-hidden">
        <ChatPage
          activeBookId={projectId}
          mode="interactive-film-authoring"
          nav={nav}
          theme={theme}
          t={t}
          sse={sse}
        />
      </div>
    );
  }

  if (phase === "world" && subView === "anchor") {
    return <WorldAnchorView graph={graph} c={c} />;
  }

  if (phase === "scale") {
    return <ScalePlaceholderView c={c} />;
  }

  if (phase === "structure" && subView === "flow") {
    return <FlowView projectId={projectId} nav={nav} theme={theme} t={t} embedded />;
  }

  if (
    (phase === "structure" && subView === "tree") ||
    (phase === "workshop" && subView === "tree")
  ) {
    return (
      <div className={contentWrap}>
        <StoryGraphTree projectId={projectId} nav={nav} theme={theme} t={t} embedded />
      </div>
    );
  }

  if (phase === "workshop" && subView === "chat") {
    return (
      <div className="h-full relative overflow-hidden">
        <ChatPage
          activeBookId={projectId}
          mode="interactive-film-authoring"
          nav={nav}
          theme={theme}
          t={t}
          sse={sse}
        />
      </div>
    );
  }

  if (phase === "validate") {
    return (
      <div className={`${contentWrap} space-y-4`}>
        <AnalysisPanel projectId={projectId} theme={theme} />
        <ExportBar projectId={projectId} theme={theme} />
      </div>
    );
  }

  return null;
}
