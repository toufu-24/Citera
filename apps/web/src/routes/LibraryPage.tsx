import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Archive,
  ArrowDownUp,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  FileText,
  Filter,
  Folder,
  FolderMinus,
  FolderOpen,
  FolderPlus,
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

import { ActionMenu } from "../components/ActionMenu";
import { ApiRequestError, api, type CollectionRecord, type PaperListItem } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { db } from "../lib/database";
import { parseCitationFile, resolveImportedTagIds } from "../lib/import";
import { PaperDetailView } from "./PaperDetailPage";

type StatusFilter = "all" | PaperListItem["status"] | "deleted";
type PaperRowAction = "open" | "copy-bibtex" | "toggle-archive" | "trash" | "restore" | "rate";

const statusLabel: Record<PaperListItem["status"], string> = {
  inbox: "未着手",
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

function collectionPath(collection: CollectionRecord, collections: CollectionRecord[]): string {
  const byId = new Map(collections.map((item) => [item.id, item]));
  const names = [collection.name];
  const visited = new Set([collection.id]);
  let parentId = collection.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names.join(" / ");
}

function PaperRow({
  paper,
  checked,
  onCheck,
  onOpen,
  onAction,
  onRate,
  actionPending,
  open,
}: {
  paper: PaperListItem;
  checked: boolean;
  onCheck: (checked: boolean) => void;
  onOpen: (paperId: string) => void;
  onAction: (paper: PaperListItem, action: PaperRowAction) => void;
  onRate: (paper: PaperListItem, rating: number | null) => void;
  actionPending: boolean;
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
      <td>
        <div className="collection-stack">
          {paper.collections?.slice(0, 1).map((collection) => (
            <span className="collection-chip" key={collection.id}>
              <Folder size={12} /> {collection.name}
            </span>
          ))}
          {(paper.collections?.length ?? 0) > 1 && (
            <span className="tag-more">+{(paper.collections?.length ?? 0) - 1}</span>
          )}
        </div>
      </td>
      <td className="icon-state-cell" aria-label={paper.hasPdf ? "PDFあり" : "PDFなし"}>
        {paper.hasPdf ? <FileText size={17} /> : <span>—</span>}
      </td>
      <td className="rating-cell">
        <div className="inline-rating" aria-label={`評価 ${paper.rating ?? 0} / 5`}>
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              type="button"
              key={value}
              className={value <= (paper.rating ?? 0) ? "active" : ""}
              aria-label={`${paper.title}を${value}つ星に評価`}
              title={`${value}つ星`}
              disabled={actionPending}
              onClick={() => onRate(paper, paper.rating === value ? null : value)}
            >
              <Star size={16} fill={value <= (paper.rating ?? 0) ? "currentColor" : "none"} />
            </button>
          ))}
        </div>
      </td>
      <td className="date-cell">{formatDate(paper.updatedAt)}</td>
      <td className="row-action-cell">
        <ActionMenu
          label={`${paper.title} のその他の操作`}
          className="row-action-menu"
          items={
            paper.deletedAt
              ? [
                  {
                    label: "ゴミ箱から復元",
                    icon: <RotateCcw size={17} />,
                    onSelect: () => onAction(paper, "restore"),
                    disabled: actionPending,
                  },
                  {
                    label: "BibTeXをコピー",
                    icon: <Copy size={17} />,
                    onSelect: () => onAction(paper, "copy-bibtex"),
                    disabled: actionPending,
                  },
                ]
              : [
                  {
                    label: "詳細を開く",
                    icon: <BookOpen size={17} />,
                    onSelect: () => onAction(paper, "open"),
                  },
                  {
                    label: "BibTeXをコピー",
                    icon: <Copy size={17} />,
                    onSelect: () => onAction(paper, "copy-bibtex"),
                    disabled: actionPending,
                  },
                  {
                    label: paper.status === "archived" ? "未着手に戻す" : "保管済みにする",
                    icon:
                      paper.status === "archived" ? <RotateCcw size={17} /> : <Archive size={17} />,
                    onSelect: () => onAction(paper, "toggle-archive"),
                    disabled: actionPending,
                  },
                  {
                    label: "ゴミ箱へ移動",
                    icon: <Trash2 size={17} />,
                    onSelect: () => onAction(paper, "trash"),
                    disabled: actionPending,
                    danger: true,
                  },
                ]
          }
        />
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
  const [bulkCollectionId, setBulkCollectionId] = useState("");
  const [selectedCollectionId, setSelectedCollectionId] = useState("");
  const [collectionCreatorOpen, setCollectionCreatorOpen] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [newCollectionParentId, setNewCollectionParentId] = useState("");
  const [tagCreatorOpen, setTagCreatorOpen] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("#73846f");
  const [importMessage, setImportMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const [rowActionMessage, setRowActionMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const [openPaperId, setOpenPaperId] = useState<string | null>(null);
  const [manualEntry, setManualEntry] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(() =>
    clampDrawerWidth(Math.min(720, Math.round(window.innerWidth * 0.58))),
  );
  const [drawerResizing, setDrawerResizing] = useState(false);
  const drawerResizeStartRef = useRef<{ x: number; width: number } | null>(null);
  const newTagNameRef = useRef<HTMLInputElement>(null);
  const createDialog = useRef<HTMLDialogElement>(null);
  const queryClient = useQueryClient();
  const preferences = useQuery({ queryKey: ["preferences"], queryFn: api.preferences });
  const collections = useQuery({ queryKey: ["collections"], queryFn: api.collections });

  const importPapers = useMutation({
    mutationFn: async (file: File) => {
      const imported = await parseCitationFile(file);
      const tagsByName = new Map(
        (await api.tags()).map((tag) => [tag.name.trim().toLocaleLowerCase(), tag]),
      );
      let created = 0;
      let duplicates = 0;
      let failed = 0;
      const ignoredTagNames = new Set<string>();
      for (const paper of imported) {
        const resolvedTags = resolveImportedTagIds(paper.tags, tagsByName);
        resolvedTags.ignoredTagNames.forEach((name) => ignoredTagNames.add(name));
        const { tags: _tags, ...body } = paper;
        void _tags;
        try {
          await api.createPaper({
            ...body,
            tagIds: resolvedTags.tagIds,
            clientMutationId: crypto.randomUUID(),
          });
          created += 1;
        } catch (error) {
          if (error instanceof ApiRequestError && error.code === "DUPLICATE_IDENTIFIER") {
            duplicates += 1;
          } else {
            failed += 1;
          }
        }
      }
      if (created === 0 && failed > 0) {
        throw new Error(`${failed}件を登録できませんでした。ファイル内容を確認してください。`);
      }
      return {
        total: imported.length,
        created,
        duplicates,
        failed,
        ignoredTags: ignoredTagNames.size,
      };
    },
    onSuccess: ({ created, duplicates, failed, ignoredTags }) => {
      setImportMessage({
        kind: failed ? "error" : "success",
        text: `${created}件を登録しました${duplicates ? `（重複${duplicates}件をスキップ）` : ""}${
          failed ? `。${failed}件は登録できませんでした` : ""
        }${ignoredTags ? `。未登録のタグ${ignoredTags}個は追加せず無視しました` : ""}。`,
      });
      void queryClient.invalidateQueries({ queryKey: ["papers"] });
    },
    onError: (error) => {
      setImportMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "インポートに失敗しました。",
      });
    },
  });

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
    if (selectedCollectionId) params.set("collection", selectedCollectionId);
    return params;
  }, [
    deferredQuery,
    hasPdf,
    hasTranslation,
    recentOnly,
    selectedCollectionId,
    sort,
    status,
    yearFrom,
    yearTo,
  ]);

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
  const collectionOptions = useMemo(
    () =>
      (collections.data ?? [])
        .map((collection) => ({
          collection,
          label: collectionPath(collection, collections.data ?? []),
        }))
        .sort((left, right) => left.label.localeCompare(right.label, "ja")),
    [collections.data],
  );

  useEffect(() => {
    if (tagCreatorOpen) newTagNameRef.current?.focus();
  }, [tagCreatorOpen]);

  const createQuickTag = useMutation({
    mutationFn: () => api.createTag({ name: newTagName.trim(), color: newTagColor }),
    onSuccess: async () => {
      setNewTagName("");
      await queryClient.invalidateQueries({ queryKey: ["tags"] });
      newTagNameRef.current?.focus();
    },
  });

  const createQuickCollection = useMutation({
    mutationFn: () =>
      api.createCollection({
        name: newCollectionName.trim(),
        parentId: newCollectionParentId || null,
      }),
    onSuccess: async () => {
      setNewCollectionName("");
      setNewCollectionParentId("");
      setCollectionCreatorOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["collections"] });
    },
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

  const bulkCollection = useMutation({
    mutationFn: async (collectionId: string) => {
      await Promise.all(
        [...selected].map((paperId) => api.addPaperToCollection(paperId, collectionId)),
      );
    },
    onSuccess: async () => {
      setBulkCollectionId("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["papers"] }),
        queryClient.invalidateQueries({ queryKey: ["collections"] }),
      ]);
    },
    onError: () => setBulkCollectionId(""),
  });

  const bulkRemoveCollection = useMutation({
    mutationFn: async () => {
      if (!selectedCollectionId) return;
      await Promise.all(
        [...selected].map((paperId) =>
          api.removePaperFromCollection(paperId, selectedCollectionId),
        ),
      );
    },
    onSuccess: async () => {
      setSelected(new Set());
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["papers"] }),
        queryClient.invalidateQueries({ queryKey: ["collections"] }),
      ]);
    },
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

  const rowAction = useMutation({
    mutationFn: async ({
      paper,
      action,
      rating,
    }: {
      paper: PaperListItem;
      action: PaperRowAction;
      rating?: number | null;
    }) => {
      if (action === "copy-bibtex") {
        await copyText(await api.bibtex(paper.id));
        return action;
      }
      if (action === "toggle-archive") {
        await api.updatePaper(paper.id, paper.version, {
          status: paper.status === "archived" ? "inbox" : "archived",
        });
        return action;
      }
      if (action === "trash") {
        await api.removePaper(paper.id, paper.version);
        return action;
      }
      if (action === "restore") {
        await api.restorePaper(paper.id, paper.version);
        return action;
      }
      if (action === "rate") {
        await api.updatePaper(paper.id, paper.version, { rating: rating ?? null });
        return action;
      }
      return action;
    },
    onSuccess: async (action) => {
      setRowActionMessage({
        kind: "success",
        text:
          action === "copy-bibtex"
            ? "BibTeXをクリップボードにコピーしました。"
            : action === "rate"
              ? "評価を更新しました。"
              : "論文の状態を更新しました。",
      });
      if (action !== "copy-bibtex") {
        setSelected(new Set());
        await queryClient.invalidateQueries({ queryKey: ["papers"] });
      }
    },
    onError: () =>
      setRowActionMessage({
        kind: "error",
        text: "操作を完了できませんでした。再試行してください。",
      }),
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

  function runRowAction(paper: PaperListItem, action: PaperRowAction) {
    setRowActionMessage(null);
    if (action === "open") {
      setOpenPaperId(paper.id);
      return;
    }
    if (action === "trash" && !window.confirm(`「${paper.title}」をゴミ箱へ移動しますか？`)) {
      return;
    }
    rowAction.mutate({ paper, action });
  }

  function ratePaper(paper: PaperListItem, rating: number | null) {
    setRowActionMessage(null);
    rowAction.mutate({ paper, action: "rate", rating });
  }

  function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const year = formString(form, "publicationYear");
    const identifier = formString(form, "doi").trim();
    const normalizedIdentifier = identifier
      .replace(/^doi:\s*/iu, "")
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "");
    const identifierType = /^10\.\d{4,9}\//u.test(normalizedIdentifier) ? "doi" : "arxiv";
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
          <button
            type="button"
            className="button secondary"
            aria-expanded={tagCreatorOpen}
            aria-controls="quick-tag-creator"
            onClick={() => {
              setTagCreatorOpen((open) => !open);
              createQuickTag.reset();
            }}
          >
            <Tag size={17} /> タグを追加
          </button>
          <label
            className={`button secondary file-import-button${importPapers.isPending ? " disabled" : ""}`}
          >
            <Upload size={17} /> {importPapers.isPending ? "インポート中…" : "インポート"}
            <input
              type="file"
              accept=".bib,.bibtex,.ris,.json,.csv"
              disabled={importPapers.isPending}
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) {
                  setImportMessage(null);
                  importPapers.mutate(file);
                }
              }}
            />
          </label>
          <button className="button primary" onClick={openCreateDialog}>
            <Plus size={18} /> 論文を追加
          </button>
        </div>
      </header>

      {tagCreatorOpen && (
        <form
          id="quick-tag-creator"
          className="quick-tag-creator"
          onSubmit={(event) => {
            event.preventDefault();
            if (newTagName.trim()) createQuickTag.mutate();
          }}
        >
          <label className="quick-tag-color">
            <span>色</span>
            <input
              type="color"
              value={newTagColor}
              onChange={(event) => setNewTagColor(event.target.value)}
              aria-label="新しいタグの色"
            />
          </label>
          <label className="quick-tag-name">
            <span>タグ名</span>
            <input
              ref={newTagNameRef}
              value={newTagName}
              maxLength={100}
              placeholder="例: あとで読む"
              aria-label="新しいタグ名"
              onChange={(event) => {
                setNewTagName(event.target.value);
                createQuickTag.reset();
              }}
            />
          </label>
          <button
            className="button primary compact"
            disabled={!newTagName.trim() || createQuickTag.isPending}
          >
            <Plus size={15} /> {createQuickTag.isPending ? "追加中…" : "追加"}
          </button>
          {createQuickTag.isSuccess && (
            <span className="quick-tag-feedback success" role="status">
              追加しました
            </span>
          )}
          {createQuickTag.isError && (
            <span className="quick-tag-feedback error" role="alert">
              追加できませんでした。同名タグがないか確認してください。
            </span>
          )}
          <button
            type="button"
            className="quick-tag-close"
            onClick={() => setTagCreatorOpen(false)}
            aria-label="タグ追加を閉じる"
          >
            <X size={16} />
          </button>
        </form>
      )}

      {importMessage && (
        <p
          className={
            importMessage.kind === "success" ? "import-status success" : "import-status error"
          }
          role={importMessage.kind === "error" ? "alert" : "status"}
        >
          {importMessage.text}
          <button type="button" onClick={() => setImportMessage(null)} aria-label="通知を閉じる">
            <X size={14} />
          </button>
        </p>
      )}

      {rowActionMessage && (
        <div
          className={`import-status ${rowActionMessage.kind === "error" ? "error" : ""}`}
          role={rowActionMessage.kind === "error" ? "alert" : "status"}
        >
          <span>{rowActionMessage.text}</span>
          <button
            type="button"
            onClick={() => setRowActionMessage(null)}
            aria-label="操作結果を閉じる"
          >
            <X size={16} />
          </button>
        </div>
      )}

      <section className="collection-panel" aria-label="フォルダー">
        <header>
          <div>
            <FolderOpen size={18} />
            <strong>フォルダー</strong>
          </div>
          <button
            type="button"
            className="text-button"
            aria-expanded={collectionCreatorOpen}
            onClick={() => {
              setCollectionCreatorOpen((open) => !open);
              createQuickCollection.reset();
            }}
          >
            <FolderPlus size={15} /> 新しいフォルダー
          </button>
        </header>

        {collectionCreatorOpen && (
          <form
            className="quick-collection-creator"
            onSubmit={(event) => {
              event.preventDefault();
              if (newCollectionName.trim()) createQuickCollection.mutate();
            }}
          >
            <input
              value={newCollectionName}
              maxLength={200}
              autoFocus
              placeholder="フォルダー名"
              aria-label="新しいフォルダー名"
              onChange={(event) => {
                setNewCollectionName(event.target.value);
                createQuickCollection.reset();
              }}
            />
            <select
              value={newCollectionParentId}
              onChange={(event) => setNewCollectionParentId(event.target.value)}
              aria-label="親フォルダー"
            >
              <option value="">最上位に作成</option>
              {collectionOptions.map(({ collection, label }) => (
                <option key={collection.id} value={collection.id}>
                  {label}
                </option>
              ))}
            </select>
            <button
              className="button secondary compact"
              disabled={!newCollectionName.trim() || createQuickCollection.isPending}
            >
              {createQuickCollection.isPending ? "作成中…" : "作成"}
            </button>
            {createQuickCollection.isError && (
              <span className="quick-tag-feedback error" role="alert">
                フォルダーを作成できませんでした。
              </span>
            )}
          </form>
        )}

        <nav className="collection-filter-list" aria-label="フォルダーで絞り込む">
          <button
            type="button"
            className={selectedCollectionId ? "" : "active"}
            aria-pressed={!selectedCollectionId}
            onClick={() => setSelectedCollectionId("")}
          >
            <FolderOpen size={15} /> すべての論文
          </button>
          {collectionOptions.map(({ collection, label }) => (
            <button
              type="button"
              key={collection.id}
              className={selectedCollectionId === collection.id ? "active" : ""}
              aria-pressed={selectedCollectionId === collection.id}
              title={collection.description ?? undefined}
              onClick={() => setSelectedCollectionId(collection.id)}
            >
              {selectedCollectionId === collection.id ? (
                <FolderOpen size={15} />
              ) : (
                <Folder size={15} />
              )}
              <span>{label}</span>
              <small>{collection.paperCount ?? 0}</small>
            </button>
          ))}
          {!collections.isPending && collectionOptions.length === 0 && (
            <span className="collection-empty-hint">フォルダーはまだありません。</span>
          )}
        </nav>
      </section>

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
              <option value="inbox">未着手</option>
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
          {status !== "deleted" && (
            <label className="bulk-tag-control">
              <FolderPlus size={16} aria-hidden="true" />
              <span className="sr-only">選択した論文をフォルダーへ追加</span>
              <select
                value={bulkCollectionId}
                aria-label="選択した論文をフォルダーへ追加"
                disabled={collections.isPending || collections.isError || bulkCollection.isPending}
                onChange={(event) => {
                  const collectionId = event.target.value;
                  setBulkCollectionId(collectionId);
                  if (collectionId) bulkCollection.mutate(collectionId);
                }}
              >
                <option value="">
                  {collections.isPending ? "フォルダーを読込中…" : "フォルダーへ追加…"}
                </option>
                {collectionOptions.map(({ collection, label }) => (
                  <option key={collection.id} value={collection.id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {status !== "deleted" && selectedCollectionId && (
            <button
              type="button"
              onClick={() => bulkRemoveCollection.mutate()}
              disabled={bulkRemoveCollection.isPending}
            >
              <FolderMinus size={16} /> フォルダーから外す
            </button>
          )}
          {(bulkTag.error || bulkCollection.error || bulkRemoveCollection.error) && (
            <span className="bulk-error" role="alert">
              分類の変更に失敗しました
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
            {selectedCollectionId ? <FolderOpen size={31} /> : <BookOpen size={31} />}
            <h2>
              {selectedCollectionId
                ? "このフォルダーにはまだ論文がありません"
                : "最初の論文を追加しましょう"}
            </h2>
            <p>
              {selectedCollectionId
                ? "「すべての論文」に戻り、論文を選択してフォルダーへ追加できます。"
                : "DOI、arXiv ID、または手入力から始められます。"}
            </p>
            {selectedCollectionId ? (
              <button
                type="button"
                className="button secondary"
                onClick={() => setSelectedCollectionId("")}
              >
                すべての論文へ戻る
              </button>
            ) : (
              <button className="button primary" onClick={openCreateDialog}>
                <Plus size={17} /> 論文を追加
              </button>
            )}
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
                  <th>フォルダー</th>
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
                    onAction={runRowAction}
                    onRate={ratePaper}
                    actionPending={rowAction.isPending}
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
            <PaperDetailView paperId={openPaperId} drawer onClose={() => setOpenPaperId(null)} />
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
                <button type="button" className="text-button" onClick={() => setManualEntry(false)}>
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
                    <option value="inbox">未着手</option>
                    <option value="reading">読書中</option>
                    <option value="read">読了</option>
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
              {duplicateDetails &&
                (duplicateDetails.deletedAt && duplicateDetails.version !== null ? (
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
                ))}
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
