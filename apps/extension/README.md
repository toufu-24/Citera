# Citera browser extension

Manifest V3 extension for Chromium browsers. It deliberately has no persistent page access:

- `activeTab` and `scripting` inject `content-script.js` only after the user opens the popup.
- API and PDF origins are declared as optional hosts. Citera requests only the exact configured API origin and, when needed, the detected PDF origin from a user gesture.
- Page and PDF targets must be HTTP(S), contain no URL user information, and must not directly address localhost, private, loopback, link-local, reserved, or non-global IP space. Redirects are handled manually, capped, and every visible target is validated before another request.
- Automatic PDF retrieval is limited to the page's exact origin. A different origin is off by default and needs a separate popup confirmation; confirmed cross-origin requests always omit cookies and HTTP authentication. Same-origin downloads retain the publisher session, use a finite timeout, and remain size/magic-byte checked.
- Access tokens live in `storage.session`; the rotating refresh token is device-local in `storage.local`. Settings contain no credentials and may use `storage.sync`.

## Build and load

```bash
mise trust
mise install
mise exec -- pnpm install
mise exec -- pnpm --filter @citera/extension build
```

Load `apps/extension/dist` as an unpacked extension from `chrome://extensions`. For Firefox portability, browser calls are isolated in `src/lib/browser.ts`; a Firefox MV3 manifest can reuse the application code.

## Citera API contract used by the extension

The extension assumes these extension-specific OAuth endpoints in addition to the REST API documented for Citera:

- `GET /v1/auth/extension/authorize` accepts `redirect_uri`, `code_challenge`, `code_challenge_method=S256`, `state`, and `nonce`, then redirects to the `chrome.identity` callback with `code` and `state`.
- `POST /v1/auth/extension/token` accepts `{ grantType: "authorization_code", code, redirectUri, codeVerifier, deviceName }` and returns `{ accessToken, expiresIn, refreshToken, refreshExpiresIn, nonce }`. The returned nonce must match the authorization transaction.
- `POST /v1/auth/refresh` accepts `{ refreshToken }` and returns a newly rotated token pair in the same stored family lineage. The previous refresh credential is revoked; replaying it durably revokes the family and all still-active child sessions.
- `POST /v1/auth/logout` uses the bearer access token to revoke the extension session, which also invalidates its refresh credential.

The callback is exactly `chrome.identity.getRedirectURL("oauth2")`, normally `https://<extension-id>.chromiumapp.org/oauth2`. Put the extension ID in the API's `ALLOWED_EXTENSION_IDS`; also put `chrome-extension://<extension-id>` in API `ALLOWED_ORIGINS` and R2 `AllowedOrigins`. For a non-Chromium callback, use `EXTENSION_REDIRECT_ORIGINS` explicitly.

The popup loads tags, collections and `GET /v1/preferences` together. Server-side default status/tags/collection become the initial selection, and the user can change them for that save. Saving uses `POST /v1/ingestions` with `{ clientMutationId, sourceType: "extension", sourceUrl, paper, includePdf }`; `paper` carries author objects, the chosen status/tag/collection IDs, identifier type/original-value inputs, and observed page metadata. The API performs canonical identifier normalization. Saving is followed by `POST /v1/papers/{paperId}/files/upload-url`, direct `PUT`, `POST /v1/files/{fileId}/complete`, and finally `POST /v1/ingestions/{ingestionId}/complete`. The extension sends every returned upload header unchanged; signed `Content-Length` is intentionally not returned because JavaScript cannot set it, and Chromium derives the same value from the ArrayBuffer body. Exact duplicates may be returned as a successful `duplicate` object or an HTTP `409` with the existing paper in `error.details`.

`VITE_API_BASE_URL` can set the build-time default; otherwise local development uses `http://127.0.0.1:8787`. The options page permits HTTPS origins and loopback HTTP only. If a redirect is opaque, its destination cannot be validated and the extension rejects it; opening the final PDF directly is the safe retry path. If the publisher PDF cannot be fetched with the allowed session/permission, the extension still saves bibliography only. It has no arbitrary local-file picker, so add that PDF from Citera Web.
