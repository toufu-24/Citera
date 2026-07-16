import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  BookMarked,
  BookOpen,
  CalendarDays,
  ChevronRight,
  Columns2,
  Copy,
  ExternalLink,
  FileText,
  FolderPlus,
  ListTodo,
  MapPin,
  MessageSquarePlus,
  Pencil,
  RefreshCw,
  Save,
  Sparkles,
  Star,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ActionMenu } from "../components/ActionMenu";
import { PdfUpload } from "../components/PdfUpload";
import { PdfViewer } from "../components/PdfViewer";
import { ApiRequestError, api, type NoteRecord, type PaperDetail } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { db } from "../lib/database";

function formString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

type PaperDetailViewProps = {
  paperId: string;
  drawer?: boolean;
  onClose?: () => void;
  initialTab?: "pdf" | "details";
};

export function PaperDetailPage() {
  const { paperId } = useParams({ from: "/app/papers/$paperId" });
  return <PaperDetailView paperId={paperId} />;
}

export function PaperDetailView({
  paperId,
  drawer = false,
  onClose,
  initialTab = "details",
}: PaperDetailViewProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [currentPage, setCurrentPage] = useState(1);
  const [mobileTab, setMobileTab] = useState<"pdf" | "details">(initialTab);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [focusMode, setFocusMode] = useState(false);
  const [editing, setEditing] = useState(false);
  const [paperNote, setPaperNote] = useState<string | null>(null);
  const [summaryDraft, setSummaryDraft] = useState<string | null>(null);
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [collectionEditorOpen, setCollectionEditorOpen] = useState(false);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [comparePdfs, setComparePdfs] = useState(false);
  const [pdfFetchQueued, setPdfFetchQueued] = useState(false);
  const [pdfFetchJobId, setPdfFetchJobId] = useState<string | null>(null);
  const [pdfFetchError, setPdfFetchError] = useState<string | null>(null);
  const [metadataRefreshQueued, setMetadataRefreshQueued] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteType, setNoteType] = useState<"general" | "page" | "todo">("general");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteDraft, setEditingNoteDraft] = useState("");
  const compareViewersRef = useRef<HTMLDivElement>(null);

  const paper = useQuery({
    queryKey: ["paper", paperId],
    queryFn: async () => {
      try {
        return await api.paper(paperId);
      } catch (error) {
        const recoverable =
          !navigator.onLine ||
          error instanceof TypeError ||
          (error instanceof ApiRequestError && error.status >= 500);
        if (!recoverable) throw error;
        const cached = await db.papers.get(paperId);
        if (!cached) throw error;
        const notes = await db.notes.where("paperId").equals(paperId).toArray();
        return {
          ...cached,
          abstract: null,
          sourceUrl: null,
          volume: null,
          issue: null,
          pages: null,
          publisher: null,
          language: null,
          paperType: "article-journal",
          priority: 0,
          readProgress: 0,
          identifiers: [],
          collections: cached.collections ?? [],
          notes,
          files: [],
          noteMarkdown: null,
        } satisfies PaperDetail;
      }
    },
    refetchInterval: metadataRefreshQueued ? 2_000 : false,
  });
  const pdfFetchStatus = useQuery({
    queryKey: ["pdf-fetch", paperId, pdfFetchJobId],
    queryFn: () => api.fetchPdfStatus(paperId, pdfFetchJobId ?? ""),
    enabled: Boolean(pdfFetchJobId),
    refetchInterval: pdfFetchJobId ? 2_000 : false,
    retry: 2,
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
    onSuccess: () => {
      setMetadataRefreshQueued(true);
      void queryClient.invalidateQueries({ queryKey: ["paper", paperId] });
    },
  });

  const fetchPdf = useMutation({
    mutationFn: () => api.fetchPdf(paperId),
    onSuccess: (result) => {
      setPdfFetchError(null);
      setPdfFetchJobId(result.jobId ?? null);
      setPdfFetchQueued(Boolean(result.jobId));
      void queryClient.invalidateQueries({ queryKey: ["paper", paperId] });
      void queryClient.invalidateQueries({ queryKey: ["papers"] });
    },
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

  const deletePaper = useMutation({
    mutationFn: () => {
      if (!paper.data) throw new Error("Paper is not loaded");
      return api.removePaper(paperId, paper.data.version);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["papers"] });
      if (onClose) onClose();
      else void navigate({ to: "/library" });
    },
  });

  const copyBibtex = useMutation({
    mutationFn: () => api.bibtex(paperId),
    onSuccess: async (content) => {
      await copyText(content);
    },
  });

  const refreshNotes = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["paper", paperId] }),
      queryClient.invalidateQueries({ queryKey: ["papers"] }),
    ]);
  };
  const createNote = useMutation({
    mutationFn: () =>
      api.addNote(paperId, {
        noteType,
        pageNumber: noteType === "page" ? currentPage : null,
        contentMarkdown: noteDraft.trim(),
      }),
    onSuccess: async () => {
      setNoteDraft("");
      await refreshNotes();
    },
  });
  const editNote = useMutation({
    mutationFn: (note: NoteRecord) =>
      api.updateNote(note.id, note.version, { contentMarkdown: editingNoteDraft.trim() }),
    onSuccess: async () => {
      setEditingNoteId(null);
      setEditingNoteDraft("");
      await refreshNotes();
    },
  });
  const deleteNote = useMutation({
    mutationFn: (note: NoteRecord) => api.removeNote(note.id, note.version),
    onSuccess: refreshNotes,
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
  const verifiedFiles = useMemo(
    () => orderedFiles.filter((file) => file.uploadState === "verified"),
    [orderedFiles],
  );
  useEffect(() => {
    if (paper.data && paperNote === null) setPaperNote(paper.data.noteMarkdown ?? "");
  }, [paper.data, paperNote]);
  useEffect(() => {
    if (paper.data) document.title = `${paper.data.title} — Citera`;
  }, [paper.data]);
  useEffect(() => {
    if (paper.data && summaryDraft === null) setSummaryDraft(paper.data.summary ?? "");
  }, [paper.data, summaryDraft]);
  useEffect(() => {
    if (paper.data?.files.some((file) => file.uploadState === "verified")) {
      setPdfFetchQueued(false);
      setPdfFetchJobId(null);
    }
  }, [paper.data?.files]);
  useEffect(() => {
    if (!metadataRefreshQueued) return;
    if (paper.data?.metadataState === "complete" || paper.data?.metadataState === "failed") {
      setMetadataRefreshQueued(false);
      void queryClient.invalidateQueries({ queryKey: ["papers"] });
      return;
    }
    const timeoutId = window.setTimeout(() => setMetadataRefreshQueued(false), 120_000);
    return () => window.clearTimeout(timeoutId);
  }, [metadataRefreshQueued, paper.data?.metadataState, queryClient]);
  useEffect(() => {
    const statusData = pdfFetchStatus.data;
    const status = statusData?.state;
    if (status === "complete") {
      setPdfFetchQueued(false);
      setPdfFetchJobId(null);
      void queryClient.invalidateQueries({ queryKey: ["paper", paperId] });
      void queryClient.invalidateQueries({ queryKey: ["papers"] });
    } else if (status === "failed") {
      setPdfFetchQueued(false);
      setPdfFetchJobId(null);
      setPdfFetchError(
        statusData?.errorMessage ??
          "PDFの取得に失敗しました。Jobs Workerのログを確認してください。",
      );
    } else if (pdfFetchStatus.isError && pdfFetchJobId) {
      setPdfFetchQueued(false);
      setPdfFetchJobId(null);
      setPdfFetchError("PDF取得ジョブの状態を確認できませんでした。");
    }
  }, [pdfFetchJobId, pdfFetchStatus.data, pdfFetchStatus.isError, paperId, queryClient]);
  useEffect(() => {
    if (!pdfFetchJobId) return;
    const timeoutId = window.setTimeout(() => {
      setPdfFetchQueued(false);
      setPdfFetchJobId(null);
      setPdfFetchError(
        "PDF取得の状態を確認できませんでした。Jobs Workerが起動しているか確認してください。",
      );
    }, 120_000);
    return () => window.clearTimeout(timeoutId);
  }, [pdfFetchJobId]);
  useEffect(() => {
    setPaperNote(null);
    setSummaryDraft(null);
    setCurrentPage(1);
    setMobileTab(initialTab);
    setComparePdfs(false);
    setPdfFetchQueued(false);
    setPdfFetchJobId(null);
    setPdfFetchError(null);
    setMetadataRefreshQueued(false);
    setNoteDraft("");
    setEditingNoteId(null);
    setEditingNoteDraft("");
  }, [initialTab, paperId]);
  useEffect(() => {
    document.body.classList.toggle("citera-focus-mode", focusMode);
    return () => document.body.classList.remove("citera-focus-mode");
  }, [focusMode]);
  useEffect(() => {
    if (!selectedFileId || !verifiedFiles.some((file) => file.id === selectedFileId)) {
      setSelectedFileId(verifiedFiles[0]?.id ?? null);
    }
  }, [selectedFileId, verifiedFiles]);

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
    files.find((file) => file.id === selectedFileId && file.uploadState === "verified") ??
    verifiedFiles[0];
  const doi = data.identifiers.find(
    (identifier) => (identifier.identifierType ?? identifier.type) === "doi",
  )?.normalizedValue;
  const arxivId = data.identifiers.find(
    (identifier) => (identifier.identifierType ?? identifier.type) === "arxiv",
  )?.normalizedValue;

  function submitMetadata(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const authors = formString(form, "authors")
      .split(/\r?\n|;/u)
      .map((value) => value.trim())
      .filter(Boolean)
      .map((displayName) => ({ displayName }));
    const doiInput = formString(form, "doi").trim();
    const arxivInput = formString(form, "arxiv").trim();
    const preservedIdentifiers = data.identifiers
      .filter((identifier) => {
        const type = identifier.identifierType ?? identifier.type;
        return type !== "doi" && type !== "arxiv";
      })
      .flatMap((identifier) => {
        const identifierType = identifier.identifierType ?? identifier.type;
        return identifierType
          ? [
              {
                identifierType,
                value: identifier.originalValue ?? identifier.normalizedValue,
              },
            ]
          : [];
      });
    const identifiers = [
      ...preservedIdentifiers,
      ...(doiInput ? [{ identifierType: "doi" as const, value: doiInput }] : []),
      ...(arxivInput ? [{ identifierType: "arxiv" as const, value: arxivInput }] : []),
    ];
    update.mutate(
      {
        title: formString(form, "title"),
        authors,
        identifiers,
        abstract: formString(form, "abstract") || null,
        venue: formString(form, "venue") || null,
        publicationYear: formString(form, "publicationYear")
          ? Number(formString(form, "publicationYear"))
          : null,
        publicationDate: formString(form, "publicationDate") || null,
        volume: formString(form, "volume") || null,
        issue: formString(form, "issue") || null,
        pages: formString(form, "pages") || null,
        publisher: formString(form, "publisher") || null,
        language: formString(form, "language") || null,
        paperType: formString(form, "paperType"),
        priority: Number(formString(form, "priority")),
        readProgress: Number(formString(form, "readProgress")),
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
                <ArrowLeft size={16} /> 詳細に戻る
              </button>
            )}
            <PdfUpload
              paperId={paperId}
              onComplete={() => {
                void queryClient.invalidateQueries({ queryKey: ["paper", paperId] });
                void queryClient.invalidateQueries({ queryKey: ["papers"] });
              }}
            />
            <ActionMenu
              label="論文のその他の操作"
              className="detail-action-menu"
              items={[
                {
                  label: "書誌情報を編集",
                  icon: <Pencil size={17} />,
                  onSelect: () => {
                    setMobileTab("details");
                    setEditing(true);
                  },
                },
                {
                  label: "BibTeXをコピー",
                  icon: <Copy size={17} />,
                  onSelect: () => copyBibtex.mutate(),
                  disabled: copyBibtex.isPending,
                },
                {
                  label: data.status === "archived" ? "一覧に戻す" : "アーカイブ",
                  icon: <Archive size={17} />,
                  onSelect: () =>
                    update.mutate({ status: data.status === "archived" ? "inbox" : "archived" }),
                  disabled: update.isPending,
                },
                ...(data.sourceUrl
                  ? [
                      {
                        label: "元ページを開く",
                        icon: <ExternalLink size={17} />,
                        onSelect: () =>
                          window.open(data.sourceUrl ?? "", "_blank", "noopener,noreferrer"),
                      },
                    ]
                  : []),
                {
                  label: "ゴミ箱へ移動",
                  icon: <Trash2 size={17} />,
                  onSelect: () => {
                    if (window.confirm("この論文をゴミ箱へ移動しますか？")) deletePaper.mutate();
                  },
                  disabled: deletePaper.isPending,
                  danger: true,
                },
              ]}
            />
            <button
              type="button"
              className="button secondary compact"
              onClick={() => copyBibtex.mutate()}
              disabled={copyBibtex.isPending}
            >
              <Copy size={15} /> BibTeX
            </button>
            {copyBibtex.isSuccess && (
              <span className="action-feedback" role="status">
                コピーしました
              </span>
            )}
          </div>
        </header>

        {mobileTab === "pdf" && orderedFiles.length > 0 && (
          <nav className="pdf-file-tabs" aria-label="PDFを切り替え">
            {orderedFiles.map((file) => (
              <button
                key={file.id}
                type="button"
                className={file.id === pdf?.id ? "active" : ""}
                disabled={file.uploadState !== "verified"}
                onClick={() => setSelectedFileId(file.id)}
              >
                {file.label ?? file.originalName}
                {file.isDefault ? " ★" : ""}
                {file.uploadState !== "verified" &&
                  (file.uploadState === "failed" ? "（読み込み失敗）" : "（準備中）")}
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
            {verifiedFiles.length > 1 && (
              <button
                type="button"
                className={comparePdfs ? "pdf-compare-toggle active" : "pdf-compare-toggle"}
                onClick={() => setComparePdfs((value) => !value)}
                aria-pressed={comparePdfs}
                title={comparePdfs ? "PDFを1つずつ表示" : "PDFを横並びで表示"}
              >
                <Columns2 size={14} /> {comparePdfs ? "1つずつ表示" : "横並びで表示"}
              </button>
            )}
          </nav>
        )}

        <div
          className="mobile-detail-tabs"
          role="tablist"
          aria-label="論文詳細の表示"
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const next = mobileTab === "pdf" ? "details" : "pdf";
            setMobileTab(next);
            document.getElementById(`detail-tab-${next}`)?.focus();
          }}
        >
          <button
            id="detail-tab-pdf"
            type="button"
            role="tab"
            aria-selected={mobileTab === "pdf"}
            aria-controls="detail-panel-pdf"
            tabIndex={mobileTab === "pdf" ? 0 : -1}
            className={mobileTab === "pdf" ? "active" : ""}
            onClick={() => setMobileTab("pdf")}
          >
            PDF
          </button>
          <button
            id="detail-tab-details"
            type="button"
            role="tab"
            aria-selected={mobileTab === "details"}
            aria-controls="detail-panel-details"
            tabIndex={mobileTab === "details" ? 0 : -1}
            className={mobileTab === "details" ? "active" : ""}
            onClick={() => setMobileTab("details")}
          >
            情報とコメント
          </button>
        </div>

        <div className={`detail-split ${inspectorOpen ? "inspector-open" : "inspector-closed"}`}>
          <div
            id="detail-panel-pdf"
            role="tabpanel"
            aria-labelledby="detail-tab-pdf"
            className={mobileTab === "pdf" ? "pdf-pane mobile-active" : "pdf-pane"}
          >
            {comparePdfs && verifiedFiles.length > 1 ? (
              <div
                ref={compareViewersRef}
                className="pdf-compare-viewers"
                aria-label="PDF横並び表示"
              >
                {verifiedFiles.map((file) => (
                  <article className="pdf-compare-viewer" key={file.id}>
                    <header className="pdf-compare-viewer-header">
                      <strong>{file.label ?? file.originalName}</strong>
                      {file.isDefault && <span>既定</span>}
                    </header>
                    <PdfViewer
                      fileId={file.id}
                      title={`${data.title} - ${file.label ?? file.originalName}`}
                      page={currentPage}
                      onPageChange={setCurrentPage}
                      inspectorOpen={inspectorOpen}
                      onToggleInspector={() => setInspectorOpen((value) => !value)}
                      focusMode={focusMode}
                      onToggleFocus={() => setFocusMode((value) => !value)}
                      fullscreenTargetRef={compareViewersRef}
                    />
                  </article>
                ))}
              </div>
            ) : (
              <PdfViewer
                fileId={pdf?.id ?? null}
                title={data.title}
                page={currentPage}
                onPageChange={setCurrentPage}
                inspectorOpen={inspectorOpen}
                onToggleInspector={() => setInspectorOpen((value) => !value)}
                focusMode={focusMode}
                onToggleFocus={() => setFocusMode((value) => !value)}
              />
            )}
          </div>
          <aside
            id="detail-panel-details"
            role="tabpanel"
            aria-labelledby="detail-tab-details"
            className={mobileTab === "details" ? "metadata-pane mobile-active" : "metadata-pane"}
          >
            <div className="inspector-tabs" aria-label="詳細パネル">
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
                      {duplicates.data?.length ? (
                        <ul className="duplicate-candidates">
                          {duplicates.data.slice(0, 3).map((candidate) => (
                            <li key={candidate.paper.id}>
                              <Link
                                to="/papers/$paperId"
                                params={{ paperId: candidate.paper.id }}
                                onClick={drawer ? onClose : undefined}
                              >
                                <span>{candidate.paper.title}</span>
                                <small>
                                  {candidate.reasons.includes("title_year")
                                    ? "タイトルと出版年が一致"
                                    : "識別子またはPDFが一致"}
                                </small>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      ) : null}
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
                        <option value="inbox">未着手</option>
                        <option value="reading">読書中</option>
                        <option value="read">読了</option>
                        <option value="archived">アーカイブ</option>
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
                      <a href={`https://arxiv.org/abs/${arxivId}`} target="_blank" rel="noreferrer">
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
                    {data.hasPdf ? (
                      <button
                        type="button"
                        className="button primary"
                        onClick={() => setMobileTab("pdf")}
                      >
                        <BookOpen size={17} /> PDFを見る
                      </button>
                    ) : arxivId || doi ? (
                      <button
                        type="button"
                        className="button primary"
                        onClick={() => fetchPdf.mutate()}
                        disabled={fetchPdf.isPending || pdfFetchQueued}
                      >
                        <FileText size={17} />
                        {fetchPdf.isPending
                          ? "取得を開始中…"
                          : pdfFetchQueued
                            ? "PDF取得中…"
                            : "PDFを自動取得"}
                      </button>
                    ) : null}
                    <a className="button secondary" href="#paper-abstract">
                      <Sparkles size={17} /> Abstractを読む
                    </a>
                    <a className="button secondary" href="#paper-comment">
                      <Pencil size={17} /> コメントを書く
                    </a>
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
                  {(fetchPdf.error || pdfFetchError) && (
                    <p className="form-error" role="alert">
                      {pdfFetchError ??
                        "PDFを自動取得できませんでした。識別子を確認するか、手動で追加してください。"}
                    </p>
                  )}
                </section>

                <section className="summary-section">
                  <header>
                    <div>
                      <p className="eyebrow">LIBRARY SUMMARY</p>
                      <h2>一言要約</h2>
                    </div>
                    <span className="muted-copy">論文一覧に表示</span>
                  </header>
                  <input
                    value={summaryDraft ?? ""}
                    onChange={(event) => setSummaryDraft(event.target.value)}
                    maxLength={240}
                    placeholder="この論文を一言で表すと…"
                    aria-label="一言要約"
                  />
                  <div className="summary-actions">
                    <span className="muted-copy">240文字まで</span>
                    <button
                      type="button"
                      className="button primary compact"
                      onClick={() => update.mutate({ summary: summaryDraft?.trim() || null })}
                      disabled={
                        update.isPending ||
                        summaryDraft === null ||
                        summaryDraft === (data.summary ?? "")
                      }
                    >
                      <Save size={15} /> 保存
                    </button>
                  </div>
                </section>

                <section className="notes-workspace" id="paper-notes">
                  <header>
                    <div>
                      <p className="eyebrow">NOTES</p>
                      <h2>メモとToDo</h2>
                    </div>
                    <span className="note-count">{data.notes.length}件</span>
                  </header>
                  <form
                    className="note-composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (noteDraft.trim()) createNote.mutate();
                    }}
                  >
                    <textarea
                      value={noteDraft}
                      rows={3}
                      maxLength={1_000_000}
                      placeholder={
                        noteType === "page"
                          ? `${currentPage}ページ目の気づきを記録…`
                          : noteType === "todo"
                            ? "あとで確認すること…"
                            : "この論文についてメモを追加…"
                      }
                      aria-label="新しいメモ"
                      onChange={(event) => setNoteDraft(event.target.value)}
                    />
                    <footer>
                      <div className="note-type-options" role="group" aria-label="メモの種類">
                        <button
                          type="button"
                          className={noteType === "general" ? "active" : ""}
                          aria-pressed={noteType === "general"}
                          onClick={() => setNoteType("general")}
                        >
                          <MessageSquarePlus size={14} /> 一般メモ
                        </button>
                        <button
                          type="button"
                          className={noteType === "page" ? "active" : ""}
                          aria-pressed={noteType === "page"}
                          onClick={() => setNoteType("page")}
                        >
                          <MapPin size={14} /> {currentPage}ページ
                        </button>
                        <button
                          type="button"
                          className={noteType === "todo" ? "active" : ""}
                          aria-pressed={noteType === "todo"}
                          onClick={() => setNoteType("todo")}
                        >
                          <ListTodo size={14} /> ToDo
                        </button>
                      </div>
                      <button
                        className="button primary compact"
                        disabled={!noteDraft.trim() || createNote.isPending}
                      >
                        {createNote.isPending ? "追加中…" : "メモを追加"}
                      </button>
                    </footer>
                  </form>
                  {createNote.error && (
                    <p className="form-error" role="alert">
                      メモを追加できませんでした。
                    </p>
                  )}
                  <div className="note-workspace-list" aria-live="polite">
                    {data.notes.length ? (
                      data.notes.map((note) => (
                        <article className={`workspace-note note-${note.noteType}`} key={note.id}>
                          <header>
                            <span>
                              {note.noteType === "page" ? (
                                <>
                                  <MapPin size={13} /> {note.pageNumber}ページ
                                </>
                              ) : note.noteType === "todo" ? (
                                <>
                                  <ListTodo size={13} /> ToDo
                                </>
                              ) : (
                                <>
                                  <MessageSquarePlus size={13} /> メモ
                                </>
                              )}
                            </span>
                            <time dateTime={note.updatedAt}>{formatDate(note.updatedAt)}</time>
                          </header>
                          {editingNoteId === note.id ? (
                            <form
                              className="note-edit-form"
                              onSubmit={(event) => {
                                event.preventDefault();
                                if (editingNoteDraft.trim()) editNote.mutate(note);
                              }}
                            >
                              <textarea
                                value={editingNoteDraft}
                                rows={3}
                                aria-label="メモを編集"
                                onChange={(event) => setEditingNoteDraft(event.target.value)}
                              />
                              <div>
                                <button
                                  type="button"
                                  className="text-button"
                                  onClick={() => setEditingNoteId(null)}
                                >
                                  キャンセル
                                </button>
                                <button
                                  className="button primary compact"
                                  disabled={!editingNoteDraft.trim() || editNote.isPending}
                                >
                                  保存
                                </button>
                              </div>
                            </form>
                          ) : (
                            <>
                              <p>{note.contentMarkdown}</p>
                              <footer>
                                {note.noteType === "page" && note.pageNumber && (
                                  <button
                                    type="button"
                                    className="text-button"
                                    onClick={() => {
                                      setCurrentPage(note.pageNumber ?? 1);
                                      setMobileTab("pdf");
                                    }}
                                  >
                                    PDFで開く
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="text-button"
                                  onClick={() => {
                                    setEditingNoteId(note.id);
                                    setEditingNoteDraft(note.contentMarkdown);
                                  }}
                                >
                                  編集
                                </button>
                                <button
                                  type="button"
                                  className="text-button danger"
                                  disabled={deleteNote.isPending}
                                  onClick={() => {
                                    if (window.confirm("このメモを削除しますか？"))
                                      deleteNote.mutate(note);
                                  }}
                                >
                                  削除
                                </button>
                              </footer>
                            </>
                          )}
                        </article>
                      ))
                    ) : (
                      <div className="notes-empty">
                        <MessageSquarePlus size={20} />
                        <p>気づきや次に確認することを、ここに残せます。</p>
                      </div>
                    )}
                  </div>
                  {(editNote.error || deleteNote.error) && (
                    <p className="form-error" role="alert">
                      メモを更新できませんでした。再読み込みしてお試しください。
                    </p>
                  )}
                </section>

                <section className="metadata-section" id="paper-abstract">
                  <header>
                    <h2>Abstract</h2>
                    <div>
                      <button
                        type="button"
                        className="text-icon-button"
                        onClick={() => refresh.mutate()}
                        disabled={refresh.isPending || metadataRefreshQueued}
                      >
                        <RefreshCw
                          size={15}
                          className={refresh.isPending || metadataRefreshQueued ? "spin" : ""}
                        />
                        {metadataRefreshQueued ? "更新中…" : "再取得"}
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
                      <label>
                        著者（1行に1名）
                        <textarea
                          name="authors"
                          rows={3}
                          defaultValue={data.authors.map((author) => author.displayName).join("\n")}
                        />
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
                          出版日
                          <input
                            name="publicationDate"
                            type="date"
                            defaultValue={data.publicationDate ?? ""}
                          />
                        </label>
                        <label>
                          掲載誌・会議
                          <input name="venue" defaultValue={data.venue ?? ""} />
                        </label>
                        <label>
                          出版社
                          <input name="publisher" defaultValue={data.publisher ?? ""} />
                        </label>
                        <label>
                          巻
                          <input name="volume" defaultValue={data.volume ?? ""} />
                        </label>
                        <label>
                          号
                          <input name="issue" defaultValue={data.issue ?? ""} />
                        </label>
                        <label>
                          ページ
                          <input name="pages" defaultValue={data.pages ?? ""} />
                        </label>
                        <label>
                          言語
                          <input name="language" defaultValue={data.language ?? ""} />
                        </label>
                        <label>
                          資料種別
                          <select name="paperType" defaultValue={data.paperType}>
                            <option value="article-journal">学術論文</option>
                            <option value="paper-conference">会議論文</option>
                            <option value="chapter">章</option>
                            <option value="book">書籍</option>
                            <option value="thesis">学位論文</option>
                            <option value="preprint">プレプリント</option>
                            <option value="report">レポート</option>
                            <option value="dataset">データセット</option>
                            <option value="software">ソフトウェア</option>
                            <option value="other">その他</option>
                          </select>
                        </label>
                        <label>
                          優先度（0〜5）
                          <input
                            name="priority"
                            type="number"
                            min={0}
                            max={5}
                            defaultValue={data.priority}
                          />
                        </label>
                        <label>
                          読書進捗（%）
                          <input
                            name="readProgress"
                            type="number"
                            min={0}
                            max={100}
                            defaultValue={data.readProgress}
                          />
                        </label>
                      </div>
                      <div className="form-grid">
                        <label>
                          DOI
                          <input name="doi" defaultValue={doi ?? ""} />
                        </label>
                        <label>
                          arXiv ID
                          <input name="arxiv" defaultValue={arxivId ?? ""} />
                        </label>
                      </div>
                      <label>
                        元ページ
                        <input name="sourceUrl" type="url" defaultValue={data.sourceUrl ?? ""} />
                      </label>
                      <label>
                        Abstract
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
                          Abstractはまだありません。書誌情報を再取得するか、編集して追加できます。
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

                <section className="comment-section" id="paper-comment">
                  <header>
                    <div>
                      <p className="eyebrow">COMMENT</p>
                      <h2>論文へのコメント</h2>
                    </div>
                    <span className="muted-copy">論文全体に対して</span>
                  </header>
                  <textarea
                    value={paperNote ?? ""}
                    onChange={(event) => setPaperNote(event.target.value)}
                    rows={12}
                    placeholder="この論文について気づいたこと、研究との関係など…"
                    aria-label="論文へのコメント"
                  />
                  <div className="comment-actions">
                    <span className="muted-copy">必要ならMarkdownも使えます。</span>
                    <button
                      type="button"
                      className="button primary compact"
                      onClick={() => update.mutate({ noteMarkdown: paperNote?.trim() || null })}
                      disabled={
                        update.isPending ||
                        paperNote === null ||
                        paperNote === (data.noteMarkdown ?? "")
                      }
                    >
                      <Save size={15} /> 保存
                    </button>
                  </div>
                  {update.error && (
                    <p className="form-error" role="alert">
                      コメントを保存できませんでした。再読み込みしてお試しください。
                    </p>
                  )}
                </section>

                <section className="danger-zone">
                  <button
                    type="button"
                    disabled={deletePaper.isPending}
                    onClick={() => {
                      if (window.confirm("この論文をゴミ箱へ移動しますか？")) deletePaper.mutate();
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
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
