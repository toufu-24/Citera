# Security

## Threat model

Citera’s threat model covers unauthenticated Internet users, another Access identity, malicious page content, leaked signed URLs, replayed sync/Queue messages, and unsafe external metadata. It does not claim to protect data from a compromised user device, compromised extension, or Cloudflare account.

## Authentication

- Production static Web routes and the two identity-bootstrap endpoints are enforced by Cloudflare Access. The Worker independently validates the bootstrap endpoints' injected `Cf-Access-Jwt-Assertion` with the team JWKS, RS256, exact issuer, application audience and time claims before using `issuer + subject` as the identity.
- API paths have a path-specific Access Bypass so extension bearer calls can reach the Worker. The protected Web session bootstrap exchanges the Access identity for a random high-entropy Citera token in an `HttpOnly; Secure; SameSite=Lax` cookie. Every bypassed API route then applies Citera cookie/bearer authentication and resource authorization. D1 stores only `SHA-256(TOKEN_HASH_PEPPER || ":" || token)` and session metadata.
- Extension interactive authorization runs behind Access and then uses Citera authorization code + PKCE S256. Its one-time code has a short expiry and consumed flag. Access token is short lived; refresh token rotates on every successful refresh and only peppered hashes are stored. Sessions retain family/parent/replacement lineage. Reuse of a revoked predecessor durably revokes the family and every active child; conditional child issuance prevents a concurrent refresh from escaping that revocation.
- Legacy Google OAuth code remains available only outside production for local compatibility. Production legacy login, callback, and dev-login routes fail closed.
- Production request handling fails closed with `503` when Access, R2, origin, or hashing configuration is incomplete.
- Cookie/session/refresh responses use `Cache-Control: no-store`.

## Authorization and tenant isolation

- Auth middleware derives `userId`; routes never accept a user ID as authority.
- Resource routes are written with user predicates, and join tables carry `user_id` where practical. This is an implementation convention backed by code review, not database row-level security.
- Missing resource owned by someone else returns the same `404` as a nonexistent resource.
- Cross-user access should be covered by Worker integration tests before production; do not infer isolation solely from IDs being hard to guess.
- R2 delete/download first loads an owned file row and verifies key prefix equals `users/{userId}/...`.

## R2 protection

- Production deployment must keep the bucket private and leave `r2.dev` public access disabled; this is a Cloudflare resource setting, not enforced by repository code.
- Object key is generated from server IDs, never original filename/path.
- Production presigned URL is S3 SigV4 with exact method/generated key, short TTL and, for PUT, signed content type/checksum/`If-None-Match`/actual `Content-Length`. `Content-Length` is not returned as a client-set header because browsers forbid JavaScript from setting it; the user agent derives the signed value from the Blob/ArrayBuffer body, so a different-length upload fails signature verification at R2. Use an R2 access key scoped to only the Citera bucket and treat the URL as a bearer credential.
- Pre-sign validates claimed size/type/hash, checks the configured owner storage quota across pending/uploaded/verified rows, and applies the upload-ticket rate limit. The quota check is a pre-ticket aggregate rather than a serialized reservation, so simultaneous tickets can race. Completion requires matching actual R2 size and SHA-256 checksum, then checks `%PDF-` range bytes. Size/checksum/magic failure marks the row failed and deletes the object immediately. The hourly cleanup also tombstones stale pending/uploaded/failed rows and deletes any remaining objects after `PENDING_UPLOAD_TTL_SECONDS`.
- Local proxy requires the normal Citera session and validates the same file state/key.
- CORS is exact-origin allowlist. Wildcard origin and credentials are not combined.

## CSRF and CORS

- Local cookie-authenticated mutations require an `Origin` present in `ALLOWED_ORIGINS`; there is no separate double-submit token/header in the current implementation.
- Production Web bootstrap requests are authenticated at the edge and through the signed Access assertion; later API requests use the Citera cookie. Exact Origin checking remains enabled for cookie mutations and cross-origin requests.
- Extension requests use bearer tokens and do not rely on cookies. `chrome-extension://<id>` must be present in API `ALLOWED_ORIGINS`; `ALLOWED_EXTENSION_IDS` separately allows the `chromiumapp.org` OAuth callback.
- Preflight allows only required methods/headers; the extension authorization redirect is GET but issues a one-time code.

## Input and content safety

- Structured JSON requests are validated. Sync mutations additionally validate the allowed entity/operation-specific payload instead of accepting arbitrary fields. Every POST/PATCH/DELETE body, plus any request labelled `application/json`, is capped at 1 MiB independently of `Content-Type`: a declared oversize `Content-Length` is rejected and middleware also counts bytes from a cloned stream so omitted/chunked length cannot bypass the limit. The local authenticated PDF PUT follows its separate file-size/checksum path. Not every response has runtime schema validation.
- PDF max size is configurable. MIME/extension are hints only; SHA-256, actual size and magic bytes are authoritative.
- Markdown source is stored, parsed without raw script execution, and sanitized with DOMPurify before insertion.
- Search/query/sort keys are allowlisted; SQL values use D1 prepared bindings.
- Persisted source/page URLs are limited to HTTP(S) without embedded user information or fragments; normal REST input also rejects credential-like query parameter names. Arbitrary URLs are display metadata and are not fetched by the server.
- CSV output uses RFC-style quoting for comma/quote/newline and prefixes spreadsheet formula triggers (`=`, `+`, `-`, `@`, tab, carriage return) with an apostrophe. BibTeX/RIS use format-specific escaping.

## SSRF and external APIs

- Server does not fetch arbitrary page/PDF URL supplied by a user.
- Metadata jobs build URLs only for fixed Crossref and arXiv HTTPS hosts from normalized identifiers. OpenAlex is a type/interface placeholder only.
- There is no general server-side URL fetch path, so user-supplied page/PDF URLs are not passed to Worker `fetch`. The fixed provider requests currently use the platform's default redirect handling; per-hop host revalidation is not implemented.
- Metadata-provider fetch has an 8-second abort timeout, explicit status handling, user-agent/contact setting and cache TTL. Response byte/content-type limits are not yet enforced for these external responses.
- The extension accepts only credential-free HTTP(S) page/PDF URLs and rejects localhost plus directly addressed private, loopback, link-local, reserved and non-global IP space. It automatically retrieves only an exact same-origin PDF. Cross-origin retrieval requires a separate confirmation showing the target and always uses `credentials: "omit"`; same-origin retrieval may use the current publisher session.
- Extension redirects are manual, limited to five, and every visible next/final URL is revalidated. An opaque redirect is rejected, the full download has a 20-second timeout and 100 MiB streaming cap, and PDF magic bytes are checked before upload. Browser `fetch` cannot independently pin DNS resolution, so a publicly named host using DNS rebinding remains a residual client-side risk.

## Token and secret handling

- `TOKEN_HASH_PEPPER`, `IP_HASH_SALT` and R2 S3 credentials are Wrangler secrets. Production request handling fails closed unless the token pepper and independent IP salt are each at least 32 characters; R2 access credentials exist; `R2_ACCOUNT_ID` is exactly 32 hexadecimal characters; Access team domain/AUD are configured; `APP_ORIGIN` is a bare HTTPS origin; the origin allowlist contains only HTTPS/extension origins; and dev bypass is disabled.
- Rotating `TOKEN_HASH_PEPPER` invalidates existing sessions/access/refresh credentials; there is no previous-key overlap window.
- Access application tokens are validated in memory and are not persisted by Citera.
- Application code does not intentionally log Authorization/Cookie values or signed URLs. There is no general-purpose structured redaction logger, so log review remains a release requirement.
- Wrangler authentication should use OS keychain where supported.

## Headers

API responses currently receive:

```text
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()
Cross-Origin-Resource-Policy: same-site
Cache-Control: no-store
```

Static PWA assets are served by the assets binding without passing through API middleware. `apps/web/public/_headers` supplies a PDF.js-compatible CSP, framing/object/base restrictions, HSTS, nosniff, Referrer/Permissions policies and cache rules; production sourcemaps are disabled. Verify these headers on the actual custom-domain response because repository configuration alone does not prove edge application.

Both production Wrangler environments disable `workers_dev`; the API custom domain is therefore the intended public entry point, while the Jobs Worker has no `*.workers.dev` endpoint. Provision the API route before deployment and verify that no unintended preview/staging hostname reaches production bindings.

## Rate limits and abuse

The D1 fixed-window limiter covers `/v1/auth/*` (60 requests/5 minutes), upload-ticket creation (30/minute), and expensive mutations for ingestion, metadata refresh, export, sync and account deletion (20/minute). It keys primarily by a salted `CF-Connecting-IP` hash, falls back to a bounded credential fingerprint when needed, and returns `429` with `RateLimit-*` headers. Synchronous metadata export also applies a configurable estimated/final byte cap before writing to R2. The hourly scheduled cleanup removes stale `rate_limits` rows.

## Queue safety

- Queue is at-least-once. The consumer derives `idempotencyKey = type:entityId:sourceVersion`, choosing export ID, file ID, paper ID or finally user ID as the entity.
- API producers batch the domain state/change and a unique D1 `job_outbox` row. They attempt immediate dispatch in `waitUntil`; the hourly Jobs Cron retries pending rows, so a Queue send failure after the domain commit does not silently lose required work. Successfully dispatched rows are retained for 90 days before cleanup.
- D1 `job_runs` unique key claims the consumer side effect. A fresh `running` lease causes delayed redelivery; a stale lease can be reclaimed. Completed/permanent-failed messages are acknowledged.
- After the Queue envelope passes schema validation, transient errors use capped exponential retry and permanent handler errors are recorded and acked. A schema-invalid envelope has no trusted owner/idempotency identity, so it is logged and acknowledged without creating a `job_runs` row.
- Successful messages are individually acked so another batch failure does not replay them.
- When the application reaches its configured retry maximum it records `failed` and acknowledges the message, so that path does not enter the DLQ. The configured DLQ remains a guard for Queue-level delivery failures; D1 `job_runs` is the durable application record.
- Account deletion sets a durable user tombstone before dispatch. Authentication/session creation is then rejected, and every non-deletion Queue delivery for that owner is acknowledged before claiming a new run. The deletion job waits 20 minutes (covering the 15-minute maximum signed URL and normal stale-job lease), retries while another run remains active, performs a final paginated R2-prefix sweep, then cascade-deletes the user. The hourly Cron advances a monotonic deletion generation and emits a fresh outbox job after terminal/stale attempts so an interrupted delete cannot be stranded.

## Deletion

Paper/collection/note/file rows use soft-delete/tombstone state, but only paper has a restore endpoint in the current API. Deleting a file enqueues immediate idempotent object cleanup after rechecking owner/key; there is no grace period. Hourly scheduled cleanup deletes expired export objects and marks their jobs expired, and also removes expired OAuth/code/cache rows plus old dispatched-outbox/mutation/rate-limit records. Account deletion requires an exact signed-in-email confirmation and atomically records the user tombstone/generation, revokes every session family/session and records a durable job. Physical deletion is deliberately deferred for at least 20 minutes, then rechecks running jobs, deletes the entire scoped R2 prefix and finally deletes the D1 user/cascades. `job_runs.user_id` intentionally has no user FK so the deletion run can reach a terminal record after deletion; hourly generation recovery replaces terminal/stale deletion attempts. Backup restore is not implemented.

## Security verification checklist

- [ ] Two-user integration isolation passes for every resource family.
- [ ] D1 dump contains no raw web/refresh/access bearer token.
- [ ] Access issuer/audience/signature/time failures and extension state/nonce/PKCE failures reject.
- [ ] CSRF and disallowed Origin mutations reject.
- [ ] Oversize/non-PDF/mismatched hash upload fails and is not downloadable.
- [ ] Presigned key/header/body length cannot be changed; browser-derived signed `Content-Length` works against remote R2 and TTL is at most 15 minutes.
- [ ] Queue-send failure, duplicate delivery and consumer crash-window tests converge through `job_outbox` / `job_runs`.
- [ ] Refresh predecessor replay returns `REFRESH_TOKEN_REUSED` and invalidates every active token in that family.
- [ ] Account deletion immediately fences auth/new jobs, waits the 20-minute grace, removes the full owner prefix, and recovers a terminal/stale deletion generation.
- [ ] Private/unsafe URL inputs never reach `fetch`.
- [ ] Logs are sampled for secret/signed URL/PDF text leakage.

This checklist is a release gate, not a statement that every item already passes.
