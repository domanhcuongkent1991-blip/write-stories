import { useMemo, useState, useCallback } from "react";
import { useApi, buildApiUrl } from "../hooks/use-api";
import { useColors } from "../hooks/use-colors";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { visibleChoices, applyEffects, initVarState, type VarState } from "@actalk/inkos-core/interactive-film/evaluator";
import type { StoryGraph, Choice } from "@actalk/inkos-core/interactive-film/graph-schema";

interface Nav { toDashboard: () => void }

const STORY_PLAYER_HUD_CLASS_NAME = "max-h-[min(40dvh,16rem)] w-full max-w-full space-y-1 overflow-y-auto rounded-lg border border-border bg-card/95 px-4 py-3 shadow-lg backdrop-blur-sm lg:fixed lg:bottom-6 lg:right-6 lg:w-auto lg:max-w-[calc(100vw-3rem)]";
const STORY_PLAYER_HUD_ROW_CLASS_NAME = "flex min-w-0 items-start justify-between gap-4 text-xs";
const STORY_PLAYER_CHOICE_CLASS_NAME = "w-full break-words text-left px-5 py-4 border border-border rounded-xl hover:bg-muted/40 transition-colors";

export function getStoryPlayerHudClassName(): string {
  return STORY_PLAYER_HUD_CLASS_NAME;
}

export function getStoryPlayerHudRowClassName(): string {
  return STORY_PLAYER_HUD_ROW_CLASS_NAME;
}

export function getStoryPlayerChoiceClassName(): string {
  return STORY_PLAYER_CHOICE_CLASS_NAME;
}

export function StoryPlayer({
  projectId,
  nav,
  theme,
  t,
  embedded = false,
}: {
  projectId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
  embedded?: boolean;
}) {
  const c = useColors(theme);
  const { data: graph, loading, error } = useApi<StoryGraph>(`/projects/${projectId}/story-graph`);

  const startId = useMemo(
    () => graph?.nodes.find((n) => n.type === "start")?.id ?? graph?.nodes[0]?.id ?? null,
    [graph],
  );

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [vars, setVars] = useState<VarState>({});
  const [unlocked, setUnlocked] = useState<string[]>([]);
  const [started, setStarted] = useState(false);

  const reset = useCallback(() => {
    setVars(graph ? initVarState(graph.variables) : {});
    setCurrentId(startId);
    setUnlocked([]);
    setStarted(true);
  }, [graph, startId]);

  if (loading) return <div className={c.muted}>{t("common.loading")}</div>;
  if (error) return <div className="text-destructive">{t("common.error")}: {error}</div>;
  if (!graph) return null;

  if (!started || !currentId) {
    return (
      <div className="space-y-6" data-testid="player-start-screen">
        {!embedded && <button onClick={nav.toDashboard} className={c.link} data-testid="player-back">← {t("bread.books")}</button>}
        <h1 className="text-2xl font-semibold">{graph.title}</h1>
        <button
          onClick={reset}
          data-testid="player-start"
          className={`px-6 py-3 rounded-lg ${c.btnPrimary}`}
        >开始游玩</button>
      </div>
    );
  }

  const node = graph.nodes.find((n) => n.id === currentId);
  if (!node) return <div className="text-destructive">节点缺失：{currentId}</div>;

  const isEnding = node.type === "ending";
  const choices = visibleChoices(node, vars);

  const onChoose = (targetNodeId: string, effects: Choice["effects"]) => {
    setVars((s) => applyEffects(s, effects));
    setCurrentId(targetNodeId);
    const target = graph.nodes.find((n) => n.id === targetNodeId);
    if (target?.type === "ending" && !unlocked.includes(target.id)) {
      setUnlocked((u) => [...u, target.id]);
    }
  };

  return (
    <div className="space-y-6 relative" data-testid="player-screen">
      {!embedded && <button onClick={nav.toDashboard} className={c.link} data-testid="player-back">← {t("bread.books")}</button>}
      <h2 className="text-xl font-medium" data-testid="player-node-title">{node.title}</h2>

      {node.imageSlot?.assetRef && (
        <img
          data-testid="player-image"
          src={buildApiUrl('/project/files/' + node.imageSlot.assetRef.split('/').map(encodeURIComponent).join('/')) ?? undefined}
          alt={node.title}
          className="w-full rounded-lg mb-4"
          loading="lazy"
        />
      )}

      {node.sceneDesc && <p className={`italic ${c.muted}`}>{node.sceneDesc}</p>}

      {node.dialogue.length > 0 && (
        <div className="space-y-3">
          {node.dialogue.map((line, i) => (
            <div key={i}>
              <div className="text-primary text-xs uppercase tracking-wider">{line.speaker}</div>
              <div className="text-sm">{line.text}</div>
            </div>
          ))}
        </div>
      )}

      {isEnding ? (
        <div className="border rounded-xl p-8 text-center space-y-4" data-testid="player-ending">
          <div className="text-xs uppercase tracking-widest text-primary" data-testid="player-ending-type">
            {graph.endings.find((e) => e.nodeId === node.id)?.type ?? "ending"}
          </div>
          <div className="text-lg" data-testid="player-ending-title">
            {graph.endings.find((e) => e.nodeId === node.id)?.title ?? node.title}
          </div>
          <div className={c.muted} data-testid="player-unlocked">
            已解锁结局 {unlocked.length} / {graph.endings.length}
          </div>
          <button onClick={reset} data-testid="player-restart" className={`px-5 py-2 rounded ${c.btnSecondary}`}>
            重新开始
          </button>
        </div>
      ) : (
        <div className="space-y-2" data-testid="player-choices">
          {choices.map((choice) => (
            <button
              key={choice.id}
              data-testid={`choice-${choice.id}`}
              onClick={() => onChoose(choice.targetNodeId, choice.effects)}
              className={getStoryPlayerChoiceClassName()}
            >
              {choice.text}
            </button>
          ))}
          {choices.length === 0 && <div className="text-destructive" data-testid="player-deadend">此路不通</div>}
        </div>
      )}

      {graph.variables.length > 0 && (
        <div className={getStoryPlayerHudClassName()} data-testid="player-hud">
          {graph.variables.map((v) => (
            <div key={v.name} className={getStoryPlayerHudRowClassName()}>
              <span className={`min-w-0 flex-1 break-words ${c.muted}`}>{v.name}</span>
              <span className="shrink-0 font-mono text-primary" data-testid={`hud-${v.name}`}>
                {String(vars[v.name] ?? v.default)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
