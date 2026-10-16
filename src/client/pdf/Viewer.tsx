import { useEffect, useRef, useState } from 'react';
import {
  getDocument, GlobalWorkerOptions, PDFDataRangeTransport,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PdfManifest } from '../../shared/protocol';
import type { PdfRangeSource } from '../presentation';
import { readCompletedPdf, type CacheProgress } from './roomCache';
import { fileAccentStyle } from '../fileAccent';

GlobalWorkerOptions.workerSrc = workerUrl;
const REQUEST_CHUNK = 65_536;

/** Pure byte-range transport. The host tab handles IndexedDB and network deduplication. */
class LivePdfRanges extends PDFDataRangeTransport {
  private cancelled = false;
  private cancels = new Set<() => void>();
  constructor(
    private readonly file: PdfManifest,
    private readonly source: PdfRangeSource,
    private readonly onError: (message: string) => void,
  ) {
    // FlashView delivers random-access ranges only. No separate progressive
    // byte stream exists, so close PDF.js's full-reader immediately; otherwise
    // it can wait forever for a progressiveDone event that never arrives.
    super(file.size, null, true);
  }

  override requestDataRange(begin: number, end: number): void {
    if (this.cancelled) return;
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) ||
        begin < 0 || end <= begin || end > this.file.size) {
      this.onError('PDF.js requested an invalid byte range');
      return;
    }
    // PDF.js identifies its range reader by its ORIGINAL begin offset and
    // closes the reader after ONE onDataRange notification. A partial response
    // or multiple onDataRange(begin+offset, ...) calls permanently stall it.
    const response = new Uint8Array(end - begin);
    const cancellations = new Set<() => void>();
    const expectedChunks = Math.ceil((end - begin) / REQUEST_CHUNK);
    let receivedChunks = 0;
    let failed = false;
    const cleanUp = () => {
      for (const cancel of cancellations) this.cancels.delete(cancel);
      cancellations.clear();
    };
    const fail = (message: string) => {
      if (this.cancelled || failed) return;
      failed = true;
      for (const cancel of cancellations) cancel();
      cleanUp();
      this.onError(message);
    };
    for (let offset = begin; offset < end && !this.cancelled && !failed; offset += REQUEST_CHUNK) {
      const requestedBegin = offset;
      const requestedEnd = Math.min(offset + REQUEST_CHUNK, end);
      const cancel = this.source.requestRange(
        this.file.fileId, requestedBegin, requestedEnd,
        (start, bytes) => {
          if (this.cancelled || failed) return;
          if (start !== requestedBegin || bytes.byteLength !== requestedEnd - requestedBegin) {
            fail('Received an incomplete PDF byte range');
            return;
          }
          response.set(bytes, requestedBegin - begin);
          if (++receivedChunks === expectedChunks) {
            cleanUp();
            // Exactly one response, exactly at the begin offset PDF.js expects.
            this.onDataRange(begin, response);
          }
        },
        message => fail(message),
      );
      cancellations.add(cancel);
      this.cancels.add(cancel);
    }
  }
  override abort(): void {
    this.cancelled = true;
    for (const cancel of this.cancels) cancel();
    this.cancels.clear();
  }
}

/**
 * A viewer can be closed and reopened without re-downloading the PDF because
 * its range source is backed by the room-level IndexedDB cache.
 */
export function Viewer({ file, socket, close, cached, cachedRoomId, previewImage, onFirstPageRendered, onTiming }: {
  file: PdfManifest;
  socket: PdfRangeSource;
  close: () => void;
  cached?: CacheProgress | null;
  cachedRoomId?: string | null;
  previewImage?: string | null;
  onFirstPageRendered?: () => void;
  onTiming?: (metric: 'pdf_open_ms' | 'page_render_ms', duration: number, page?: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const reportedFirst = useRef(false);
  const renderSequence = useRef(0);
  const activeRender = useRef<ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [renderedPage, setRenderedPage] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pageAttempt, setPageAttempt] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  // A functioning partial viewer must remain visible when caching finishes.
  // Only fall back to the complete local file if the first page has NOT
  // rendered yet or a later page needs repair.
  const [sourceMode, setSourceMode] = useState<'partial' | 'full'>(
    cached?.complete ? 'full' : 'partial',
  );
  // The projector is a full-viewport canvas. Render pages at the largest
  // aspect-preserving size that fits it, then apply user-controlled zoom.
  useEffect(() => {
    const target = stage.current;
    if (!target) return;
    const measure = () => {
      const width = target.clientWidth;
      const height = target.clientHeight;
      if (!width || !height) return;
      setStageSize(previous => previous.width === width && previous.height === height
        ? previous : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const sync = () => {
      setFullscreen(document.fullscreenElement === wrapper.current);
      // The element moves into/out of the browser top layer. Some browsers
      // don't repaint an existing canvas even when its measured size stays
      // identical; request one fresh frame while retaining the old pixels.
      setPageAttempt(value => value + 1);
      // Native fullscreen transitions can change dimensions before the
      // ResizeObserver reports its next frame on Chromium/Firefox.
      requestAnimationFrame(() => {
        const element = stage.current;
        if (!element) return;
        const width = element.clientWidth;
        const height = element.clientHeight;
        if (width > 0 && height > 0)
          setStageSize(previous => previous.width === width && previous.height === height
            ? previous : { width, height });
      });
    };
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  const completeAvailable = Boolean(cached?.complete && cachedRoomId);
  useEffect(() => {
    if (completeAvailable && sourceMode === 'partial' && !reportedFirst.current) {
      setSourceMode('full');
    }
  }, [completeAvailable, sourceMode]);
  const loadingFullPdf = completeAvailable && sourceMode === 'full';

  useEffect(() => {
    let disposed = false;
    let task: ReturnType<typeof getDocument> | null = null;
    let transport: LivePdfRanges | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    setPdfDocument(null);
    setLoading(true);
    setError('');
    setRendering(false);
    reportedFirst.current = false;
    const openedAt = performance.now();

    const fail = (reason: string) => {
      if (disposed) return;
      setError(reason);
      setLoading(false);
      setRendering(false);
    };

    const run = async () => {
      try {
        let loadingTask: ReturnType<typeof getDocument>;
        const options = {
          maxImageSize: -1,
          cMapUrl: '/pdf-assets/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/pdf-assets/standard_fonts/',
          wasmUrl: '/pdf-assets/wasm/',
          iccUrl: '/pdf-assets/icc_profiles/',
        };
        if (loadingFullPdf && cachedRoomId) {
          const data = await readCompletedPdf(cachedRoomId, file);
          if (disposed) return;
          if (!data) throw Error('Some cached PDF chunks are missing. Reopen after the download finishes.');
          // This is the normal, resilient path once the background download ends.
          // No live WebSocket or PDFDataRangeTransport is involved in rendering.
          loadingTask = getDocument({ ...options, data });
        } else {
          transport = new LivePdfRanges(file, socket, reason => {
            if (disposed) return;
            fail('A PDF byte-range request failed: ' + reason);
          });
          loadingTask = getDocument({
            ...options, range: transport,
            rangeChunkSize: REQUEST_CHUNK,
            disableStream: true,
            disableAutoFetch: true,
          });
        }
        task = loadingTask;
        watchdog = setTimeout(() => {
          fail('The document is taking too long to open. Try again after it is fully cached.');
        }, 30_000);
        loadingTask.onPassword = () => {
          fail('This PDF is password protected; password entry is not supported yet.');
        };
        const pdf = await loadingTask.promise;
        if (disposed) return;
        if (watchdog !== null) clearTimeout(watchdog);
        watchdog = null;
        onTiming?.('pdf_open_ms', performance.now() - openedAt);
        setPdfDocument(pdf);
        setLoading(false);
        setError('');
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Unable to open this PDF');
      }
    };
    void run();
    return () => {
      disposed = true;
      renderSequence.current++;
      if (watchdog !== null) clearTimeout(watchdog);
      activeRender.current?.cancel();
      transport?.abort();
      void task?.destroy();
    };
    // Switching to completed cached data intentionally restarts the document
    // exactly once, rather than continuing a potentially stalled range stream.
  }, [file.fileId, file.size, socket, cachedRoomId, loadingFullPdf, attempt, onTiming]);

  useEffect(() => {
    if (!pdfDocument || !canvas.current) return;
    let cancelled = false;
    const generation = ++renderSequence.current;
    const pageStartedAt = performance.now();
    setRendering(true);
    // Keep the previously painted slide on-screen during fullscreen/zoom.
    // Clearing this state also flashed the sender's JPEG over a ready PDF.
    setError('');
    const timer = setTimeout(() => {
      if (!cancelled && renderSequence.current === generation) {
        setRendering(false);
        setError('This page is taking too long to render. Try Retry page, or wait for caching to finish.');
      }
    }, 25_000);

    const run = async () => {
      try {
        const pdfPage = await pdfDocument.getPage(page);
        if (cancelled || generation !== renderSequence.current || !canvas.current) return;
        const original = pdfPage.getViewport({ scale: 1 });
        const fit = stageSize.width > 0 && stageSize.height > 0
          ? Math.min((stageSize.width - 24) / original.width,
              (stageSize.height - 12) / original.height)
          : 1;
        const viewport = pdfPage.getViewport({ scale: Math.max(0.1, fit) * zoom });
        const pixelRatio = Math.max(0.1, Math.min(
          window.devicePixelRatio || 1, 2,
          Math.sqrt(16_000_000 / Math.max(1, viewport.width * viewport.height)),
        ));
        const previous = activeRender.current;
        if (previous) {
          previous.cancel();
          await previous.promise.catch(() => {});
        }
        if (cancelled || generation !== renderSequence.current || !canvas.current) return;
        // Render offscreen. Resizing an on-screen canvas immediately clears
        // its pixels; if fullscreen causes a slow/cancelled render the teacher
        // would otherwise see an entirely black slide.
        const next = document.createElement('canvas');
        next.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
        next.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
        const nextContext = next.getContext('2d', { alpha: false });
        if (!nextContext) throw new Error('Canvas unavailable');
        const task = pdfPage.render({
          canvas: next, canvasContext: nextContext, viewport,
          transform: pixelRatio !== 1 ? [pixelRatio, 0, 0, pixelRatio, 0, 0] : undefined,
        });
        activeRender.current = task;
        await task.promise;
        if (cancelled || generation !== renderSequence.current || !canvas.current) return;
        // Commit in one paint operation. Preserve the old slide until this
        // moment, including after rapid zoom/fullscreen transitions.
        const visible = canvas.current;
        const context = visible.getContext('2d', { alpha: false });
        if (!context) throw new Error('Canvas unavailable');
        visible.width = next.width;
        visible.height = next.height;
        visible.style.width = viewport.width + 'px';
        visible.style.height = viewport.height + 'px';
        context.drawImage(next, 0, 0);
        onTiming?.('page_render_ms', performance.now() - pageStartedAt, page);
        setRendering(false);
        setRenderedPage(page);
        setError('');
        if (!reportedFirst.current) {
          reportedFirst.current = true;
          onFirstPageRendered?.();
        }
      } catch (err) {
        if (!cancelled && generation === renderSequence.current &&
          (err as Error)?.name !== 'RenderingCancelledException') {
          setError(err instanceof Error ? err.message : 'Unable to render page');
          setRendering(false);
        }
      } finally {
        if (generation === renderSequence.current) activeRender.current = null;
        clearTimeout(timer);
      }
    };
    void run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      renderSequence.current++;
      activeRender.current?.cancel();
    };
  }, [pdfDocument, page, zoom, pageAttempt, stageSize.width, stageSize.height,
    onFirstPageRendered, onTiming]);

  useEffect(() => { setPageInput(String(page)); }, [page]);

  const go = (next: number) => {
    if (!pdfDocument || !Number.isFinite(next)) return;
    setPage(Math.min(pdfDocument.numPages, Math.max(1, Math.floor(next))));
  };
  useEffect(() => {
    const keyHandler = (event: KeyboardEvent) => {
      if (!pdfDocument || event.target instanceof HTMLInputElement) return;
      if (['ArrowRight', 'PageDown'].includes(event.key)) go(page + 1);
      if (['ArrowLeft', 'PageUp'].includes(event.key)) go(page - 1);
    };
    window.addEventListener('keydown', keyHandler);
    return () => window.removeEventListener('keydown', keyHandler);
  // go is deliberately reconstructed from the latest page state.
  }, [pdfDocument, page]);

  const changeFullscreen = async () => {
    try {
      if (window.document.fullscreenElement) await window.document.exitFullscreen();
      else await wrapper.current?.requestFullscreen();
      // State also synchronizes when browser chrome exits via Escape.
      setFullscreen(Boolean(window.document.fullscreenElement));
    } catch {
      // Fullscreen may be unavailable on embedded/mobile browsers; preserve
      // the currently visible page rather than resetting the presentation.
      setFullscreen(document.fullscreenElement === wrapper.current);
    }
  };

  const retry = () => {
    if (completeAvailable && sourceMode === 'partial') {
      // A stalled range reader can be replaced with the already-saved PDF.
      setSourceMode('full');
    } else if (pdfDocument) setPageAttempt(value => value + 1);
    else setAttempt(value => value + 1);
  };
  const showQuickPreview = Boolean(previewImage && page === 1 && renderedPage !== 1);
  const cachedLabel = cached
    ? (cached.complete ? 'Saved for this room · direct local rendering' :
      formatBytes(cached.bytes) + ' / ' + formatBytes(cached.size) + ' cached · streaming preview')
    : 'Checking local cache…';
  return (
    <section ref={wrapper} className="viewer" style={fileAccentStyle(file.fileId)} aria-label="PDF presenter">
      <header className="viewer-toolbar">
        <div className="viewer-filename">
          <button type="button" className="icon-button close-viewer" onClick={close}
            aria-label="Back to documents" title="Back to classroom">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
              stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true"><path d="m14 5-7 7 7 7"/></svg>
          </button>
          <span className="viewer-file-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"
              strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 3.5h7.5L19 9v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1Z"/>
              <path d="M13 3.5V9h6M8 13h8M8 16.5h6"/>
            </svg>
          </span>
          <div className="viewer-file-info">
            <strong title={file.name}>{file.name}</strong>
            <small title={cachedLabel}><span className={'viewer-file-status ' +
              (cached?.complete ? 'is-complete' : 'is-loading')} aria-hidden="true"/>{cachedLabel}</small>
          </div>
        </div>
        <nav className="viewer-controls" aria-label="Presentation controls">
          <button type="button" disabled={!pdfDocument || page <= 1}
            onClick={() => go(page - 1)} aria-label="Previous page" title="Previous page (←)">‹</button>
          <form onSubmit={event => { event.preventDefault(); go(Number(pageInput)); }}>
            <input aria-label="Page number" type="number" min={1} max={pdfDocument?.numPages ?? 1}
              value={pageInput} onChange={event => setPageInput(event.target.value)}/>
            <span>/ {pdfDocument?.numPages ?? '—'}</span>
          </form>
          <button type="button" disabled={!pdfDocument || page >= pdfDocument.numPages}
            onClick={() => go(page + 1)} aria-label="Next page" title="Next page (→)">›</button>
          <span className="toolbar-divider" aria-hidden="true"/>
          <button type="button" disabled={(!pdfDocument && !showQuickPreview) || zoom <= 0.5}
            onClick={() => setZoom(z => Math.max(.5, +(z - .25).toFixed(2)))}
            aria-label="Zoom out" title="Zoom out">−</button>
          <button type="button" className="zoom-reset" disabled={zoom === 1}
            onClick={() => setZoom(1)} aria-label="Reset zoom to fit" title="Reset to fit">
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" disabled={(!pdfDocument && !showQuickPreview) || zoom >= 2}
            onClick={() => setZoom(z => Math.min(2, +(z + .25).toFixed(2)))}
            aria-label="Zoom in" title="Zoom in">+</button>
          <span className="toolbar-divider" aria-hidden="true"/>
          <button type="button" onClick={changeFullscreen}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            title={fullscreen ? 'Exit fullscreen (Esc)' : 'Enter fullscreen'}>
            {fullscreen ? '⤢' : '⛶'}
          </button>
        </nav>
      </header>
      {error && <div className="viewer-alert" role="alert">{error} <button onClick={retry}>Retry {pdfDocument ? 'page' : 'PDF'} ↻</button></div>}
      <div className="page-stage" ref={stage}>
        {loading && !showQuickPreview && <div className="page-loading"><div className="spinner"/><strong>Opening PDF</strong><span>Preparing document structure and requesting missing bytes…</span></div>}
        {(pdfDocument || showQuickPreview) && <div className="page-shell">
          {pdfDocument && <canvas ref={canvas} aria-label={'Page ' + page} data-rendered-page={renderedPage ?? ''}/>}
          {showQuickPreview && <div className="quick-preview">
            <img src={previewImage!} alt="First slide preview" data-first-page-preview="true"
              style={{ transform: `scale(${zoom})` }}/>
            <span>First slide ready · full PDF caching in background</span>
          </div>}
          {rendering && !error && !showQuickPreview && renderedPage !== page &&
            <div className="page-overlay" aria-live="polite"><div className="spinner"/>Loading page {page}…</div>}
        </div>}
        {!loading && !pdfDocument && !showQuickPreview && <div className="page-loading">PDF is not available yet. Cached bytes are preserved.<button className="outline-button" onClick={retry}>Retry PDF ↻</button></div>}
      </div>
      <footer className="viewer-footer">
        <span className="status-dot"/> {cached?.complete ? 'PDF available offline in this room' : 'Caching PDF in background'}
        <span>Previously received bytes are reused · Presentation tabs can be closed freely</span>
      </footer>
    </section>
  );
}

export function formatBytes(size: number): string {
  if (size < 1024) return size + ' B';
  if (size < 1024 ** 2) return (size / 1024).toFixed(1) + ' KB';
  return (size / (1024 ** 2)).toFixed(1) + ' MB';
}
