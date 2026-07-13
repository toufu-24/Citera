import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { ChevronLeft, ChevronRight, Download, Minus, Plus, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, shouldSendCredentials } from "../lib/api";

interface PdfViewerProps {
  fileId: string | null;
  title: string;
  onPageChange?: (page: number) => void;
}

export function PdfViewer({ fileId, title, onPageChange }: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [documentHandle, setDocumentHandle] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1.15);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    setPage(1);
    setPageCount(0);
    setDocumentHandle(null);
    setUrl(null);
    setError(null);
    if (!fileId) return;

    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    void api
      .downloadUrl(fileId)
      .then(async ({ url: nextUrl, headers }) => {
        if (cancelled) return;
        setUrl(nextUrl);
        const pdfjs = await import("pdfjs-dist");
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        loadingTask = pdfjs.getDocument({
          url: nextUrl,
          httpHeaders: headers,
          withCredentials: shouldSendCredentials(nextUrl),
        });
        const pdf = await loadingTask.promise;
        if (cancelled) {
          await pdf.destroy();
          return;
        }
        setDocumentHandle(pdf);
        setPageCount(pdf.numPages);
      })
      .catch(() => {
        if (!cancelled) {
          setError("PDF を読み込めませんでした。署名 URL を更新して再試行してください。");
        }
      });

    return () => {
      cancelled = true;
      if (loadingTask) void loadingTask.destroy();
    };
  }, [fileId, loadAttempt]);

  useEffect(() => {
    if (!documentHandle || !canvasRef.current) return;
    let cancelled = false;
    let renderTask: RenderTask | undefined;
    void documentHandle
      .getPage(page)
      .then((pdfPage) => {
        if (cancelled || !canvasRef.current) return;
        const pixelRatio = window.devicePixelRatio || 1;
        const viewport = pdfPage.getViewport({ scale });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D is not available");
        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        renderTask = pdfPage.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        return renderTask.promise;
      })
      .catch((renderError: unknown) => {
        if (
          !cancelled &&
          !(renderError instanceof Error && renderError.name === "RenderingCancelledException")
        ) {
          setError("このページを描画できませんでした。");
        }
      });
    onPageChange?.(page);
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [documentHandle, onPageChange, page, scale]);

  if (!fileId) {
    return (
      <div className="pdf-empty">
        <div className="pdf-empty-sheet">
          <span>PDF</span>
        </div>
        <h3>PDF はまだありません</h3>
        <p>上部の「PDFを追加」からアップロードできます。</p>
      </div>
    );
  }

  return (
    <section
      className="pdf-viewer"
      aria-label={`${title} の PDF`}
      aria-busy={!documentHandle && !error}
    >
      <div className="pdf-toolbar">
        <div className="page-controls">
          <button
            type="button"
            className="icon-button"
            onClick={() => setPage((value) => Math.max(1, value - 1))}
            disabled={page <= 1}
            aria-label="前のページ"
          >
            <ChevronLeft size={18} />
          </button>
          <span>
            <input
              type="number"
              min={1}
              max={pageCount || 1}
              value={page}
              onChange={(event) =>
                setPage(
                  Math.min(pageCount || 1, Math.max(1, event.currentTarget.valueAsNumber || 1)),
                )
              }
              aria-label="ページ番号"
            />{" "}
            / <span aria-live="polite">{pageCount || "—"}</span>
          </span>
          <button
            type="button"
            className="icon-button"
            onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
            disabled={!pageCount || page >= pageCount}
            aria-label="次のページ"
          >
            <ChevronRight size={18} />
          </button>
        </div>
        <div className="zoom-controls">
          <button
            type="button"
            className="icon-button"
            onClick={() => setScale((value) => Math.max(0.6, value - 0.15))}
            aria-label="縮小"
          >
            <Minus size={17} />
          </button>
          <span>{Math.round(scale * 100)}%</span>
          <button
            type="button"
            className="icon-button"
            onClick={() => setScale((value) => Math.min(2.4, value + 0.15))}
            aria-label="拡大"
          >
            <Plus size={17} />
          </button>
          {url && (
            <a
              className="icon-button"
              href={url}
              download={`${title}.pdf`}
              aria-label="PDFをダウンロード"
            >
              <Download size={17} />
            </a>
          )}
        </div>
      </div>
      <div className="pdf-stage">
        {error ? (
          <div className="pdf-error" role="alert">
            <p>{error}</p>
            <button
              type="button"
              className="button secondary compact"
              onClick={() => setLoadAttempt((value) => value + 1)}
            >
              <RotateCcw size={15} /> 再試行
            </button>
          </div>
        ) : !documentHandle ? (
          <div className="loading-state">
            <span className="spinner" />
            <p>PDFを開いています…</p>
          </div>
        ) : (
          <canvas ref={canvasRef} role="img" aria-label={`${title}、${page} ページ目`} />
        )}
      </div>
    </section>
  );
}
