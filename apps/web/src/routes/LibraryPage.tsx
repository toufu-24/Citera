import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Archive,
  ArrowDownUp,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  Download,
  FileText,
  Filter,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Star,
  Tag,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { ApiRequestError, api, type PaperListItem } from "../lib/api";
import { db } from "../lib/database";
import { PaperDetailView } from "./PaperDetailPage";

type StatusFilter = "all" | PaperListItem["status"] | "deleted";

const statusLabel: Record<PaperListItem["status"], string> = {
  inbox: "未整理",
  reading: "読書中",
  read: "読了",
  archived: "保管済み",
};

const exportFormatLabel = {
  bibtex: "BibTeX",
  "csl-json": "CSL-JSON",
  ris: "RIS",
  csv: "CSV",
  json: "JSON",
} as const;

const MIN_DRAWER_WIDTH = 420;
const MAX_DRAWER_WIDTH = 960;

function clampDrawerWidth(value: number) {
  const viewportMax = Math.max(MIN_DRAWER_WIDTH, window.innerWidth - 320);
  return Math.min(Math.min(MAX_DRAWER_WIDTH, viewportMax), Math.max(MIN_DRAWER_WIDTH, value));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function duplicateDetailsFromError(error: unknown): {
  paperId: string;
  deletedAt: string | null;
  version: number | null;
} | null {
  if (!(error instanceof ApiRequestError) || error.code !== "DUPLICATE_IDENTIFIER") return null;
  if (!error.details || typeof error.details !== "object" || Array.isArray(error.details)) {
    return null;
  }
  const details = error.details as { paperId?: unknown; deletedAt?: unknown; version?: unknown };
  if (typeof details.paperId !== "string") return null;
  return {
    paperId: details.paperId,
    deletedAt: typeof details.deletedAt === "string" ? details.deletedAt : null,
    version: typeof details.version === "number" ? details.version : null,
  };
}

function PaperRow({
  paper,
  checked,
  onCheck,
  onOpen,
  open,
}: {
  paper: PaperListItem;
  checked: boolean;
  onCheck: (checked: boolean) => void;
  onOpen: (paperId: string) => void;
  open: boolean;
}) {
  return (
    <tr
      className={`paper-row${checked ? " selected" : ""}${open ? " is-open" : ""}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a, button, input")) return;
        onOpen(paper.id);
      }}
    >
      <td className="selection-cell">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onCheck(event.target.checked)}
          aria-label={`${paper.title} を選択`}
        />
      </td>
      <td className="paper-main-cell">
        <div className="paper-type-icon">
          <FileText size={19} />
        </div>
        <div>
          <Link
            to="/papers/$paperId"
            params={{ paperId: paper.id }}
            className="paper-title"
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              onOpen(paper.id);
            }}
          >
            {paper.title}
          </Link>
          <p className="paper-authors">
            {paper.authors.map((author) => author.displayName).join(", ") || "著者未設定"}
          </p>
        </div>
      </td>
      <td className="summary-cell">
        {paper.summary ? <span title={paper.summary}>{paper.summary}</span> : <span>—</span>}
      </td>
      <td>
        <span className={`status-badge status-${paper.status}`}>{statusLabel[paper.status]}</span>
      </td>
      <td className="year-cell">{paper.publicationYear ?? "—"}</td>
      <td className="venue-cell">{paper.venue ?? "—"}</td>
      <td>
        <div className="tag-stack">
          {paper.tags.slice(0, 2).map((tag) => (
            <span className="tag-chip" key={tag.id}>
              <i style={{ background: tag.color ?? "#73846f" }} />
              {tag.name}
            </span>
          ))}
          {paper.tags.length > 2 && <span className="tag-more">+{paper.tags.length - 2}</span>}
        </div>
      </td>
      <td className="icon-state-cell" aria-label={paper.hasPdf ? "PDFあり" : "PDFなし"}>
        {paper.hasPdf ? <FileText size={17} /> : <span>—</span>}
      </td>
      <td className="rating-cell" aria-label={`評価 ${paper.rating ?? 0}`}>
        <Star size={16} fill={paper.rating ? "currentColor" : "none"} />
        {paper.rating ?? "—"}
      </td>
      <td className="date-cell">{formatDate(paper.updatedAt)}</td>
      <td>
        <button className="icon-button" aria-label="その他の操作">
          <MoreHorizontal size={18} />
        </button>
      </td>
    </tr>
  );
}

export function LibraryPage() {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [hasPdf, setHasPdf] = useState<"all" | "true" | "false">("all");
  const [hasTranslation, setHasTranslation] = useState<"all" | "true" | "false">("all");
  const [recentOnly, setRecentOnly] = useState(false);
  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  const [sort, setSort] = useState("updated_at:desc");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTagId, setBulkTagId] = useState("");
  const [openPaperId, setOpenPaperId] = useState<string | null>(null);
  const [manualEntry, setManualEntry] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(() =>
    clampDrawerWidth(Math.min(720, Math.round(window.innerWidth * 0.58))),
  );
  const [drawerResizing, setDrawerResizing] = useState(false);
  const drawerResizeStartRef = useRef<{ x: number; width: number } | null>(null);
  const createDialog = useRef<HTMLDialogElement>(null);
  const queryClient = useQueryClient();
  const preferences = useQuery({ queryKey: ["preferences"], queryFn: api.preferences });

  const search = useMemo(() => {
    const params = new URLSearchParams({ limit: "50", sort });
    if (deferredQuery.trim()) params.set("q", deferredQuery.trim());
    if (status === "deleted") params.set("deleted", "only");
    else if (status !== "all") params.set("status", status);
    if (hasPdf !== "all") params.set("hasPdf", hasPdf);
    if (hasTranslation !== "all") params.set("hasTranslation", hasTranslation);
    if (recentOnly) params.set("recent", "true");
    if (/^\d{4}$/u.test(yearFrom)) params.set("yearFrom", yearFrom);
    if (/^\d{4}$/u.test(yearTo)) params.set("yearTo", yearTo);
    return params;
  }, [deferredQuery, hasPdf, hasTranslation, recentOnly, sort, status, yearFrom, yearTo]);

  const searchKey = search.toString();
  useEffect(() => setSelected(new Set()), [searchKey]);

  const papers = useInfiniteQuery({
    queryKey: ["papers", search.toString()],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const pageSearch = new URLSearchParams(search);
      if (pageParam) pageSearch.set("cursor", pageParam);
      try {
        const page = await api.papers(pageSearch);
        await db.papers.bulkPut(page.items);
        return page;
      } catch (error) {
        if (!navigator.onLine && pageParam === null) {
          return { items: await db.papers.toArray(), nextCursor: null, hasMore: false };
        }
        throw error;
      }
    },
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined,
  });
  const items = papers.data?.pages.flatMap((page) => page.items) ?? [];
  const availableTags = useQuery({
    queryKey: ["tags"],
    queryFn: api.tags,
    enabled: selected.size > 0 && status !== "deleted",
  });

  const createPaper = useMutation({
    mutationFn: api.createPaper,
    onSuccess: async () => {
      createDialog.current?.querySelector("form")?.reset();
      createDialog.current?.close();
      setManualEntry(false);
      await queryClient.invalidateQueries({ queryKey: ["papers"] });
    },
  });

  const duplicateDetails = duplicateDetailsFromError(createPaper.error);
  const restoreDuplicate = useMutation({
    mutationFn: () => {
      if (!duplicateDetails || duplicateDetails.version === null) {
        throw new Error("The duplicate paper version is unavailable.");
      }
      return api.restorePaper(duplicateDetails.paperId, duplicateDetails.version);
    },
    onSuccess: async () => {
      createDialog.current?.close();
      await queryClient.invalidateQueries({ queryKey: ["papers"] });
    },
  });

  const bulkStatus = useMutation({
    mutationFn: async (nextStatus: PaperListItem["status"]) => {
      const byId = new Map(items.map((paper) => [paper.id, paper]));
      await Promise.all(
        [...selected].map((id) => {
          const paper = byId.get(id);
          return paper
            ? api.updatePaper(id, paper.version, { status: nextStatus })
            : Promise.resolve();
        }),
      );
    },
    onSuccess: async () => {
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: ["papers"] });
    },
  });

  const bulkTag = useMutation({
    mutationFn: async (tagId: string) => {
      await Promise.all([...selected].map((paperId) => api.addPaperTag(paperId, tagId)));
    },
    onSuccess: async () => {
      setBulkTagId("");
      await queryClient.invalidateQueries({ queryKey: ["papers"] });
    },
    onError: () => setBulkTagId(""),
  });

  const bulkDelete = useMutation({
    mutationFn: async () => {
      const byId = new Map(items.map((paper) => [paper.id, paper]));
      await Promise.all(
        [...selected].map((id) => {
          const paper = byId.get(id);
          return paper ? api.removePaper(id, paper.version) : Promise.resolve();
        }),
      );
    },
    onSuccess: async () => {
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: ["papers"] });
    },
  });

  const bulkRestore = useMutation({
    mutationFn: async () => {
      const byId = new Map(items.map((paper) => [paper.id, paper]));
      await Promise.all(
        [...selected].map((id) => {
          const paper = byId.get(id);
          return paper ? api.restorePaper(id, paper.version) : Promise.resolve();
        }),
      );
    },
    onSuccess: async () => {
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: ["papers"] });
    },
  });

  const exportMutation = useMutation({
    mutationFn: (format: string) => api.exportPapers({ format, paperIds: [...selected] }),
    onSuccess: (job) => {
      if (job.downloadUrl) window.location.assign(job.downloadUrl);
    },
  });

  const allSelected = items.length > 0 && items.every((paper) => selected.has(paper.id));

  function openCreateDialog() {
    createPaper.reset();
    setManualEntry(false);
    createDialog.current?.showModal();
  }

  useEffect(() => {
    if (!openPaperId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenPaperId(null);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [openPaperId]);

  useEffect(() => {
    if (!drawerResizing) return;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.userSelect = previousUserSelect;
    };
  }, [drawerResizing]);

  function startDrawerResize(event: React.PointerEvent<HTMLDivElement>) {
    if (window.innerWidth <= 820) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drawerResizeStartRef.current = { x: event.clientX, width: drawerWidth };
    setDrawerResizing(true);
  }

  function resizeDrawer(event: React.PointerEvent<HTMLDivElement>) {
    const start = drawerResizeStartRef.current;
    if (!start) return;
    setDrawerWidth(clampDrawerWidth(start.width - (event.clientX - start.x)));
  }

  function endDrawerResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drawerResizeStartRef.current = null;
    setDrawerResizing(false);
  }

  function nudgeDrawerWidth(delta: number) {
    setDrawerWidth((current) => clampDrawerWidth(current + delta));
  }

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(items.map((paper) => paper.id)) : new Set());
  }

  function toggleOne(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const year = formString(form, "publicationYear");
    const identifier = formString(form, "doi").trim();
    const normalizedIdentifier = identifier
      .replace(/^doi:\s*/iu, "")
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "");
    const identifierType = /^10\.\d{4,9}\//u.test(
      normalizedIdentifier,
    )
      ? "doi"
      : "arxiv";
    const selectedStatus = formString(form, "status");
    const title = formString(form, "title").trim();
    const authors = formString(form, "authors")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((displayName) => ({ displayName }));
    const venue = formString(form, "venue").trim();
    const sourceUrl = formString(form, "sourceUrl").trim();
    const body: Record<string, unknown> = {
      identifiers: identifier ? [{ identifierType, value: identifier }] : [],
      clientMutationId: crypto.randomUUID(),
    };
    if (title) body.title = title;
    if (authors.length) body.authors = authors;
    if (year) body.publicationYear = Number(year);
    if (venue) body.venue = venue;
    if (sourceUrl) body.sourceUrl = sourceUrl;
    if (selectedStatus) body.status = selectedStatus;
    createPaper.mutate(body);
  }

  return (
    <div className="page library-page">
      <header className="page-heading library-heading">
        <div>
          <p className="eyebrow">YOUR RESEARCH</p>
          <h1>ライブラリ</h1>
          <p>
            {papers.data ? `${items.length} 件を表示` : "論文を読み込んでいます"} ·
            最終同期は自動更新
          </p>
        </div>
        <div className="heading-actions">
          <label className="button secondary file-import-button">
            <Upload size={17} /> インポート
            <input type="file" accept=".bib,.ris,.json,.csv" hidden />
          </label>
          <button className="button primary" onClick={openCreateDialog}>
            <Plus size={18} /> 論文を追加
          </button>
        </div>
      </header>

      <section className="library-toolbar" aria-label="ライブラリの検索とフィルター">
        <label className="search-field">
          <Search size={19} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="タイトル、著者、DOI、タグを検索…"
            aria-label="論文を検索"
          />
          {query && (
            <button onClick={() => setQuery("")} aria-label="検索をクリア">
              <X size={15} />
            </button>
          )}
        </label>
        <button
          className={filtersOpen ? "button filter-button active" : "button filter-button"}
          onClick={() => setFiltersOpen((value) => !value)}
        >
          <SlidersHorizontal size={17} /> フィルター <ChevronDown size={15} />
        </button>
        <label className="sort-field">
          <ArrowDownUp size={17} />
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            aria-label="並び替え"
          >
            <option value="updated_at:desc">更新が新しい順</option>
            <option value="created_at:desc">追加が新しい順</option>
            <option value="publication_date:desc">出版年が新しい順</option>
            <option value="title:asc">タイトル順</option>
            <option value="rating:desc">評価が高い順</option>
          </select>
        </label>
      </section>

      {filtersOpen && (
        <section className="filter-panel">
          <label>
            状態
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as StatusFilter)}
            >
              <option value="all">すべて</option>
              <option value="inbox">未整理</option>
              <option value="reading">読書中</option>
              <option value="read">読了</option>
              <option value="archived">保管済み</option>
              <option value="deleted">ゴミ箱</option>
            </select>
          </label>
          <label>
            PDF
            <select
              value={hasPdf}
              onChange={(event) => setHasPdf(event.target.value as typeof hasPdf)}
            >
              <option value="all">すべて</option>
              <option value="true">PDFあり</option>
              <option value="false">PDFなし</option>
            </select>
          </label>
          <label>
            翻訳版
            <select
              value={hasTranslation}
              onChange={(event) => setHasTranslation(event.target.value as typeof hasTranslation)}
            >
              <option value="all">すべて</option>
              <option value="true">あり</option>
              <option value="false">なし</option>
            </select>
          </label>
          <label className="checkbox-filter">
            <input
              type="checkbox"
              checked={recentOnly}
              onChange={(event) => setRecentOnly(event.target.checked)}
            />
            最近追加（30日以内）
          </label>
          <label>
            出版年
            <div className="range-inputs">
              <input
                inputMode="numeric"
                pattern="[0-9]{4}"
                value={yearFrom}
                onChange={(event) => setYearFrom(event.target.value)}
                placeholder="開始"
                aria-label="出版年の開始"
              />
              <span>—</span>
              <input
                inputMode="numeric"
                pattern="[0-9]{4}"
                value={yearTo}
                onChange={(event) => setYearTo(event.target.value)}
                placeholder="終了"
                aria-label="出版年の終了"
              />
            </div>
          </label>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setStatus("all");
              setHasPdf("all");
              setHasTranslation("all");
              setRecentOnly(false);
              setYearFrom("");
              setYearTo("");
            }}
          >
            条件をリセット
          </button>
        </section>
      )}

      {selected.size > 0 && (
        <div className="bulk-toolbar">
          <strong>{selected.size} 件を選択</strong>
          {status === "deleted" ? (
            <button
              type="button"
              onClick={() => bulkRestore.mutate()}
              disabled={bulkRestore.isPending}
            >
              <RotateCcw size={16} /> 復元
            </button>
          ) : (
            <>
              <button type="button" onClick={() => bulkStatus.mutate("reading")}>
                <BookOpen size={16} /> 読書中
              </button>
              <button type="button" onClick={() => bulkStatus.mutate("read")}>
                <CheckCircle2 size={16} /> 読了
              </button>
              <button type="button" onClick={() => bulkStatus.mutate("archived")}>
                <Archive size={16} /> 保管
              </button>
            </>
          )}
          {status !== "deleted" && (
            <label className="bulk-tag-control">
              <Tag size={16} aria-hidden="true" />
              <span className="sr-only">選択した論文へタグを追加</span>
              <select
                value={bulkTagId}
                aria-label="選択した論文へタグを追加"
                disabled={availableTags.isPending || availableTags.isError || bulkTag.isPending}
                onChange={(event) => {
                  const tagId = event.target.value;
                  setBulkTagId(tagId);
                  if (tagId) bulkTag.mutate(tagId);
                }}
              >
                <option value="">
                  {availableTags.isPending ? "タグを読込中…" : "タグを追加…"}
                </option>
                {availableTags.data?.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {bulkTag.error && (
            <span className="bulk-error" role="alert">
              タグ追加に失敗しました
            </span>
          )}
          <div className="menu-wrap">
            <button
              onClick={() =>
                exportMutation.mutate(preferences.data?.defaultExportFormat ?? "bibtex")
              }
            >
              <Download size={16} />
              {exportFormatLabel[preferences.data?.defaultExportFormat ?? "bibtex"]}
            </button>
          </div>
          {status !== "deleted" && (
            <button
              type="button"
              className="danger-action"
              onClick={() => {
                if (window.confirm(`${selected.size} 件をゴミ箱へ移動しますか？`))
                  bulkDelete.mutate();
              }}
            >
              <Trash2 size={16} /> 削除
            </button>
          )}
          <button
            className="icon-button"
            onClick={() => setSelected(new Set())}
            aria-label="選択解除"
          >
            <X size={17} />
          </button>
        </div>
      )}

      <section className="library-table-card">
        {papers.isLoading ? (
          <div className="loading-state">
            <span className="spinner" />
            <p>ライブラリを整理しています…</p>
          </div>
        ) : papers.isError ? (
          <div className="empty-state">
            <Filter size={28} />
            <h2>ライブラリを読み込めませんでした</h2>
            <p>接続を確認して、もう一度お試しください。</p>
            <button className="button secondary" onClick={() => void papers.refetch()}>
              <RotateCcw size={16} /> 再試行
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="empty-state">
            <BookOpen size={31} />
            <h2>最初の論文を追加しましょう</h2>
            <p>DOI、arXiv ID、または手入力から始められます。</p>
            <button className="button primary" onClick={openCreateDialog}>
              <Plus size={17} /> 論文を追加
            </button>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="paper-table">
              <thead>
                <tr>
                  <th className="selection-cell">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={(event) => toggleAll(event.target.checked)}
                      aria-label="すべて選択"
                    />
                  </th>
                  <th>論文</th>
                  <th>一言要約</th>
                  <th>状態</th>
                  <th>年</th>
                  <th>掲載誌・会議</th>
                  <th>タグ</th>
                  <th>PDF</th>
                  <th>評価</th>
                  <th>更新日</th>
                  <th>
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((paper) => (
                  <PaperRow
                    key={paper.id}
                    paper={paper}
                    checked={selected.has(paper.id)}
                    onCheck={(checked) => toggleOne(paper.id, checked)}
                    onOpen={setOpenPaperId}
                    open={openPaperId === paper.id}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {papers.hasNextPage && (
          <button
            type="button"
            className="load-more"
            onClick={() => void papers.fetchNextPage()}
            disabled={papers.isFetchingNextPage}
          >
            {papers.isFetchingNextPage ? "読み込み中…" : "さらに読み込む"}
          </button>
        )}
      </section>

      {openPaperId && (
        <>
          <button
            type="button"
            className="library-detail-backdrop"
            aria-label="論文詳細を閉じる"
            onClick={() => setOpenPaperId(null)}
          />
          <aside
            className={
              drawerResizing ? "library-detail-drawer is-resizing" : "library-detail-drawer"
            }
            style={{ width: drawerWidth }}
            aria-label="論文詳細"
          >
            <div
              className="drawer-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="詳細ドロワーの幅を変更"
              aria-valuemin={MIN_DRAWER_WIDTH}
              aria-valuemax={MAX_DRAWER_WIDTH}
              aria-valuenow={drawerWidth}
              tabIndex={0}
              onPointerDown={startDrawerResize}
              onPointerMove={resizeDrawer}
              onPointerUp={endDrawerResize}
              onPointerCancel={endDrawerResize}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  nudgeDrawerWidth(24);
                } else if (event.key === "ArrowRight") {
                  event.preventDefault();
                  nudgeDrawerWidth(-24);
                }
              }}
            />
            <PaperDetailView
              paperId={openPaperId}
              drawer
              onClose={() => setOpenPaperId(null)}
            />
          </aside>
        </>
      )}

      <dialog className="modal" ref={createDialog}>
        <form onSubmit={submitCreate}>
          <header>
            <div>
              <p className="eyebrow">NEW PAPER</p>
              <h2>論文を追加</h2>
            </div>
            <button
              type="button"
              className="icon-button"
              onClick={() => createDialog.current?.close()}
              aria-label="閉じる"
            >
              <X size={19} />
            </button>
          </header>
          <p className="modal-description">
            DOIまたはarXiv IDを入力すると、書誌情報を自動取得して登録します。
          </p>
          <label className="form-field">
            <span>{manualEntry ? "DOI / arXiv ID（任意）" : "DOI / arXiv ID"}</span>
            <input
              name="doi"
              autoFocus
              required={!manualEntry}
              placeholder="10.1000/xyz または 2401.01234"
            />
          </label>
          {!manualEntry ? (
            <button
              type="button"
              className="text-button modal-manual-switch"
              onClick={() => setManualEntry(true)}
            >
              DOIがない場合は手入力
            </button>
          ) : (
            <section className="manual-entry-block" aria-label="論文情報を手入力">
              <header>
                <div>
                  <strong>書誌情報を手入力</strong>
                  <span>DOIがなくても登録できます。</span>
                </div>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setManualEntry(false)}
                >
                  DOI入力に戻る
                </button>
              </header>
              <label className="form-field">
                <span>タイトル</span>
                <input name="title" required placeholder="論文タイトル" />
              </label>
              <label className="form-field">
                <span>著者</span>
                <input name="authors" placeholder="著者名をカンマ区切りで入力" />
              </label>
              <div className="form-grid">
                <label className="form-field">
                  <span>出版年</span>
                  <input
                    name="publicationYear"
                    inputMode="numeric"
                    pattern="[0-9]{4}"
                    placeholder="2026"
                  />
                </label>
                <label className="form-field">
                  <span>状態</span>
                  <select name="status" defaultValue="">
                    <option value="">
                      設定の既定値（
                      {statusLabel[preferences.data?.defaultStatus ?? "inbox"]}）
                    </option>
                    <option value="inbox">未整理</option>
                    <option value="reading">読書中</option>
                    <option value="read">読了</option>
                    <option value="archived">保管済み</option>
                  </select>
                </label>
              </div>
              <label className="form-field">
                <span>掲載誌・会議</span>
                <input name="venue" />
              </label>
              <label className="form-field">
                <span>元ページ URL</span>
                <input name="sourceUrl" type="url" placeholder="https://…" />
              </label>
            </section>
          )}
          {createPaper.error && (
            <div className="form-error" role="alert">
              <p>
                {createPaper.error instanceof ApiRequestError
                  ? createPaper.error.message
                  : "保存できませんでした。入力内容と接続を確認してください。"}
              </p>
              {duplicateDetails && (
                duplicateDetails.deletedAt && duplicateDetails.version !== null ? (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => restoreDuplicate.mutate()}
                    disabled={restoreDuplicate.isPending}
                  >
                    {restoreDuplicate.isPending ? "復元中…" : "ゴミ箱から復元"}
                  </button>
                ) : (
                  <Link
                    to="/papers/$paperId"
                    params={{ paperId: duplicateDetails.paperId }}
                    onClick={() => createDialog.current?.close()}
                  >
                    登録済みの論文を開く
                  </Link>
                )
              )}
            </div>
          )}
          <footer>
            <button
              type="button"
              className="button secondary"
              onClick={() => createDialog.current?.close()}
            >
              キャンセル
            </button>
            <button className="button primary" disabled={createPaper.isPending}>
              {createPaper.isPending ? "保存中…" : "ライブラリへ保存"}
            </button>
          </footer>
        </form>
      </dialog>
    </div>
  );
}
