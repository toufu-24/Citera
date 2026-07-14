import { Hono, type Context, type Next } from "hono";
import {
  authenticate,
  authSession,
  authorizeExtension,
  beginGoogleLogin,
  devLogin,
  exchangeExtensionToken,
  finishGoogleLogin,
  listDevices,
  logout,
  refreshSession,
  revokeDevice,
} from "./auth";
import { ApiError, errorResponse } from "./errors";
import { collectionsRoutes, notesRoutes, paperTagsRoutes, tagsRoutes } from "./routes/library";
import { filesRoutes, ingestionsRoutes } from "./routes/files";
import { exportsRoutes, usageRoutes } from "./routes/exports";
import { papersRoutes } from "./routes/papers";
import { metadataRoutes } from "./routes/metadata";
import { accountRoutes, preferencesRoutes } from "./routes/settings";
import { syncRoutes } from "./routes/sync";
import type { AppBindings } from "./types";
import { allowedOrigins, createId, sha256Hex } from "./utils";

export const app = new Hono<AppBindings>();

const MAX_JSON_BODY_BYTES = 1024 * 1024;

async function assertJsonBodyWithinLimit(request: Request): Promise<void> {
  const declaredHeader = request.headers.get("Content-Length");
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new ApiError(
        400,
        "CONTENT_LENGTH_INVALID",
        "Content-Length must be a non-negative integer.",
      );
    }
    if (declared > MAX_JSON_BODY_BYTES) {
      throw new ApiError(413, "REQUEST_TOO_LARGE", "JSON request bodies are limited to 1 MiB.");
    }
  }

  const body = request.clone().body;
  if (!body) return;
  const reader = body.getReader();
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > MAX_JSON_BODY_BYTES) {
        await reader.cancel("Citera JSON body limit exceeded");
        throw new ApiError(413, "REQUEST_TOO_LARGE", "JSON request bodies are limited to 1 MiB.");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function assertProductionConfiguration(env: AppBindings["Bindings"]): void {
  if (env.ENVIRONMENT !== "production") return;
  const appOrigin = (() => {
    try {
      return new URL(env.APP_ORIGIN);
    } catch {
      return null;
    }
  })();
  const origins = [...allowedOrigins(env.ALLOWED_ORIGINS)];
  const accessTeamDomain = env.ACCESS_TEAM_DOMAIN?.trim() ?? "";
  const invalid =
    env.AUTH_DEV_BYPASS === "true" ||
    !env.TOKEN_HASH_PEPPER ||
    env.TOKEN_HASH_PEPPER.length < 32 ||
    !env.IP_HASH_SALT ||
    env.IP_HASH_SALT.length < 32 ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY ||
    !env.R2_ACCOUNT_ID ||
    !/^[0-9a-f]{32}$/iu.test(env.R2_ACCOUNT_ID) ||
    !accessTeamDomain ||
    accessTeamDomain.includes("replace-with") ||
    accessTeamDomain.includes("example.com") ||
    accessTeamDomain.startsWith("http://") ||
    (!accessTeamDomain.startsWith("https://") && !accessTeamDomain.includes(".")) ||
    !env.ACCESS_AUDIENCE ||
    env.ACCESS_AUDIENCE.includes("replace-with") ||
    !appOrigin ||
    appOrigin.protocol !== "https:" ||
    appOrigin.pathname !== "/" ||
    appOrigin.search !== "" ||
    appOrigin.hash !== "" ||
    origins.length === 0 ||
    origins.some(
      (origin) => !origin.startsWith("https://") && !origin.startsWith("chrome-extension://"),
    );
  if (invalid) {
    throw new ApiError(
      503,
      "PRODUCTION_CONFIG_INVALID",
      "Citera production security configuration is incomplete.",
    );
  }
}

app.use("*", async (c, next) => {
  const requestId = c.req.header("X-Request-ID")?.slice(0, 100) || createId("req");
  c.set("requestId", requestId);
  assertProductionConfiguration(c.env);
  const origin = c.req.header("Origin");
  const allowed = allowedOrigins(c.env.ALLOWED_ORIGINS);
  if (origin && allowed.has(origin)) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Vary", "Origin");
    c.header("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
    c.header(
      "Access-Control-Allow-Headers",
      "Authorization,Content-Type,If-Match,X-Dev-Auth-Token,X-Request-ID,Range",
    );
    c.header("Access-Control-Expose-Headers", "ETag,Content-Length,Content-Range,X-Request-ID");
    c.header("Access-Control-Max-Age", "600");
  }
  c.header("X-Request-ID", requestId);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("Cross-Origin-Resource-Policy", "same-site");
  c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  c.header("Cache-Control", "no-store");
  if (c.req.method === "OPTIONS") {
    if (origin && !allowed.has(origin))
      throw new ApiError(403, "CORS_ORIGIN_DENIED", "The request origin is not allowed.");
    return c.body(null, 204);
  }
  const contentType = c.req.header("Content-Type") ?? "";
  const bodyMethod =
    c.req.method === "POST" || c.req.method === "PATCH" || c.req.method === "DELETE";
  if (bodyMethod || contentType.toLowerCase().includes("application/json")) {
    await assertJsonBodyWithinLimit(c.req.raw);
  }
  await next();
});

async function rateLimit(c: Context<AppBindings>, next: Next): Promise<void> {
  const authSensitive = /^(?:\/v1|\/api\/v1)\/auth\//u.test(c.req.path);
  const uploadSensitive = c.req.path.endsWith("/files/upload-url");
  const expensive =
    (c.req.method === "POST" &&
      (c.req.path === "/v1/exports" ||
        c.req.path === "/v1/ingestions" ||
        c.req.path.endsWith("/refresh-metadata") ||
        c.req.path === "/v1/sync/mutations")) ||
    (c.req.method === "DELETE" && c.req.path === "/v1/account");
  if (!authSensitive && !uploadSensitive && !expensive) return next();
  const scope = uploadSensitive ? "upload" : expensive ? "expensive" : "auth";
  const duration = uploadSensitive || expensive ? 60 : 300;
  const limit = uploadSensitive ? 30 : expensive ? 20 : 60;
  const key =
    c.req.header("CF-Connecting-IP") ??
    c.req.header("Authorization")?.slice(0, 64) ??
    c.req.header("Cookie")?.slice(0, 64) ??
    "unknown";
  const keyHash = await sha256Hex(`${c.env.IP_HASH_SALT ?? "local"}:${key}`);
  const windowStart = Math.floor(Date.now() / 1000 / duration) * duration;
  await c.env.DB.prepare(
    `INSERT INTO rate_limits (scope,key_hash,window_start,count) VALUES (?,?,?,1)
     ON CONFLICT(scope,key_hash,window_start) DO UPDATE SET count=count+1`,
  )
    .bind(scope, keyHash, windowStart)
    .run();
  const row = await c.env.DB.prepare(
    "SELECT count FROM rate_limits WHERE scope=? AND key_hash=? AND window_start=?",
  )
    .bind(scope, keyHash, windowStart)
    .first<{ count: number }>();
  c.header("RateLimit-Limit", String(limit));
  c.header("RateLimit-Remaining", String(Math.max(0, limit - Number(row?.count ?? 1))));
  c.header("RateLimit-Reset", String(windowStart + duration));
  if (Number(row?.count ?? 1) > limit)
    throw new ApiError(429, "RATE_LIMITED", "Too many requests.");
  return next();
}

app.use("/v1/*", rateLimit);

app.get("/health", (c) => c.json({ name: "Citera API", status: "ok" }));
app.get("/v1/health", async (c) => {
  await c.env.DB.prepare("SELECT 1").first();
  return c.json({ name: "Citera API", status: "ok", environment: c.env.ENVIRONMENT });
});

app.post("/v1/auth/dev-login", devLogin);
app.get("/v1/auth/login/:provider", beginGoogleLogin);
app.get("/v1/auth/callback/:provider", finishGoogleLogin);
app.post("/v1/auth/extension/token", exchangeExtensionToken);
app.post("/v1/auth/refresh", refreshSession);

app.use("/v1/*", authenticate);
app.use("/api/v1/*", authenticate);

app.get("/v1/auth/extension/authorize", authorizeExtension);
app.get("/v1/auth/session", authSession);
app.get("/v1/me", authSession);
app.post("/v1/auth/logout", logout);
app.get("/v1/auth/devices", listDevices);
app.delete("/v1/auth/devices/:sessionId", revokeDevice);

app.route("/v1/papers", papersRoutes);
app.route("/v1", metadataRoutes);
app.route("/v1/papers", paperTagsRoutes);
app.route("/v1/tags", tagsRoutes);
app.route("/v1/collections", collectionsRoutes);
app.route("/v1", notesRoutes);
app.route("/v1", filesRoutes);
app.route("/v1/ingestions", ingestionsRoutes);
app.route("/v1/sync", syncRoutes);
app.route("/v1/exports", exportsRoutes);
app.route("/v1/usage", usageRoutes);
app.route("/v1/preferences", preferencesRoutes);
app.route("/v1/account", accountRoutes);

// The MVP contract uses /api/v1. Keep /v1 as a compatibility alias for the PWA and extension.
app.get("/api/v1/me", authSession);
app.route("/api/v1/items", papersRoutes);
app.route("/api/v1/papers", papersRoutes);
app.route("/api/v1", metadataRoutes);
app.route("/api/v1", paperTagsRoutes);
app.route("/api/v1/items", paperTagsRoutes);
app.route("/api/v1/tags", tagsRoutes);
app.route("/api/v1/collections", collectionsRoutes);
app.route("/api/v1", notesRoutes);
app.route("/api/v1", filesRoutes);
app.route("/api/v1/ingestions", ingestionsRoutes);
app.route("/api/v1/sync", syncRoutes);
app.route("/api/v1/exports", exportsRoutes);
app.route("/api/v1/usage", usageRoutes);
app.route("/api/v1/preferences", preferencesRoutes);
app.route("/api/v1/account", accountRoutes);

app.notFound((c) =>
  c.json(
    {
      error: { code: "NOT_FOUND", message: "Route not found.", details: {} },
      requestId: c.get("requestId"),
    },
    404,
  ),
);
app.onError((error, c) => errorResponse(c, error));
