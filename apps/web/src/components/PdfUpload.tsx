import { CheckCircle2, FileUp, LoaderCircle, X } from "lucide-react";
import { useRef, useState } from "react";

import { api, shouldSendCredentials } from "../lib/api";

interface PdfUploadProps {
  paperId: string;
  onComplete: () => void;
}

function toHex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function PdfUpload({ paperId, onComplete }: PdfUploadProps) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState(0);
  const [retryFile, setRetryFile] = useState<File | null>(null);
  const [state, setState] = useState<
    "idle" | "hashing" | "uploading" | "verifying" | "done" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [fileKind, setFileKind] = useState<"fulltext" | "translation" | "bilingual" | "supplement" | "other">("fulltext");
  const [languageCode, setLanguageCode] = useState("");
  const [label, setLabel] = useState("");
  const [isDefault, setIsDefault] = useState(false);

  async function upload(file: File) {
    setRetryFile(file);
    setError(null);
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setState("error");
      setError("PDF ファイルを選択してください。");
      return;
    }
    if (file.size === 0) {
      setState("error");
      setError("空のファイルはアップロードできません。");
      return;
    }
    try {
      setState("hashing");
      setProgress(12);
      const sha256 = toHex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
      const ticket = await api.uploadUrl(paperId, {
        sizeBytes: file.size,
        mediaType: "application/pdf",
        sha256,
        originalName: file.name,
        fileKind,
        languageCode: languageCode || null,
        label: label.trim() || null,
        isDefault,
      });
      if (ticket.duplicate && ticket.uploadState === "verified") {
        setProgress(100);
        setState("done");
        setRetryFile(null);
        onComplete();
        return;
      }
      if (ticket.duplicate && ticket.uploadState === "uploaded") {
        setProgress(82);
        setState("verifying");
        await api.completeUpload(ticket.fileId);
        setProgress(100);
        setState("done");
        setRetryFile(null);
        onComplete();
        return;
      }
      if (!ticket.uploadUrl) throw new Error("The existing upload cannot be resumed");
      setState("uploading");
      setProgress(45);
      const response = await fetch(ticket.uploadUrl, {
        method: "PUT",
        headers: ticket.headers,
        body: file,
        credentials: shouldSendCredentials(ticket.uploadUrl) ? "include" : "omit",
      });
      if (!response.ok) throw new Error(`Upload failed (${response.status})`);
      setProgress(82);
      setState("verifying");
      await api.completeUpload(ticket.fileId);
      setProgress(100);
      setState("done");
      setRetryFile(null);
      onComplete();
    } catch {
      setState("error");
      setError("アップロードを完了できませんでした。接続を確認して再試行してください。");
    }
  }

  return (
    <div className={`pdf-upload upload-${state}`}>
      <input
        ref={input}
        hidden
        type="file"
        accept="application/pdf,.pdf"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.currentTarget.value = "";
          if (file) void upload(file);
        }}
      />
      {state === "idle" || state === "error" ? (
        <>
          <div className="pdf-upload-options">
            <select value={fileKind} onChange={(event) => setFileKind(event.target.value as typeof fileKind)} aria-label="PDFの種類">
              <option value="fulltext">本文</option>
              <option value="translation">翻訳版</option>
              <option value="bilingual">対訳版</option>
              <option value="supplement">補足資料</option>
              <option value="other">その他</option>
            </select>
            <select value={languageCode} onChange={(event) => setLanguageCode(event.target.value)} aria-label="PDFの言語">
              <option value="">言語未設定</option>
              <option value="ja">日本語</option>
              <option value="en">英語</option>
              <option value="de">ドイツ語</option>
              <option value="fr">フランス語</option>
              <option value="zh-Hans">中国語（簡体）</option>
              <option value="zh-Hant">中国語（繁体）</option>
            </select>
            <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="表示名（任意）" aria-label="PDFの表示名" />
            <label>
              <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} /> 既定
            </label>
          </div>
          <button
            type="button"
            className="button secondary compact"
            onClick={() => input.current?.click()}
          >
            <FileUp size={16} /> PDFを追加
          </button>
        </>
      ) : (
        <div className="upload-progress">
          <span aria-live="polite">
            {state === "done" ? (
              <CheckCircle2 size={16} />
            ) : (
              <LoaderCircle className="spin" size={16} />
            )}
            {state === "hashing"
              ? "検証準備"
              : state === "uploading"
                ? "アップロード中"
                : state === "verifying"
                  ? "PDFを検証中"
                  : "完了"}
          </span>
          <div
            role="progressbar"
            aria-label="PDF アップロード"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <i style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}
      {error && (
        <>
          <div className="inline-error" role="alert">
            <X size={14} />
            {error}
          </div>
          {retryFile && (
            <button type="button" className="text-button" onClick={() => void upload(retryFile)}>
              再試行
            </button>
          )}
        </>
      )}
    </div>
  );
}
