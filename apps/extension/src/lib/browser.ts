import type { ContentExtractRequest, ExtensionRequest, ProgressMessage } from "../types";

type StorageAreaName = "local" | "session" | "sync";
type RuntimeMessage = ExtensionRequest | ProgressMessage;
type RuntimeHandler = (
  message: ExtensionRequest,
  sender: chrome.runtime.MessageSender,
) => Promise<unknown>;

const extensionApi =
  (globalThis as typeof globalThis & { browser?: typeof chrome }).browser ??
  (globalThis as typeof globalThis & { chrome?: typeof chrome }).chrome;

function storageArea(name: StorageAreaName): chrome.storage.StorageArea {
  const area = extensionApi.storage[name];
  if (area == null) throw new Error(`storage.${name} is unavailable in this browser`);
  return area;
}

function runtimeErrorMessage(): string | undefined {
  return extensionApi.runtime.lastError?.message;
}

export async function storageGet<T>(area: StorageAreaName, key: string): Promise<T | undefined> {
  const result = await storageArea(area).get(key);
  return result[key] as T | undefined;
}

export async function storageSet<T>(area: StorageAreaName, key: string, value: T): Promise<void> {
  await storageArea(area).set({ [key]: value });
}

export async function storageRemove(area: StorageAreaName, keys: string | string[]): Promise<void> {
  await storageArea(area).remove(keys);
}

export async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await extensionApi.tabs.query({ active: true, currentWindow: true });
  if (tab == null || tab.id == null) throw new Error("アクティブなタブを取得できませんでした。");
  return tab;
}

export async function injectContentScript(tabId: number): Promise<void> {
  await extensionApi.scripting.executeScript({
    target: { tabId },
    files: ["content-script.js"],
  });
}

export async function sendTabExtractMessage(tabId: number): Promise<unknown> {
  const message: ContentExtractRequest = { type: "CITERA_EXTRACT_PAGE" };
  return extensionApi.tabs.sendMessage(tabId, message);
}

export async function sendRuntimeMessage<T>(message: ExtensionRequest): Promise<T> {
  const response = (await extensionApi.runtime.sendMessage(message)) as unknown;
  if (response != null && typeof response === "object" && "__citeraError" in response) {
    const errorMessage = (response as { __citeraError?: unknown }).__citeraError;
    throw new Error(typeof errorMessage === "string" ? errorMessage : "Unknown extension error");
  }
  return response as T;
}

export async function broadcastProgress(message: ProgressMessage): Promise<void> {
  try {
    await extensionApi.runtime.sendMessage(message as RuntimeMessage);
  } catch {
    // The popup may close while a save continues; progress delivery is best-effort.
  }
}

export function onRuntimeMessage(handler: RuntimeHandler): () => void {
  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): true => {
    void Promise.resolve(handler(message as ExtensionRequest, sender)).then(
      (response) => sendResponse(response),
      (error: unknown) =>
        sendResponse({
          __citeraError: error instanceof Error ? error.message : "Unknown extension error",
        }),
    );
    return true;
  };
  extensionApi.runtime.onMessage.addListener(listener);
  return () => extensionApi.runtime.onMessage.removeListener(listener);
}

export function onProgressMessage(listener: (message: ProgressMessage) => void): () => void {
  const runtimeListener = (message: unknown): void => {
    const candidate = message as Partial<ProgressMessage>;
    if (candidate.type === "SAVE_PROGRESS" && candidate.stage != null && candidate.detail != null) {
      listener(candidate as ProgressMessage);
    }
  };
  extensionApi.runtime.onMessage.addListener(runtimeListener);
  return () => extensionApi.runtime.onMessage.removeListener(runtimeListener);
}

export function getRedirectUrl(path = "oauth2"): string {
  return extensionApi.identity.getRedirectURL(path);
}

export async function launchWebAuthFlow(url: string): Promise<string> {
  const redirectUrl = await extensionApi.identity.launchWebAuthFlow({ url, interactive: true });
  if (redirectUrl == null) {
    throw new Error(runtimeErrorMessage() ?? "認証プロバイダから応答がありませんでした。");
  }
  return redirectUrl;
}

export function originPattern(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.hostname}/*`;
}

export async function hasOriginPermission(value: string): Promise<boolean> {
  return extensionApi.permissions.contains({ origins: [originPattern(value)] });
}

export async function requestOriginPermissions(values: string[]): Promise<boolean> {
  const origins = [...new Set(values.map(originPattern))];
  if (origins.length === 0) return true;
  return extensionApi.permissions.request({ origins });
}

export async function openOptionsPage(): Promise<void> {
  await extensionApi.runtime.openOptionsPage();
}

export async function createNotification(
  id: string,
  title: string,
  message: string,
): Promise<void> {
  await extensionApi.notifications.create(id, {
    type: "basic",
    iconUrl: extensionApi.runtime.getURL("icons/icon-128.png"),
    title,
    message,
  });
}
