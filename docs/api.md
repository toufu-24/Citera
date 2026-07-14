# REST API

Base path は `/api/v1`。既存Web/PWA・拡張との互換性のため `/v1` も同じhandlerへ転送します。Structured request は route ごとの Zod schema または `packages/sync` の共有 schema で検証します。Domain response schema もありますが、現在の API は全 response を runtime Zod parse しているわけではありません。Web/extension はそれぞれの client adapter を使います。

## Authentication

本番Webの入口は Cloudflare Access です。Accessが付与する `Cf-Access-Jwt-Assertion` をWorkerが署名・issuer・audience・有効期限まで検証し、`access_issuer + access_subject` で利用者を識別します。初回認証時に `users`、個人 `libraries`、owner membership を作ります。APIは対象リソースのlibrary membershipを確認し、request body/queryのuser IDやlibrary IDをauthorityとして信頼しません。ローカル開発と既存拡張互換では従来のdev/session flowを使用できます。

Refresh credentials rotate within a persisted family lineage. Reuse of a revoked predecessor returns `401 REFRESH_TOKEN_REUSED`, revokes the family row and invalidates every still-active family session/access token.

開発用 `POST /auth/dev-login` は local Wrangler かつ `AUTH_DEV_BYPASS=true` のときだけ有効です。

Extension authorize endpoint requires an existing Web cookie session. Its `redirect_uri` must match `ALLOWED_EXTENSION_IDS`-derived Chromium callbacks or the explicit `EXTENSION_REDIRECT_ORIGINS` allowlist; token exchange then uses the one-time code and PKCE verifier.

## Error

```json
{
  "error": {
    "code": "PAPER_NOT_FOUND",
    "message": "Paper was not found.",
    "details": {}
  },
  "requestId": "req_01..."
}
```

代表 status: `400` validation、`401` unauthenticated、`403` forbidden、`404` scoped resource not found、`409` version/duplicate conflict、`413` body/file/storage/export limit exceeded、`422` invalid PDF、`429` rate limited、`503` transient provider/storage or invalid production configuration。

## Endpoints

### Authentication and devices

| Method | Path                        | Description                                                            |
| ------ | --------------------------- | ---------------------------------------------------------------------- |
| GET    | `/auth/session`             | Current user/session                                                   |
| GET    | `/auth/login/google`        | Begin Google OAuth (state + PKCE + nonce)                              |
| GET    | `/auth/callback/google`     | Validate callback and create hashed session                            |
| POST   | `/auth/refresh`             | Rotate Web/extension credential; predecessor replay revokes the family |
| POST   | `/auth/logout`              | Revoke current session and clear cookie                                |
| GET    | `/auth/devices`             | List active sessions                                                   |
| DELETE | `/auth/devices/:sessionId`  | Revoke one owned session                                               |
| GET    | `/auth/extension/authorize` | Issue one-time code for a logged-in owner and PKCE challenge           |
| POST   | `/auth/extension/token`     | Exchange code + verifier for short access/refresh tokens               |
| GET    | `/me`                       | Access-authenticated user and personal library                         |

### Preferences and account

| Method | Path           | Description                                                               |
| ------ | -------------- | ------------------------------------------------------------------------- |
| GET    | `/preferences` | Read default collection/tags/status/export format                         |
| PATCH  | `/preferences` | Validate owned collection/tags and persist supplied defaults              |
| DELETE | `/account`     | Confirm email, tombstone the owner, revoke sessions and queue full delete |

When `POST /papers` or a new-paper `POST /ingestions` omits status/tag/collection fields, the API applies these stored defaults; explicitly supplied values, including empty tag/collection arrays, win. Web manual create intentionally omits an unchanged status so the API default applies. The Web selected-export action reads `defaultExportFormat`, while the extension loads preferences with its tag/collection choices and exposes the resulting initial selection for per-save edits.

Account deletion accepts `{ "confirmation": "owner@example.com" }` and returns `202` after atomically setting `users.deletion_requested_at`/generation, revoking every family/session and committing the durable `account.delete` outbox row. The tombstone immediately blocks authentication/session creation and fences non-deletion Queue jobs. The deletion job waits at least 20 minutes—longer than the maximum 15-minute signed URL and normal 15-minute job lease—then retries while another owned job is still `running`, paginates a final deletion of every R2 object under the owner prefix and deletes the D1 user so foreign-key cascades remove owned relational data. The hourly Cron advances the deletion generation and creates a new outbox job for terminal or stale deletion attempts; the current `job_runs` row can still reach terminal state after the user row is gone.

### Papers

| Method | Path                                    | Description                                                                                                                                           |
| ------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/papers`                               | Cursor list, search/filter/sort                                                                                                                       |
| POST   | `/papers`                               | Create paper, record supplied scalar bibliography fields as user provenance, enqueue enrich/reindex; idempotent when a client mutation ID is supplied |
| GET    | `/papers/:paperId`                      | Aggregate detail                                                                                                                                      |
| PATCH  | `/papers/:paperId`                      | Update with `If-Match` version                                                                                                                        |
| DELETE | `/papers/:paperId`                      | Soft delete                                                                                                                                           |
| POST   | `/papers/:paperId/restore`              | Restore tombstone                                                                                                                                     |
| POST   | `/papers/:paperId/refresh-metadata`     | Enqueue enrichment                                                                                                                                    |
| GET    | `/papers/:paperId/duplicate-candidates` | Identifier/file/title+year duplicate candidates                                                                                                       |
| GET    | `/items/:itemId/bibtex`                 | Structureから生成したBibTeXを返す                                                                                                                      |

DOI登録は `POST /metadata/resolve-doi` でプレビュー情報を取得します。`POST /items` は title がない場合でも `doi` または DOI identifier があればCrossrefから取得して登録できます。取得失敗時は `DOI_NOT_FOUND` / `METADATA_FETCH_FAILED` を返し、クライアントは手入力へ切り替えます。同一個人library内の現役論文にある同一DOIは `DUPLICATE_IDENTIFIER` ですが、ゴミ箱内の論文は重複判定から除外されます。ゴミ箱内の論文を復元する際に現役の同一DOIがあれば、復元は競合として拒否されます。

List example:

```http
GET /v1/papers?q=compressed%20sensing&tags=optimization,cs&status=reading&yearFrom=2000&yearTo=2026&hasPdf=true&sort=publication_date:desc&cursor=eyJ...
```

Response:

```json
{
  "items": [{ "id": "pap_01...", "title": "...", "version": 7 }],
  "nextCursor": "eyJzb3J0VmFsdWUiOiIyMDI2LTA3LTEzV...",
  "hasMore": true
}
```

Cursor is opaque base64url JSON containing the sort key/direction, normalized sort value and ID tiebreaker. The client must continue with the same filters; the API validates the encoded sort/direction but does not fingerprint the remaining filter set. Default page size is 50 and the endpoint maximum is 100; these are application limits, not Cloudflare billing limits.

Update example:

```http
PATCH /v1/papers/pap_01...
If-Match: 7
Content-Type: application/json

{"status":"read","rating":5}
```

Current version mismatch returns `409 VERSION_CONFLICT` with the current safe snapshot.

### Ingestion and files

| Method | Path                                | Description                                                                 |
| ------ | ----------------------------------- | --------------------------------------------------------------------------- |
| POST   | `/ingestions`                       | Save page/identifier metadata idempotently                                  |
| GET    | `/ingestions/:ingestionId`          | Progress/state                                                              |
| POST   | `/ingestions/:ingestionId/complete` | Require attached files to be verified, mark complete and enqueue processing |
| POST   | `/ingestions/:ingestionId/retry`    | Retry allowed failed state                                                  |
| POST   | `/papers/:paperId/files/upload-url` | Validate claim and issue exact PUT ticket                                   |
| GET    | `/items/:itemId/files`              | List all non-deleted PDF variants                                           |
| POST   | `/items/:itemId/files/upload-ticket`| Add a labeled/typed/language-aware PDF                                     |
| PUT    | `/files/:fileId/content`            | Local/test-only authenticated R2 upload proxy                               |
| POST   | `/files/:fileId/complete`           | Idempotent HEAD/magic verification                                          |
| GET    | `/files/:fileId/download-url`       | Short GET ticket/local proxy URL                                            |
| GET    | `/files/:fileId/content`            | Local/test-only authenticated Range proxy                                   |
| DELETE | `/files/:fileId`                    | Soft delete and keep the PDF restorable                                     |
| PATCH  | `/files/:fileId`                    | Edit file kind/language/label/default                                      |
| POST   | `/files/:fileId/retry`               | Retry a failed upload                                                     |
| POST   | `/files/:fileId/restore`             | Restore a soft-deleted PDF                                                 |

When an ingestion creates a paper, the server also stores its title, authors, publication year, venue, abstract, URL and additional `observedMetadata` as field-level provenance. `sourceType: "manual"` becomes selected `user` provenance; extension/Web sources become `webpage`, while import/PDF sources retain `import`/`pdf`. Later enrichment merges those saved candidates with exact provider results while protecting selected user fields.

Upload ticket request:

```json
{
  "sizeBytes": 1943372,
  "mediaType": "application/pdf",
  "sha256": "64-lowercase-hex",
  "originalName": "paper.pdf",
  "kind": "original_pdf",
  "ingestionId": "ing_01..."
}
```

`kind` defaults to `original_pdf`; `ingestionId` is optional for a PDF added outside an ingestion. MVP metadata fields are `fileKind` (`fulltext`, `translation`, `bilingual`, `supplement`, `other`), optional `languageCode`, optional `label`, `sortOrder`, and `isDefault`. One paper has at most one active default PDF; fallback is first `fulltext`, then first PDF.

Response shape:

```json
{
  "file": {
    "id": "fil_01...",
    "ingestionId": "ing_01...",
    "uploadState": "pending"
  },
  "upload": {
    "url": "https://...",
    "headers": {
      "Content-Type": "application/pdf",
      "If-None-Match": "*"
    },
    "expiresIn": 300
  },
  "duplicate": false
}
```

Production の `upload.url` は R2 S3 endpoint の presigned PUT、local/test は `/v1/files/:fileId/content` です。Production では例示した returned header に加えて `x-amz-checksum-sha256` を client がそのまま送り、SigV4 は申告した実 byte 数の `Content-Length` も signed header として拘束します。`Content-Length` は browser JavaScript の forbidden header なので API response の client header map からは除かれ、Browser が Blob/ArrayBuffer body から同じ値を自動導出します。異なる長さの body は R2 が署名不一致として拒否します。その後 complete endpoint が actual object size、必須 SHA-256 checksum、先頭 `%PDF-` を再検証します。Mismatch は row を failed にして object を削除します。Duplicate の場合は `upload: null` です。Local content URL には通常の session credential が必要ですが、R2 presigned URL へ cookie を送ってはいけません。この browser-derived header behavior は local proxy では再現できないため、remote R2 staging smoke test が必要です。

### Notes, tags, collections

| Method       | Path                                         |
| ------------ | -------------------------------------------- |
| GET/POST     | `/papers/:paperId/notes`                     |
| PATCH/DELETE | `/notes/:noteId`                             |
| GET/POST     | `/tags`                                      |
| PATCH/DELETE | `/tags/:tagId`                               |
| PUT/DELETE   | `/papers/:paperId/tags/:tagId`               |
| GET/POST     | `/collections`                               |
| PATCH/DELETE | `/collections/:collectionId`                 |
| PUT/DELETE   | `/collections/:collectionId/papers/:paperId` |

Paper の update/delete/restore と note の update/delete は stored integer version に対する `If-Match` を使います。Note の親を変更するときは、同一 owner・同一 paper の未削除 note であることを確認し、self/cycle を拒否します。Tag と collection row は version column を持たず、現在の PATCH/DELETE route は `If-Match` を要求しません。それらの change-log version は既存 change から導出されます。Markdown is stored as source, never trusted HTML; client rendering sanitizes output.

Paperには別途 `note_markdown` を持つ論文単位のMarkdownメモもあります。タイトル・著者・DOI・掲載誌・タグ・noteとこのMarkdownメモを検索対象にし、表示時のHTML化はサニタイズします。読書状態は `unread | reading | read | on_hold` で、`hasPdf`、`hasTranslation`、`recent` と組み合わせて絞り込めます。

### Sync

```http
GET /v1/sync?cursor=18420&limit=500
POST /v1/sync/mutations
```

```json
{
  "changes": [
    {
      "sequence": 18421,
      "entityType": "paper",
      "entityId": "pap_01...",
      "operation": "update",
      "version": 7,
      "data": { "id": "pap_01...", "status": "read", "version": 7 }
    }
  ],
  "nextCursor": 18421,
  "hasMore": false
}
```

Mutation body:

```json
{
  "mutations": [
    {
      "clientMutationId": "mut_01...",
      "entityType": "paper",
      "entityId": "pap_01...",
      "operation": "update",
      "baseVersion": 6,
      "payload": { "status": "read" },
      "createdAt": "2026-07-13T07:00:00.000Z"
    }
  ]
}
```

`/sync/mutations` が現在受理する entity は `paper`、`paper_tag`、`collection_paper` です。Entity/operation ごとに payload の field・型・長さ・URL 制約を検証し、その他の entity は validated REST endpoint の利用を要求します。Paper mutation は `baseVersion` の完全一致を要求し、mismatch は conflict result になります。Relation add/remove は現在 `baseVersion` を使いません。`clientMutationId` の記録により replay は記録済み結果（status は `duplicate`）へ収束します。現在の実装では entity update、change row、mutation-result row が単一 D1 batch ではなく段階的に書かれる箇所があり、完全な atomicity は未完了です。

### Exports and usage

| Method | Path                              | Description                                            |
| ------ | --------------------------------- | ------------------------------------------------------ |
| POST   | `/exports`                        | Produce BibTeX/CSL-JSON/RIS/CSV/JSON or enqueue backup |
| GET    | `/exports/:exportId`              | Job state                                              |
| GET    | `/exports/:exportId/download-url` | Short R2 URL when complete                             |
| GET    | `/exports/:exportId/content`      | Local/test-only authenticated export content           |
| GET    | `/usage`                          | Approximate owner paper/note/file usage                |

Metadata-export selection is either `paperIds` (up to 1,000 IDs) or `all: true`; active-query/tag/collection scope is not implemented. Non-backup formats are generated synchronously and stored in R2 before the response, with a pre-query estimate and final encoded-byte check against `MAX_EXPORT_BYTES` (default 25 MiB, maximum configuration 100 MiB). `backup` requires exactly `{ "format": "backup", "all": true }`; supplying `paperIds` is rejected. It is a library-wide Queue job built as an in-memory ZIP up to the configured `MAX_BACKUP_BYTES` limit and includes verified original PDFs, not supplements/derived objects. Every selection/data query reapplies user scoping.

## Queue dispatch semantics

Paper maintenance, ingestion completion/retry, verified-file processing, file/account cleanup, metadata refresh and backup generation store a unique `job_outbox` row in the same D1 batch as the state that requires the work. The API then attempts Queue dispatch in `waitUntil`; a failed dispatch does not lose the accepted operation because the Jobs hourly Cron retries pending rows. Repeated API calls and redelivery converge through the outbox/consumer idempotency key. A successful `2xx` therefore means the job was durably accepted, not that background work has already finished.

## Conditional responses and cache

- Paper create/detail/update/restore responses include an ETag containing the current integer version. List responses currently do not include an ETag.
- Metadata provider cache stores provider key, serialized candidate, fetched time and configurable TTL. Conditional provider revalidation is not implemented.
- PDF response supports Range and exposes `Accept-Ranges`, `Content-Range`, `Content-Length`, `ETag` through R2 CORS.
- API responses currently receive `Cache-Control: no-store` globally, including auth/session and signed URL descriptors.

## Current limitations

- Google is the only upstream OAuth provider. A `/auth/login/github` request returns `404 AUTH_PROVIDER_NOT_FOUND`.
- The Web UI does not yet enqueue offline mutations into the sync Outbox. The sync endpoints and Dexie tables are present for that next step.
- Web pull currently applies paper/note/tag/collection entity changes; file and paper-tag/collection-paper relation changes are not materialized into Dexie.
- Tag/collection rows do not yet have stored optimistic-concurrency versions; their REST mutations do not require `If-Match`.
- Export object expiry is enforced when issuing a download URL; the hourly Jobs cron deletes expired objects and marks their rows `expired`.
