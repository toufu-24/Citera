import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveRestore,
  Check,
  Cloud,
  Database,
  Download,
  FolderTree,
  HardDrive,
  KeyRound,
  Laptop,
  LogOut,
  Save,
  Shield,
  Smartphone,
  Tags,
  Trash2,
  UserRound,
} from "lucide-react";

import {
  ApiRequestError,
  api,
  type CollectionRecord,
  type PaperTag,
  type UserPreferences,
} from "../lib/api";
import { clearActiveDatabase } from "../lib/database";
import { collectionOptions } from "../lib/collections";

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

function collectionErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiRequestError)) return fallback;
  if (error.code === "COLLECTION_HAS_CHILDREN") {
    return "子フォルダーを先に移動または削除してから、親フォルダーを削除してください。";
  }
  if (error.code === "COLLECTION_CYCLE") {
    return "この親フォルダーは階層が循環するため選択できません。";
  }
  return error.message || fallback;
}

function TagEditor({ tag }: { tag: PaperTag }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.color ?? "#73846f");
  const update = useMutation({
    mutationFn: () => api.updateTag(tag.id, { name: name.trim(), color }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["tags"] }),
  });
  const remove = useMutation({
    mutationFn: () => api.removeTag(tag.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tags"] });
      void queryClient.invalidateQueries({ queryKey: ["preferences"] });
      void queryClient.invalidateQueries({ queryKey: ["papers"] });
    },
  });
  return (
    <div className="library-manager-row">
      <input
        type="color"
        value={color}
        onChange={(event) => setColor(event.target.value)}
        aria-label={`${tag.name} の色`}
      />
      <input
        value={name}
        maxLength={100}
        onChange={(event) => setName(event.target.value)}
        aria-label={`${tag.name} の名前`}
      />
      <span>{tag.paperCount ?? 0}件</span>
      <button
        type="button"
        className="text-button"
        disabled={
          !name.trim() ||
          update.isPending ||
          (name === tag.name && color === (tag.color ?? "#73846f"))
        }
        onClick={() => update.mutate()}
      >
        保存
      </button>
      <button
        type="button"
        className="text-button danger"
        disabled={remove.isPending}
        onClick={() => {
          if (window.confirm(`タグ「${tag.name}」を削除しますか？論文自体は削除されません。`)) {
            remove.mutate();
          }
        }}
      >
        削除
      </button>
      {(update.error || remove.error) && (
        <span className="manager-error">保存できませんでした</span>
      )}
    </div>
  );
}

function CollectionEditor({
  collection,
  collections,
}: {
  collection: CollectionRecord;
  collections: CollectionRecord[];
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(collection.name);
  const [description, setDescription] = useState(collection.description ?? "");
  const [parentId, setParentId] = useState(collection.parentId ?? "");
  const parentOptions = collectionOptions(collections, collection.id);
  const hasChildren = collections.some((candidate) => candidate.parentId === collection.id);
  const update = useMutation({
    mutationFn: () =>
      api.updateCollection(collection.id, {
        name: name.trim(),
        description: description.trim() || null,
        parentId: parentId || null,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["collections"] }),
  });
  const remove = useMutation({
    mutationFn: () => api.removeCollection(collection.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
      void queryClient.invalidateQueries({ queryKey: ["preferences"] });
      void queryClient.invalidateQueries({ queryKey: ["papers"] });
    },
  });
  return (
    <div className="collection-manager-row">
      <div>
        <input
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
          aria-label={`${collection.name} の名前`}
        />
        <input
          value={description}
          maxLength={10_000}
          placeholder="説明（任意）"
          onChange={(event) => setDescription(event.target.value)}
          aria-label={`${collection.name} の説明`}
        />
        <select
          value={parentId}
          onChange={(event) => setParentId(event.target.value)}
          aria-label={`${collection.name} の親フォルダー / 子フォルダー`}
        >
          <option value="">親なし</option>
          {parentOptions.map(({ collection: candidate, label }) => (
            <option key={candidate.id} value={candidate.id}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <span>{collection.paperCount ?? 0}件</span>
      <button
        type="button"
        className="text-button"
        disabled={!name.trim() || update.isPending}
        onClick={() => update.mutate()}
      >
        保存
      </button>
      <button
        type="button"
        className="text-button danger"
        disabled={remove.isPending || hasChildren}
        title={hasChildren ? "子フォルダーを先に移動または削除してください" : undefined}
        onClick={() => {
          if (
            window.confirm(
              `コレクション「${collection.name}」を削除しますか？論文自体は削除されません。`,
            )
          ) {
            remove.mutate();
          }
        }}
      >
        削除
      </button>
      {(update.error || remove.error) && (
        <span className="manager-error">
          {collectionErrorMessage(
            remove.error ?? update.error,
            "フォルダーを保存できませんでした。",
          )}
        </span>
      )}
    </div>
  );
}

function LibraryOrganization({
  tags,
  collections,
}: {
  tags: PaperTag[];
  collections: CollectionRecord[];
}) {
  const queryClient = useQueryClient();
  const [tagName, setTagName] = useState("");
  const [tagColor, setTagColor] = useState("#73846f");
  const [collectionName, setCollectionName] = useState("");
  const [collectionDescription, setCollectionDescription] = useState("");
  const [collectionParentId, setCollectionParentId] = useState("");
  const organizedCollections = collectionOptions(collections);
  const createTag = useMutation({
    mutationFn: () => api.createTag({ name: tagName.trim(), color: tagColor }),
    onSuccess: () => {
      setTagName("");
      void queryClient.invalidateQueries({ queryKey: ["tags"] });
    },
  });
  const createCollection = useMutation({
    mutationFn: () =>
      api.createCollection({
        name: collectionName.trim(),
        description: collectionDescription.trim() || null,
        parentId: collectionParentId || null,
      }),
    onSuccess: () => {
      setCollectionName("");
      setCollectionDescription("");
      setCollectionParentId("");
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
    },
  });
  const submitTag = (event: FormEvent) => {
    event.preventDefault();
    if (tagName.trim()) createTag.mutate();
  };
  const submitCollection = (event: FormEvent) => {
    event.preventDefault();
    if (collectionName.trim()) createCollection.mutate();
  };

  return (
    <div className="library-managers">
      <section>
        <h3>
          <Tags size={16} /> タグ
        </h3>
        <form className="manager-create-form tag-create-form" onSubmit={submitTag}>
          <input
            type="color"
            value={tagColor}
            onChange={(event) => setTagColor(event.target.value)}
            aria-label="新しいタグの色"
          />
          <input
            value={tagName}
            maxLength={100}
            placeholder="新しいタグ"
            aria-label="新しいタグ名"
            onChange={(event) => setTagName(event.target.value)}
          />
          <button
            className="button secondary compact"
            disabled={!tagName.trim() || createTag.isPending}
          >
            追加
          </button>
        </form>
        <div className="manager-list">
          {tags.map((tag) => (
            <TagEditor key={tag.id} tag={tag} />
          ))}
          {!tags.length && <p className="settings-hint">タグはまだありません。</p>}
        </div>
        {createTag.error && <p className="form-error">タグを作成できませんでした。</p>}
      </section>

      <section>
        <h3>
          <FolderTree size={16} /> フォルダー
        </h3>
        <form className="manager-create-form collection-create-form" onSubmit={submitCollection}>
          <label className="collection-create-field">
            <span>フォルダー名</span>
            <input
              value={collectionName}
              maxLength={200}
              placeholder="例：2026年の研究"
              aria-label="新しいコレクション名"
              onChange={(event) => setCollectionName(event.target.value)}
            />
          </label>
          <label className="collection-create-field">
            <span>説明 <small>任意</small></span>
            <input
              value={collectionDescription}
              maxLength={10_000}
              placeholder="このフォルダーの用途"
              aria-label="新しいコレクションの説明"
              onChange={(event) => setCollectionDescription(event.target.value)}
            />
          </label>
          <label className="collection-create-field">
            <span>親フォルダー / 子フォルダー</span>
            <select
              value={collectionParentId}
              onChange={(event) => setCollectionParentId(event.target.value)}
              aria-label="親フォルダー / 子フォルダー"
            >
              <option value="">最上位に作成</option>
              {organizedCollections.map(({ collection, label }) => (
                <option key={collection.id} value={collection.id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="button secondary compact"
            disabled={!collectionName.trim() || createCollection.isPending}
          >
            追加
          </button>
        </form>
        <div className="manager-list">
          {organizedCollections.map(({ collection }) => (
            <CollectionEditor
              key={collection.id}
              collection={collection}
              collections={collections}
            />
          ))}
          {!collections.length && <p className="settings-hint">コレクションはまだありません。</p>}
        </div>
        {createCollection.error && (
          <p className="form-error" role="alert">
            {collectionErrorMessage(createCollection.error, "フォルダーを作成できませんでした。")}
          </p>
        )}
      </section>
    </div>
  );
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
          <a href="#organization">
            <Tags size={17} /> タグと分類
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
                  {collectionOptions(collections.data ?? []).map(({ collection, label }) => (
                    <option key={collection.id} value={collection.id}>
                      {label}
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
                  <option value="inbox">未着手</option>
                  <option value="reading">読書中</option>
                  <option value="read">読了</option>
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

          <section className="settings-card" id="organization">
            <header>
              <div className="settings-icon">
                <Tags size={19} />
              </div>
              <div>
            <h2>タグとフォルダー</h2>
            <p>分類を作成・変更し、フォルダーの階層を管理します。</p>
              </div>
            </header>
            {tags.isPending || collections.isPending ? (
              <div className="loading-row">読み込み中…</div>
            ) : tags.isError || collections.isError ? (
              <p className="form-error" role="alert">
                タグとコレクションを読み込めませんでした。
              </p>
            ) : (
              <LibraryOrganization tags={tags.data ?? []} collections={collections.data ?? []} />
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
