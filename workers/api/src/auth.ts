import { Google, generateCodeVerifier, generateState } from "arctic";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import { verifyWithJwks } from "hono/utils/jwt/jwt";
import { z } from "zod";
import { all, first } from "./db";
import { ApiError } from "./errors";
import type { AppBindings, AuthSession, AuthUser } from "./types";
import {
  addSeconds,
  allowedOrigins,
  constantTimeEqual,
  createId,
  nowUtcIso,
  randomToken,
  sha256Hex,
} from "./utils";

const SESSION_COOKIE = "citera_session";
const WEB_SESSION_SECONDS = 60 * 60 * 24 * 30;
const ACCESS_TOKEN_SECONDS = 15 * 60;
const EXTENSION_REFRESH_SECONDS = 60 * 60 * 24 * 30;

interface SessionRow extends Record<string, unknown> {
  session_id: string;
  user_id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
}

interface IssuedSession {
  sessionId: string;
  sessionToken: string;
  accessToken?: string;
  expiresAt: string;
  accessExpiresAt?: string;
}

interface AccessIdentityRow extends Record<string, unknown> {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  status: string;
  deletion_requested_at?: string | null;
}

interface LibraryRow extends Record<string, unknown> {
  id: string;
  kind: string;
  name: string;
}

function accessIssuer(env: AppBindings["Bindings"]): string | null {
  const configured = env.ACCESS_TEAM_DOMAIN?.trim();
  if (!configured) return null;
  return (configured.startsWith("http://") || configured.startsWith("https://")
    ? configured
    : `https://${configured}`
  ).replace(/\/$/u, "");
}

function accessJwksUrl(env: AppBindings["Bindings"], issuer: string): string {
  return env.ACCESS_JWKS_URL?.trim() || `${issuer}/cdn-cgi/access/certs`;
}

function assertLegacyAuthDisabled(env: AppBindings["Bindings"]): void {
  if (env.ENVIRONMENT === "production") {
    throw new ApiError(404, "NOT_FOUND", "The legacy authentication route is disabled.");
  }
}

function claimText(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function ensurePersonalLibrary(db: D1Database, userId: string, displayName: string): Promise<LibraryRow> {
  const existing = await first<LibraryRow>(
    db,
    `SELECT l.id,l.kind,l.name
     FROM libraries l JOIN library_members m ON m.library_id=l.id
     WHERE m.user_id=? AND m.status='active' AND l.kind='personal'
     ORDER BY l.created_at LIMIT 1`,
    userId,
  );
  if (existing) return existing;

  const libraryId = userId.startsWith("usr_") ? `lib_${userId.slice(4)}` : createId("lib");
  const now = nowUtcIso();
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO libraries (id,kind,name,created_at)
       VALUES (?,'personal',?,?)`,
    ).bind(libraryId, `${displayName || "Personal"} library`, now),
    db.prepare(
      `INSERT OR IGNORE INTO library_members
       (library_id,user_id,role,status,created_at) VALUES (? ,?,'owner','active',?)`,
    ).bind(libraryId, userId, now),
  ]);
  const library = await first<LibraryRow>(
    db,
    `SELECT l.id,l.kind,l.name
     FROM libraries l JOIN library_members m ON m.library_id=l.id
     WHERE m.user_id=? AND m.status='active' AND l.kind='personal'
     ORDER BY l.created_at LIMIT 1`,
    userId,
  );
  if (!library) throw new ApiError(503, "LIBRARY_NOT_READY", "The personal library could not be created.");
  return library;
}

async function upsertAccessUser(
  c: Context<AppBindings>,
  payload: Record<string, unknown>,
  issuer: string,
): Promise<{ user: AuthUser; library: LibraryRow }> {
  const subject = claimText(payload, "sub");
  if (!subject) throw new ApiError(401, "ACCESS_SUBJECT_INVALID", "Access JWT subject is missing.");
  const email = claimText(payload, "email") ?? `${subject}@access.local`;
  const displayName = claimText(payload, "name") ?? claimText(payload, "preferred_username") ?? email;
  const avatarUrl = claimText(payload, "picture");
  const byIdentity = await first<AccessIdentityRow>(
    c.env.DB,
    `SELECT id,email,display_name,avatar_url,status,deletion_requested_at FROM users
     WHERE access_issuer=? AND access_subject=? LIMIT 1`,
    issuer,
    subject,
  );
  const byEmail = byIdentity
    ? null
    : await first<AccessIdentityRow>(
        c.env.DB,
        "SELECT id,email,display_name,avatar_url,status,deletion_requested_at FROM users WHERE email=? COLLATE NOCASE LIMIT 1",
        email,
      );
  const existing = byIdentity ?? byEmail;
  if (existing?.status === "departed" || existing?.deletion_requested_at) {
    throw new ApiError(403, "USER_DEPARTED", "This user is no longer allowed to access Citera.");
  }
  const userId = existing?.id ?? createId("usr");
  const now = nowUtcIso();
  await c.env.DB.prepare(
    `INSERT INTO users
      (id,email,display_name,avatar_url,access_issuer,access_subject,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?, 'active',?,?)
     ON CONFLICT(id) DO UPDATE SET
       email=excluded.email,display_name=excluded.display_name,avatar_url=excluded.avatar_url,
       access_issuer=excluded.access_issuer,access_subject=excluded.access_subject,
       status='active',updated_at=excluded.updated_at
     WHERE users.status <> 'departed' AND users.deletion_requested_at IS NULL`,
  )
    .bind(userId, email.toLowerCase(), displayName, avatarUrl, issuer, subject, now, now)
    .run();
  const library = await ensurePersonalLibrary(c.env.DB, userId, displayName);
  return {
    user: { id: userId, email: email.toLowerCase(), displayName, avatarUrl, libraryId: library.id },
    library,
  };
}

async function authenticateAccess(c: Context<AppBindings>, next: () => Promise<void>): Promise<void> {
  const issuer = accessIssuer(c.env);
  const audience = c.env.ACCESS_AUDIENCE?.trim();
  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!issuer || !audience) {
    throw new ApiError(503, "ACCESS_NOT_CONFIGURED", "Cloudflare Access verification is not configured.");
  }
  if (!token) throw new ApiError(401, "UNAUTHENTICATED", "A valid Cloudflare Access identity is required.");
  let payload: Awaited<ReturnType<typeof verifyWithJwks>>;
  try {
    payload = await verifyWithJwks(
      token,
      {
        jwks_uri: accessJwksUrl(c.env, issuer),
        verification: { iss: issuer, aud: audience },
        allowedAlgorithms: ["RS256"],
      },
      { signal: AbortSignal.timeout(8_000) },
    );
  } catch {
    throw new ApiError(401, "UNAUTHENTICATED", "The Cloudflare Access identity is invalid or expired.");
  }
  const identity = await upsertAccessUser(c, payload, issuer);
  c.set("user", identity.user);
  c.set("libraryId", identity.library.id);
  c.set("session", { id: `access:${claimText(payload, "sub")}`, via: "access" });
  await next();
}

function sessionHash(env: AppBindings["Bindings"], token: string): Promise<string> {
  if (!env.TOKEN_HASH_PEPPER || env.TOKEN_HASH_PEPPER.length < 32) {
    throw new ApiError(
      503,
      "TOKEN_HASH_NOT_CONFIGURED",
      "Token hashing is not configured securely.",
    );
  }
  return sha256Hex(`${env.TOKEN_HASH_PEPPER}:${token}`);
}

function setSessionCookie(c: Context<AppBindings>, token: string, maxAge: number): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: c.env.ENVIRONMENT === "production",
    sameSite: "Lax",
    path: "/",
    maxAge,
  });
}

async function issueSession(
  c: Context<AppBindings>,
  input: {
    userId: string;
    deviceName: string;
    extension: boolean;
    familyId?: string;
    parentSessionId?: string;
  },
): Promise<IssuedSession> {
  const now = nowUtcIso();
  const refreshSeconds = input.extension ? EXTENSION_REFRESH_SECONDS : WEB_SESSION_SECONDS;
  const expiresAt = addSeconds(now, refreshSeconds);
  const sessionToken = randomToken(32);
  const tokenHash = await sessionHash(c.env, sessionToken);
  const accessToken = input.extension ? randomToken(32) : undefined;
  const accessTokenHash = accessToken ? await sessionHash(c.env, accessToken) : null;
  const accessExpiresAt = accessToken ? addSeconds(now, ACCESS_TOKEN_SECONDS) : null;
  const ip = c.req.header("CF-Connecting-IP");
  const ipHash = ip ? await sha256Hex(`${c.env.IP_HASH_SALT ?? "local"}:${ip}`) : null;
  const sessionId = createId("ses");
  const familyId = input.familyId ?? sessionId;
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO session_families (id,user_id,created_at,revoked_at)
       SELECT ?,?,?,NULL
       WHERE EXISTS (
         SELECT 1 FROM users WHERE id=? AND deletion_requested_at IS NULL
       )`,
    ).bind(familyId, input.userId, now, input.userId),
    c.env.DB.prepare(
      `INSERT INTO sessions
      (id, user_id, token_hash, access_token_hash, access_expires_at, family_id, parent_session_id,
       replaced_by_session_id, device_name, user_agent, ip_hash, expires_at, last_used_at, created_at, revoked_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL
     WHERE EXISTS (SELECT 1 FROM session_families WHERE id=? AND user_id=? AND revoked_at IS NULL)
       AND EXISTS (SELECT 1 FROM users WHERE id=? AND deletion_requested_at IS NULL)`,
    ).bind(
      sessionId,
      input.userId,
      tokenHash,
      accessTokenHash,
      accessExpiresAt,
      familyId,
      input.parentSessionId ?? null,
      input.deviceName.slice(0, 120),
      c.req.header("User-Agent")?.slice(0, 500) ?? null,
      ipHash,
      expiresAt,
      now,
      now,
      familyId,
      input.userId,
      input.userId,
    ),
  ]);
  if (results[1]?.meta.changes !== 1) {
    const owner = await first<{ deletion_requested_at: string | null } & Record<string, unknown>>(
      c.env.DB,
      "SELECT deletion_requested_at FROM users WHERE id=?",
      input.userId,
    );
    if (owner?.deletion_requested_at) {
      throw new ApiError(
        409,
        "ACCOUNT_DELETION_PENDING",
        "Account deletion is in progress. New sessions cannot be created.",
      );
    }
    throw new ApiError(401, "REFRESH_TOKEN_REUSED", "The session family has been revoked.");
  }
  if (!input.extension) setSessionCookie(c, sessionToken, refreshSeconds);
  return {
    sessionId,
    sessionToken,
    ...(accessToken ? { accessToken } : {}),
    expiresAt,
    ...(accessExpiresAt ? { accessExpiresAt } : {}),
  };
}

function sessionToContext(
  row: SessionRow,
  via: AuthSession["via"],
): { user: AuthUser; session: AuthSession } {
  return {
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
    },
    session: { id: row.session_id, via },
  };
}

export const authenticate: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.env.ENVIRONMENT === "production" || c.req.header("Cf-Access-Jwt-Assertion")) {
    await authenticateAccess(c, next);
    return;
  }
  const authorization = c.req.header("Authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
  const cookie = getCookie(c, SESSION_COOKIE) ?? null;
  const token = bearer ?? cookie;
  if (!token || token.length < 32 || token.length > 256) {
    throw new ApiError(401, "AUTH_REQUIRED", "Authentication is required.");
  }
  const hash = await sessionHash(c.env, token);
  const now = nowUtcIso();
  const row = bearer
    ? await first<SessionRow>(
        c.env.DB,
        `SELECT s.id AS session_id, u.id AS user_id, u.email, u.display_name, u.avatar_url
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.revoked_at IS NULL AND s.expires_at > ?
           AND u.deletion_requested_at IS NULL
           AND s.access_token_hash = ? AND s.access_expires_at > ?
         LIMIT 1`,
        now,
        hash,
        now,
      )
    : await first<SessionRow>(
        c.env.DB,
        `SELECT s.id AS session_id, u.id AS user_id, u.email, u.display_name, u.avatar_url
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
           AND u.deletion_requested_at IS NULL LIMIT 1`,
        hash,
        now,
      );
  if (!row) {
    if (cookie) deleteCookie(c, SESSION_COOKIE, { path: "/" });
    throw new ApiError(401, "SESSION_EXPIRED", "The session is invalid or expired.");
  }
  const auth = sessionToContext(row, bearer ? "bearer" : "cookie");
  const library = await ensurePersonalLibrary(c.env.DB, auth.user.id, auth.user.displayName);
  auth.user.libraryId = library.id;
  c.set("user", auth.user);
  c.set("session", auth.session);
  c.set("libraryId", library.id);

  if (auth.session.via === "cookie" && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    const allowed = allowedOrigins(c.env.ALLOWED_ORIGINS);
    if (!origin || !allowed.has(origin)) {
      throw new ApiError(403, "CSRF_REJECTED", "The request origin is not allowed.");
    }
  }

  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      "UPDATE sessions SET last_used_at = ? WHERE id = ? AND last_used_at < datetime(?, '-15 minutes')",
    )
      .bind(now, auth.session.id, now)
      .run(),
  );
  await next();
};

function googleClient(env: AppBindings["Bindings"]): Google {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
    throw new ApiError(503, "OAUTH_NOT_CONFIGURED", "Google OAuth is not configured.");
  }
  return new Google(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI);
}

function requireOwnerConfiguration(env: AppBindings["Bindings"]): void {
  if (env.ENVIRONMENT === "production" && !env.OWNER_EMAIL?.trim()) {
    throw new ApiError(
      503,
      "OWNER_EMAIL_NOT_CONFIGURED",
      "Production login is disabled until OWNER_EMAIL is configured.",
    );
  }
}

function safeReturnTo(c: Context<AppBindings>, raw: string | undefined): string {
  const fallback = new URL("/auth/complete", c.env.APP_ORIGIN).toString();
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw, c.env.APP_ORIGIN);
    return parsed.origin === new URL(c.env.APP_ORIGIN).origin ? parsed.toString() : fallback;
  } catch {
    return fallback;
  }
}

const googleProfileSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.boolean(),
  name: z.string().min(1),
  picture: z.string().url().optional(),
});

export async function beginGoogleLogin(c: Context<AppBindings>): Promise<Response> {
  assertLegacyAuthDisabled(c.env);
  if (c.req.param("provider") !== "google") {
    throw new ApiError(
      404,
      "AUTH_PROVIDER_NOT_FOUND",
      "The authentication provider is not supported.",
    );
  }
  requireOwnerConfiguration(c.env);
  const state = generateState();
  const verifier = generateCodeVerifier();
  const nonce = randomToken(24);
  const now = nowUtcIso();
  await c.env.DB.prepare(
    `INSERT INTO oauth_states
      (state_hash, provider, code_verifier, nonce_hash, return_to, expires_at, created_at)
     VALUES (?, 'google', ?, ?, ?, ?, ?)`,
  )
    .bind(
      await sha256Hex(state),
      verifier,
      await sha256Hex(nonce),
      safeReturnTo(c, c.req.query("returnTo")),
      addSeconds(now, 600),
      now,
    )
    .run();
  const url = googleClient(c.env).createAuthorizationURL(state, verifier, [
    "openid",
    "email",
    "profile",
  ]);
  url.searchParams.set("nonce", nonce);
  return c.redirect(url.toString(), 302);
}

interface OauthStateRow extends Record<string, unknown> {
  code_verifier: string;
  nonce_hash: string;
  return_to: string;
  expires_at: string;
}

export async function finishGoogleLogin(c: Context<AppBindings>): Promise<Response> {
  assertLegacyAuthDisabled(c.env);
  if (c.req.param("provider") !== "google") {
    throw new ApiError(
      404,
      "AUTH_PROVIDER_NOT_FOUND",
      "The authentication provider is not supported.",
    );
  }
  requireOwnerConfiguration(c.env);
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state)
    throw new ApiError(400, "OAUTH_CALLBACK_INVALID", "OAuth code and state are required.");
  const stateHash = await sha256Hex(state);
  const saved = await first<OauthStateRow>(
    c.env.DB,
    "SELECT code_verifier, nonce_hash, return_to, expires_at FROM oauth_states WHERE state_hash = ? AND provider = 'google'",
    stateHash,
  );
  await c.env.DB.prepare("DELETE FROM oauth_states WHERE state_hash = ?").bind(stateHash).run();
  if (!saved || saved.expires_at <= nowUtcIso()) {
    throw new ApiError(400, "OAUTH_STATE_INVALID", "OAuth state is invalid or expired.");
  }

  let accessToken: string;
  let idToken: string;
  try {
    const tokens = await googleClient(c.env).validateAuthorizationCode(code, saved.code_verifier);
    accessToken = tokens.accessToken();
    idToken = tokens.idToken();
  } catch {
    throw new ApiError(400, "OAUTH_CODE_INVALID", "OAuth authorization could not be completed.");
  }
  const clientId = c.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new ApiError(503, "OAUTH_NOT_CONFIGURED", "Google OAuth is not configured.");
  let payload: Awaited<ReturnType<typeof verifyWithJwks>>;
  try {
    payload = await verifyWithJwks(
      idToken,
      {
        jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
        verification: { iss: /^(?:https:\/\/)?accounts\.google\.com$/u, aud: clientId },
        allowedAlgorithms: ["RS256"],
      },
      { signal: AbortSignal.timeout(8_000) },
    );
  } catch {
    throw new ApiError(400, "OAUTH_ID_TOKEN_INVALID", "OAuth identity token validation failed.");
  }
  if (
    typeof payload.nonce !== "string" ||
    !constantTimeEqual(await sha256Hex(payload.nonce), saved.nonce_hash)
  ) {
    throw new ApiError(400, "OAUTH_NONCE_INVALID", "OAuth nonce validation failed.");
  }
  if (typeof payload.sub !== "string")
    throw new ApiError(400, "OAUTH_SUBJECT_INVALID", "OAuth subject is invalid.");
  let profileResponse: Response;
  try {
    profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new ApiError(502, "OAUTH_PROFILE_FAILED", "The user profile could not be loaded.");
  }
  if (!profileResponse.ok)
    throw new ApiError(502, "OAUTH_PROFILE_FAILED", "The user profile could not be loaded.");
  const parsedProfile = googleProfileSchema.safeParse(await profileResponse.json());
  if (!parsedProfile.success) {
    throw new ApiError(
      502,
      "OAUTH_PROFILE_INVALID",
      "The identity provider returned an invalid user profile.",
    );
  }
  const profile = parsedProfile.data;
  if (profile.sub !== payload.sub) {
    throw new ApiError(
      400,
      "OAUTH_SUBJECT_MISMATCH",
      "OAuth identity token and profile subjects do not match.",
    );
  }
  if (!profile.email_verified)
    throw new ApiError(403, "EMAIL_NOT_VERIFIED", "A verified email address is required.");
  if (c.env.OWNER_EMAIL && profile.email.toLowerCase() !== c.env.OWNER_EMAIL.trim().toLowerCase()) {
    throw new ApiError(403, "OWNER_ONLY", "This Citera instance is restricted to its owner.");
  }

  const existingAccount = await first<
    { user_id: string; deletion_requested_at: string | null } & Record<string, unknown>
  >(
    c.env.DB,
    `SELECT oa.user_id,u.deletion_requested_at
     FROM oauth_accounts oa JOIN users u ON u.id=oa.user_id
     WHERE oa.provider='google' AND oa.provider_account_id=?`,
    profile.sub,
  );
  const existingEmail = await first<
    { id: string; deletion_requested_at: string | null } & Record<string, unknown>
  >(
    c.env.DB,
    "SELECT id,deletion_requested_at FROM users WHERE email = ? COLLATE NOCASE",
    profile.email,
  );
  if (existingAccount?.deletion_requested_at || existingEmail?.deletion_requested_at) {
    throw new ApiError(
      409,
      "ACCOUNT_DELETION_PENDING",
      "Account deletion is in progress. Sign-in is disabled until it completes.",
    );
  }
  const userId = existingAccount?.user_id ?? existingEmail?.id ?? createId("usr");
  const now = nowUtcIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO users (id, email, display_name, avatar_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET email=excluded.email, display_name=excluded.display_name,
         avatar_url=excluded.avatar_url, updated_at=excluded.updated_at
       WHERE users.deletion_requested_at IS NULL`,
    ).bind(userId, profile.email.toLowerCase(), profile.name, profile.picture ?? null, now, now),
    c.env.DB.prepare(
      `INSERT INTO oauth_accounts (id, user_id, provider, provider_account_id, created_at, updated_at)
       VALUES (?, ?, 'google', ?, ?, ?)
       ON CONFLICT(provider, provider_account_id) DO UPDATE SET updated_at=excluded.updated_at`,
    ).bind(createId("oac"), userId, profile.sub, now, now),
  ]);
  await issueSession(c, { userId, deviceName: "Web browser", extension: false });
  return c.redirect(saved.return_to, 302);
}

const devLoginSchema = z.object({
  email: z.string().email().default("demo@citera.local"),
  displayName: z.string().min(1).max(120).default("Citera Developer"),
  deviceName: z.string().min(1).max(120).default("Local development"),
});

export async function devLogin(c: Context<AppBindings>): Promise<Response> {
  if (c.env.ENVIRONMENT === "production" || c.env.AUTH_DEV_BYPASS !== "true") {
    throw new ApiError(404, "NOT_FOUND", "Route not found.");
  }
  if (c.env.DEV_AUTH_TOKEN) {
    const supplied = c.req.header("X-Dev-Auth-Token") ?? "";
    if (!constantTimeEqual(supplied, c.env.DEV_AUTH_TOKEN)) {
      throw new ApiError(
        403,
        "DEV_AUTH_DENIED",
        "The development authentication token is invalid.",
      );
    }
  }
  const origin = c.req.header("Origin");
  if (!origin || !allowedOrigins(c.env.ALLOWED_ORIGINS).has(origin)) {
    throw new ApiError(403, "CSRF_REJECTED", "The request origin is not allowed.");
  }
  const body = devLoginSchema.parse(await c.req.json().catch(() => ({})));
  const now = nowUtcIso();
  const found = await first<
    { id: string; deletion_requested_at: string | null } & Record<string, unknown>
  >(
    c.env.DB,
    "SELECT id,deletion_requested_at FROM users WHERE email = ? COLLATE NOCASE",
    body.email,
  );
  if (found?.deletion_requested_at) {
    throw new ApiError(
      409,
      "ACCOUNT_DELETION_PENDING",
      "Account deletion is in progress. Sign-in is disabled until it completes.",
    );
  }
  const userId = found?.id ?? createId("usr");
  await c.env.DB.prepare(
    `INSERT INTO users (id, email, display_name, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, updated_at=excluded.updated_at
     WHERE users.deletion_requested_at IS NULL`,
  )
    .bind(userId, body.email.toLowerCase(), body.displayName, now, now)
    .run();
  const issued = await issueSession(c, { userId, deviceName: body.deviceName, extension: false });
  return c.json({
    user: {
      id: userId,
      email: body.email.toLowerCase(),
      displayName: body.displayName,
      avatarUrl: null,
    },
    expiresAt: issued.expiresAt,
  });
}

function redirectAllowed(env: AppBindings["Bindings"], value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (!["https:", "http:", "chrome-extension:"].includes(parsed.protocol)) return false;
  const configured = (env.EXTENSION_REDIRECT_ORIGINS ?? "")
    .split(",")
    .map((item) => item.trim().replace(/\/$/u, ""))
    .filter(Boolean);
  for (const extensionId of (env.ALLOWED_EXTENSION_IDS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    configured.push(`chrome-extension://${extensionId}`, `https://${extensionId}.chromiumapp.org`);
  }
  return configured.some((origin) => value === origin || value.startsWith(`${origin}/`));
}

const authorizeQuerySchema = z.object({
  redirect_uri: z.string().min(1),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/u),
  code_challenge_method: z.literal("S256").default("S256"),
  state: z.string().min(8).max(512),
  nonce: z.string().min(8).max(512),
});

export async function authorizeExtension(c: Context<AppBindings>): Promise<Response> {
  if (c.get("session").via !== "cookie") {
    throw new ApiError(403, "WEB_SESSION_REQUIRED", "A signed-in web session is required.");
  }
  const input = authorizeQuerySchema.parse(c.req.query());
  if (!redirectAllowed(c.env, input.redirect_uri)) {
    throw new ApiError(400, "REDIRECT_URI_INVALID", "The extension redirect URI is not allowed.");
  }
  const code = randomToken(32);
  const now = nowUtcIso();
  await c.env.DB.prepare(
    `INSERT INTO authorization_codes
      (code_hash, user_id, redirect_uri, code_challenge, nonce, expires_at, created_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      await sha256Hex(code),
      c.get("user").id,
      input.redirect_uri,
      input.code_challenge,
      input.nonce,
      addSeconds(now, 300),
      now,
    )
    .run();
  const redirect = new URL(input.redirect_uri);
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("state", input.state);
  return new Response(null, { status: 302, headers: { Location: redirect.toString() } });
}

const extensionTokenSchema = z.object({
  grantType: z.literal("authorization_code"),
  code: z.string().min(32).max(256),
  redirectUri: z.string().min(1),
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/u),
  deviceName: z.string().min(1).max(120).default("Citera browser extension"),
});

function pkceChallenge(verifier: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then((digest) => {
    let binary = "";
    for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  });
}

interface AuthCodeRow extends Record<string, unknown> {
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  nonce: string;
  expires_at: string;
  used_at: string | null;
}

export async function exchangeExtensionToken(c: Context<AppBindings>): Promise<Response> {
  assertLegacyAuthDisabled(c.env);
  const input = extensionTokenSchema.parse(await c.req.json());
  const hash = await sha256Hex(input.code);
  const saved = await first<AuthCodeRow>(
    c.env.DB,
    "SELECT * FROM authorization_codes WHERE code_hash = ?",
    hash,
  );
  if (
    !saved ||
    saved.used_at ||
    saved.expires_at <= nowUtcIso() ||
    saved.redirect_uri !== input.redirectUri ||
    !constantTimeEqual(await pkceChallenge(input.codeVerifier), saved.code_challenge)
  ) {
    throw new ApiError(
      400,
      "AUTHORIZATION_CODE_INVALID",
      "The authorization code is invalid or expired.",
    );
  }
  const now = nowUtcIso();
  const consumed = await c.env.DB.prepare(
    "UPDATE authorization_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL",
  )
    .bind(now, hash)
    .run();
  if (consumed.meta.changes !== 1) {
    throw new ApiError(
      400,
      "AUTHORIZATION_CODE_INVALID",
      "The authorization code has already been used.",
    );
  }
  const issued = await issueSession(c, {
    userId: saved.user_id,
    deviceName: input.deviceName,
    extension: true,
  });
  return c.json({
    accessToken: issued.accessToken,
    expiresIn: ACCESS_TOKEN_SECONDS,
    refreshToken: issued.sessionToken,
    refreshExpiresIn: EXTENSION_REFRESH_SECONDS,
    nonce: saved.nonce,
  });
}

const refreshSchema = z.object({ refreshToken: z.string().min(32).max(256).optional() });

interface RefreshRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  device_name: string;
  access_token_hash: string | null;
  family_id: string;
  revoked_at: string | null;
  expires_at: string;
}

export async function refreshSession(c: Context<AppBindings>): Promise<Response> {
  assertLegacyAuthDisabled(c.env);
  const body = refreshSchema.parse(await c.req.json().catch(() => ({})));
  const cookieToken = getCookie(c, SESSION_COOKIE);
  if (!body.refreshToken && cookieToken) {
    const origin = c.req.header("Origin");
    if (!origin || !allowedOrigins(c.env.ALLOWED_ORIGINS).has(origin)) {
      throw new ApiError(403, "CSRF_REJECTED", "The request origin is not allowed.");
    }
  }
  const token = body.refreshToken ?? cookieToken;
  if (!token) throw new ApiError(401, "REFRESH_TOKEN_REQUIRED", "A refresh token is required.");
  const now = nowUtcIso();
  const saved = await first<RefreshRow>(
    c.env.DB,
    `SELECT id,user_id,device_name,access_token_hash,family_id,revoked_at,expires_at FROM sessions
     WHERE token_hash = ?`,
    await sessionHash(c.env, token),
  );
  if (!saved)
    throw new ApiError(401, "REFRESH_TOKEN_INVALID", "The refresh token is invalid or expired.");
  if (saved.revoked_at) {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE session_families SET revoked_at=? WHERE id=? AND revoked_at IS NULL",
      ).bind(now, saved.family_id),
      c.env.DB.prepare(
        "UPDATE sessions SET revoked_at=? WHERE family_id=? AND revoked_at IS NULL",
      ).bind(now, saved.family_id),
    ]);
    throw new ApiError(
      401,
      "REFRESH_TOKEN_REUSED",
      "Refresh token reuse revoked the session family.",
    );
  }
  if (saved.expires_at <= now)
    throw new ApiError(401, "REFRESH_TOKEN_INVALID", "The refresh token is invalid or expired.");
  const revoked = await c.env.DB.prepare(
    "UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
  )
    .bind(now, saved.id)
    .run();
  if (revoked.meta.changes !== 1) {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE session_families SET revoked_at=? WHERE id=? AND revoked_at IS NULL",
      ).bind(now, saved.family_id),
      c.env.DB.prepare(
        "UPDATE sessions SET revoked_at=? WHERE family_id=? AND revoked_at IS NULL",
      ).bind(now, saved.family_id),
    ]);
    throw new ApiError(401, "REFRESH_TOKEN_REUSED", "The refresh token has already been rotated.");
  }
  const extension = saved.access_token_hash !== null || body.refreshToken !== undefined;
  const issued = await issueSession(c, {
    userId: saved.user_id,
    deviceName: saved.device_name,
    extension,
    familyId: saved.family_id,
    parentSessionId: saved.id,
  });
  await c.env.DB.prepare("UPDATE sessions SET replaced_by_session_id=? WHERE id=? AND family_id=?")
    .bind(issued.sessionId, saved.id, saved.family_id)
    .run();
  if (extension) {
    return c.json({
      accessToken: issued.accessToken,
      expiresIn: ACCESS_TOKEN_SECONDS,
      refreshToken: issued.sessionToken,
      refreshExpiresIn: EXTENSION_REFRESH_SECONDS,
    });
  }
  return c.json({ expiresAt: issued.expiresAt });
}

export async function authSession(c: Context<AppBindings>): Promise<Response> {
  const row = await first<{ expires_at: string } & Record<string, unknown>>(
    c.env.DB,
    "SELECT expires_at FROM sessions WHERE id=? AND user_id=?",
    c.get("session").id,
    c.get("user").id,
  );
  return c.json({
    user: c.get("user"),
    library: {
      id: c.get("libraryId"),
      kind: "personal",
    },
    session: { id: c.get("session").id, expiresAt: row?.expires_at ?? null },
    expiresAt: row?.expires_at ?? null,
  });
}

export async function logout(c: Context<AppBindings>): Promise<Response> {
  await c.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ?")
    .bind(nowUtcIso(), c.get("session").id, c.get("user").id)
    .run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.body(null, 204);
}

export async function listDevices(c: Context<AppBindings>): Promise<Response> {
  const rows = await all<Record<string, unknown>>(
    c.env.DB,
    `SELECT id, device_name, user_agent, created_at, last_used_at, expires_at,
            CASE WHEN id = ? THEN 1 ELSE 0 END AS current
     FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
     ORDER BY last_used_at DESC`,
    c.get("session").id,
    c.get("user").id,
    nowUtcIso(),
  );
  return c.json({
    devices: rows.map((row) => ({
      id: row.id,
      deviceName: row.device_name,
      userAgent: row.user_agent,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      current: Boolean(row.current),
    })),
  });
}

export async function revokeDevice(c: Context<AppBindings>): Promise<Response> {
  const result = await c.env.DB.prepare(
    "UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
  )
    .bind(nowUtcIso(), c.req.param("sessionId"), c.get("user").id)
    .run();
  if (result.meta.changes !== 1)
    throw new ApiError(404, "SESSION_NOT_FOUND", "The device session was not found.");
  if (c.req.param("sessionId") === c.get("session").id)
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.body(null, 204);
}
