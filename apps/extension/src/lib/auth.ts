import type { AuthStatus } from "../types";
import {
  getRedirectUrl,
  launchWebAuthFlow,
  storageGet,
  storageRemove,
  storageSet,
} from "./browser";
import { createPkceTransaction, type PkceTransaction } from "./pkce";
import { readSettings } from "./settings";

interface AccessCredential {
  token: string;
  expiresAt: number;
  apiBaseUrl: string;
}

interface RefreshCredential {
  token: string;
  expiresAt?: number;
  apiBaseUrl: string;
}

interface ParsedTokenResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn?: number;
  nonce?: string;
  idToken?: string;
}

const ACCESS_KEY = "citera.auth.access.v1";
const REFRESH_KEY = "citera.auth.refresh.v1";
const TRANSACTION_KEY = "citera.auth.pkce.v1";
const EXPIRY_SKEW_MS = 30_000;
const MAX_TRANSACTION_AGE_MS = 10 * 60 * 1_000;

let refreshPromise: Promise<string> | null = null;

function asRecord(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function getString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key] !== "") return record[key];
  }
  return undefined;
}

function getNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    if (typeof record[key] === "number" && Number.isFinite(record[key])) return record[key];
  }
  return undefined;
}

function parseTokenResponse(value: unknown): ParsedTokenResponse {
  const record = asRecord(value);
  const accessToken = getString(record, "accessToken", "access_token");
  const refreshToken = getString(record, "refreshToken", "refresh_token");
  const expiresIn = getNumber(record, "expiresIn", "expires_in");
  if (accessToken == null || refreshToken == null || expiresIn == null || expiresIn <= 0) {
    throw new Error("Citera APIから不正なトークン応答を受信しました。");
  }
  const refreshExpiresIn = getNumber(record, "refreshExpiresIn", "refresh_expires_in");
  const nonce = getString(record, "nonce");
  const idToken = getString(record, "idToken", "id_token");
  return {
    accessToken,
    refreshToken,
    expiresIn,
    ...(refreshExpiresIn == null ? {} : { refreshExpiresIn }),
    ...(nonce == null ? {} : { nonce }),
    ...(idToken == null ? {} : { idToken }),
  };
}

function nonceFromIdToken(idToken: string | undefined): string | undefined {
  const payload = idToken?.split(".")[1];
  if (payload == null) return undefined;
  try {
    const standard = payload.replace(/-/gu, "+").replace(/_/gu, "/");
    const decoded = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
    return getString(asRecord(JSON.parse(decoded) as unknown), "nonce");
  } catch {
    return undefined;
  }
}

async function errorMessage(response: Response): Promise<string> {
  const body = asRecord(await response.json().catch(() => null));
  const error = asRecord(body.error);
  return getString(error, "message") ?? `認証リクエストに失敗しました (${response.status})。`;
}

async function tokenRequest(
  url: string,
  body: Record<string, string>,
): Promise<ParsedTokenResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return parseTokenResponse(await response.json());
}

async function storeTokenResponse(tokens: ParsedTokenResponse, apiBaseUrl: string): Promise<void> {
  const now = Date.now();
  const access: AccessCredential = {
    token: tokens.accessToken,
    expiresAt: now + tokens.expiresIn * 1_000,
    apiBaseUrl,
  };
  const refresh: RefreshCredential = {
    token: tokens.refreshToken,
    apiBaseUrl,
    ...(tokens.refreshExpiresIn == null
      ? {}
      : { expiresAt: now + tokens.refreshExpiresIn * 1_000 }),
  };
  // Persist the newly rotated refresh credential first so a worker shutdown cannot
  // leave only a short-lived access token after the server invalidated the old token.
  await storageSet("local", REFRESH_KEY, refresh);
  await storageSet("session", ACCESS_KEY, access);
}

async function clearCredentials(): Promise<void> {
  await Promise.all([
    storageRemove("session", [ACCESS_KEY, TRANSACTION_KEY]),
    storageRemove("local", REFRESH_KEY),
  ]);
}

export async function login(): Promise<AuthStatus> {
  const settings = await readSettings();
  const transaction = await createPkceTransaction();
  await storageSet("session", TRANSACTION_KEY, transaction);

  const redirectUri = getRedirectUrl("oauth2");
  const authorizeUrl = new URL(`${settings.apiBaseUrl}/v1/auth/extension/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", "citera-browser-extension");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("code_challenge", transaction.codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", transaction.state);
  authorizeUrl.searchParams.set("nonce", transaction.nonce);

  try {
    const callback = new URL(await launchWebAuthFlow(authorizeUrl.toString()));
    const saved = await storageGet<PkceTransaction>("session", TRANSACTION_KEY);
    if (
      saved == null ||
      saved.state !== callback.searchParams.get("state") ||
      Date.now() - saved.createdAt > MAX_TRANSACTION_AGE_MS
    ) {
      throw new Error("OAuth stateが一致しないか、認証操作が期限切れです。");
    }
    const oauthError =
      callback.searchParams.get("error_description") ?? callback.searchParams.get("error");
    if (oauthError != null) throw new Error(oauthError);
    const code = callback.searchParams.get("code");
    if (code == null || code === "") throw new Error("認可コードが返されませんでした。");

    const tokens = await tokenRequest(`${settings.apiBaseUrl}/v1/auth/extension/token`, {
      grantType: "authorization_code",
      code,
      redirectUri,
      codeVerifier: saved.codeVerifier,
      deviceName: "Citera browser extension",
    });
    const returnedNonce = tokens.nonce ?? nonceFromIdToken(tokens.idToken);
    if (returnedNonce !== saved.nonce) {
      throw new Error("OAuth nonceを検証できませんでした。");
    }
    await storeTokenResponse(tokens, settings.apiBaseUrl);
    return { authenticated: true, expiresAt: Date.now() + tokens.expiresIn * 1_000 };
  } finally {
    await storageRemove("session", TRANSACTION_KEY);
  }
}

async function performRefresh(): Promise<string> {
  const [refresh, settings] = await Promise.all([
    storageGet<RefreshCredential>("local", REFRESH_KEY),
    readSettings(),
  ]);
  if (refresh == null || (refresh.expiresAt != null && refresh.expiresAt <= Date.now())) {
    await clearCredentials();
    throw new Error("Citeraへの接続期限が切れました。もう一度接続してください。");
  }
  if (refresh.apiBaseUrl !== settings.apiBaseUrl) {
    await clearCredentials();
    throw new Error("API URLが変更されました。新しいCiteraへもう一度接続してください。");
  }
  try {
    const tokens = await tokenRequest(`${settings.apiBaseUrl}/v1/auth/refresh`, {
      refreshToken: refresh.token,
    });
    if (tokens.refreshToken === refresh.token) {
      throw new Error("Citera APIが更新トークンをローテーションしませんでした。");
    }
    await storeTokenResponse(tokens, settings.apiBaseUrl);
    return tokens.accessToken;
  } catch (error) {
    await clearCredentials();
    throw error;
  }
}

export async function refreshAccessToken(): Promise<string> {
  refreshPromise ??= performRefresh().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export async function getAccessToken(): Promise<string> {
  const [access, settings] = await Promise.all([
    storageGet<AccessCredential>("session", ACCESS_KEY),
    readSettings(),
  ]);
  if (access != null && access.apiBaseUrl !== settings.apiBaseUrl) {
    await clearCredentials();
    throw new Error("API URLが変更されました。新しいCiteraへもう一度接続してください。");
  }
  if (access != null && access.expiresAt - EXPIRY_SKEW_MS > Date.now()) return access.token;
  return refreshAccessToken();
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const [access, refresh, settings] = await Promise.all([
    storageGet<AccessCredential>("session", ACCESS_KEY),
    storageGet<RefreshCredential>("local", REFRESH_KEY),
    readSettings(),
  ]);
  if (
    (access != null && access.apiBaseUrl !== settings.apiBaseUrl) ||
    (refresh != null && refresh.apiBaseUrl !== settings.apiBaseUrl)
  ) {
    await clearCredentials();
    return { authenticated: false };
  }
  if (access != null && access.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return { authenticated: true, expiresAt: access.expiresAt };
  }
  if (refresh == null || (refresh.expiresAt != null && refresh.expiresAt <= Date.now())) {
    return { authenticated: false };
  }
  try {
    await refreshAccessToken();
    const renewed = await storageGet<AccessCredential>("session", ACCESS_KEY);
    return renewed == null
      ? { authenticated: false }
      : { authenticated: true, expiresAt: renewed.expiresAt };
  } catch {
    return { authenticated: false };
  }
}

export async function logout(): Promise<void> {
  const [storedAccess, refresh, settings] = await Promise.all([
    storageGet<AccessCredential>("session", ACCESS_KEY),
    storageGet<RefreshCredential>("local", REFRESH_KEY),
    readSettings(),
  ]);
  try {
    const accessMatches = storedAccess?.apiBaseUrl === settings.apiBaseUrl;
    const refreshMatches = refresh?.apiBaseUrl === settings.apiBaseUrl;
    const accessToken =
      (accessMatches ? storedAccess.token : undefined) ??
      (!refreshMatches ? undefined : await getAccessToken().catch(() => undefined));
    if (accessToken != null || refreshMatches) {
      await fetch(`${settings.apiBaseUrl}/v1/auth/logout`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(accessToken == null ? {} : { authorization: `Bearer ${accessToken}` }),
        },
        body: JSON.stringify(refreshMatches ? { refreshToken: refresh.token } : {}),
      });
    }
  } finally {
    await clearCredentials();
  }
}
