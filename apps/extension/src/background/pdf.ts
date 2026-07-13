import { isSameRemoteOrigin, parseSafeRemoteUrl, resolveSafeRemoteUrl } from "../lib/remote-url";

const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface DownloadedPdf {
  bytes: Uint8Array;
  sha256: string;
  mediaType: "application/pdf";
  originalName: string;
}

export interface DownloadPdfOptions {
  pageUrl: string;
  allowCrossOrigin: boolean;
  timeoutMs?: number;
}

function safeFileName(url: string, contentDisposition: string | null): string {
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(contentDisposition ?? "")?.[1];
  const plain = /filename="?([^";]+)"?/iu.exec(contentDisposition ?? "")?.[1];
  let candidate = encoded == null ? plain : decodeURIComponent(encoded);
  if (candidate == null || candidate.trim() === "") {
    try {
      candidate = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "paper.pdf");
    } catch {
      candidate = "paper.pdf";
    }
  }
  const sanitized = [...candidate]
    .map((character) =>
      character.codePointAt(0) != null && character.codePointAt(0)! < 32
        ? "_"
        : character.replace(/[\\/:*?"<>|]/gu, "_"),
    )
    .join("")
    .slice(0, 180);
  return sanitized.toLowerCase().endsWith(".pdf") ? sanitized : `${sanitized}.pdf`;
}

async function readWithLimit(response: Response): Promise<Uint8Array> {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_PDF_BYTES) {
    throw new Error("PDFが100 MBの拡張機能上限を超えています。");
  }
  if (response.body == null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PDF_BYTES)
      throw new Error("PDFが100 MBの拡張機能上限を超えています。");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PDF_BYTES) {
      await reader.cancel();
      throw new Error("PDFが100 MBの拡張機能上限を超えています。");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertRetrievalAllowed(pageUrl: URL, targetUrl: URL, allowCrossOrigin: boolean): boolean {
  const sameOrigin = isSameRemoteOrigin(pageUrl, targetUrl);
  if (!sameOrigin && !allowCrossOrigin) {
    throw new Error("別サイトのPDFを取得するには、ポップアップで明示的な許可が必要です。");
  }
  return sameOrigin;
}

async function fetchPdfResponse(
  url: string,
  options: DownloadPdfOptions,
): Promise<{ response: Response; finalUrl: URL }> {
  const pageUrl = parseSafeRemoteUrl(options.pageUrl, "ページURL");
  let targetUrl = parseSafeRemoteUrl(url, "PDF URL");
  const signal = AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const sameOrigin = assertRetrievalAllowed(pageUrl, targetUrl, options.allowCrossOrigin);
    const response = await fetch(targetUrl.toString(), {
      cache: "no-store",
      credentials: sameOrigin ? "include" : "omit",
      redirect: "manual",
      referrerPolicy: "no-referrer",
      signal,
      headers: { accept: "application/pdf,application/octet-stream;q=0.8" },
    });

    if (response.type === "opaqueredirect") {
      throw new Error(
        "安全性を確認できないPDFリダイレクトを拒否しました。PDFを直接開いて再度お試しください。",
      );
    }
    if (!REDIRECT_STATUSES.has(response.status)) {
      const responseUrl = response.url.trim();
      if (responseUrl !== "") {
        const validatedResponseUrl = parseSafeRemoteUrl(responseUrl, "PDF応答URL");
        assertRetrievalAllowed(pageUrl, validatedResponseUrl, options.allowCrossOrigin);
        targetUrl = validatedResponseUrl;
      }
      return { response, finalUrl: targetUrl };
    }
    if (redirects === MAX_REDIRECTS) {
      throw new Error("PDFのリダイレクト回数が上限を超えました。");
    }
    const location = response.headers.get("location");
    if (location == null || location.trim() === "") {
      throw new Error("安全性を確認できないPDFリダイレクトを拒否しました。");
    }
    targetUrl = resolveSafeRemoteUrl(location, targetUrl.toString(), "PDFリダイレクト先");
    assertRetrievalAllowed(pageUrl, targetUrl, options.allowCrossOrigin);
  }

  throw new Error("PDFのリダイレクトを処理できませんでした。");
}

export async function downloadPdf(
  url: string,
  options: DownloadPdfOptions,
): Promise<DownloadedPdf> {
  const { response, finalUrl } = await fetchPdfResponse(url, options);
  if (!response.ok)
    throw new Error(`閲覧セッションでPDFを取得できませんでした (${response.status})。`);
  const bytes = await readWithLimit(response);
  if (
    bytes.byteLength < 5 ||
    bytes[0] !== 0x25 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x44 ||
    bytes[3] !== 0x46 ||
    bytes[4] !== 0x2d
  ) {
    throw new Error("取得したファイルはPDFマジックバイトを持っていません。");
  }
  const digestInput = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(digestInput).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return {
    bytes,
    sha256: hex(new Uint8Array(digest)),
    mediaType: "application/pdf",
    originalName: safeFileName(finalUrl.toString(), response.headers.get("content-disposition")),
  };
}
