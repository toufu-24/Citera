import type {
  ExtensionRequest,
  PageMetadata,
  SavePaperInput,
  SavePaperResult,
  SaveStage,
} from "../types";
import {
  completeFileUpload,
  completeIngestion,
  createIngestion,
  createUploadTicket,
  discardFile,
  getLibraryChoices,
  uploadToSignedUrl,
} from "../lib/api";
import { getAuthStatus, login, logout } from "../lib/auth";
import {
  broadcastProgress,
  createNotification,
  getActiveTab,
  injectContentScript,
  onRuntimeMessage,
  openOptionsPage,
  sendTabExtractMessage,
} from "../lib/browser";
import { parseSafeRemoteUrl } from "../lib/remote-url";
import { readSettings } from "../lib/settings";
import { downloadPdf } from "./pdf";

function fallbackMetadata(tab: chrome.tabs.Tab): PageMetadata {
  const rawPageUrl = tab.url ?? "";
  if (rawPageUrl === "") throw new Error("このタブのURLを読み取れません。");
  const pageUrl = parseSafeRemoteUrl(rawPageUrl, "ページURL").toString();
  const isPdf = /\.pdf(?:$|[?#])/iu.test(pageUrl);
  return {
    title: tab.title?.trim() || (isPdf ? "PDF" : "Untitled paper"),
    authors: [],
    pageUrl,
    ...(isPdf ? { pdfUrl: pageUrl } : {}),
    keywords: [],
    detectedSources: isPdf ? ["pdf"] : [],
    isPdf,
  };
}

function parseContentResponse(value: unknown): PageMetadata {
  if (value != null && typeof value === "object" && "__citeraContentError" in value) {
    const message = (value as { __citeraContentError?: unknown }).__citeraContentError;
    throw new Error(typeof message === "string" ? message : "ページを解析できませんでした。");
  }
  const metadata = value as Partial<PageMetadata>;
  if (
    metadata == null ||
    typeof metadata.title !== "string" ||
    typeof metadata.pageUrl !== "string"
  ) {
    throw new Error("ページ抽出スクリプトから不正な応答を受信しました。");
  }
  const pageUrl = parseSafeRemoteUrl(metadata.pageUrl, "ページURL").toString();
  if (metadata.pdfUrl != null && typeof metadata.pdfUrl !== "string") {
    throw new Error("ページ抽出スクリプトから不正なPDF URLを受信しました。");
  }
  const pdfUrl =
    metadata.pdfUrl == null ? undefined : parseSafeRemoteUrl(metadata.pdfUrl, "PDF URL").toString();
  return {
    ...(value as PageMetadata),
    pageUrl,
    ...(pdfUrl == null ? {} : { pdfUrl }),
  };
}

async function extractActivePage(): Promise<PageMetadata> {
  const tab = await getActiveTab();
  try {
    await injectContentScript(tab.id as number);
    return parseContentResponse(await sendTabExtractMessage(tab.id as number));
  } catch (error) {
    const fallback = fallbackMetadata(tab);
    if (fallback.isPdf) return fallback;
    throw error;
  }
}

async function progress(stage: SaveStage, detail: string): Promise<void> {
  await broadcastProgress({ type: "SAVE_PROGRESS", stage, detail });
}

async function maybeNotify(title: string, message: string): Promise<void> {
  const settings = await readSettings();
  if (!settings.notificationsEnabled) return;
  try {
    await createNotification(`citera-${crypto.randomUUID()}`, title, message);
  } catch {
    // Notification delivery must never turn a completed library write into a failure.
  }
}

async function savePaper(input: SavePaperInput): Promise<SavePaperResult> {
  const pageUrl = parseSafeRemoteUrl(input.metadata.pageUrl, "ページURL").toString();
  const pdfUrl =
    input.metadata.pdfUrl == null
      ? undefined
      : parseSafeRemoteUrl(input.metadata.pdfUrl, "PDF URL").toString();
  const validatedInput: SavePaperInput = {
    ...input,
    metadata: {
      ...input.metadata,
      pageUrl,
      ...(pdfUrl == null ? {} : { pdfUrl }),
    },
  };

  await progress("creating", "書誌情報をCiteraへ送信しています…");
  const ingestion = await createIngestion(validatedInput);
  if (ingestion.duplicate != null) {
    await maybeNotify("Citera — 登録済み", ingestion.duplicate.title ?? ingestion.duplicate.reason);
    return {
      outcome: "duplicate",
      reason: ingestion.duplicate.reason,
      ...(ingestion.duplicate.paperId == null ? {} : { paperId: ingestion.duplicate.paperId }),
      ...(ingestion.duplicate.title == null ? {} : { title: ingestion.duplicate.title }),
    };
  }

  let fileId: string | undefined;
  let warning: string | undefined;
  if (validatedInput.includePdf && pdfUrl != null) {
    let ticket: Awaited<ReturnType<typeof createUploadTicket>> | undefined;
    try {
      await progress("downloading-pdf", "安全性を検証しながらPDFを取得しています…");
      const pdf = await downloadPdf(pdfUrl, {
        pageUrl,
        allowCrossOrigin: validatedInput.allowCrossOriginPdf,
      });
      await progress("hashing-pdf", "PDFを検証し、SHA-256を計算しました。");
      ticket = await createUploadTicket(ingestion.paperId, ingestion.ingestionId, {
        sizeBytes: pdf.bytes.byteLength,
        mediaType: pdf.mediaType,
        sha256: pdf.sha256,
        originalName: pdf.originalName,
      });
      await progress("uploading-pdf", "署名付きURLへPDFをアップロードしています…");
      const etag = await uploadToSignedUrl(ticket, pdf.bytes);
      await completeFileUpload(ticket, etag);
      fileId = ticket.fileId;
    } catch (error) {
      if (ticket != null && !ticket.duplicate) {
        await discardFile(ticket.fileId).catch(() => undefined);
      }
      warning = `${error instanceof Error ? error.message : "PDFを保存できませんでした。"} 書誌情報のみ保存しました。PDFを直接開いて再度試すか、Citera Webから追加してください。`;
    }
  }

  await progress("finalizing", "保存処理を完了しています…");
  await completeIngestion(ingestion.ingestionId, fileId);
  await maybeNotify(
    warning == null ? "Citeraへ保存しました" : "Citeraへ書誌情報を保存しました",
    warning ?? validatedInput.metadata.title,
  );
  return {
    outcome: "saved",
    paperId: ingestion.paperId,
    ingestionId: ingestion.ingestionId,
    pdfIncluded: fileId != null,
    ...(warning == null ? {} : { warning }),
  };
}

async function handleMessage(message: ExtensionRequest): Promise<unknown> {
  switch (message.type) {
    case "AUTH_STATUS":
      return getAuthStatus();
    case "LOGIN":
      return login();
    case "LOGOUT":
      await logout();
      return undefined;
    case "OPEN_OPTIONS":
      await openOptionsPage();
      return undefined;
    case "EXTRACT_ACTIVE_PAGE":
      return extractActivePage();
    case "GET_LIBRARY_CHOICES":
      return getLibraryChoices();
    case "SAVE_PAPER":
      try {
        return await savePaper(message.input);
      } catch (error) {
        await maybeNotify(
          "Citeraへの保存に失敗しました",
          error instanceof Error ? error.message : "不明なエラーが発生しました。",
        );
        throw error;
      }
  }
}

onRuntimeMessage((message) => handleMessage(message));
