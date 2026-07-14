import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
  TextLayer as PdfTextLayer,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Maximize2,
  Minimize2,
  Minus,
  PanelRight,
  Plus,
  RotateCcw,
  RotateCw,
} from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";

import { api, shouldSendCredentials } from "../lib/api";

type PdfViewMode = "fit-width" | "fit-page" | "actual" | "custom";

interface PdfViewerProps {
  fileId: string | null;
  title: string;
  page?: number;
  onPageChange?: (page: number) => void;
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
  focusMode?: boolean;
  onToggleFocus?: () => void;
  fullscreenTargetRef?: RefObject<HTMLElement | null>;
}

interface PageDimensions {
  pageNumber: number;
  width: number;
  height: number;
}

interface StageMetrics {
  width: number;
  height: number;
  paddingX: number;
  paddingY: number;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const VIEW_MODE_STORAGE_KEY = "citera.pdf.view-mode";
const SCALE_STORAGE_KEY = "citera.pdf.scale";
const VIRTUAL_PAGE_RADIUS = 3;
const PAGE_LABEL_HEIGHT = 0;

function readStoredMode(): PdfViewMode {
  try {
    const value = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return value === "fit-page" || value === "actual" || value === "custom" ? value : "fit-width";
  } catch {
    return "fit-width";
  }
}

function readStoredScale(): number {
  try {
    const storedValue = window.localStorage.getItem(SCALE_STORAGE_KEY);
    if (storedValue === null) return 1;
    const value = Number(storedValue);
    return Number.isFinite(value) ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, value)) : 1;
  } catch {
    return 1;
  }
}

function storePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Local preferences are optional and can be unavailable in private contexts.
  }
}

function rotatedPageDimensions(dimensions: PageDimensions, rotation: number): PageDimensions {
  return rotation % 180 === 0
    ? dimensions
    : { ...dimensions, width: dimensions.height, height: dimensions.width };
}

function pageScale(
  dimensions: PageDimensions,
  rotation: number,
  viewMode: PdfViewMode,
  customScale: number,
  availableWidth: number,
  availableHeight: number,
): number {
  const rotated = rotatedPageDimensions(dimensions, rotation);
  const calculated =
    viewMode === "fit-width"
      ? availableWidth / rotated.width
      : viewMode === "fit-page"
        ? Math.min(availableWidth / rotated.width, availableHeight / rotated.height)
        : viewMode === "actual"
          ? 1
          : customScale;
  return viewMode === "custom"
    ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, calculated))
    : Math.max(0.01, calculated);
}

function PdfPageCanvas({
  documentHandle,
  pageNumber,
  scale,
  rotation,
  title,
}: {
  documentHandle: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  rotation: number;
  title: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [renderError, setRenderError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | undefined;
    let textLayer: PdfTextLayer | undefined;
    setRenderError(false);
    void documentHandle
      .getPage(pageNumber)
      .then((pdfPage) => {
        if (cancelled || !canvasRef.current || !textLayerRef.current) return;
        const pixelRatio = window.devicePixelRatio || 1;
        const viewport = pdfPage.getViewport({ scale, rotation });
        const canvas = canvasRef.current;
        const textLayerElement = textLayerRef.current;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D is not available");
        canvas.width = Math.round(viewport.width * pixelRatio);
        canvas.height = Math.round(viewport.height * pixelRatio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        textLayerElement.replaceChildren();
        textLayerElement.style.setProperty("--total-scale-factor", String(scale));
        textLayerElement.style.setProperty("--scale-factor", String(scale));
        renderTask = pdfPage.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        const textContentPromise = pdfPage
          .getTextContent()
          .then(async (textContent) => {
            if (cancelled) return;
            const { TextLayer } = await import("pdfjs-dist");
            textLayer = new TextLayer({
              textContentSource: textContent,
              container: textLayerElement,
              viewport,
            });
            await textLayer.render();
          })
          .catch(() => undefined);
        return Promise.all([renderTask.promise, textContentPromise]);
      })
      .catch((error: unknown) => {
        if (
          !cancelled &&
          !(error instanceof Error && error.name === "RenderingCancelledException")
        ) {
          setRenderError(true);
        }
      });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      textLayerRef.current?.replaceChildren();
    };
  }, [documentHandle, pageNumber, rotation, scale]);

  if (renderError) {
    return <span className="pdf-page-render-error">このページを描画できませんでした。</span>;
  }
  return (
    <>
      <canvas ref={canvasRef} role="img" aria-label={`${title}、${pageNumber} ページ目`} />
      <div ref={textLayerRef} className="pdf-text-layer" aria-label="本文テキスト" />
    </>
  );
}

export function PdfViewer({
  fileId,
  title,
  page: controlledPage,
  onPageChange,
  inspectorOpen = true,
  onToggleInspector,
  focusMode = false,
  onToggleFocus,
  fullscreenTargetRef,
}: PdfViewerProps) {
  const viewerRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pageElementsRef = useRef(new Map<number, HTMLElement>());
  const intersectionAreasRef = useRef(new Map<number, number>());
  const currentPageRef = useRef(controlledPage ?? 1);
  const lastControlledPageRef = useRef(controlledPage);
  const [url, setUrl] = useState<string | null>(null);
  const [documentHandle, setDocumentHandle] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(controlledPage ?? 1);
  const [pageCount, setPageCount] = useState(0);
  const [viewMode, setViewMode] = useState<PdfViewMode>(readStoredMode);
  const [customScale, setCustomScale] = useState(readStoredScale);
  const [rotation, setRotation] = useState(0);
  const [pageDimensions, setPageDimensions] = useState<PageDimensions[]>([]);
  const [stageMetrics, setStageMetrics] = useState<StageMetrics>({
    width: 0,
    height: 0,
    paddingX: 0,
    paddingY: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [editingZoom, setEditingZoom] = useState(false);
  const [zoomDraft, setZoomDraft] = useState("100");
  const [editingPage, setEditingPage] = useState(false);
  const [pageDraft, setPageDraft] = useState("1");
  const [isFullscreen, setIsFullscreen] = useState(false);
  currentPageRef.current = page;

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(
        document.fullscreenElement === (fullscreenTargetRef?.current ?? viewerRef.current),
      );
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, [fullscreenTargetRef]);

  useEffect(() => {
    const controlledPageChanged = controlledPage !== lastControlledPageRef.current;
    lastControlledPageRef.current = controlledPage;
    if (controlledPage && controlledPageChanged && controlledPage !== currentPageRef.current) {
      setPage(controlledPage);
      window.requestAnimationFrame(() => {
        pageElementsRef.current.get(controlledPage)?.scrollIntoView({ block: "start" });
      });
    }
  }, [controlledPage]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const measure = () => {
      const styles = window.getComputedStyle(stage);
      setStageMetrics({
        width: stage.clientWidth,
        height: stage.clientHeight,
        paddingX: Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight),
        paddingY: Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom),
      });
    };

    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [fileId]);

  useEffect(() => {
    storePreference(VIEW_MODE_STORAGE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    storePreference(SCALE_STORAGE_KEY, String(customScale));
  }, [customScale]);

  useEffect(() => {
    setPage(controlledPage ?? 1);
    setPageCount(0);
    setDocumentHandle(null);
    setPageDimensions([]);
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
    if (pageCount > 0 && page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const availableWidth = Math.max(1, stageMetrics.width - stageMetrics.paddingX);
  const availableHeight = Math.max(
    1,
    stageMetrics.height - stageMetrics.paddingY - PAGE_LABEL_HEIGHT,
  );
  const currentDimensions = pageDimensions[page - 1] ?? pageDimensions[0];
  const effectiveScale = currentDimensions
    ? pageScale(currentDimensions, rotation, viewMode, customScale, availableWidth, availableHeight)
    : viewMode === "custom"
      ? customScale
      : 1;

  useEffect(() => {
    if (!documentHandle) return;
    let cancelled = false;
    void Promise.all(
      Array.from({ length: documentHandle.numPages }, async (_, index) => {
        const pageNumber = index + 1;
        const pdfPage = await documentHandle.getPage(pageNumber);
        const viewport = pdfPage.getViewport({ scale: 1, rotation: 0 });
        return { pageNumber, width: viewport.width, height: viewport.height };
      }),
    )
      .then((dimensions) => {
        if (!cancelled) setPageDimensions(dimensions);
      })
      .catch(() => {
        if (!cancelled) setError("PDFのページ情報を読み込めませんでした。");
      });
    return () => {
      cancelled = true;
    };
  }, [documentHandle]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || pageDimensions.length !== pageCount || pageCount === 0) return;
    intersectionAreasRef.current.clear();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNumber = Number((entry.target as HTMLElement).dataset.pageNumber);
          intersectionAreasRef.current.set(
            pageNumber,
            entry.isIntersecting ? entry.intersectionRect.width * entry.intersectionRect.height : 0,
          );
        }
        let mostVisiblePage = 0;
        let largestArea = 0;
        for (const [pageNumber, area] of intersectionAreasRef.current) {
          if (area > largestArea) {
            mostVisiblePage = pageNumber;
            largestArea = area;
          }
        }
        if (mostVisiblePage > 0) setPage(mostVisiblePage);
      },
      { root: stage, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
    );
    for (const element of pageElementsRef.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [pageCount, pageDimensions]);

  function scrollToPage(nextPage: number) {
    const targetPage = Math.min(pageCount || 1, Math.max(1, nextPage));
    setPage(targetPage);
    window.requestAnimationFrame(() => {
      pageElementsRef.current.get(targetPage)?.scrollIntoView({ block: "start" });
    });
  }

  function preservePageAfterLayoutChange(change: () => void) {
    const targetPage = currentPageRef.current;
    change();
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        pageElementsRef.current.get(targetPage)?.scrollIntoView({ block: "start" });
      });
    });
  }

  function handleZoomWheel(event: React.WheelEvent<HTMLDivElement>) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.1 : 0.9;
    preservePageAfterLayoutChange(() => {
      setCustomScale(
        Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(effectiveScale * factor * 100) / 100)),
      );
      setViewMode("custom");
    });
  }

  useEffect(() => {
    onPageChange?.(page);
  }, [onPageChange, page]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isFormField = target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if (isFormField) return;

      const stageFocused = Boolean(
        stageRef.current &&
        document.activeElement &&
        stageRef.current.contains(document.activeElement),
      );
      if (stageFocused && event.key === "PageDown") {
        scrollToPage(currentPageRef.current + 1);
        event.preventDefault();
        return;
      }
      if (stageFocused && event.key === "PageUp") {
        scrollToPage(currentPageRef.current - 1);
        event.preventDefault();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && (event.key === "+" || event.key === "=")) {
        preservePageAfterLayoutChange(() => {
          setCustomScale(Math.min(MAX_SCALE, Math.round((effectiveScale + 0.1) * 100) / 100));
          setViewMode("custom");
        });
        event.preventDefault();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && (event.key === "-" || event.key === "_")) {
        preservePageAfterLayoutChange(() => {
          setCustomScale(Math.max(MIN_SCALE, Math.round((effectiveScale - 0.1) * 100) / 100));
          setViewMode("custom");
        });
        event.preventDefault();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "0") {
        preservePageAfterLayoutChange(() => setViewMode("fit-width"));
        event.preventDefault();
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "f") {
        toggleFullscreen();
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [effectiveScale, focusMode, onToggleFocus, pageCount]);

  function adjustScale(delta: number) {
    preservePageAfterLayoutChange(() => {
      setCustomScale(
        Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round((effectiveScale + delta) * 100) / 100)),
      );
      setViewMode("custom");
    });
  }

  function commitZoom() {
    const parsed = Number(zoomDraft) / 100;
    if (Number.isFinite(parsed)) {
      preservePageAfterLayoutChange(() => {
        setCustomScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, parsed)));
        setViewMode("custom");
      });
    }
    setEditingZoom(false);
  }

  function commitPage() {
    const parsed = Number.parseInt(pageDraft, 10);
    if (Number.isFinite(parsed)) {
      scrollToPage(parsed);
    }
    setEditingPage(false);
  }

  function toggleFullscreen() {
    const fullscreenTarget = fullscreenTargetRef?.current ?? viewerRef.current;
    if (!fullscreenTarget) return;
    if (document.fullscreenElement === fullscreenTarget) {
      void document.exitFullscreen();
      return;
    }
    if (focusMode && onToggleFocus && !document.fullscreenElement && !fullscreenTargetRef) {
      onToggleFocus();
      return;
    }
    if (fullscreenTarget.requestFullscreen) {
      void fullscreenTarget
        .requestFullscreen({ navigationUI: "hide" })
        .catch(() => onToggleFocus?.());
      return;
    }
    onToggleFocus?.();
  }

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
      ref={viewerRef}
      className="pdf-viewer"
      aria-label={`${title} の PDF`}
      aria-busy={!documentHandle && !error}
    >
      <div className="pdf-toolbar">
        <div className="page-controls" aria-label="ページ移動">
          <button
            type="button"
            className="icon-button"
            onClick={() => scrollToPage(page - 1)}
            disabled={page <= 1}
            aria-label="前のページ"
            title="前のページ (PageUp)"
          >
            <ChevronLeft size={18} />
          </button>
          <span>
            <input
              type="number"
              min={1}
              max={pageCount || 1}
              value={editingPage ? pageDraft : page}
              onFocus={() => {
                setPageDraft(String(page));
                setEditingPage(true);
              }}
              onChange={(event) => setPageDraft(event.currentTarget.value)}
              onBlur={commitPage}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitPage();
                }
              }}
              aria-label="ページ番号"
              title="ページ番号を入力して Enter"
            />{" "}
            / <span aria-live="polite">{pageCount || "—"}</span>
          </span>
          <button
            type="button"
            className="icon-button"
            onClick={() => scrollToPage(page + 1)}
            disabled={!pageCount || page >= pageCount}
            aria-label="次のページ"
            title="次のページ (PageDown)"
          >
            <ChevronRight size={18} />
          </button>
        </div>
        <div className="zoom-controls" aria-label="PDF表示倍率">
          <button
            type="button"
            className="icon-button"
            onClick={() => adjustScale(-0.1)}
            aria-label="縮小"
            title="縮小 (Ctrl/Cmd −)"
          >
            <Minus size={17} />
          </button>
          <input
            className="zoom-value"
            type="number"
            min={25}
            max={400}
            step={1}
            value={editingZoom ? zoomDraft : Math.round(effectiveScale * 100)}
            readOnly={!editingZoom}
            onClick={() => {
              setZoomDraft(String(Math.round(effectiveScale * 100)));
              setEditingZoom(true);
            }}
            onChange={(event) => setZoomDraft(event.currentTarget.value)}
            onBlur={commitZoom}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitZoom();
              }
            }}
            aria-label="倍率（％）"
            title="クリックして倍率を入力"
          />
          <span aria-hidden="true">%</span>
          <button
            type="button"
            className="icon-button"
            onClick={() => adjustScale(0.1)}
            aria-label="拡大"
            title="拡大 (Ctrl/Cmd ＋)"
          >
            <Plus size={17} />
          </button>
          <button
            type="button"
            className={`toolbar-mode-button ${viewMode === "fit-width" ? "active" : ""}`}
            onClick={() => preservePageAfterLayoutChange(() => setViewMode("fit-width"))}
            aria-pressed={viewMode === "fit-width"}
            aria-label="幅に合わせる"
            title="幅に合わせる (Ctrl/Cmd 0)"
          >
            幅
          </button>
          <button
            type="button"
            className={`toolbar-mode-button ${viewMode === "fit-page" ? "active" : ""}`}
            onClick={() => preservePageAfterLayoutChange(() => setViewMode("fit-page"))}
            aria-pressed={viewMode === "fit-page"}
            aria-label="ページ全体"
            title="ページ全体"
          >
            全体
          </button>
          <button
            type="button"
            className={`toolbar-mode-button ${viewMode === "actual" ? "active" : ""}`}
            onClick={() => preservePageAfterLayoutChange(() => setViewMode("actual"))}
            aria-pressed={viewMode === "actual"}
            aria-label="実寸"
            title="実寸"
          >
            実寸
          </button>
        </div>
        <div className="pdf-toolbar-actions">
          <button
            type="button"
            className="icon-button"
            onClick={() =>
              preservePageAfterLayoutChange(() => setRotation((value) => (value + 90) % 360))
            }
            aria-label="90度回転"
            title="90度回転"
          >
            <RotateCw size={17} />
          </button>
          {onToggleInspector && (
            <button
              type="button"
              className={`icon-button ${inspectorOpen ? "active" : ""}`}
              onClick={onToggleInspector}
              aria-label={inspectorOpen ? "情報パネルを閉じる" : "情報パネルを開く"}
              title={inspectorOpen ? "情報パネルを閉じる" : "情報パネルを開く"}
            >
              <PanelRight size={17} />
            </button>
          )}
          <button
            type="button"
            className={`icon-button ${isFullscreen ? "active" : ""}`}
            onClick={toggleFullscreen}
            aria-label={isFullscreen || focusMode ? "全画面表示を終了" : "全画面表示"}
            title={isFullscreen || focusMode ? "全画面表示を終了 (F)" : "全画面表示 (F)"}
          >
            {isFullscreen || focusMode ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
          {url && (
            <a
              className="icon-button"
              href={url}
              download={`${title}.pdf`}
              aria-label="PDFをダウンロード"
              title="PDFをダウンロード"
            >
              <Download size={17} />
            </a>
          )}
        </div>
      </div>
      <div
        ref={stageRef}
        className="pdf-stage"
        tabIndex={0}
        aria-label="PDF表示領域"
        onWheel={handleZoomWheel}
      >
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
        ) : !documentHandle || pageDimensions.length !== pageCount || stageMetrics.width === 0 ? (
          <div className="loading-state">
            <span className="spinner" />
            <p>{documentHandle ? "ページを準備しています…" : "PDFを開いています…"}</p>
          </div>
        ) : (
          <div className="pdf-pages" aria-label={`${pageCount}ページの連続表示`}>
            {pageDimensions.map((dimensions) => {
              const scale = pageScale(
                dimensions,
                rotation,
                viewMode,
                customScale,
                availableWidth,
                availableHeight,
              );
              const rotated = rotatedPageDimensions(dimensions, rotation);
              const displayWidth = rotated.width * scale;
              const displayHeight = rotated.height * scale;
              const shouldRender = Math.abs(dimensions.pageNumber - page) <= VIRTUAL_PAGE_RADIUS;
              return (
                <section
                  key={dimensions.pageNumber}
                  ref={(element) => {
                    if (element) pageElementsRef.current.set(dimensions.pageNumber, element);
                    else pageElementsRef.current.delete(dimensions.pageNumber);
                  }}
                  className={`pdf-page-shell ${dimensions.pageNumber === page ? "current" : ""}`}
                  data-page-number={dimensions.pageNumber}
                  aria-label={`ページ ${dimensions.pageNumber} / ${pageCount}`}
                  style={{ width: displayWidth }}
                >
                  <span className="sr-only">ページ {dimensions.pageNumber} の始まり</span>
                  <div
                    className={`pdf-page-surface ${shouldRender ? "rendered" : "virtual"}`}
                    style={{ width: displayWidth, height: displayHeight }}
                  >
                    {shouldRender ? (
                      <PdfPageCanvas
                        documentHandle={documentHandle}
                        pageNumber={dimensions.pageNumber}
                        scale={scale}
                        rotation={rotation}
                        title={title}
                      />
                    ) : (
                      <span className="pdf-page-placeholder" aria-hidden="true" />
                    )}
                  </div>
                  <span className="pdf-page-number">p. {dimensions.pageNumber}</span>
                  <span className="sr-only">ページ {dimensions.pageNumber} の終わり</span>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
