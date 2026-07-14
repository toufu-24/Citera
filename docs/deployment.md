# Cloudflare deployment

## 1. Prerequisites

```bash
mise trust
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm exec playwright install chromium
mise exec -- pnpm wrangler login --use-keyring
mise exec -- pnpm wrangler whoami
```

Use a dedicated Cloudflare account/project when testing destructive migration or remote R2. `wrangler dev --remote` writes real data; Citera defaults to local simulations.

## 2. Provision resources

```bash
mise exec -- pnpm wrangler d1 create citera-db
mise exec -- pnpm wrangler r2 bucket create citera-files
mise exec -- pnpm wrangler queues create citera-jobs
mise exec -- pnpm wrangler queues create citera-jobs-dlq
```

Copy the returned D1 ID into the production bindings in both root `wrangler.jsonc` and `workers/jobs/wrangler.jsonc`. D1/R2/Queue bindings are non-inheritable between Wrangler environments, so repeat complete bindings under each `env.staging` and `env.production` rather than assuming inheritance.

Bindings:

| Worker | Binding        | Resource                                                   |
| ------ | -------------- | ---------------------------------------------------------- |
| API    | `DB`           | D1 `citera-db`                                             |
| API    | `FILES`        | private R2 `citera-files`                                  |
| API    | `JOBS`         | Queue producer `citera-jobs`                               |
| Jobs   | `DB`           | same D1                                                    |
| Jobs   | `FILES`        | same R2                                                    |
| Jobs   | `JOBS`         | same Queue producer, used by the pending-outbox Cron sweep |
| Jobs   | queue consumer | `citera-jobs`, DLQ `citera-jobs-dlq`                       |
| Jobs   | Cron trigger   | `17 * * * *` outbox/deletion recovery + cleanup sweep      |

Only Jobs Worker is an active consumer.

## 3. Migrate D1

Inspect committed SQL before applying:

```bash
mise exec -- pnpm db:generate
git diff -- migrations packages/database
mise exec -- pnpm db:migrate:local
mise exec -- pnpm db:migrate:remote
```

Wrangler tracks applied migration names in `d1_migrations`. Never edit an applied migration; add the next ordered file. Remote migration creates a backup and rolls back the failing migration, but already successful prior migrations remain.

## 4. R2 API token and CORS

Create an R2 API token limited to Object Read & Write for only `citera-files`. R2 must be enabled on the account before token creation, even when usage is expected to stay within its free allowance.

```bash
mise exec -- pnpm wrangler secret put R2_ACCESS_KEY_ID --env production --config wrangler.jsonc
mise exec -- pnpm wrangler secret put R2_SECRET_ACCESS_KEY --env production --config wrangler.jsonc
```

Put the non-secret 32-character hexadecimal `R2_ACCOUNT_ID` and `R2_BUCKET_NAME` in `env.production.vars`. Edit `r2-cors.json` so `AllowedOrigins` contains both the deployed Web origin and `chrome-extension://<stable-extension-id>`, then:

```bash
mise exec -- pnpm wrangler r2 bucket cors set citera-files --file r2-cors.json
mise exec -- pnpm wrangler r2 bucket cors list citera-files
```

Keep the bucket private. Presigned URLs work only at the R2 S3 endpoint, not custom domains. They are reusable bearer URLs until expiry, so Citera limits TTL to at most 900 seconds and uses exact generated keys. PUT signatures bind `Content-Type`, checksum, `If-None-Match` and the declared actual `Content-Length`. Browser JavaScript cannot set `Content-Length`; Citera deliberately omits it from the returned client header map and the user agent derives the same value from the Blob/ArrayBuffer body. The committed CORS file includes `GET`, `HEAD`, `PUT`, the upload/Range headers and response headers needed by the Web app and extension; replace every placeholder before applying it.

## 5. Cloudflare Access setup

Create these self-hosted Access applications. More-specific application paths take precedence over their parent path:

| Application | Public hostname / paths                                                                                                                    | Policy                            | Purpose                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Citera Web  | Add three public-hostname entries to the same app: `citera.fujinoso.com` (no path), `/v1/auth/session`, and `/v1/auth/extension/authorize` | explicit Allow for intended users | Protect static Web/PWA routes and inject the same-audience user JWT on the two exact bootstrap paths                                         |
| Citera API  | `/v1/*` and `/api/v1/*`                                                                                                                    | Bypass / Include Everyone         | Let Citera cookie/bearer requests reach the Worker; the two exact Web-app path entries above remain protected because they are more specific |

Bypass disables Access security and logging for those API paths; this is deliberate only because every routed API endpoint then applies Citera authentication and resource authorization in the Worker. Do not add unauthenticated application endpoints under those prefixes without a security review. Keep `/health` public only if external monitoring requires it; `/v1/health` remains authenticated.

Copy the team domain (`https://<team>.cloudflareaccess.com`) to `ACCESS_TEAM_DOMAIN` and the Citera Web application's 64-character Application Audience (AUD) tag to `ACCESS_AUDIENCE`. The Worker validates `Cf-Access-Jwt-Assertion` with the team JWKS, RS256, exact issuer and audience. A Web call to the protected session endpoint receives a separate HttpOnly Citera cookie used on the bypassed API paths. Extension token/API calls use Citera bearer credentials and therefore do not depend on Access cookies.

Set secrets:

```bash
mise exec -- pnpm wrangler secret put TOKEN_HASH_PEPPER --env production --config wrangler.jsonc
mise exec -- pnpm wrangler secret put IP_HASH_SALT --env production --config wrangler.jsonc
```

Set bare HTTPS `APP_ORIGIN`, `ALLOWED_ORIGINS` to the Web origin plus `chrome-extension://<id>`, and `ALLOWED_EXTENSION_IDS` to the same stable ID. Production request handling fails closed when Access/origin configuration is invalid, `R2_ACCOUNT_ID` is not 32 hex characters, R2 credentials are absent, either hash secret is shorter than 32 characters, or dev bypass is enabled. Use independent random values for the token pepper and IP salt.

Review all non-secret runtime values before deploy:

| Target              | Values                                                                                                                                                                                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API Worker          | `ENVIRONMENT`, `APP_ORIGIN`, `ALLOWED_ORIGINS`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUDIENCE`, `ALLOWED_EXTENSION_IDS`, optional `EXTENSION_REDIRECT_ORIGINS`, `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `MAX_PDF_BYTES`, `MAX_USER_STORAGE_BYTES`, `MAX_EXPORT_BYTES`, `PRESIGN_TTL_SECONDS`; keep `AUTH_DEV_BYPASS=false` |
| Jobs Worker         | `ENVIRONMENT`, `MAX_JOB_ATTEMPTS`, `MAX_BACKUP_BYTES`, `PENDING_UPLOAD_TTL_SECONDS`, `METADATA_CACHE_SECONDS`, optional `CROSSREF_MAILTO`                                                                                                                                                                      |
| Web/extension build | `VITE_API_BASE_URL=https://citera.fujinoso.com`; `VITE_ENABLE_DEV_LOGIN` must not be enabled for production Web                                                                                                                                                                                                |

## 6. Extension identity

Pack or publish the extension once so its ID is stable. Add that ID to `ALLOWED_EXTENSION_IDS`, API `ALLOWED_ORIGINS`, and R2 `AllowedOrigins`, then build the extension with the production `VITE_API_BASE_URL` (for example via a non-secret root `.env.production`). Its `chrome.identity.getRedirectURL("oauth2")` is normally `https://<id>.chromiumapp.org/oauth2`; the API derives that allowlist entry from the extension ID. For a non-Chromium callback, set `EXTENSION_REDIRECT_ORIGINS` explicitly. Rebuild and load `apps/extension/dist`.

## 7. Validate before deploy

After replacing the production Access team-domain/AUD placeholders, run the production preflight. The committed template intentionally fails this check until those external values are known.

```bash
mise exec -- pnpm lint
mise exec -- pnpm typecheck
mise exec -- pnpm test
mise exec -- pnpm test:integration
mise exec -- pnpm test:e2e
mise exec -- pnpm build
mise exec -- pnpm deploy:check
```

`deploy:check` rejects zero/mismatched D1 IDs; mismatched R2/Queue bindings; production `workers_dev` other than `false`; a non-HTTPS `APP_ORIGIN`; an invalid Access team domain or non-64-character AUD tag; a non-hex/non-32-character `R2_ACCOUNT_ID`; invalid extension IDs; enabled dev bypass; and API/R2 CORS origin differences. It validates committed non-secret configuration only; runtime validation additionally requires token/IP hash and R2 secrets, and neither check can prove that the custom-domain route, Access policy, or Cloudflare resources already exist.

Production R2 presign flow cannot be proven against local Miniflare. Use a disposable remote bucket/environment and an actual Web/extension browser request for one controlled smoke test: exact-size signed PUT with browser-derived `Content-Length`, different-size/key/header rejection, completion checksum/magic check, Range GET, expired URL rejection, and cleanup.

## 8. Deploy

Before the first production deploy, create/bind the custom domain route for the production API Worker in Cloudflare and replace all committed placeholder domain, callback, owner, extension and resource IDs. Both production Wrangler environments set `workers_dev=false`, so neither Worker leaves a `*.workers.dev` fallback URL; deploying the API without the custom-domain route would leave no intended public entry point.

```bash
mise run deploy
```

The root deploy task first runs the same `deploy:check`, builds the workspace, deploys API Worker + assets with `--env production`, then deploys Jobs Worker with its production environment. The committed production D1 IDs and placeholder callback/extension/domain/R2-account/CORS values must be replaced first. For a future incompatible Queue-message change, do not use that normal order: deploy the backward-compatible Jobs consumer first, then the producer. The current message schema carries a `sourceVersion` value but no independent protocol-schema version.

## 9. Custom domain and staging

- Before step 8, bind `citera.fujinoso.com` to API Worker; static assets and `/v1/*` share the origin to keep cookies SameSite and simplify CORS.
- Use separate `citera-staging` D1/R2/Queue resources; never share production R2 write credentials.
- Use a separate staging Access application/AUD and restrictive staging policy.
- Keep Worker-side JWT validation and application authorization even though Access protects the hostname.

## 10. Local multi-worker caveat

Cloudflare documents multi-config local producer/consumer as experimental, and Queues does not support remote dev. `mise run dev` therefore starts only Web and API. Start the Jobs Worker explicitly with `mise exec -- pnpm dev:jobs` on port `8790` when exercising it; if cross-process Queue delivery or shared local bindings are not available in the installed Wrangler version, exercise the Queue handler directly through the integration tests. Do not substitute a production Queue for local development.

## 11. Operations

- Monitor API error rate, D1 rows read/written, Queue retries/DLQ, hourly Cron runs and R2 storage/operations.
- D1 Free daily limits are hard limits; an exhausted read/write allowance causes queries to fail until reset. Indexes and bounded page size are essential.
- Queue Free retention and DLQ guarantees may be short; D1 `job_outbox` is the producer handoff and `job_runs` is the durable consumer operational record.
- Keep future heavy PDF extraction in clients; the current extraction job is only a delegated placeholder. Queue jobs must fit measured CPU/memory budgets and checkpoint state.
- Rotating `TOKEN_HASH_PEPPER` immediately invalidates extension sessions; no old-key overlap is implemented. Rotate R2 credentials with the provider's overlap procedure, then revoke the old credential.
- Backup creation can be smoke-tested, but restore/import is not implemented. Keep an independent D1/R2 backup procedure until restore support exists.
- Test account deletion only in disposable staging: confirm immediate user tombstone/session revocation and auth/non-deletion-job fencing; no physical deletion before the 20-minute grace covering the maximum 15-minute signed URL and normal lease; retry while an owned job is running; paginated final removal of the complete owner R2 prefix and D1 cascade; and hourly generation recovery after a terminal/stale deletion attempt.

## 12. Production gaps to close

- Verify that the committed `apps/web/public/_headers` policy appears on custom-domain static responses; API middleware headers do not cover assets served directly by the assets binding.
- Run a two-user tenant-isolation suite and a real Access JWT/login/logout smoke test.
- Verify extension API CORS and R2 CORS separately; configuring only one is insufficient.
- Backup ZIP generation is in-memory and bounded by `MAX_BACKUP_BYTES`; it is not suitable for a large library.
- Verify the Jobs Worker hourly Cron after deploy; it recovers terminal/stale account-deletion generations, dispatches pending `job_outbox` rows and cleans stale uploads, expired exports, OAuth/code/cache rows, old outbox/client-mutation records and rate-limit rows.
- Exercise refresh rotation/replay in staging: replaying a predecessor must revoke its `session_families` row and every active child session.

Current official references:

- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Local development data](https://developers.cloudflare.com/workers/local-development/local-data/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)
- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Queues retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)
