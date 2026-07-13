import type { PaperStatus } from "@citera/domain";
import { useEffect, useState } from "react";

import type { AuthStatus, ExtensionSettings } from "../types";
import { hasOriginPermission, requestOriginPermissions, sendRuntimeMessage } from "../lib/browser";
import {
  DEFAULT_SETTINGS,
  normalizeApiBaseUrl,
  readSettings,
  writeSettings,
} from "../lib/settings";

type Notice = { kind: "success" | "error"; message: string } | null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "不明なエラーが発生しました。";
}

export function Options() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [auth, setAuth] = useState<AuthStatus>({ authenticated: false });
  const [originAllowed, setOriginAllowed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await readSettings();
        setSettings(loaded);
        const [status, allowed] = await Promise.all([
          sendRuntimeMessage<AuthStatus>({ type: "AUTH_STATUS" }),
          hasOriginPermission(loaded.apiBaseUrl),
        ]);
        setAuth(status);
        setOriginAllowed(allowed);
      } catch (error) {
        setNotice({ kind: "error", message: errorMessage(error) });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function update<Key extends keyof ExtensionSettings>(
    key: Key,
    value: ExtensionSettings[Key],
  ): void {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  async function persist(showNotice = true): Promise<ExtensionSettings> {
    const normalized = { ...settings, apiBaseUrl: normalizeApiBaseUrl(settings.apiBaseUrl) };
    const allowed = await requestOriginPermissions([normalized.apiBaseUrl]);
    if (!allowed) throw new Error("Citera APIへのアクセス権限が許可されませんでした。");
    await writeSettings(normalized);
    setSettings(normalized);
    setOriginAllowed(true);
    if (showNotice) setNotice({ kind: "success", message: "設定を保存しました。" });
    return normalized;
  }

  async function saveSettings(): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      await persist();
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function connect(): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      await persist(false);
      const status = await sendRuntimeMessage<AuthStatus>({ type: "LOGIN" });
      setAuth(status);
      setNotice({ kind: "success", message: "Citeraへ接続しました。" });
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      await sendRuntimeMessage({ type: "LOGOUT" });
      setAuth({ authenticated: false });
      setNotice({ kind: "success", message: "この端末の接続を解除しました。" });
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="options-shell">
      <header className="options-header">
        <div className="brand-lockup large">
          <span className="brand-mark" aria-hidden="true">
            C
          </span>
          <div>
            <strong>Citera</strong>
            <span>Browser extension settings</span>
          </div>
        </div>
        <span className={`connection-pill ${auth.authenticated ? "connected" : ""}`}>
          {auth.authenticated ? "接続済み" : "未接続"}
        </span>
      </header>

      <div className="options-grid" aria-busy={loading || busy}>
        <section className="settings-card">
          <div className="section-heading">
            <span>01</span>
            <div>
              <h1>接続</h1>
              <p>Citera APIとOAuthセッション</p>
            </div>
          </div>
          <label className="field wide">
            <span>Citera API URL</span>
            <input
              type="url"
              value={settings.apiBaseUrl}
              disabled={loading || busy}
              spellCheck={false}
              placeholder="https://citera.example.com"
              onChange={(event) => {
                update("apiBaseUrl", event.target.value);
                setOriginAllowed(false);
              }}
            />
          </label>
          <p className="field-help">
            本番環境はHTTPS必須です。HTTPはlocalhostと127.0.0.1だけ利用できます。
          </p>
          <div className="permission-row">
            <span className={`permission-dot ${originAllowed ? "granted" : ""}`} />
            <span>
              {originAllowed
                ? "このAPIオリジンへのアクセスを許可済み"
                : "保存時にこのAPIオリジンだけを許可します"}
            </span>
          </div>
          <div className="button-row">
            {auth.authenticated ? (
              <button
                className="button danger"
                type="button"
                disabled={busy}
                onClick={() => void disconnect()}
              >
                接続を解除
              </button>
            ) : (
              <button
                className="button primary"
                type="button"
                disabled={busy}
                onClick={() => void connect()}
              >
                PKCEで接続
              </button>
            )}
          </div>
        </section>

        <section className="settings-card">
          <div className="section-heading">
            <span>02</span>
            <div>
              <h2>端末側の初期値</h2>
              <p>接続中は Citera アカウントの保存既定値を優先します</p>
            </div>
          </div>
          <label className="field wide">
            <span>論文の状態（未接続時のフォールバック）</span>
            <select
              value={settings.defaultStatus}
              disabled={loading || busy}
              onChange={(event) => update("defaultStatus", event.target.value as PaperStatus)}
            >
              <option value="inbox">受信箱</option>
              <option value="reading">読書中</option>
              <option value="read">読了</option>
              <option value="archived">アーカイブ</option>
            </select>
          </label>
          <label className="switch-row">
            <span>
              <strong>PDFを含める</strong>
              <small>検出したPDFを初期状態で選択します</small>
            </span>
            <input
              type="checkbox"
              checked={settings.includePdfByDefault}
              disabled={loading || busy}
              onChange={(event) => update("includePdfByDefault", event.target.checked)}
            />
          </label>
          <label className="switch-row">
            <span>
              <strong>デスクトップ通知</strong>
              <small>保存完了、重複、失敗を通知します</small>
            </span>
            <input
              type="checkbox"
              checked={settings.notificationsEnabled}
              disabled={loading || busy}
              onChange={(event) => update("notificationsEnabled", event.target.checked)}
            />
          </label>
        </section>

        <aside className="security-note">
          <strong>必要な場所だけにアクセス</strong>
          <p>
            Citeraは常時すべてのページを読みません。ポップアップを開いたタブ、設定したAPI、選択したPDFオリジンに対して、その操作に必要なときだけ権限を使います。
          </p>
          <p>
            短寿命アクセストークンはブラウザセッション領域、ローテーション更新トークンは端末ローカル領域へ保存され、同期されません。
          </p>
        </aside>
      </div>

      {notice != null && (
        <div
          className={`options-notice ${notice.kind}`}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.message}
        </div>
      )}

      <footer className="options-footer">
        <span>Citera Extension · Manifest V3</span>
        <button
          className="button primary"
          type="button"
          disabled={loading || busy}
          onClick={() => void saveSettings()}
        >
          {busy ? "処理中…" : "設定を保存"}
        </button>
      </footer>
    </main>
  );
}
