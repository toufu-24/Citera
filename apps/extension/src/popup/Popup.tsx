import type { PaperStatus } from "@citera/domain";
import { useEffect, useMemo, useState } from "react";

import type {
  AuthStatus,
  LibraryChoices,
  PageMetadata,
  SavePaperResult,
  SaveStage,
} from "../types";
import { onProgressMessage, requestOriginPermissions, sendRuntimeMessage } from "../lib/browser";
import { requiresCrossOriginPdfConsent } from "../lib/remote-url";
import { readSettings } from "../lib/settings";

type ScreenState = "loading" | "ready" | "saving" | "saved" | "duplicate" | "error";

const STATUS_LABELS: Record<PaperStatus, string> = {
  inbox: "受信箱",
  reading: "読書中",
  read: "読了",
  archived: "アーカイブ",
};

const SOURCE_LABELS: Record<PageMetadata["detectedSources"][number], string> = {
  citation: "Citation",
  "dublin-core": "Dublin Core",
  "json-ld": "JSON-LD",
  doi: "DOI",
  arxiv: "arXiv",
  pdf: "PDF",
};

const STAGE_LABELS: Record<SaveStage, string> = {
  creating: "書誌情報",
  "downloading-pdf": "PDF取得",
  "hashing-pdf": "PDF検証",
  "uploading-pdf": "PDF保存",
  finalizing: "完了処理",
};

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "不明なエラーが発生しました。";
}

export function Popup() {
  const [screen, setScreen] = useState<ScreenState>("loading");
  const [metadata, setMetadata] = useState<PageMetadata | null>(null);
  const [auth, setAuth] = useState<AuthStatus>({ authenticated: false });
  const [choices, setChoices] = useState<LibraryChoices>({
    tags: [],
    collections: [],
    preferences: {
      defaultStatus: "inbox",
      defaultTagIds: [],
      defaultCollectionId: null,
    },
  });
  const [status, setStatus] = useState<PaperStatus>("inbox");
  const [includePdf, setIncludePdf] = useState(false);
  const [allowCrossOriginPdf, setAllowCrossOriginPdf] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedCollections, setSelectedCollections] = useState<string[]>([]);
  const [progressStage, setProgressStage] = useState<SaveStage | null>(null);
  const [progressDetail, setProgressDetail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SavePaperResult | null>(null);

  useEffect(() => {
    const stop = onProgressMessage((message) => {
      setProgressStage(message.stage);
      setProgressDetail(message.detail);
    });
    void (async () => {
      try {
        const settings = await readSettings();
        setStatus(settings.defaultStatus);
        const [page, authStatus] = await Promise.all([
          sendRuntimeMessage<PageMetadata>({ type: "EXTRACT_ACTIVE_PAGE" }),
          sendRuntimeMessage<AuthStatus>({ type: "AUTH_STATUS" }),
        ]);
        setMetadata(page);
        const needsConsent =
          page.pdfUrl == null ? false : requiresCrossOriginPdfConsent(page.pageUrl, page.pdfUrl);
        setIncludePdf(settings.includePdfByDefault && page.pdfUrl != null && !needsConsent);
        setAuth(authStatus);
        if (authStatus.authenticated) {
          const library = await sendRuntimeMessage<LibraryChoices>({
            type: "GET_LIBRARY_CHOICES",
          });
          setChoices(library);
          setStatus(library.preferences.defaultStatus);
          const availableTagIds = new Set(library.tags.map((tag) => tag.id));
          setSelectedTags(
            library.preferences.defaultTagIds.filter((tagId) => availableTagIds.has(tagId)),
          );
          setSelectedCollections(
            library.preferences.defaultCollectionId &&
              library.collections.some(
                (collection) => collection.id === library.preferences.defaultCollectionId,
              )
              ? [library.preferences.defaultCollectionId]
              : [],
          );
        }
        setScreen("ready");
      } catch (cause) {
        setError(messageFrom(cause));
        setScreen("error");
      }
    })();
    return stop;
  }, []);

  const authorLine = useMemo(() => {
    if (metadata == null || metadata.authors.length === 0) return "著者情報なし";
    const visible = metadata.authors
      .slice(0, 3)
      .map((author) => author.displayName)
      .join("、");
    return metadata.authors.length > 3
      ? `${visible} ほか${metadata.authors.length - 3}名`
      : visible;
  }, [metadata]);

  const pdfNeedsCrossOriginConsent = useMemo(() => {
    if (metadata?.pdfUrl == null) return false;
    return requiresCrossOriginPdfConsent(metadata.pageUrl, metadata.pdfUrl);
  }, [metadata]);

  async function connect(): Promise<void> {
    setError(null);
    try {
      const settings = await readSettings();
      const allowed = await requestOriginPermissions([settings.apiBaseUrl]);
      if (!allowed) throw new Error("Citera APIへの接続権限が許可されませんでした。");
      const authStatus = await sendRuntimeMessage<AuthStatus>({ type: "LOGIN" });
      setAuth(authStatus);
      const library = await sendRuntimeMessage<LibraryChoices>({ type: "GET_LIBRARY_CHOICES" });
      setChoices(library);
      setStatus(library.preferences.defaultStatus);
      const availableTagIds = new Set(library.tags.map((tag) => tag.id));
      setSelectedTags(
        library.preferences.defaultTagIds.filter((tagId) => availableTagIds.has(tagId)),
      );
      setSelectedCollections(
        library.preferences.defaultCollectionId &&
          library.collections.some(
            (collection) => collection.id === library.preferences.defaultCollectionId,
          )
          ? [library.preferences.defaultCollectionId]
          : [],
      );
    } catch (cause) {
      setError(messageFrom(cause));
    }
  }

  async function save(): Promise<void> {
    if (metadata == null || !auth.authenticated) return;
    if (includePdf && pdfNeedsCrossOriginConsent && !allowCrossOriginPdf) {
      setError("別サイトのPDFを取得するには、下の確認項目を選択してください。");
      return;
    }
    setScreen("saving");
    setError(null);
    setResult(null);
    setProgressStage("creating");
    setProgressDetail("保存を準備しています…");
    try {
      const settings = await readSettings();
      const origins = [settings.apiBaseUrl];
      if (includePdf && metadata.pdfUrl != null) origins.push(metadata.pdfUrl);
      const allowed = await requestOriginPermissions(origins);
      if (!allowed) throw new Error("保存に必要なサイト権限が許可されませんでした。");
      const saved = await sendRuntimeMessage<SavePaperResult>({
        type: "SAVE_PAPER",
        input: {
          metadata,
          status,
          tagIds: selectedTags,
          collectionIds: selectedCollections,
          includePdf,
          allowCrossOriginPdf: includePdf && pdfNeedsCrossOriginConsent && allowCrossOriginPdf,
        },
      });
      setResult(saved);
      setScreen(saved.outcome === "duplicate" ? "duplicate" : "saved");
    } catch (cause) {
      setError(messageFrom(cause));
      setScreen("error");
    }
  }

  function toggle(list: string[], value: string, setter: (next: string[]) => void): void {
    setter(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  }

  if (screen === "loading") {
    return (
      <main className="popup-shell centered-state" aria-busy="true">
        <span className="brand-mark" aria-hidden="true">
          C
        </span>
        <div className="spinner" />
        <p>論文情報を読み取っています…</p>
      </main>
    );
  }

  return (
    <main className="popup-shell">
      <header className="brand-row">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            C
          </span>
          <div>
            <strong>Citera</strong>
            <span>Collect what matters.</span>
          </div>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="設定を開く"
          title="設定"
          onClick={() => void sendRuntimeMessage({ type: "OPEN_OPTIONS" })}
        >
          ⚙
        </button>
      </header>

      {metadata != null && (
        <section className="paper-preview" aria-labelledby="paper-title">
          <div className="source-row">
            {metadata.detectedSources.length === 0 ? (
              <span className="badge muted">ページ情報</span>
            ) : (
              metadata.detectedSources.map((source) => (
                <span className="badge" key={source}>
                  {SOURCE_LABELS[source]}
                </span>
              ))
            )}
          </div>
          <h1 id="paper-title">{metadata.title}</h1>
          <p className="authors">{authorLine}</p>
          <div className="paper-facts">
            {metadata.publicationYear != null && <span>{metadata.publicationYear}</span>}
            {metadata.venue != null && <span>{metadata.venue}</span>}
            {metadata.doi != null && <span className="mono">{metadata.doi}</span>}
            {metadata.arxivId != null && <span className="mono">arXiv:{metadata.arxivId}</span>}
          </div>
        </section>
      )}

      {!auth.authenticated && (
        <section className="connection-card">
          <div>
            <strong>Citeraへ接続</strong>
            <p>安全なPKCE認証でライブラリへ保存します。</p>
          </div>
          <button className="button secondary" type="button" onClick={() => void connect()}>
            接続する
          </button>
        </section>
      )}

      {auth.authenticated && metadata != null && screen !== "saved" && screen !== "duplicate" && (
        <section className="save-form" aria-label="保存設定">
          <label className="field">
            <span>状態</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as PaperStatus)}
              disabled={screen === "saving"}
            >
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="choice-group" disabled={screen === "saving"}>
            <legend>タグ</legend>
            {choices.tags.length === 0 ? (
              <p className="empty-choice">タグはまだありません</p>
            ) : (
              <div className="chip-grid">
                {choices.tags.map((tag) => (
                  <label
                    className={`choice-chip ${selectedTags.includes(tag.id) ? "selected" : ""}`}
                    key={tag.id}
                  >
                    <input
                      type="checkbox"
                      checked={selectedTags.includes(tag.id)}
                      onChange={() => toggle(selectedTags, tag.id, setSelectedTags)}
                    />
                    {tag.color != null && (
                      <span className="tag-dot" style={{ backgroundColor: tag.color }} />
                    )}
                    {tag.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <fieldset className="choice-group" disabled={screen === "saving"}>
            <legend>コレクション</legend>
            {choices.collections.length === 0 ? (
              <p className="empty-choice">コレクションはまだありません</p>
            ) : (
              <div className="chip-grid">
                {choices.collections.map((collection) => (
                  <label
                    className={`choice-chip ${selectedCollections.includes(collection.id) ? "selected" : ""}`}
                    key={collection.id}
                  >
                    <input
                      type="checkbox"
                      checked={selectedCollections.includes(collection.id)}
                      onChange={() =>
                        toggle(selectedCollections, collection.id, setSelectedCollections)
                      }
                    />
                    {collection.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <label className={`pdf-toggle ${metadata.pdfUrl == null ? "disabled" : ""}`}>
            <input
              type="checkbox"
              checked={includePdf}
              disabled={metadata.pdfUrl == null || screen === "saving"}
              onChange={(event) => {
                setIncludePdf(event.target.checked);
                if (!event.target.checked) setAllowCrossOriginPdf(false);
              }}
            />
            <span>
              <strong>PDFも保存</strong>
              <small>
                {metadata.pdfUrl == null
                  ? "PDFリンクが見つかりません"
                  : pdfNeedsCrossOriginConsent
                    ? "別サイトのため追加の確認が必要です"
                    : "同じオリジンの認証状態だけを利用します"}
              </small>
            </span>
          </label>

          {includePdf && pdfNeedsCrossOriginConsent && (
            <label className="pdf-cross-origin-consent">
              <input
                type="checkbox"
                checked={allowCrossOriginPdf}
                disabled={screen === "saving"}
                onChange={(event) => setAllowCrossOriginPdf(event.target.checked)}
              />
              <span>
                <strong>表示した取得先からPDFを保存する</strong>
                <small className="pdf-consent-target" title={metadata.pdfUrl}>
                  取得先: {metadata.pdfUrl}
                </small>
                <small>取得先に閲覧中ページのCookieや認証情報は送信しません</small>
              </span>
            </label>
          )}

          {screen === "saving" ? (
            <div className="progress-card" role="status">
              <div className="progress-heading">
                <span>{progressStage == null ? "保存中" : STAGE_LABELS[progressStage]}</span>
                <span className="pulse-dot" />
              </div>
              <div className="progress-track">
                <span />
              </div>
              <p>{progressDetail}</p>
            </div>
          ) : (
            <button
              className="button primary save-button"
              type="button"
              onClick={() => void save()}
            >
              Citeraに保存
            </button>
          )}
        </section>
      )}

      {screen === "saved" && result?.outcome === "saved" && (
        <section
          className={`result-card ${result.warning == null ? "success" : "warning"}`}
          role="status"
        >
          <span className="result-icon">{result.warning == null ? "✓" : "!"}</span>
          <div>
            <strong>
              {result.warning == null ? "ライブラリへ保存しました" : "書誌情報を保存しました"}
            </strong>
            <p>
              {result.warning ??
                (result.pdfIncluded
                  ? "PDFも安全にアップロードされました。"
                  : "Citeraで同期されます。")}
            </p>
          </div>
        </section>
      )}

      {screen === "duplicate" && result?.outcome === "duplicate" && (
        <section className="result-card duplicate" role="status">
          <span className="result-icon">↺</span>
          <div>
            <strong>すでに登録済みです</strong>
            <p>{result.title ?? result.reason}</p>
          </div>
        </section>
      )}

      {error != null && (
        <section className="error-banner" role="alert">
          <strong>処理を完了できませんでした</strong>
          <p>{error}</p>
          {screen === "error" && metadata != null && auth.authenticated && (
            <button className="text-button" type="button" onClick={() => setScreen("ready")}>
              戻る
            </button>
          )}
        </section>
      )}

      <footer>
        <span>Citera Extension</span>
        <span>v0.1</span>
      </footer>
    </main>
  );
}
