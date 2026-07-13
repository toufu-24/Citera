import { extractDocumentMetadata } from "./extractor";

import type { ContentExtractRequest } from "../types";

const api = (globalThis as typeof globalThis & { browser?: typeof chrome }).browser ?? chrome;
const marker = "__citeraContentScriptInstalled";
const markedGlobal = globalThis as typeof globalThis & Record<string, unknown>;

if (markedGlobal[marker] !== true) {
  markedGlobal[marker] = true;
  api.runtime.onMessage.addListener(
    (
      message: ContentExtractRequest,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ): boolean | undefined => {
      if (message.type !== "CITERA_EXTRACT_PAGE") return undefined;
      try {
        sendResponse(extractDocumentMetadata(document, location.href));
      } catch (error) {
        sendResponse({
          __citeraContentError:
            error instanceof Error ? error.message : "ページのメタデータを抽出できませんでした。",
        });
      }
      return false;
    },
  );
}
