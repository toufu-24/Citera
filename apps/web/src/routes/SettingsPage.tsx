import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveRestore,
  Check,
  Cloud,
  Database,
  Download,
  HardDrive,
  KeyRound,
  Laptop,
  LogOut,
  Save,
  Shield,
  Smartphone,
  Trash2,
  UserRound,
} from "lucide-react";

import { api, type UserPreferences } from "../lib/api";
import { clearActiveDatabase } from "../lib/database";

const initialPreferences: UserPreferences = {
  defaultCollectionId: null,
  defaultTagIds: [],
  defaultStatus: "inbox",
  defaultExportFormat: "bibtex",
  updatedAt: null,
};

function bytes(value: number) {
  return new Intl.NumberFormat("ja-JP", {
    style: "unit",
    unit: value >= 1_000_000_000 ? "gigabyte" : "megabyte",
    maximumFractionDigits: 1,
  }).format(value >= 1_000_000_000 ? value / 1_000_000_000 : value / 1_000_000);
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: ["session"], queryFn: api.session });
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices });
  const usage = useQuery({ queryKey: ["usage"], queryFn: api.usage });
  const tags = useQuery({ queryKey: ["tags"], queryFn: api.tags });
  const collections = useQuery({ queryKey: ["collections"], queryFn: api.collections });
  const preferencesQuery = useQuery({ queryKey: ["preferences"], queryFn: api.preferences });
  const [preferences, setPreferences] = useState<UserPreferences>(initialPreferences);
  const [accountConfirmation, setAccountConfirmation] = useState("");

  useEffect(() => {
    if (preferencesQuery.data) setPreferences(preferencesQuery.data);
  }, [preferencesQuery.data]);

  const savePreferences = useMutation({
    mutationFn: () =>
      api.updatePreferences({
        defaultCollectionId: preferences.defaultCollectionId,
        defaultTagIds: preferences.defaultTagIds,
        defaultStatus: preferences.defaultStatus,
        defaultExportFormat: preferences.defaultExportFormat,
      }),
    onSuccess: (saved) => {
      setPreferences(saved);
      queryClient.setQueryData(["preferences"], saved);
    },
  });
  const revoke = useMutation({
    mutationFn: api.revokeDevice,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["devices"] }),
  });
  const backup = useMutation({
    mutationFn: () => api.exportPapers({ format: "backup", all: true }),
    onSuccess: (job) => {
      if (job.downloadUrl) window.location.assign(job.downloadUrl);
    },
  });
  const deleteAccount = useMutation({
    mutationFn: () => api.deleteAccount(accountConfirmation.trim()),
    onSuccess: async () => {
      queryClient.clear();
      await clearActiveDatabase();
      window.location.replace("/login");
    },
  });

  const accountEmail = session.data?.user.email ?? "";
  const deletionConfirmed =
    accountEmail.length > 0 &&
    accountConfirmation.trim().toLowerCase() === accountEmail.toLowerCase();

  return (
    <div className="page settings-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">PREFERENCES</p>
          <h1>設定</h1>
          <p>アカウント、同期、エクスポートとデータを管理します。</p>
        </div>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="設定メニュー">
          <a href="#account" className="active">
            <UserRound size={17} /> アカウント
          </a>
          <a href="#devices">
            <Laptop size={17} /> 端末とセッション
          </a>
          <a href="#defaults">
            <ArchiveRestore size={17} /> 保存の既定値
          </a>
          <a href="#export">
            <Download size={17} /> エクスポート
          </a>
          <a href="#storage">
            <HardDrive size={17} /> ストレージ
          </a>
          <a href="#security">
            <Shield size={17} /> セキュリティ
          </a>
        </nav>

        <div className="settings-content">
          <section className="settings-card" id="account">
            <header>
              <div className="settings-icon">
                <UserRound size={19} />
              </div>
              <div>
                <h2>アカウント</h2>
                <p>現在 Citera にログインしているアカウントです。</p>
              </div>
            </header>
            <div className="profile-row">
              <div className="avatar large">
                {session.data?.user.displayName.slice(0, 1).toUpperCase() ?? "C"}
              </div>
              <div>
                <strong>{session.data?.user.displayName ?? "—"}</strong>
                <span>{session.data?.user.email ?? "—"}</span>
              </div>
              <span className="connected-badge">
                <Check size={13} /> 接続済み
              </span>
            </div>
          </section>

          <section className="settings-card" id="devices">
            <header>
              <div className="settings-icon">
                <Laptop size={19} />
              </div>
              <div>
                <h2>端末とセッション</h2>
                <p>不要な端末をログアウトできます。</p>
              </div>
            </header>
            <div className="device-list">
              {devices.isPending ? (
                <div className="loading-row">読み込み中…</div>
              ) : devices.isError ? (
                <p className="form-error" role="alert">
                  端末情報を読み込めませんでした。
                </p>
              ) : devices.data?.length ? (
                devices.data.map((device) => (
                  <div className="device-row" key={device.id}>
                    <div className="device-icon">
                      {device.deviceName.toLowerCase().includes("mobile") ? (
                        <Smartphone size={19} />
                      ) : (
                        <Laptop size={19} />
                      )}
                    </div>
                    <div>
                      <strong>{device.deviceName}</strong>
                      <span>
                        最終使用{" "}
                        {new Intl.DateTimeFormat("ja-JP", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(device.lastUsedAt))}
                      </span>
                    </div>
                    {device.current ? (
                      <span className="current-device">この端末</span>
                    ) : (
                      <button
                        type="button"
                        className="text-button danger"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(device.id)}
                      >
                        <LogOut size={14} /> 失効
                      </button>
                    )}
                  </div>
                ))
              ) : (
                <p className="settings-hint">有効な端末はありません。</p>
              )}
            </div>
            {revoke.error && (
              <p className="form-error" role="alert">
                セッションを失効できませんでした。
              </p>
            )}
          </section>

          <section className="settings-card" id="defaults">
            <header>
              <div className="settings-icon">
                <ArchiveRestore size={19} />
              </div>
              <div>
                <h2>保存の既定値</h2>
                <p>Web と拡張機能から追加する論文に適用します。</p>
              </div>
            </header>
            <div className="settings-form-grid">
              <label>
                既定のコレクション
                <select
                  value={preferences.defaultCollectionId ?? ""}
                  disabled={collections.isPending || preferencesQuery.isPending}
                  onChange={(event) =>
                    setPreferences((current) => ({
                      ...current,
                      defaultCollectionId: event.target.value || null,
                    }))
                  }
                >
                  <option value="">指定なし</option>
                  {collections.data?.map((collection) => (
                    <option key={collection.id} value={collection.id}>
                      {collection.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                既定の状態
                <select
                  value={preferences.defaultStatus}
                  disabled={preferencesQuery.isPending}
                  onChange={(event) =>
                    setPreferences((current) => ({
                      ...current,
                      defaultStatus: event.target.value as UserPreferences["defaultStatus"],
                    }))
                  }
                >
                  <option value="inbox">未整理</option>
                  <option value="reading">読書中</option>
                  <option value="read">読了</option>
                  <option value="archived">アーカイブ</option>
                </select>
              </label>
              <label className="full">
                既定のタグ
                <select
                  className="multi-select"
                  multiple
                  value={preferences.defaultTagIds}
                  disabled={tags.isPending || preferencesQuery.isPending}
                  onChange={(event) =>
                    setPreferences((current) => ({
                      ...current,
                      defaultTagIds: Array.from(
                        event.currentTarget.selectedOptions,
                        (option) => option.value,
                      ),
                    }))
                  }
                >
                  {tags.data?.map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.name}
                    </option>
                  ))}
                </select>
                <span className="settings-hint">
                  複数選択できます。未選択なら既定タグは付与しません。
                </span>
              </label>
            </div>
            <footer>
              <button
                type="button"
                className="button primary compact"
                disabled={preferencesQuery.isPending || savePreferences.isPending}
                onClick={() => savePreferences.mutate()}
              >
                <Save size={15} /> {savePreferences.isPending ? "保存中…" : "変更を保存"}
              </button>
            </footer>
            {preferencesQuery.error && (
              <p className="form-error" role="alert">
                既定値を読み込めませんでした。
              </p>
            )}
            {savePreferences.isSuccess && <p className="form-success">既定値を保存しました。</p>}
            {savePreferences.error && (
              <p className="form-error" role="alert">
                既定値を保存できませんでした。
              </p>
            )}
          </section>

          <section className="settings-card" id="export">
            <header>
              <div className="settings-icon">
                <Download size={19} />
              </div>
              <div>
                <h2>エクスポートとバックアップ</h2>
                <p>
                  メタデータだけの軽量エクスポート、または PDF を含む完全バックアップを作成します。
                </p>
              </div>
            </header>
            <div className="export-options">
              <div>
                <label htmlFor="default-export-format">
                  <strong>既定の引用形式</strong>
                </label>
                <select
                  id="default-export-format"
                  value={preferences.defaultExportFormat}
                  disabled={preferencesQuery.isPending}
                  onChange={(event) =>
                    setPreferences((current) => ({
                      ...current,
                      defaultExportFormat: event.target
                        .value as UserPreferences["defaultExportFormat"],
                    }))
                  }
                >
                  <option value="bibtex">BibTeX</option>
                  <option value="csl-json">CSL-JSON</option>
                  <option value="ris">RIS</option>
                  <option value="csv">CSV</option>
                  <option value="json">JSON</option>
                </select>
              </div>
              <div className="settings-inline-action">
                <span>既定形式の変更は Web アプリの新しいエクスポート操作に使われます。</span>
                <button
                  type="button"
                  className="button primary compact"
                  disabled={preferencesQuery.isPending || savePreferences.isPending}
                  onClick={() => savePreferences.mutate()}
                >
                  <Save size={15} /> {savePreferences.isPending ? "保存中…" : "形式を保存"}
                </button>
              </div>
              <div className="backup-callout">
                <div>
                  <Cloud size={21} />
                  <p>
                    <strong>ライブラリ全体のバックアップ</strong>
                    <span>論文、メモ、タグ、コレクションと PDF を ZIP にまとめます。</span>
                  </p>
                </div>
                <button
                  type="button"
                  className="button secondary compact"
                  onClick={() => backup.mutate()}
                  disabled={backup.isPending}
                >
                  {backup.isPending ? "バックアップを作成中…" : "バックアップを作成"}
                </button>
              </div>
              {backup.error && (
                <p className="form-error" role="alert">
                  バックアップを作成できませんでした。しばらくしてから再試行してください。
                </p>
              )}
            </div>
          </section>

          <section className="settings-card" id="storage">
            <header>
              <div className="settings-icon">
                <Database size={19} />
              </div>
              <div>
                <h2>データ使用量</h2>
                <p>Cloudflare D1 と R2 に保存しているデータの概算です。</p>
              </div>
            </header>
            <div className="usage-grid">
              <div>
                <span>論文</span>
                <strong>{usage.data?.papers ?? "—"}</strong>
              </div>
              <div>
                <span>PDF ストレージ</span>
                <strong>{usage.data ? bytes(usage.data.storageBytes) : "—"}</strong>
              </div>
              <div>
                <span>メモ</span>
                <strong>{usage.data?.notes ?? "—"}</strong>
              </div>
              <div>
                <span>ファイル</span>
                <strong>{usage.data?.files ?? "—"}</strong>
              </div>
            </div>
            {usage.error && (
              <p className="form-error" role="alert">
                使用量を取得できませんでした。
              </p>
            )}
            <p className="settings-hint">
              無料枠は変更されることがあります。現在値は Cloudflare
              の公式料金ページで確認してください。
            </p>
          </section>

          <section className="settings-card" id="security">
            <header>
              <div className="settings-icon">
                <KeyRound size={19} />
              </div>
              <div>
                <h2>セキュリティ</h2>
                <p>セッションと暗号化キーはサーバー側で管理されます。</p>
              </div>
            </header>
            <div className="security-list">
              <p>
                <Shield size={17} />
                <span>
                  <strong>プライベート R2</strong>PDF は公開バケットを経由せず、短時間だけ有効な URL
                  で転送されます。
                </span>
              </p>
              <p>
                <KeyRound size={17} />
                <span>
                  <strong>ハッシュ化セッション</strong>
                  データベースに平文のセッション・更新トークンを保存しません。
                </span>
              </p>
            </div>
            <div className="danger-settings">
              <div>
                <strong>アカウントデータを削除</strong>
                <span>論文、PDF、メモ、セッションを含むすべてのデータを完全に削除します。</span>
                <label htmlFor="account-delete-confirmation">
                  確認のためメールアドレスを入力
                  <input
                    id="account-delete-confirmation"
                    type="email"
                    autoComplete="off"
                    spellCheck={false}
                    value={accountConfirmation}
                    placeholder={accountEmail || "you@example.com"}
                    onChange={(event) => setAccountConfirmation(event.target.value)}
                  />
                </label>
              </div>
              <button
                type="button"
                className="button danger"
                disabled={!deletionConfirmed || deleteAccount.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      "Citera の全データを完全に削除します。この操作は取り消せません。続行しますか？",
                    )
                  ) {
                    deleteAccount.mutate();
                  }
                }}
              >
                <Trash2 size={15} /> {deleteAccount.isPending ? "削除を受付中…" : "完全に削除"}
              </button>
            </div>
            {deleteAccount.error && (
              <p className="form-error" role="alert">
                削除を受け付けられませんでした。メールアドレスを確認して再試行してください。
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
