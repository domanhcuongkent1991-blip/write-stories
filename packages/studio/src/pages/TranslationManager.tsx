import { useEffect, useMemo, useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { fetchJson, useApi } from "../hooks/use-api";
import { Check, ChevronDown, Download, FileText, Languages, Loader2, Play, Upload, BookA, Trash2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { filterModelGroups } from "./chat-page-state";

interface Nav { toDashboard: () => void }

interface TranslationSummary {
  readonly projectId: string;
  readonly title: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly chapters: number;
}

interface TranslationListResponse {
  readonly translations: ReadonlyArray<TranslationSummary>;
}

interface TranslationManifest {
  readonly projectId: string;
  readonly title: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly chapters: ReadonlyArray<{ readonly number: number; readonly title: string; readonly status: string }>;
}

interface TranslationDetailResponse {
  readonly manifest: TranslationManifest;
  readonly report: string;
  readonly chapters?: ReadonlyArray<{
    readonly number: number;
    readonly title: string;
    readonly status: string;
    readonly segments: ReadonlyArray<{
      readonly index: number;
      readonly source: string;
      readonly target: string;
      readonly notes?: string;
    }>;
  }>;
}

interface TranslationUploadResponse {
  readonly storedPath: string;
  readonly size: number;
  readonly mimeType: string;
}

interface TranslationCreateResponse {
  readonly projectId: string;
  readonly title: string;
}

interface TranslationRunResponse {
  readonly translatedSegments: number;
  readonly reviewedChapters: number;
  readonly reportPath: string;
  readonly skillIds?: ReadonlyArray<string>;
}

interface ModelGroup {
  readonly service: string;
  readonly label: string;
  readonly models: ReadonlyArray<{ readonly id: string; readonly name?: string }>;
}

interface TranslationExportResponse {
  readonly outputPath: string;
  readonly format: string;
}

interface GlossaryTerm {
  readonly source: string;
  readonly target: string;
  readonly note?: string;
  readonly category?: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly origin?: string;
  readonly pinned?: boolean;
}

interface GlossaryResponse {
  readonly version: number;
  readonly terms: ReadonlyArray<GlossaryTerm>;
}

interface TranslationPrepResponse {
  readonly terms: ReadonlyArray<unknown>;
  readonly conflicts: ReadonlyArray<unknown>;
  readonly sampleCount: number;
}

interface TranslationQaReport {
  readonly number: number;
  readonly passed: boolean;
  readonly metrics: {
    readonly adherence: number;
    readonly cjkResidue: number;
    readonly addressVariants: number;
    readonly variants: number;
  };
}

interface TranslationQaResponse {
  readonly reports: ReadonlyArray<TranslationQaReport>;
}

const GLOSSARY_CATEGORIES = [
  "person",
  "place",
  "organization",
  "sect",
  "technique",
  "item",
  "other",
] as const;

function termKey(term: GlossaryTerm): string {
  return term.source.trim().toLowerCase();
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const LANGUAGE_PRESETS_ZH = [
  "自动识别",
  "中文（简体）",
  "中文（繁体）",
  "英语",
  "日语",
  "韩语",
  "法语",
  "德语",
  "西班牙语",
  "葡萄牙语",
  "俄语",
  "阿拉伯语",
  "印尼语",
  "越南语",
  "泰语",
  "意大利语",
  "土耳其语",
] as const;

const LANGUAGE_PRESETS_EN = [
  "Auto detect",
  "Chinese (Simplified)",
  "Chinese (Traditional)",
  "English",
  "Japanese",
  "Korean",
  "French",
  "German",
  "Spanish",
  "Portuguese",
  "Russian",
  "Arabic",
  "Indonesian",
  "Vietnamese",
  "Thai",
  "Italian",
  "Turkish",
] as const;

export function TranslationManager({ nav, theme, t }: { nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const isZh = t("nav.connected") === "已连接";
  const languagePresets = isZh ? LANGUAGE_PRESETS_ZH : LANGUAGE_PRESETS_EN;
  const { data, loading, error, refetch } = useApi<TranslationListResponse>("/translations");
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<TranslationDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState<"upload" | "create" | "run" | "export" | "prep" | "glossarySave" | "">("");
  const [file, setFile] = useState<File | null>(null);
  const [uploaded, setUploaded] = useState<TranslationUploadResponse | null>(null);
  const [title, setTitle] = useState("");
  const [sourceLanguage, setSourceLanguage] = useState(isZh ? "自动识别" : "Auto detect");
  const [targetLanguage, setTargetLanguage] = useState(isZh ? "中文（简体）" : "English");
  const [segmentMaxChars, setSegmentMaxChars] = useState(1200);
  const [runModel, setRunModel] = useState("");
  const [runService, setRunService] = useState("");
  const [runBatchSize, setRunBatchSize] = useState(8);
  const [modelGroups, setModelGroups] = useState<ReadonlyArray<ModelGroup>>([]);
  const [modelSearch, setModelSearch] = useState("");
  const [previewChapterNumber, setPreviewChapterNumber] = useState<number | null>(null);
  const [view, setView] = useState<"preview" | "glossary" | "qa">("preview");
  const [glossary, setGlossary] = useState<ReadonlyArray<GlossaryTerm>>([]);
  const [glossaryLoading, setGlossaryLoading] = useState(false);
  const [newTerm, setNewTerm] = useState({ source: "", target: "", category: "other" });
  const [qaReports, setQaReports] = useState<ReadonlyArray<TranslationQaReport>>([]);
  const [qaLoading, setQaLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const services = await fetchJson<{ services: ReadonlyArray<{ service: string; connected: boolean }> }>("/services");
        const bank = await fetchJson<{ groups: ReadonlyArray<ModelGroup> }>("/services/models").catch(() => ({ groups: [] }));
        const custom = await fetchJson<{ groups: ReadonlyArray<ModelGroup> }>("/services/models/custom").catch(() => ({ groups: [] }));
        if (cancelled) return;
        const connected = new Set(services.services.filter((s) => s.connected).map((s) => s.service));
        setModelGroups(
          [...bank.groups, ...custom.groups].filter((g) => connected.has(g.service) && g.models.length > 0),
        );
      } catch {
        if (!cancelled) setModelGroups([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const filteredModelGroups = useMemo(() => filterModelGroups(modelGroups, modelSearch), [modelGroups, modelSearch]);

  const runSelectionLabel = useMemo(() => {
    if (!runModel) return t("translation.modelDefault");
    const group = modelGroups.find((g) => g.service === runService);
    const model = group?.models.find((m) => m.id === runModel);
    return group ? `${group.label} · ${model?.name ?? runModel}` : runModel;
  }, [runModel, runService, modelGroups, t]);

  const translations = data?.translations ?? [];
  const selected = useMemo(
    () => translations.find((item) => item.projectId === selectedId) ?? translations[0],
    [translations, selectedId],
  );

  useEffect(() => {
    if (!selected?.projectId) {
      setDetail(null);
      setPreviewChapterNumber(null);
      return;
    }
    setDetailLoading(true);
    fetchJson<TranslationDetailResponse>(`/translations/${encodeURIComponent(selected.projectId)}`)
      .then((nextDetail) => {
        setDetail(nextDetail);
        setPreviewChapterNumber(nextDetail.chapters?.[0]?.number ?? nextDetail.manifest.chapters[0]?.number ?? null);
      })
      .catch((err) => setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setDetailLoading(false));
  }, [selected?.projectId]);

  const previewChapter = useMemo(() => {
    const chapters = detail?.chapters ?? [];
    return chapters.find((chapter) => chapter.number === previewChapterNumber) ?? chapters[0] ?? null;
  }, [detail?.chapters, previewChapterNumber]);

  const uploadFile = async () => {
    if (!file) return;
    setBusy("upload");
    setStatus("");
    try {
      const dataUrl = await fileToDataUrl(file);
      const res = await fetchJson<TranslationUploadResponse>("/translations/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, dataUrl }),
      });
      setUploaded(res);
      if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/u, ""));
      setStatus(isZh ? `已上传：${res.storedPath}` : `Uploaded: ${res.storedPath}`);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy("");
    }
  };

  const createProject = async () => {
    if (!uploaded?.storedPath) return;
    setBusy("create");
    setStatus("");
    try {
      const res = await fetchJson<TranslationCreateResponse>("/translations/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath: uploaded.storedPath,
          sourceLanguage,
          targetLanguage,
          title: title.trim() || undefined,
          segmentMaxChars,
        }),
      });
      setSelectedId(res.projectId);
      setStatus(isZh ? `已创建翻译项目：${res.title}` : `Created translation project: ${res.title}`);
      await refetch();
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy("");
    }
  };

  const runProject = async () => {
    if (!selected?.projectId) return;
    setBusy("run");
    setStatus("");
    try {
      const res = await fetchJson<TranslationRunResponse>(`/translations/${encodeURIComponent(selected.projectId)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchSize: runBatchSize || 8,
          model: runModel || undefined,
          service: runService || undefined,
        }),
      });
      setStatus(isZh
        ? `翻译 ${res.translatedSegments} 段，审校 ${res.reviewedChapters} 章。${res.skillIds?.length ? `Skill：${res.skillIds.join(" · ")}。` : ""}报告：${res.reportPath}`
        : `Translated ${res.translatedSegments} segments, reviewed ${res.reviewedChapters} chapters. ${res.skillIds?.length ? `Skills: ${res.skillIds.join(" · ")}. ` : ""}Report: ${res.reportPath}`);
      await refetch();
      const updated = await fetchJson<TranslationDetailResponse>(`/translations/${encodeURIComponent(selected.projectId)}`);
      setDetail(updated);
      setPreviewChapterNumber(updated.chapters?.[0]?.number ?? updated.manifest.chapters[0]?.number ?? null);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy("");
    }
  };

  const exportProject = async (format: "md" | "txt" | "epub") => {
    if (!selected?.projectId) return;
    setBusy("export");
    setStatus("");
    try {
      const res = await fetchJson<TranslationExportResponse>(`/translations/${encodeURIComponent(selected.projectId)}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format }),
      });
      setStatus(isZh ? `已导出 ${format}: ${res.outputPath}` : `Exported ${format}: ${res.outputPath}`);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy("");
    }
  };

  const loadGlossary = async (projectId: string) => {
    setGlossaryLoading(true);
    try {
      const res = await fetchJson<GlossaryResponse>(`/translations/${encodeURIComponent(projectId)}/glossary`);
      setGlossary([...res.terms]);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGlossaryLoading(false);
    }
  };

  const loadQaReports = async (projectId: string) => {
    setQaLoading(true);
    try {
      const res = await fetchJson<TranslationQaResponse>(`/translations/${encodeURIComponent(projectId)}/qa`);
      setQaReports([...res.reports].sort((a, b) => a.number - b.number));
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setQaLoading(false);
    }
  };

  useEffect(() => {
    if (!selected?.projectId) return;
    if (view === "glossary") void loadGlossary(selected.projectId);
    if (view === "qa") void loadQaReports(selected.projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selected?.projectId]);

  const switchView = (next: "preview" | "glossary" | "qa") => {
    setView(next);
    if (next === "glossary" && selected?.projectId) void loadGlossary(selected.projectId);
    if (next === "qa" && selected?.projectId) void loadQaReports(selected.projectId);
  };

  const saveGlossary = async () => {
    if (!selected?.projectId) return;
    setBusy("glossarySave");
    setStatus("");
    try {
      const res = await fetchJson<GlossaryResponse>(`/translations/${encodeURIComponent(selected.projectId)}/glossary`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terms: glossary }),
      });
      setGlossary([...res.terms]);
      setStatus(isZh ? `已保存术语表：${res.terms.length} 条` : `Saved glossary: ${res.terms.length} terms`);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy("");
    }
  };

  const prepGlossary = async () => {
    if (!selected?.projectId) return;
    setBusy("prep");
    setStatus("");
    try {
      const res = await fetchJson<TranslationPrepResponse>(`/translations/${encodeURIComponent(selected.projectId)}/prep`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      await loadGlossary(selected.projectId);
      setStatus(isZh
        ? `术语表准备完成：${res.terms.length} 条，冲突 ${res.conflicts.length} 个。`
        : `Glossary prep finished: ${res.terms.length} terms, ${res.conflicts.length} conflict(s).`);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy("");
    }
  };

  const addGlossaryTerm = () => {
    if (!newTerm.source.trim() || !newTerm.target.trim()) return;
    setGlossary((current) => [
      ...current.filter((term) => termKey(term) !== newTerm.source.trim().toLowerCase()),
      {
        source: newTerm.source.trim(),
        target: newTerm.target.trim(),
        category: newTerm.category,
        origin: "approved",
      },
    ]);
    setNewTerm({ source: "", target: "", category: "other" });
  };

  const updateGlossaryTerm = (key: string, patch: Partial<GlossaryTerm>) => {
    setGlossary((current) => current.map((term) => (termKey(term) === key ? { ...term, ...patch } : term)));
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button>
        <span className="text-border">/</span>
        <span>{t("nav.translation")}</span>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl flex items-center gap-3">
            <Languages size={28} className="text-primary" />
            {t("translation.title")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("translation.subtitle")}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[420px_1fr] gap-6">
        <section className={`rounded-2xl border ${c.cardStatic} p-5 space-y-4`}>
          <div className="flex items-center gap-2">
            <Upload size={18} className="text-primary" />
            <h2 className="font-semibold">{t("translation.newProject")}</h2>
          </div>
          <div className="space-y-3">
            <input
              type="file"
              accept=".txt,.md,.markdown,.pdf,.epub,text/plain,text/markdown,application/pdf,application/epub+zip"
              onChange={(event) => {
                const next = event.currentTarget.files?.[0] ?? null;
                setFile(next);
                setUploaded(null);
                if (next && !title.trim()) setTitle(next.name.replace(/\.[^.]+$/u, ""));
              }}
              className="block w-full text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-2 file:text-sm file:font-semibold file:text-primary-foreground"
            />
            {file && (
              <div className="rounded-lg bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
                {file.name} · {formatFileSize(file.size)}
              </div>
            )}
            <button
              onClick={uploadFile}
              disabled={!file || busy === "upload"}
              className={`w-full rounded-lg px-4 py-2 text-sm font-semibold ${c.btnSecondary} disabled:opacity-40`}
            >
              {busy === "upload" ? <Loader2 size={14} className="inline animate-spin mr-2" /> : null}
              {t("translation.upload")}
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("translation.source")}
              <select
                value={sourceLanguage}
                onChange={(e) => setSourceLanguage(e.target.value)}
                className="w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm normal-case text-foreground"
              >
                {languagePresets.map((language) => (
                  <option key={`source-${language}`} value={language}>{language}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("translation.target")}
              <select
                value={targetLanguage}
                onChange={(e) => setTargetLanguage(e.target.value)}
                className="w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm normal-case text-foreground"
              >
                {languagePresets.filter((language) => language !== (isZh ? "自动识别" : "Auto detect")).map((language) => (
                  <option key={`target-${language}`} value={language}>{language}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="space-y-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground block">
            {t("translation.projectTitle")}
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm normal-case text-foreground" />
          </label>
          <label className="space-y-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground block">
            {t("translation.segmentMax")}
            <input type="number" min={400} max={4000} value={segmentMaxChars} onChange={(e) => setSegmentMaxChars(Number(e.target.value) || 1200)} className="w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm normal-case text-foreground" />
          </label>
          <button
            onClick={createProject}
            disabled={!uploaded || busy === "create"}
            className={`w-full rounded-lg px-4 py-2 text-sm font-bold ${c.btnPrimary} disabled:opacity-40`}
          >
            {busy === "create" ? <Loader2 size={14} className="inline animate-spin mr-2" /> : null}
            {t("translation.create")}
          </button>
        </section>

        <section className={`rounded-2xl border ${c.cardStatic} p-5 space-y-5`}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <FileText size={18} className="text-primary" />
              <h2 className="font-semibold">{t("translation.projects")}</h2>
            </div>
            <button onClick={() => refetch()} className={`rounded-lg px-3 py-1.5 text-xs ${c.btnSecondary}`}>{t("translation.refresh")}</button>
          </div>

          {loading && <div className="text-sm text-muted-foreground">{t("common.loading")}</div>}
          {error && <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
          {!loading && translations.length === 0 && (
            <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              {t("translation.empty")}
            </div>
          )}
          {translations.length > 0 && (
            <div className="grid gap-3 md:grid-cols-2">
              {translations.map((item) => (
                <button
                  key={item.projectId}
                  onClick={() => setSelectedId(item.projectId)}
                  className={`rounded-xl border p-4 text-left transition-colors ${selected?.projectId === item.projectId ? "border-primary bg-primary/10" : "border-border bg-secondary/20 hover:bg-secondary/40"}`}
                >
                  <div className="font-semibold line-clamp-1">{item.title}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{item.sourceLanguage} → {item.targetLanguage} · {item.chapters} {t("translation.chapters")}</div>
                  <div className="mt-2 text-[11px] text-muted-foreground/70">{item.projectId}</div>
                </button>
              ))}
            </div>
          )}

          {selected && (
            <div className="rounded-2xl border border-border bg-background/40 p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="break-words font-semibold">{selected.title}</div>
                  <div className="break-all text-xs text-muted-foreground">{selected.projectId}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={runProject} disabled={busy === "run"} className={`rounded-lg px-3 py-2 text-sm font-semibold ${c.btnPrimary} disabled:opacity-40`}>
                    {busy === "run" ? <Loader2 size={14} className="inline animate-spin mr-2" /> : <Play size={14} className="inline mr-2" />}
                    {t("translation.run")}
                  </button>
                  {(["md", "txt", "epub"] as const).map((format) => (
                    <button key={format} onClick={() => exportProject(format)} disabled={busy === "export"} className={`rounded-lg px-3 py-2 text-sm ${c.btnSecondary} disabled:opacity-40`}>
                      <Download size={14} className="inline mr-2" />
                      {format.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("translation.runModel")}
                  <DropdownMenu>
                    <DropdownMenuTrigger className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm normal-case text-foreground">
                      <span className="truncate">{runSelectionLabel}</span>
                      <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="bottom" align="start" className="flex max-h-80 w-64 flex-col">
                      <div className="border-b border-border/30 px-2 py-1.5">
                        <input
                          type="text"
                          value={modelSearch}
                          onChange={(e) => setModelSearch(e.target.value)}
                          placeholder={isZh ? "搜索模型..." : "Search models..."}
                          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/40"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        />
                      </div>
                      <div className="flex-1 overflow-y-auto">
                        <DropdownMenuItem
                          onClick={() => { setRunService(""); setRunModel(""); }}
                          className={!runModel ? "bg-muted/50" : ""}
                        >
                          <div className="flex flex-1 items-center justify-between">
                            <span className="text-sm">{t("translation.modelDefault")}</span>
                            {!runModel && <Check size={14} className="shrink-0 text-primary" />}
                          </div>
                        </DropdownMenuItem>
                        {filteredModelGroups.map((group) => (
                          <div key={group.service}>
                            <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{group.label}</div>
                            {group.models.map((m) => (
                              <DropdownMenuItem
                                key={`${group.service}:${m.id}`}
                                onClick={() => { setRunService(group.service); setRunModel(m.id); }}
                                className={runModel === m.id && runService === group.service ? "bg-muted/50" : ""}
                              >
                                <div className="flex flex-1 items-center justify-between">
                                  <span className="text-sm">{m.name ?? m.id}</span>
                                  {runModel === m.id && runService === group.service && <Check size={14} className="shrink-0 text-primary" />}
                                </div>
                              </DropdownMenuItem>
                            ))}
                          </div>
                        ))}
                        {filteredModelGroups.length === 0 && (
                          <div className="px-3 py-4 text-center text-xs italic text-muted-foreground/50">
                            {isZh ? "无匹配模型" : "No matching models"}
                          </div>
                        )}
                      </div>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </label>
                <label className="space-y-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("translation.runBatchSize")}
                  <input type="number" min={1} max={32} value={runBatchSize} onChange={(e) => setRunBatchSize(Number(e.target.value) || 8)} className="w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm text-foreground" />
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                {([
                  ["preview", "translation.tabPreview"],
                  ["glossary", "translation.tabGlossary"],
                  ["qa", "translation.tabQa"],
                ] as const).map(([value, labelKey]) => (
                  <button
                    key={value}
                    onClick={() => switchView(value)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${view === value ? "bg-primary/10 text-primary ring-1 ring-primary/40" : "bg-secondary/30 text-muted-foreground hover:bg-secondary/50"}`}
                  >
                    {t(labelKey)}
                  </button>
                ))}
              </div>
              {detailLoading && <div className="text-sm text-muted-foreground">{t("common.loading")}</div>}
              {view === "preview" && detail?.manifest && (
                <div className="grid gap-2 md:grid-cols-2">
                  {detail.manifest.chapters.map((chapter) => (
                    <button
                      key={`${chapter.number}-${chapter.title}`}
                      type="button"
                      onClick={() => setPreviewChapterNumber(chapter.number)}
                      className={`rounded-lg px-3 py-2 text-left text-sm transition-colors ${previewChapter?.number === chapter.number ? "bg-primary/10 ring-1 ring-primary/50" : "bg-secondary/30 hover:bg-secondary/50"}`}
                    >
                      <div className="font-medium">{chapter.title}</div>
                      <div className="text-xs text-muted-foreground">{chapter.status}</div>
                    </button>
                  ))}
                </div>
              )}
              {view === "preview" && previewChapter && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{t("translation.preview")}</div>
                      <div className="font-semibold">{previewChapter.title}</div>
                    </div>
                    <div className="text-xs text-muted-foreground">{previewChapter.status}</div>
                  </div>
                  <div className="max-h-[560px] overflow-auto rounded-xl border border-border bg-background/50">
                    {previewChapter.segments.map((segment) => (
                      <div key={segment.index} className="grid gap-0 border-b border-border/70 last:border-b-0 lg:grid-cols-2">
                        <div className="space-y-2 p-4">
                          <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{t("translation.original")}</div>
                          <p className="whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{segment.source}</p>
                        </div>
                        <div className="space-y-2 border-t border-border/70 bg-secondary/20 p-4 lg:border-l lg:border-t-0">
                          <div className="text-[11px] font-bold uppercase tracking-wide text-primary">{t("translation.translated")}</div>
                          <p className="whitespace-pre-wrap text-sm leading-7">{segment.target?.trim() || t("translation.untranslated")}</p>
                          {segment.notes?.trim() ? (
                            <p className="rounded-lg bg-background/70 px-3 py-2 text-xs leading-5 text-muted-foreground">{segment.notes}</p>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {view === "preview" && (
                <div>
                  <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">{t("translation.report")}</div>
                  <pre className="max-h-80 overflow-auto rounded-xl bg-secondary/30 p-4 text-xs leading-6 whitespace-pre-wrap">
                    {detail?.report?.trim() || t("translation.noReport")}
                  </pre>
                </div>
              )}
              {view === "glossary" && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{t("translation.glossary")}</div>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={prepGlossary} disabled={busy === "prep"} className={`rounded-lg px-3 py-2 text-xs font-semibold ${c.btnSecondary} disabled:opacity-40`}>
                        {busy === "prep" ? <Loader2 size={12} className="inline animate-spin mr-2" /> : <BookA size={12} className="inline mr-2" />}
                        {t("translation.prep")}
                      </button>
                      <button onClick={saveGlossary} disabled={busy === "glossarySave"} className={`rounded-lg px-3 py-2 text-xs font-semibold ${c.btnPrimary} disabled:opacity-40`}>
                        {busy === "glossarySave" ? <Loader2 size={12} className="inline animate-spin mr-2" /> : null}
                        {t("translation.glossarySave")}
                      </button>
                    </div>
                  </div>
                  {glossaryLoading && <div className="text-sm text-muted-foreground">{t("common.loading")}</div>}
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="space-y-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t("translation.glossarySource")}
                      <input
                        value={newTerm.source}
                        onChange={(e) => setNewTerm((current) => ({ ...current, source: e.target.value }))}
                        className="w-36 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm normal-case text-foreground"
                      />
                    </label>
                    <label className="space-y-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t("translation.glossaryTarget")}
                      <input
                        value={newTerm.target}
                        onChange={(e) => setNewTerm((current) => ({ ...current, target: e.target.value }))}
                        className="w-36 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm normal-case text-foreground"
                      />
                    </label>
                    <label className="space-y-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t("translation.glossaryCategory")}
                      <select
                        value={newTerm.category}
                        onChange={(e) => setNewTerm((current) => ({ ...current, category: e.target.value }))}
                        className="w-32 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm normal-case text-foreground"
                      >
                        {GLOSSARY_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
                      </select>
                    </label>
                    <button onClick={addGlossaryTerm} className={`rounded-lg px-3 py-2 text-xs font-semibold ${c.btnSecondary}`}>{t("translation.glossaryAdd")}</button>
                  </div>
                  {glossary.length === 0 && !glossaryLoading ? (
                    <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">{t("translation.glossaryEmpty")}</div>
                  ) : (
                    <div className="max-h-[420px] overflow-auto rounded-xl border border-border">
                      {glossary.map((term) => (
                        <div key={termKey(term)} className="grid items-center gap-2 border-b border-border/70 p-3 last:border-b-0 md:grid-cols-[1fr_1fr_150px_90px_40px]">
                          <input
                            value={term.source}
                            onChange={(e) => updateGlossaryTerm(termKey(term), { source: e.target.value })}
                            className="w-full rounded-lg border border-border bg-secondary/30 px-2 py-1.5 text-sm text-foreground"
                          />
                          <input
                            value={term.target}
                            onChange={(e) => updateGlossaryTerm(termKey(term), { target: e.target.value })}
                            className="w-full rounded-lg border border-border bg-secondary/30 px-2 py-1.5 text-sm text-foreground"
                          />
                          <select
                            value={term.category ?? "other"}
                            onChange={(e) => updateGlossaryTerm(termKey(term), { category: e.target.value })}
                            className="w-full rounded-lg border border-border bg-secondary/30 px-2 py-1.5 text-sm text-foreground"
                          >
                            {GLOSSARY_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
                          </select>
                          <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={term.pinned === true}
                              onChange={(e) => updateGlossaryTerm(termKey(term), { pinned: e.target.checked })}
                            />
                            {t("translation.glossaryPinned")}
                          </label>
                          <button
                            onClick={() => setGlossary((current) => current.filter((candidate) => termKey(candidate) !== termKey(term)))}
                            className="rounded-lg px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 size={14} className="inline" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {view === "qa" && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{t("translation.qa")}</div>
                    <button onClick={() => selected?.projectId && void loadQaReports(selected.projectId)} className={`rounded-lg px-3 py-1.5 text-xs ${c.btnSecondary}`}>
                      {qaLoading ? <Loader2 size={12} className="inline animate-spin mr-2" /> : null}
                      {t("translation.refresh")}
                    </button>
                  </div>
                  {qaReports.length === 0 && !qaLoading && (
                    <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">{t("translation.qaEmpty")}</div>
                  )}
                  {qaReports.length > 0 && (
                    <div className="overflow-auto rounded-xl border border-border">
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="bg-secondary/30 text-xs uppercase tracking-wide text-muted-foreground">
                            <th className="px-3 py-2">{t("translation.qaChapter")}</th>
                            <th className="px-3 py-2">{t("translation.qaPassed")}</th>
                            <th className="px-3 py-2">{t("translation.qaAdherence")}</th>
                            <th className="px-3 py-2">{t("translation.qaCjk")}</th>
                            <th className="px-3 py-2">{t("translation.qaAddress")}</th>
                            <th className="px-3 py-2">{t("translation.qaVariants")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {qaReports.map((report) => (
                            <tr key={report.number} className="border-t border-border/70">
                              <td className="px-3 py-2">{report.number}</td>
                              <td className={`px-3 py-2 font-semibold ${report.passed ? "text-emerald-600" : "text-destructive"}`}>
                                {report.passed ? t("translation.qaYes") : t("translation.qaNo")}
                              </td>
                              <td className="px-3 py-2">{Math.round(report.metrics.adherence * 1000) / 10}%</td>
                              <td className="px-3 py-2">{report.metrics.cjkResidue}</td>
                              <td className="px-3 py-2">{report.metrics.addressVariants}</td>
                              <td className="px-3 py-2">{report.metrics.variants}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {status && (
        <div className={`rounded-xl px-4 py-3 text-sm ${status.startsWith("Error:") ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-600"}`}>
          {status}
        </div>
      )}
    </div>
  );
}
