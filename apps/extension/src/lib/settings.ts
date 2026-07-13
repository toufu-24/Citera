import type { PaperStatus } from "@citera/domain";

import type { ExtensionSettings } from "../types";
import { storageGet, storageSet } from "./browser";

const SETTINGS_KEY = "citera.settings.v1";
const PAPER_STATUSES: readonly PaperStatus[] = ["inbox", "reading", "read", "archived"];

const buildDefaultApiUrl = import.meta.env.VITE_API_BASE_URL?.trim();

export const DEFAULT_SETTINGS: ExtensionSettings = {
  apiBaseUrl:
    buildDefaultApiUrl === "" || buildDefaultApiUrl == null
      ? "http://127.0.0.1:8787"
      : buildDefaultApiUrl.replace(/\/$/u, ""),
  defaultStatus: "inbox",
  includePdfByDefault: true,
  notificationsEnabled: true,
};

export function normalizeApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("API URLを正しいURL形式で入力してください。");
  }

  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("APIにはHTTPSを使用してください（ローカル開発のloopback HTTPを除く）。");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("API URLにユーザー名やパスワードを含めることはできません。");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/u, "");
}

export async function readSettings(): Promise<ExtensionSettings> {
  const saved = await storageGet<Partial<ExtensionSettings>>("sync", SETTINGS_KEY);
  if (saved == null) return DEFAULT_SETTINGS;
  return {
    apiBaseUrl:
      typeof saved.apiBaseUrl === "string"
        ? normalizeApiBaseUrl(saved.apiBaseUrl)
        : DEFAULT_SETTINGS.apiBaseUrl,
    defaultStatus: PAPER_STATUSES.some((status) => status === saved.defaultStatus)
      ? (saved.defaultStatus as PaperStatus)
      : DEFAULT_SETTINGS.defaultStatus,
    includePdfByDefault:
      typeof saved.includePdfByDefault === "boolean"
        ? saved.includePdfByDefault
        : DEFAULT_SETTINGS.includePdfByDefault,
    notificationsEnabled:
      typeof saved.notificationsEnabled === "boolean"
        ? saved.notificationsEnabled
        : DEFAULT_SETTINGS.notificationsEnabled,
  };
}

export async function writeSettings(settings: ExtensionSettings): Promise<void> {
  const validated: ExtensionSettings = {
    ...settings,
    apiBaseUrl: normalizeApiBaseUrl(settings.apiBaseUrl),
    defaultStatus: PAPER_STATUSES.includes(settings.defaultStatus)
      ? settings.defaultStatus
      : DEFAULT_SETTINGS.defaultStatus,
  };
  await storageSet("sync", SETTINGS_KEY, validated);
}
