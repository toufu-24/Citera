import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import DOMPurify from "dompurify";
import {
  AlertTriangle,
  ArrowLeft,
  BookMarked,
  BookOpen,
  CalendarDays,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  FolderPlus,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Star,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { marked } from "marked";
import { useEffect, useMemo, useState } from "react";

import { PdfUpload } from "../components/PdfUpload";
import { PdfViewer } from "../components/PdfViewer";
import { api, type NoteRecord, type PaperDetail } from "../lib/api";

const statusLabel: Record<PaperDetail["status"], string> = {
  inbox: "未整理",
  reading: "読書中",
  read: "読了",
  archived: "保管済み",
};

const readingStatusLabel: Record<NonNullable<PaperDetail["readingStatus"]>, string> = {
  unread: "未読",
  reading: "読書中",
  read: "読了",
  on_hold: "保留",
};

function formString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function NoteCard({
  note,
  onSave,
  onDelete,
  onPageSelect,
  saving,
}: {
  note: NoteRecord;
  onSave: (contentMarkdown: string) => void;
  onDelete: () => void;
  onPageSelect?: (() => void) | undefined;
  saving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(note.contentMarkdown);
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(note.contentMarkdown, { async: false })),
    [note.contentMarkdown],
  );

  return (
    <article className="note-card">
      <header>
        {note.noteType === "page" && onPageSelect ? (
          <button
            type="button"
            className="note-kind note-page note-page-link"
            onClick={onPageSelect}
            aria-label={`${note.pageNumber ?? "不明"}ページへ移動`}
          >
            p. {note.pageNumber ?? "—"}
          </button>
        ) : (
          <span className={`note-kind note-${note.noteType}`}>
            {note.noteType === "page"
              ? `p. ${note.pageNumber ?? "—"}`
              : note.noteType === "todo"
                ? "TODO"
                : note.noteType === "summary"
                  ? "要約"
                  : "メモ"}
          </span>
        )}
        <time dateTime={note.updatedAt}>
          {new Intl.DateTimeFormat("ja-JP", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date(note.updatedAt))}
        </time>
        <button
          type="button"
          className="icon-button"
          onClick={() => setEditing((value) => !value)}
          aria-label={editing ? "メモ編集を閉じる" : "メモを編集"}
        >
          <Pencil size={14} />
        </button>
      </header>
      {editing ? (
        <form
          className="note-editor"
          onSubmit={(event) => {
            event.preventDefault();
            if (content.trim()) {
              onSave(content);
              setEditing(false);
            }
          }}
        >
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={5}
            aria-label="メモ本文"
          />
          <footer>
            <button type="button" className="text-button danger" onClick={onDelete}>
              <Trash2 size={13} /> 削除
            </button>
            <button className="button primary compact" disabled={!content.trim() || saving}>
              <Save size={14} /> 更新
            </button>
          </footer>
        </form>
      ) : (
        <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </article>
  );
}

type PaperDetailViewProps = {
  paperId: string;
  drawer?: boolean;
  onClose?: () => void;
};

export function PaperDetailPage() {
  const { paperId } = useParams({ from: "/app/papers/$paperId" });
  return <PaperDetailView paperId={paperId} />;
}

export function PaperDetailView({ paperId, drawer = false, onClose }: PaperDetailViewProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [currentPage, setCurrentPage] = useState(1);
  const [mobileTab, setMobileTab] = useState<"pdf" | "details">("details");
  const [inspectorTab, setInspectorTab] = useState<"notes" | "info" | "outline">("info");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [focusMode, setFocusMode] = useState(false);
  const [editing, setEditing] = useState(false);
  const [noteType, setNoteType] = useState<NoteRecord["noteType"]>("general");
  const [noteContent, setNoteContent] = useState("");
  const [paperNote, setPaperNote] = useState<string | null>(null);
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [collectionEditorOpen, setCollectionEditorOpen] = useState(false);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [libraryQuery, setLibraryQuery] = useState("");

  const paper = useQuery({ queryKey: ["paper", paperId], queryFn: () => api.paper(paperId) });
  const libraryPapers = useQuery({
    queryKey: ["papers", "detail-pane"],
    queryFn: () => api.papers(new URLSearchParams({ limit: "50", sort: "updated_at:desc" })),
    enabled: !drawer,
  });
  const duplicates = useQuery({
    queryKey: ["duplicates", paperId],
    queryFn: () => api.duplicateCandidates(paperId),
    enabled: paper.data?.metadataState === "needs_review",
  });
  const availableTags = useQuery({
    queryKey: ["tags"],
    queryFn: api.tags,
    enabled: tagEditorOpen,
  });
  const availableCollections = useQuery({
    queryKey: ["collections"],
    queryFn: api.collections,
    enabled: collectionEditorOpen,
  });

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => {
      if (!paper.data) throw new Error("Paper is not loaded");
      return api.updatePaper(paperId, paper.data.version, body);
    },
    onSuccess: (next) => {
      queryClient.setQueryData<PaperDetail>(["paper", paperId], (current) =>
        current ? { ...current, ...next, notes: next.notes ?? current.notes } : current,
      );
      void queryClient.invalidateQueries({ queryKey: ["papers"] });
    },
  });

  const refresh = useMutation({
    mutationFn: () => api.refreshMetadata(paperId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["paper", paperId] }),
  });

  const toggleTag = useMutation({
    mutationFn: ({ tagId, attached }: { tagId: string; attached: boolean }) =>
      attached ? api.removePaperTag(paperId, tagId) : api.addPaperTag(paperId, tagId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["paper", paperId] }),
        queryClient.invalidateQueries({ queryKey: ["papers"] }),
      ]);
    },
  });

  const toggleCollection = useMutation({
    mutationFn: ({ collectionId, attached }: { collectionId: string; attached: boolean }) =>
      attached
        ? api.removePaperFromCollection(paperId, collectionId)
        : api.addPaperToCollection(paperId, collectionId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["paper", paperId] }),
        queryClient.invalidateQueries({ queryKey: ["papers"] }),
      ]);
    },
  });

  const addNote = useMutation({
    mutationFn: () =>
      api.addNote(paperId, {
        noteType,
        pageNumber: noteType === "page" ? currentPage : null,
        contentMarkdown: noteContent,
      }),
    onSuccess: () => {
      setNoteContent("");
      void queryClient.invalidateQueries({ queryKey: ["paper", paperId] });
    },
  });

  const editNote = useMutation({
    mutationFn: ({ note, contentMarkdown }: { note: NoteRecord; contentMarkdown: string }) =>
      api.updateNote(note.id, note.version, { contentMarkdown }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["paper", paperId] }),
  });

  const deleteNote = useMutation({
    mutationFn: (note: NoteRecord) => api.removeNote(note.id, note.version),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["paper", paperId] }),
  });

  const deletePaper = useMutation({
    mutationFn: () => {
      if (!paper.data) throw new Error("Paper is not loaded");
      return api.removePaper(paperId, paper.data.version);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["papers"] });
      void navigate({ to: "/library" });
    },
  });

  const copyBibtex = useMutation({
    mutationFn: () => api.bibtex(paperId),
    onSuccess: async (content) => {
      await navigator.clipboard.writeText(content);
    },
  });

  const files = paper.data?.files ?? [];
  const orderedFiles = useMemo(
    () =>
      [...files].sort(
        (left, right) =>
          Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)) ||
          (left.sortOrder ?? 0) - (right.sortOrder ?? 0),
      ),
    [files],
  );
  const orderedNotes = useMemo(
    () =>
      [...(paper.data?.notes ?? [])].sort(
        (left, right) =>
          Number(right.noteType === "page" && right.pageNumber === currentPage) -
            Number(left.noteType === "page" && left.pageNumber === currentPage) ||
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      ),
    [currentPage, paper.data?.notes],
  );
  const visibleLibraryPapers = useMemo(() => {
    const normalizedQuery = libraryQuery.trim().toLocaleLowerCase("ja-JP");
    if (!normalizedQuery) return libraryPapers.data?.items ?? [];
    return (libraryPapers.data?.items ?? []).filter((item) =>
      [item.title, item.venue, ...item.authors.map((author) => author.displayName)]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase("ja-JP").includes(normalizedQuery)),
    );
  }, [libraryPapers.data?.items, libraryQuery]);
  useEffect(() => {
    if (paper.data && paperNote === null) setPaperNote(paper.data.noteMarkdown ?? "");
  }, [paper.data, paperNote]);
  useEffect(() => {
    setPaperNote(null);
    setCurrentPage(1);
    setMobileTab("details");
    setInspectorTab("info");
  }, [paperId]);
  useEffect(() => {
    document.body.classList.toggle("citera-focus-mode", focusMode);
    return () => document.body.classList.remove("citera-focus-mode");
  }, [focusMode]);
  useEffect(() => {
    if (!selectedFileId || !files.some((file) => file.id === selectedFileId)) {
      setSelectedFileId(
        orderedFiles.find((file) => file.uploadState === "verified")?.id ??
          orderedFiles[0]?.id ??
          null,
      );
    }
  }, [files, orderedFiles, selectedFileId]);

  if (paper.isLoading) {
    return (
      <div className="page">
        <div className="loading-state tall">
          <span className="spinner" />
          <p>論文を開いています…</p>
        </div>
      </div>
    );
  }
  if (!paper.data || paper.isError) {
    return (
      <div className="page">
        <div className="empty-state tall">
          <AlertTriangle size={30} />
          <h1>論文を開けませんでした</h1>
          <p>削除済みか、アクセス権がない可能性があります。</p>
          <Link className="button secondary" to="/library">
            <ArrowLeft size={16} /> ライブラリへ
          </Link>
        </div>
      </div>
    );
  }

  const data = paper.data;
  const pdf =
    files.find((file) => file.id === selectedFileId) ??
    orderedFiles.find((file) => file.uploadState === "verified") ??
    orderedFiles[0];
  const doi = data.identifiers.find(
    (identifier) => (identifier.identifierType ?? identifier.type) === "doi",
  )?.normalizedValue;
  const arxivId = data.identifiers.find(
    (identifier) => (identifier.identifierType ?? identifier.type) === "arxiv",
  )?.normalizedValue;

  function submitMetadata(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    update.mutate(
      {
        title: formString(form, "title"),
        abstract: formString(form, "abstract") || null,
        venue: formString(form, "venue") || null,
        publicationYear: formString(form, "publicationYear")
          ? Number(formString(form, "publicationYear"))
          : null,
        sourceUrl: formString(form, "sourceUrl") || null,
      },
      { onSuccess: () => setEditing(false) },
    );
  }

  const closeDetail = onClose ?? (() => void navigate({ to: "/library" }));

  return (
    <div
      className={`paper-detail-page ${drawer ? "paper-detail-drawer" : ""} view-${mobileTab} ${focusMode ? "is-focus-mode" : ""}`}
    >
      {!drawer && (
        <aside className="detail-library-pane" aria-label="論文一覧">
          <header>
            <div>
              <p className="eyebrow">LIBRARY</p>
              <h2>すべての論文</h2>
            </div>
            <span>{libraryPapers.data?.items.length ?? "—"}</span>
          </header>
          <label className="detail-library-search">
            <Search size={16} />
            <input
              type="search"
              value={libraryQuery}
              onChange={(event) => setLibraryQuery(event.target.value)}
              placeholder="論文を検索…"
              aria-label="論文を検索"
            />
          </label>
          <div className="detail-library-list">
            {libraryPapers.isPending ? (
              <div className="detail-library-message">論文を読み込んでいます…</div>
            ) : visibleLibraryPapers.length ? (
              visibleLibraryPapers.map((item) => (
                <Link
                  key={item.id}
                  to="/papers/$paperId"
                  params={{ paperId: item.id }}
                  className={
                    item.id === paperId ? "detail-library-item active" : "detail-library-item"
                  }
                >
                  <i aria-hidden="true" />
                  <div>
                    <strong>{item.title}</strong>
                    <span>
                      {item.authors.map((author) => author.displayName).join(", ") || "著者未設定"}
                    </span>
                  </div>
                  <time>{item.publicationYear ?? "—"}</time>
                  <span className={`status-badge status-${item.status}`}>
                    {statusLabel[item.status]}
                  </span>
                </Link>
              ))
            ) : (
              <div className="detail-library-message">該当する論文がありません。</div>
            )}
          </div>
        </aside>
      )}

      <div className="paper-detail-panel" key={paperId}>
        <header className="detail-topbar">
          {drawer ? (
            <button
              type="button"
              className="icon-button drawer-close"
              onClick={closeDetail}
              aria-label="論文詳細を閉じる"
              title="論文詳細を閉じる"
            >
              <X size={19} />
            </button>
          ) : (
            <Link to="/library" className="back-link">
              <ArrowLeft size={17} /> ライブラリ
            </Link>
          )}
          <div className="detail-breadcrumb">
            <span>ライブラリ</span>
            <ChevronRight size={14} />
            <strong>{data.title}</strong>
          </div>
          <div className="detail-actions">
            {mobileTab === "pdf" && (
              <button
                type="button"
                className="button secondary compact"
                onClick={() => setMobileTab("details")}
              >
                <ArrowLeft size={16} /> 論文情報に戻る
              </button>
            )}
            <PdfUpload
              paperId={paperId}
              onComplete={() =>
                void queryClient.invalidateQueries({ queryKey: ["paper", paperId] })
              }
            />
            <button type="button" className="icon-button" aria-label="その他">
              <MoreHorizontal size={19} />
            </button>
            <button
              type="button"
              className="button secondary compact"
              onClick={() => copyBibtex.mutate()}
              disabled={copyBibtex.isPending}
            >
              <Copy size={15} /> BibTeX
            </button>
          </div>
        </header>

        {mobileTab === "pdf" && orderedFiles.length > 0 && (
          <nav className="pdf-file-tabs" aria-label="PDFを切り替え">
            {orderedFiles.map((file) => (
              <button
                key={file.id}
                type="button"
                className={file.id === pdf?.id ? "active" : ""}
                onClick={() => setSelectedFileId(file.id)}
              >
                {file.label ?? file.originalName}
                {file.isDefault ? " ★" : ""}
              </button>
            ))}
            {pdf && !pdf.isDefault && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  void api.updateFile(pdf.id, { isDefault: true }).then(() => {
                    void queryClient.invalidateQueries({ queryKey: ["paper", paperId] });
                  });
                }}
              >
                このPDFを既定にする
              </button>
            )}
          </nav>
        )}

        <div className="mobile-detail-tabs" role="tablist" aria-label="論文詳細の表示">
          <button
            type="button"
            role="tab"
            aria-selected={mobileTab === "pdf"}
            className={mobileTab === "pdf" ? "active" : ""}
            onClick={() => setMobileTab("pdf")}
          >
            PDF
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobileTab === "details"}
            className={mobileTab === "details" ? "active" : ""}
            onClick={() => setMobileTab("details")}
          >
            情報とメモ
          </button>
        </div>

        <div className={`detail-split ${inspectorOpen ? "inspector-open" : "inspector-closed"}`}>
          <div
            role="tabpanel"
            className={mobileTab === "pdf" ? "pdf-pane mobile-active" : "pdf-pane"}
          >
            <PdfViewer
              fileId={pdf?.id ?? null}
              title={data.title}
              page={currentPage}
              onPageChange={setCurrentPage}
              inspectorOpen={inspectorOpen}
              onToggleInspector={() => setInspectorOpen((value) => !value)}
              focusMode={focusMode}
              onToggleFocus={() => setFocusMode((value) => !value)}
              onCreatePageNote={(pageNumber) => {
                setCurrentPage(pageNumber);
                setNoteType("page");
                setInspectorTab("notes");
                setInspectorOpen(true);
                setFocusMode(false);
              }}
            />
          </div>
          <aside
            role="tabpanel"
            className={mobileTab === "details" ? "metadata-pane mobile-active" : "metadata-pane"}
          >
            <div className="inspector-tabs" role="tablist" aria-label="論文サイドパネル">
              <button
                type="button"
                role="tab"
                aria-selected={inspectorTab === "notes"}
                className={inspectorTab === "notes" ? "active" : ""}
                onClick={() => setInspectorTab("notes")}
              >
                メモ
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={inspectorTab === "info"}
                className={inspectorTab === "info" ? "active" : ""}
                onClick={() => setInspectorTab("info")}
              >
                概要
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={inspectorTab === "outline"}
                className={inspectorTab === "outline" ? "active" : ""}
                onClick={() => setInspectorTab("outline")}
              >
                目次
              </button>
              <button
                type="button"
                className="icon-button inspector-close"
                onClick={() => setInspectorOpen(false)}
                aria-label="情報パネルを閉じる"
                title="情報パネルを閉じる"
              >
                <X size={16} />
              </button>
            </div>
            <div className="inspector-content">
              {inspectorTab === "info" ? (
                <>
                  {data.metadataState === "needs_review" && (
                    <div className="review-banner">
                      <Sparkles size={18} />
                      <div>
                        <strong>書誌情報の確認が必要です</strong>
                        <p>
                          {duplicates.data?.length
                            ? `${duplicates.data.length} 件の類似論文があります。`
                            : "複数の情報源から候補が見つかりました。"}
                        </p>
                      </div>
                    </div>
                  )}
                  <section className="paper-identity">
                    <div className="paper-meta-line">
                      <label className={`status-badge status-${data.status}`}>
                        <span className="sr-only">状態</span>
                        <select
                          value={data.status}
                          onChange={(event) => update.mutate({ status: event.target.value })}
                          disabled={update.isPending}
                        >
                          {Object.entries(statusLabel).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="status-badge status-reading">
                        <span className="sr-only">読書状態</span>
                        <select
                          value={data.readingStatus ?? "unread"}
                          onChange={(event) => update.mutate({ readingStatus: event.target.value })}
                          disabled={update.isPending}
                        >
                          {Object.entries(readingStatusLabel).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <span className="publication-year">
                        <CalendarDays size={13} /> {data.publicationYear ?? "出版年不明"}
                      </span>
                      <span>{data.venue ?? "掲載先未設定"}</span>
                    </div>
                    <h1>{data.title}</h1>
                    <p className="detail-authors">
                      {data.authors.map((author) => author.displayName).join(", ") || "著者未設定"}
                    </p>
                    <div className="identifier-row">
                      {doi && (
                        <a href={`https://doi.org/${doi}`} target="_blank" rel="noreferrer">
                          DOI {doi}
                          <ExternalLink size={13} />
                        </a>
                      )}
                      {arxivId && (
                        <a
                          href={`https://arxiv.org/abs/${arxivId}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          arXiv {arxivId}
                          <ExternalLink size={13} />
                        </a>
                      )}
                    </div>
                    <div className="rating-row" aria-label="評価">
                      {[1, 2, 3, 4, 5].map((value) => (
                        <button
                          type="button"
                          key={value}
                          onClick={() =>
                            update.mutate({ rating: data.rating === value ? null : value })
                          }
                          disabled={update.isPending}
                          aria-label={`${value}つ星`}
                        >
                          <Star
                            size={19}
                            fill={value <= (data.rating ?? 0) ? "currentColor" : "none"}
                          />
                        </button>
                      ))}
                    </div>
                    <div className="paper-tags">
                      {data.tags.map((tag) => (
                        <span className="tag-chip" key={tag.id}>
                          <i style={{ background: tag.color ?? "#74856f" }} />
                          {tag.name}
                        </span>
                      ))}
                      <button
                        type="button"
                        className="tag-add"
                        aria-expanded={tagEditorOpen}
                        onClick={() => setTagEditorOpen((value) => !value)}
                      >
                        <Tag size={14} /> 追加
                      </button>
                      {tagEditorOpen && (
                        <div className="relation-editor" role="group" aria-label="タグを編集">
                          {availableTags.isPending ? (
                            <span className="relation-message">タグを読み込んでいます…</span>
                          ) : availableTags.isError ? (
                            <span className="form-error" role="alert">
                              タグを読み込めませんでした。
                            </span>
                          ) : availableTags.data?.length ? (
                            availableTags.data.map((tag) => {
                              const attached = data.tags.some((current) => current.id === tag.id);
                              return (
                                <label key={tag.id}>
                                  <input
                                    type="checkbox"
                                    checked={attached}
                                    disabled={toggleTag.isPending}
                                    onChange={() => toggleTag.mutate({ tagId: tag.id, attached })}
                                  />
                                  <i style={{ background: tag.color ?? "#74856f" }} />
                                  {tag.name}
                                </label>
                              );
                            })
                          ) : (
                            <span className="relation-message">利用できるタグがありません。</span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="collection-row">
                      <BookMarked size={16} />
                      <span>
                        {data.collections.map((collection) => collection.name).join(" / ") ||
                          "コレクション未設定"}
                      </span>
                      <button
                        type="button"
                        aria-label="コレクションを編集"
                        aria-expanded={collectionEditorOpen}
                        onClick={() => setCollectionEditorOpen((value) => !value)}
                      >
                        <FolderPlus size={16} />
                      </button>
                    </div>
                    {collectionEditorOpen && (
                      <div
                        className="relation-editor collection-editor"
                        role="group"
                        aria-label="コレクションを編集"
                      >
                        {availableCollections.isPending ? (
                          <span className="relation-message">コレクションを読み込んでいます…</span>
                        ) : availableCollections.isError ? (
                          <span className="form-error" role="alert">
                            コレクションを読み込めませんでした。
                          </span>
                        ) : availableCollections.data?.length ? (
                          availableCollections.data.map((collection) => {
                            const attached = data.collections.some(
                              (current) => current.id === collection.id,
                            );
                            return (
                              <label key={collection.id}>
                                <input
                                  type="checkbox"
                                  checked={attached}
                                  disabled={toggleCollection.isPending}
                                  onChange={() =>
                                    toggleCollection.mutate({
                                      collectionId: collection.id,
                                      attached,
                                    })
                                  }
                                />
                                {collection.name}
                              </label>
                            );
                          })
                        ) : (
                          <span className="relation-message">
                            利用できるコレクションがありません。
                          </span>
                        )}
                      </div>
                    )}
                    <div className="paper-quick-actions">
                      {pdf && (
                        <button
                          type="button"
                          className="button primary"
                          onClick={() => setMobileTab("pdf")}
                        >
                          <BookOpen size={17} /> PDFを見る
                        </button>
                      )}
                      <a className="button secondary" href="#paper-abstract">
                        <Sparkles size={17} /> 要旨を読む
                      </a>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => setInspectorTab("notes")}
                      >
                        <NotebookPen size={17} /> メモを追加
                      </button>
                    </div>
                    {(toggleTag.error || toggleCollection.error) && (
                      <p className="form-error" role="alert">
                        分類を更新できませんでした。
                      </p>
                    )}
                    {update.error && (
                      <p className="form-error" role="alert">
                        変更を保存できませんでした。再読み込みしてお試しください。
                      </p>
                    )}
                  </section>

                  <section className="metadata-section" id="paper-abstract">
                    <header>
                      <h2>要旨</h2>
                      <div>
                        <button
                          type="button"
                          className="text-icon-button"
                          onClick={() => refresh.mutate()}
                          disabled={refresh.isPending}
                        >
                          <RefreshCw size={15} className={refresh.isPending ? "spin" : ""} /> 再取得
                        </button>
                        <button
                          type="button"
                          className="text-icon-button"
                          onClick={() => setEditing((value) => !value)}
                        >
                          <Pencil size={15} /> 編集
                        </button>
                      </div>
                    </header>
                    {editing ? (
                      <form className="metadata-form" onSubmit={submitMetadata}>
                        <label>
                          タイトル
                          <input name="title" defaultValue={data.title} required />
                        </label>
                        <div className="form-grid">
                          <label>
                            出版年
                            <input
                              name="publicationYear"
                              type="number"
                              min={1000}
                              max={9999}
                              defaultValue={data.publicationYear ?? ""}
                            />
                          </label>
                          <label>
                            掲載誌・会議
                            <input name="venue" defaultValue={data.venue ?? ""} />
                          </label>
                        </div>
                        <label>
                          元ページ
                          <input name="sourceUrl" type="url" defaultValue={data.sourceUrl ?? ""} />
                        </label>
                        <label>
                          要旨
                          <textarea name="abstract" rows={6} defaultValue={data.abstract ?? ""} />
                        </label>
                        <div className="form-actions">
                          <button
                            type="button"
                            className="button secondary compact"
                            onClick={() => setEditing(false)}
                          >
                            キャンセル
                          </button>
                          <button className="button primary compact" disabled={update.isPending}>
                            <Save size={15} /> 保存
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="metadata-summary">
                        {data.abstract ? (
                          <p>{data.abstract}</p>
                        ) : (
                          <p className="muted-copy">
                            要旨はまだありません。書誌情報を再取得するか、編集して追加できます。
                          </p>
                        )}
                        {data.sourceUrl && (
                          <a href={data.sourceUrl} target="_blank" rel="noreferrer">
                            <ExternalLink size={14} /> 元ページを開く
                          </a>
                        )}
                      </div>
                    )}
                    {refresh.error && (
                      <p className="form-error" role="alert">
                        書誌情報の再取得を開始できませんでした。
                      </p>
                    )}
                  </section>

                  <section className="recent-notes-section">
                    <header>
                      <h2>最近のメモ</h2>
                      <button
                        type="button"
                        className="text-icon-button"
                        onClick={() => setInspectorTab("notes")}
                      >
                        すべて見る <ChevronRight size={14} />
                      </button>
                    </header>
                    {orderedNotes.length ? (
                      <div className="note-list">
                        {orderedNotes.slice(0, 2).map((note) => (
                          <NoteCard
                            key={note.id}
                            note={note}
                            saving={editNote.isPending}
                            onPageSelect={
                              note.noteType === "page" && note.pageNumber
                                ? () => {
                                    setCurrentPage(note.pageNumber ?? 1);
                                    setMobileTab("pdf");
                                  }
                                : undefined
                            }
                            onSave={(contentMarkdown) => editNote.mutate({ note, contentMarkdown })}
                            onDelete={() => {
                              if (window.confirm("このメモを削除しますか？"))
                                deleteNote.mutate(note);
                            }}
                          />
                        ))}
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="recent-notes-empty"
                        onClick={() => setInspectorTab("notes")}
                      >
                        <NotebookPen size={18} /> 最初のメモを追加
                      </button>
                    )}
                  </section>

                  <section className="danger-zone">
                    <button
                      type="button"
                      disabled={deletePaper.isPending}
                      onClick={() => {
                        if (window.confirm("この論文をゴミ箱へ移動しますか？"))
                          deletePaper.mutate();
                      }}
                    >
                      <Trash2 size={15} /> {deletePaper.isPending ? "移動中…" : "ゴミ箱へ移動"}
                    </button>
                    {deletePaper.error && (
                      <p className="form-error" role="alert">
                        論文を削除できませんでした。
                      </p>
                    )}
                  </section>
                </>
              ) : inspectorTab === "notes" ? (
                <>
                  <section className="notes-section">
                    <header>
                      <div>
                        <p className="eyebrow">ANNOTATIONS</p>
                        <h2>
                          <span className="current-page-note-title">
                            ページ {currentPage} のメモ
                          </span>
                          <span className="note-count">{data.notes.length}</span>
                        </h2>
                      </div>
                    </header>
                    <form
                      className="note-composer"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (noteContent.trim()) addNote.mutate();
                      }}
                    >
                      <div className="note-type-row">
                        <select
                          value={noteType}
                          onChange={(event) =>
                            setNoteType(event.target.value as NoteRecord["noteType"])
                          }
                          aria-label="メモ種別"
                        >
                          <option value="general">全体メモ</option>
                          <option value="page">ページメモ（p. {currentPage}）</option>
                          <option value="summary">要約</option>
                          <option value="todo">TODO</option>
                        </select>
                        <span>Markdown</span>
                      </div>
                      <textarea
                        value={noteContent}
                        onChange={(event) => setNoteContent(event.target.value)}
                        onKeyDown={(event) => {
                          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                            event.preventDefault();
                            event.currentTarget.form?.requestSubmit();
                          }
                        }}
                        rows={4}
                        aria-label="新しいメモ"
                        placeholder={
                          noteType === "page"
                            ? `ページ ${currentPage} の気づきを残す…`
                            : "この論文についてメモを残す…"
                        }
                      />
                      <footer>
                        <span>⌘ + Enter で保存</span>
                        <button
                          className="button primary compact"
                          disabled={!noteContent.trim() || addNote.isPending}
                        >
                          <Check size={15} /> 保存
                        </button>
                      </footer>
                    </form>
                    {addNote.error && (
                      <p className="form-error" role="alert">
                        メモを保存できませんでした。
                      </p>
                    )}
                    <div className="note-list">
                      {orderedNotes.length ? (
                        orderedNotes.map((note) => (
                          <NoteCard
                            key={note.id}
                            note={note}
                            saving={editNote.isPending}
                            onPageSelect={
                              note.noteType === "page" && note.pageNumber
                                ? () => {
                                    setCurrentPage(note.pageNumber ?? 1);
                                    setMobileTab("pdf");
                                  }
                                : undefined
                            }
                            onSave={(contentMarkdown) => editNote.mutate({ note, contentMarkdown })}
                            onDelete={() => {
                              if (window.confirm("このメモを削除しますか？"))
                                deleteNote.mutate(note);
                            }}
                          />
                        ))
                      ) : (
                        <div className="notes-empty">
                          <FileText size={20} />
                          <p>まだメモはありません。読みながら気づきを残しましょう。</p>
                        </div>
                      )}
                    </div>
                  </section>

                  <section className="metadata-section paper-note-section">
                    <header>
                      <div>
                        <p className="eyebrow">PAPER NOTE</p>
                        <h2>Markdownメモ</h2>
                      </div>
                      <span className="muted-copy">論文ごとに1件</span>
                    </header>
                    <textarea
                      value={paperNote ?? ""}
                      onChange={(event) => setPaperNote(event.target.value)}
                      onBlur={() => {
                        if (paperNote !== (data.noteMarkdown ?? "")) {
                          update.mutate({ noteMarkdown: paperNote ?? null });
                        }
                      }}
                      rows={8}
                      placeholder="要点、重要な数式、実験条件、研究との関連など…"
                      aria-label="論文のMarkdownメモ"
                    />
                    <p className="muted-copy">入力欄からフォーカスを外すと保存します。</p>
                  </section>
                </>
              ) : (
                <section className="outline-empty">
                  <FileText size={22} />
                  <h2>目次</h2>
                  <p>このPDFには表示できる目次情報がありません。</p>
                </section>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
