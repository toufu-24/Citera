import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Archive,
  ArrowDownUp,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
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
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ActionMenu } from "../components/ActionMenu";
import { ApiRequestError, api, type PaperListItem } from "../lib/api";
import { copyText } from "../lib/clipboard";
import {
  collectionAncestorIds,
  collectionDescendantIds,
  collectionOptions as buildCollectionOptions,
  collectionPath,
  collectionTree,
  type CollectionTreeNode,
} from "../lib/collections";
import { db } from "../lib/database";
import { parseCitationFile, resolveImportedTagIds } from "../lib/import";
import { PaperDetailView } from "./PaperDetailPage";

type StatusFilter = "all" | PaperListItem["status"] | "deleted";
type SortOption =
  "updated_at:desc" | "created_at:desc" | "publication_date:desc" | "title:asc" | "rating:desc";
type PaperRowAction =
  "open" | "copy-bibtex" | "toggle-archive" | "trash" | "restore" | "rate" | "change-status";

const statusLabel: Record<PaperListItem["status"], string> = {
  inbox: "未着手",
  reading: "読書中",
  read: "読了",
  archived: "アーカイブ",
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
const DEFAULT_SORT: SortOption = "created_at:desc";
const SORT_STORAGE_KEY = "citera.library.sort";

const sortOptions: Array<{ value: SortOption; label: string }> = [
  { value: "created_at:desc", label: "追加が新しい順" },
  { value: "updated_at:desc", label: "更新が新しい順" },
  { value: "publication_date:desc", label: "出版年が新しい順" },
  { value: "title:asc", label: "タイトル順" },
  { value: "rating:desc", label: "評価が高い順" },
];

const quickStatusOptions: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "すべて" },
  { value: "inbox", label: "未着手" },
  { value: "reading", label: "読書中" },
  { value: "read", label: "読了" },
  { value: "archived", label: "アーカイブ" },
  { value: "deleted", label: "ゴミ箱" },
];

function loadSavedSort(): SortOption {
  try {
    const stored = window.localStorage.getItem(SORT_STORAGE_KEY);
    if (sortOptions.some((option) => option.value === stored)) return stored as SortOption;
  } catch {
    // Storage can be unavailable in privacy-restricted browsing contexts.
  }
  return DEFAULT_SORT;
}

function saveSort(value: SortOption) {
  try {
    window.localStorage.setItem(SORT_STORAGE_KEY, value);
  } catch {
    // Keep the in-memory preference when persistent storage is unavailable.
  }
}

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

function offlinePaperPage(all: PaperListItem[], search: URLSearchParams) {
  const query = search.get("q")?.trim().toLocaleLowerCase("ja-JP") ?? "";
  const status = search.get("status");
  const deleted = search.get("deleted") === "only";
  const hasPdf = search.get("hasPdf");
  const hasNotes = search.get("hasNotes");
  const yearFrom = Number(search.get("yearFrom") || 0);
  const yearTo = Number(search.get("yearTo") || 9999);
  const collectionId = search.get("collection");
  const recentBoundary = Date.now() - 30 * 24 * 60 * 60 * 1_000;
  const filtered = all.filter((paper) => {
    if (deleted ? !paper.deletedAt : Boolean(paper.deletedAt)) return false;
    if (status && paper.status !== status) return false;
    if (hasPdf === "true" && !paper.hasPdf) return false;
    if (hasPdf === "false" && paper.hasPdf) return false;
    if (hasNotes === "true" && !paper.hasNotes) return false;
    if (hasNotes === "false" && paper.hasNotes) return false;
    if (
      paper.publicationYear &&
      (paper.publicationYear < yearFrom || paper.publicationYear > yearTo)
    ) {
      return false;
    }
    if (search.get("recent") === "true" && new Date(paper.createdAt).getTime() < recentBoundary) {
      return false;
    }
    if (collectionId && !paper.collections?.some((collection) => collection.id === collectionId)) {
      return false;
    }
    if (!query) return true;
    return [
      paper.title,
      paper.summary,
      paper.venue,
      ...paper.authors.map((author) => author.displayName),
      ...paper.tags.map((tag) => tag.name),
    ].some((value) => value?.toLocaleLowerCase("ja-JP").includes(query));
  });
  const [field, direction] = (search.get("sort") ?? DEFAULT_SORT).split(":");
  const multiplier = direction === "asc" ? 1 : -1;
  filtered.sort((left, right) => {
    const leftValue =
      field === "title"
        ? left.title.toLocaleLowerCase("ja-JP")
        : field === "created_at"
          ? left.createdAt
          : field === "publication_date"
            ? (left.publicationDate ?? String(left.publicationYear ?? 0))
            : field === "rating"
              ? (left.rating ?? 0)
              : left.updatedAt;
    const rightValue =
      field === "title"
        ? right.title.toLocaleLowerCase("ja-JP")
        : field === "created_at"
          ? right.createdAt
          : field === "publication_date"
            ? (right.publicationDate ?? String(right.publicationYear ?? 0))
            : field === "rating"
              ? (right.rating ?? 0)
              : right.updatedAt;
    return (leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0) * multiplier;
  });
  return { items: filtered.slice(0, 50), nextCursor: null, hasMore: false };
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

async function settlePaperOperations(ids: string[], operation: (id: string) => Promise<unknown>) {
  const results = await Promise.allSettled(ids.map((id) => operation(id)));
  const failedIds = ids.filter((_, index) => results[index]?.status === "rejected");
  return { succeeded: ids.length - failedIds.length, failedIds };
}

function PaperRow({
  paper,
  checked,
  onCheck,
  onOpen,
  onAction,
  onRate,
  onStatusChange,
  onOpenPdf,
  actionPending,
  open,
}: {
  paper: PaperListItem;
  checked: boolean;
  onCheck: (checked: boolean) => void;
  onOpen: (paperId: string) => void;
  onAction: (paper: PaperListItem, action: PaperRowAction) => void;
  onRate: (paper: PaperListItem, rating: number | null) => void;
  onStatusChange: (paper: PaperListItem, status: PaperListItem["status"]) => void;
  onOpenPdf: (paperId: string) => void;
  actionPending: boolean;
  open: boolean;
}) {
  return (
    <tr
      className={`paper-row${checked ? " selected" : ""}${open ? " is-open" : ""}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a, button, input, select, label")) return;
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
          <p className="paper-mobile-meta">
            {[paper.publicationYear, paper.venue].filter(Boolean).join(" · ") || "出版情報未設定"}
          </p>
          {(paper.tags.length > 0 || (paper.collections?.length ?? 0) > 0) && (
            <div className="paper-mobile-taxonomy" aria-hidden="true">
              {paper.tags.slice(0, 2).map((tag) => (
                <span className="tag-chip" key={tag.id}>
                  <i style={{ background: tag.color ?? "#73846f" }} /> {tag.name}
                </span>
              ))}
              {paper.collections?.slice(0, 1).map((collection) => (
                <span className="collection-chip" key={collection.id}>
                  <Folder size={12} /> {collection.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </td>
      <td className="summary-cell">
        {paper.summary ? <span title={paper.summary}>{paper.summary}</span> : <span>—</span>}
      </td>
      <td className="row-status-cell">
        <label className={`status-badge status-${paper.status}`}>
          <span className="sr-only">{paper.title} の状態</span>
          <select
            value={paper.status}
            disabled={actionPending || Boolean(paper.deletedAt)}
            aria-label={`${paper.title} の状態`}
            onChange={(event) =>
              onStatusChange(paper, event.target.value as PaperListItem["status"])
            }
          >
            <option value="inbox">未着手</option>
            <option value="reading">読書中</option>
            <option value="read">読了</option>
            <option value="archived">アーカイブ</option>
          </select>
        </label>
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
        {paper.hasPdf ? (
          <button
            type="button"
            className="pdf-open-button"
            aria-label={`${paper.title} のPDFを開く`}
            title="PDFを開く"
            onClick={() => onOpenPdf(paper.id)}
          >
            <FileText size={16} />
            <span className="pdf-open-label">PDF</span>
          </button>
        ) : (
          <span>—</span>
        )}
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
                    label: paper.status === "archived" ? "一覧に戻す" : "アーカイブ",
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
  const [hasNotes, setHasNotes] = useState<"all" | "true" | "false">("all");
  const [recentOnly, setRecentOnly] = useState(false);
  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  const [sort, setSort] = useState<SortOption>(loadSavedSort);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTagId, setBulkTagId] = useState("");
  const [bulkCollectionId, setBulkCollectionId] = useState("");
  const [selectedCollectionId, setSelectedCollectionId] = useState("");
  const [expandedCollectionIds, setExpandedCollectionIds] = useState<Set<string>>(new Set());
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
  const [openPaperTab, setOpenPaperTab] = useState<"pdf" | "details">("details");
  const [manualEntry, setManualEntry] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(() =>
    clampDrawerWidth(Math.min(720, Math.round(window.innerWidth * 0.58))),
  );
  const [drawerResizing, setDrawerResizing] = useState(false);
  const drawerResizeStartRef = useRef<{ x: number; width: number } | null>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
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
    if (hasNotes !== "all") params.set("hasNotes", hasNotes);
    if (recentOnly) params.set("recent", "true");
    if (/^\d{4}$/u.test(yearFrom)) params.set("yearFrom", yearFrom);
    if (/^\d{4}$/u.test(yearTo)) params.set("yearTo", yearTo);
    if (selectedCollectionId) params.set("collection", selectedCollectionId);
    return params;
  }, [
    deferredQuery,
    hasPdf,
    hasNotes,
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
        if (pageParam === null) {
          const cached = await db.papers.toArray();
          if (!navigator.onLine || cached.length > 0) return offlinePaperPage(cached, pageSearch);
        }
        throw error;
      }
    },
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined,
  });
  const items = papers.data?.pages.flatMap((page) => page.items) ?? [];
  const activeFilterCount = [
    status !== "all",
    hasPdf !== "all",
    hasNotes !== "all",
    recentOnly,
    yearFrom,
    yearTo,
  ].filter(Boolean).length;
  const hasActiveSearch = Boolean(query.trim() || activeFilterCount > 0);
  const availableTags = useQuery({
    queryKey: ["tags"],
    queryFn: api.tags,
    enabled: selected.size > 0 && status !== "deleted",
  });
  const collectionOptions = useMemo(
    () => buildCollectionOptions(collections.data ?? []),
    [collections.data],
  );
  const collectionTreeNodes = useMemo(
    () => collectionTree(collections.data ?? []),
    [collections.data],
  );
  const selectedCollection = useMemo(
    () => collections.data?.find((collection) => collection.id === selectedCollectionId),
    [collections.data, selectedCollectionId],
  );
  const selectedCollectionDescendantCount = useMemo(
    () =>
      selectedCollection && collections.data
        ? collectionDescendantIds(selectedCollection.id, collections.data).length
        : 0,
    [collections.data, selectedCollection],
  );

  useEffect(() => {
    if (!collections.isSuccess || !selectedCollectionId) return;
    if (!collections.data.some((collection) => collection.id === selectedCollectionId)) {
      setSelectedCollectionId("");
    }
  }, [collections.data, collections.isSuccess, selectedCollectionId]);

  useEffect(() => {
    if (!selectedCollectionId || !collections.data) return;
    const ancestors = collectionAncestorIds(selectedCollectionId, collections.data);
    if (!ancestors.length) return;
    setExpandedCollectionIds((current) => {
      const next = new Set(current);
      ancestors.forEach((id) => next.add(id));
      return next.size === current.size ? current : next;
    });
  }, [collections.data, selectedCollectionId]);

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
      return settlePaperOperations([...selected], (id) => {
        const paper = byId.get(id);
        return paper
          ? api.updatePaper(id, paper.version, { status: nextStatus })
          : Promise.reject(new Error("Paper is no longer in the current result"));
      });
    },
    onSuccess: async ({ succeeded, failedIds }) => {
      setSelected(new Set(failedIds));
      setRowActionMessage({
        kind: failedIds.length ? "error" : "success",
        text: failedIds.length
          ? `${succeeded}件を更新し、${failedIds.length}件は競合のため更新できませんでした。`
          : `${succeeded}件の状態を更新しました。`,
      });
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
      return settlePaperOperations([...selected], (id) => {
        const paper = byId.get(id);
        return paper
          ? api.removePaper(id, paper.version)
          : Promise.reject(new Error("Paper is no longer in the current result"));
      });
    },
    onSuccess: async ({ succeeded, failedIds }) => {
      setSelected(new Set(failedIds));
      setRowActionMessage({
        kind: failedIds.length ? "error" : "success",
        text: failedIds.length
          ? `${succeeded}件を移動し、${failedIds.length}件は移動できませんでした。`
          : `${succeeded}件をゴミ箱へ移動しました。`,
      });
      await queryClient.invalidateQueries({ queryKey: ["papers"] });
    },
  });

  const bulkRestore = useMutation({
    mutationFn: async () => {
      const byId = new Map(items.map((paper) => [paper.id, paper]));
      return settlePaperOperations([...selected], (id) => {
        const paper = byId.get(id);
        return paper
          ? api.restorePaper(id, paper.version)
          : Promise.reject(new Error("Paper is no longer in the current result"));
      });
    },
    onSuccess: async ({ succeeded, failedIds }) => {
      setSelected(new Set(failedIds));
      setRowActionMessage({
        kind: failedIds.length ? "error" : "success",
        text: failedIds.length
          ? `${succeeded}件を復元し、${failedIds.length}件は重複または競合のため復元できませんでした。`
          : `${succeeded}件を復元しました。`,
      });
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
      status,
    }: {
      paper: PaperListItem;
      action: PaperRowAction;
      rating?: number | null;
      status?: PaperListItem["status"];
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
      if (action === "change-status" && status) {
        await api.updatePaper(paper.id, paper.version, { status });
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
    const drawer = drawerRef.current;
    const backgroundElements = drawer
      ? [
          ...(drawer.parentElement?.children ?? []),
          ...document.querySelectorAll(
            ".skip-link, .app-header, .mobile-app-nav, .connection-banner",
          ),
        ].filter(
          (element, index, elements): element is HTMLElement =>
            element instanceof HTMLElement &&
            element !== drawer &&
            !element.classList.contains("library-detail-backdrop") &&
            elements.indexOf(element) === index,
        )
      : [];
    const previousAriaHidden = backgroundElements.map((element) =>
      element.getAttribute("aria-hidden"),
    );
    backgroundElements.forEach((element) => {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    });
    const frame = window.requestAnimationFrame(() => drawer?.focus());
    const handleDrawerKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (document.querySelector('[role="menu"]')) return;
        setOpenPaperId(null);
        return;
      }
      if (event.key !== "Tab" || !drawer) return;
      const focusable = [
        ...drawer.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => !element.hidden && element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        drawer.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleDrawerKeys);
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleDrawerKeys);
      backgroundElements.forEach((element, index) => {
        element.inert = false;
        const previous = previousAriaHidden[index];
        if (previous == null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", previous);
      });
      returnFocusRef.current?.focus();
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

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "/") {
        event.preventDefault();
        searchInputRef.current?.focus();
      } else if (event.key.toLocaleLowerCase() === "n" && !createDialog.current?.open) {
        event.preventDefault();
        createPaper.reset();
        setManualEntry(false);
        createDialog.current?.showModal();
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [createPaper]);

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
      openPaper(paper.id);
      return;
    }
    if (action === "trash" && !window.confirm(`「${paper.title}」をゴミ箱へ移動しますか？`)) {
      return;
    }
    rowAction.mutate({ paper, action });
  }

  function openPaper(paperId: string, tab: "pdf" | "details" = "details") {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    setOpenPaperTab(tab);
    setOpenPaperId(paperId);
  }

  function ratePaper(paper: PaperListItem, rating: number | null) {
    setRowActionMessage(null);
    rowAction.mutate({ paper, action: "rate", rating });
  }

  function changePaperStatus(paper: PaperListItem, status: PaperListItem["status"]) {
    if (paper.status === status) return;
    setRowActionMessage(null);
    rowAction.mutate({ paper, action: "change-status", status });
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

  function renderCollectionTree(nodes: CollectionTreeNode[], depth = 0): ReactNode[] {
    return nodes.flatMap((node) => {
      const hasChildren = node.children.length > 0;
      const expanded = expandedCollectionIds.has(node.collection.id);
      const rows: ReactNode[] = [
        <div
          className={`collection-tree-row${selectedCollectionId === node.collection.id ? " active" : ""}`}
          key={node.collection.id}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={hasChildren ? expanded : undefined}
          style={{ paddingLeft: `${8 + depth * 18}px` }}
        >
          {hasChildren ? (
            <button
              type="button"
              className="collection-tree-toggle"
              aria-label={`${node.collection.name} の子フォルダーを${expanded ? "閉じる" : "開く"}`}
              aria-expanded={expanded}
              onClick={() =>
                setExpandedCollectionIds((current) => {
                  const next = new Set(current);
                  if (next.has(node.collection.id)) next.delete(node.collection.id);
                  else next.add(node.collection.id);
                  return next;
                })
              }
            >
              <ChevronRight size={14} className={expanded ? "is-expanded" : ""} />
            </button>
          ) : (
            <span className="collection-tree-spacer" aria-hidden="true" />
          )}
          <button
            type="button"
            className="collection-tree-filter"
            aria-pressed={selectedCollectionId === node.collection.id}
            title={collectionPath(node.collection, collections.data ?? [])}
            onClick={() => setSelectedCollectionId(node.collection.id)}
          >
            {selectedCollectionId === node.collection.id ? (
              <FolderOpen size={15} />
            ) : (
              <Folder size={15} />
            )}
            <span>{node.collection.name}</span>
            <small>{node.collection.paperCount ?? 0}</small>
          </button>
        </div>,
      ];
      if (hasChildren && expanded) rows.push(...renderCollectionTree(node.children, depth + 1));
      return rows;
    });
  }

  return (
    <div className="page library-page">
      <header className="page-heading library-heading">
        <div>
          <p className="eyebrow">YOUR RESEARCH</p>
          <h1>ライブラリ</h1>
          <p>
            <span aria-live="polite">
              {papers.data ? `${items.length} 件を表示` : "論文を読み込んでいます"}
            </span>
            <span aria-hidden="true"> · </span>変更は自動で同期
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
          <button
            type="button"
            className="button secondary file-import-button"
            disabled={importPapers.isPending}
            onClick={() => importInputRef.current?.click()}
          >
            <Upload size={17} /> {importPapers.isPending ? "インポート中…" : "インポート"}
          </button>
          <input
            ref={importInputRef}
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
          <button className="button primary" onClick={openCreateDialog} title="論文を追加（N）">
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
            aria-controls="quick-collection-creator"
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
            id="quick-collection-creator"
            className="quick-collection-creator"
            onSubmit={(event) => {
              event.preventDefault();
              if (newCollectionName.trim()) createQuickCollection.mutate();
            }}
          >
            <div className="quick-collection-heading">
              <div>
                <FolderPlus size={16} />
                <strong>新しいフォルダー</strong>
              </div>
              <span>論文を整理する場所を作成します</span>
            </div>
            <div className="quick-collection-fields">
              <label>
                <span>フォルダー名</span>
                <input
                  value={newCollectionName}
                  maxLength={200}
                  autoFocus
                  placeholder="例：2026年の研究"
                  onChange={(event) => {
                    setNewCollectionName(event.target.value);
                    createQuickCollection.reset();
                  }}
                />
              </label>
              <label>
                <span>親フォルダー / 子フォルダー</span>
                <select
                  value={newCollectionParentId}
                  onChange={(event) => setNewCollectionParentId(event.target.value)}
                >
                  <option value="">最上位に作成</option>
                  {collectionOptions.map(({ collection, label }) => (
                    <option key={collection.id} value={collection.id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="button secondary compact"
                disabled={!newCollectionName.trim() || createQuickCollection.isPending}
              >
                <FolderPlus size={15} /> {createQuickCollection.isPending ? "作成中…" : "作成"}
              </button>
            </div>
            {createQuickCollection.isError && (
              <span className="quick-tag-feedback error" role="alert">
                {createQuickCollection.error instanceof ApiRequestError
                  ? createQuickCollection.error.message
                  : "フォルダーを作成できませんでした。"}
              </span>
            )}
          </form>
        )}

        <nav className="collection-filter-list" aria-label="フォルダーで絞り込む">
          <button
            type="button"
            className={`collection-filter-all${selectedCollectionId ? "" : " active"}`}
            aria-pressed={!selectedCollectionId}
            onClick={() => setSelectedCollectionId("")}
          >
            <FolderOpen size={15} /> すべての論文
          </button>
          <div className="collection-tree" role="tree" aria-label="フォルダー一覧">
            {renderCollectionTree(collectionTreeNodes)}
          </div>
          {!collections.isPending && collectionOptions.length === 0 && (
            <span className="collection-empty-hint">フォルダーはまだありません。</span>
          )}
        </nav>
        {selectedCollection && (
          <div className="collection-active-summary" role="status">
            <FolderOpen size={15} />
            <span>
              <strong>{selectedCollection.name}</strong>
              <small>
                {collectionPath(selectedCollection, collections.data ?? [])} ·{" "}
                {selectedCollection.paperCount ?? 0}件
                {selectedCollectionDescendantCount > 0 ? " · 子フォルダーを含む" : ""}
              </small>
            </span>
            <button
              type="button"
              className="text-button"
              onClick={() => setSelectedCollectionId("")}
            >
              解除
            </button>
          </div>
        )}
      </section>

      <section className="library-toolbar" aria-label="ライブラリの検索とフィルター">
        <label className="search-field">
          <Search size={19} />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="タイトル、著者、DOI、タグを検索…"
            aria-label="論文を検索"
            aria-keyshortcuts="/"
          />
          {query && (
            <button onClick={() => setQuery("")} aria-label="検索をクリア">
              <X size={15} />
            </button>
          )}
        </label>
        <button
          className={
            filtersOpen ||
            status !== "all" ||
            hasPdf !== "all" ||
            hasNotes !== "all" ||
            recentOnly ||
            yearFrom ||
            yearTo
              ? "button filter-button active"
              : "button filter-button"
          }
          onClick={() => setFiltersOpen((value) => !value)}
          aria-expanded={filtersOpen}
          aria-controls="library-filter-panel"
        >
          <SlidersHorizontal size={17} /> フィルター
          {activeFilterCount > 0 && <span className="filter-count">{activeFilterCount}</span>}
          <ChevronDown size={15} />
        </button>
        <label className="sort-field">
          <ArrowDownUp size={17} />
          <select
            value={sort}
            onChange={(event) => {
              const nextSort = event.target.value as SortOption;
              setSort(nextSort);
              saveSort(nextSort);
            }}
            aria-label="並び替え"
          >
            {sortOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      {filtersOpen && (
        <section className="filter-panel" id="library-filter-panel">
          <fieldset className="status-filter-fieldset">
            <legend>状態</legend>
            <div className="status-quick-filter" role="group" aria-label="読書状態で絞り込む">
              {quickStatusOptions.map((option) => (
                <button
                  type="button"
                  key={option.value}
                  className={status === option.value ? "active" : ""}
                  aria-pressed={status === option.value}
                  onClick={() => setStatus(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>
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
            メモ
            <select
              value={hasNotes}
              onChange={(event) => setHasNotes(event.target.value as typeof hasNotes)}
            >
              <option value="all">すべて</option>
              <option value="true">メモあり</option>
              <option value="false">メモなし</option>
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
              setHasNotes("all");
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
              <button
                type="button"
                disabled={bulkStatus.isPending}
                onClick={() => bulkStatus.mutate("reading")}
              >
                <BookOpen size={16} /> 読書中
              </button>
              <button
                type="button"
                disabled={bulkStatus.isPending}
                onClick={() => bulkStatus.mutate("read")}
              >
                <CheckCircle2 size={16} /> 読了
              </button>
              <button
                type="button"
                disabled={bulkStatus.isPending}
                onClick={() => bulkStatus.mutate("archived")}
              >
                <Archive size={16} /> アーカイブ
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
              disabled={bulkDelete.isPending}
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
            {selectedCollectionId ? (
              <FolderOpen size={31} />
            ) : hasActiveSearch ? (
              <Search size={31} />
            ) : (
              <BookOpen size={31} />
            )}
            <h2>
              {selectedCollectionId
                ? "このフォルダーにはまだ論文がありません"
                : hasActiveSearch
                  ? "条件に一致する論文がありません"
                  : "最初の論文を追加しましょう"}
            </h2>
            <p>
              {selectedCollectionId
                ? "「すべての論文」に戻り、論文を選択してフォルダーへ追加できます。"
                : hasActiveSearch
                  ? "検索語や絞り込み条件を変更して、もう一度お試しください。"
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
            ) : hasActiveSearch ? (
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  setQuery("");
                  setStatus("all");
                  setHasPdf("all");
                  setHasNotes("all");
                  setRecentOnly(false);
                  setYearFrom("");
                  setYearTo("");
                }}
              >
                条件をすべて解除
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
                    onOpen={openPaper}
                    onAction={runRowAction}
                    onRate={ratePaper}
                    onStatusChange={changePaperStatus}
                    onOpenPdf={(paperId) => openPaper(paperId, "pdf")}
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
            tabIndex={-1}
            onClick={() => setOpenPaperId(null)}
          />
          <aside
            ref={drawerRef}
            className={
              drawerResizing ? "library-detail-drawer is-resizing" : "library-detail-drawer"
            }
            style={{ width: drawerWidth }}
            aria-label="論文詳細"
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
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
              key={`${openPaperId}-${openPaperTab}`}
              paperId={openPaperId}
              drawer
              initialTab={openPaperTab}
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
            <section className="manual-entry-block" aria-label="書誌情報を手入力">
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
