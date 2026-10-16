import { useEffect, useRef, useState } from 'react';
import {
  getDocument, GlobalWorkerOptions, PDFDataRangeTransport,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PdfManifest } from '../../shared/protocol';
import type { PdfRangeSource } from '../presentation';
import type { CacheProgress } from './roomCache';

GlobalWorkerOptions.workerSrc = workerUrl;
const REQUEST_CHUNK = 65_536;

/** Pure byte-range transport. The host tab handles IndexedDB and network deduplication. */
class LivePdfRanges extends PDFDataRangeTransport {
  private cancelled = false;
  private cancels: Array<() => void> = [];
  constructor(
    private readonly file: PdfManifest,
    private readonly source: PdfRangeSource,
    private readonly onError: (message: string) => void,
  ) { super(file.size, null); }

  override requestDataRange(begin: number, end: number): void {
    if (this.cancelled) return;
    for (let offset = begin; offset < end; offset += REQUEST_CHUNK) {
      const finish = Math.min(offset + REQUEST_CHUNK, end);
      const cancel = this.source.requestRange(
        this.file.fileId, offset, finish,
        (start, bytes) => {
          if (!this.cancelled) this.onDataRange(start, bytes);
        },
        message => { if (!this.cancelled) this.onError(message); },
      );
      this.cancels.push(cancel);
    }
  }
  override abort(): void {
    this.cancelled = true;
    for (const cancel of this.cancels) cancel();
    this.cancels.length = 0;
  }
}

/**
 * A viewer can be closed and reopened without re-downloading the PDF because
 * its range source is backed by the room-level IndexedDB cache.
 */
export function Viewer({ file, socket, close, cached, onFirstPageRendered }: {
  file: PdfManifest;
  socket: PdfRangeSource;
  close: () => void;
  cached?: CacheProgress | null;
  onFirstPageRendered?: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const reportedFirst = useRef(false);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pageAttempt, setPageAttempt] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    let disposed = false;
    let loadingPhase = true;
    let aborted = false;
    setPdfDocument(null);
    setLoading(true);
    setError('');
    setPage(1);
    setPageInput('1');
    reportedFirst.current = false;
    const transport = new LivePdfRanges(file, socket, reason => {
      if (disposed || aborted) return;
      if (loadingPhase) {
        aborted = true;
        setLoading(false);
        setError('Unable to receive PDF: ' + reason);
        transport.abort();
        void task.destroy();
      } else {
        // Do not destroy a valid PDF when an individual page request fails.
        setError('Unable to load page: ' + reason);
        setRendering(false);
      }
    });
    const task = getDocument({
      range: transport,
      rangeChunkSize: REQUEST_CHUNK,
      disableStream: true,
      disableAutoFetch: true, // Our independent background downloader owns prefetch.
      disableRange: false,
      maxImageSize: -1, // Never silently hide a high-resolution slide image.
    });
    // This watchdog applies ONLY while obtaining the document structure.
    // The old code destroyed a successfully opened PDF after 30 seconds.
    const watchdog = setTimeout(() => {
      if (disposed || !loadingPhase) return;
      aborted = true;
      setLoading(false);
      setError("PDF opening timed out. Check the student's connection and retry.");
      transport.abort();
      void task.destroy();
    }, 30_000);

    task.onPassword = () => {
      if (disposed) return;
      aborted = true;
      setError('Password-protected PDFs are not supported yet.');
      setLoading(false);
      clearTimeout(watchdog);
      transport.abort();
      void task.destroy();
    };
    void task.promise.then(pdf => {
      if (disposed || aborted) return;
      loadingPhase = false;
      clearTimeout(watchdog);
      setPdfDocument(pdf);
      setLoading(false);
      setError('');
    }).catch(reason => {
      clearTimeout(watchdog);
      if (!disposed && !aborted) {
        setLoading(false);
        setError(reason instanceof Error ? reason.message : 'Unable to open PDF');
      }
    });
    return () => {
      disposed = true;
      clearTimeout(watchdog);
      transport.abort();
      void task.destroy();
    };
  }, [file.fileId, file.size, socket, attempt]);

  useEffect(() => {
    if (!pdfDocument || !canvas.current) return;
    let cancelled = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null;
    setRendering(true);
    setError('');
    void pdfDocument.getPage(page).then(pdfPage => {
      if (cancelled || !canvas.current) return;
      const viewport = pdfPage.getViewport({ scale: zoom });
      // Cap actual canvas pixels rather than dropping large images from the PDF.
      const pixelRatio = Math.max(0.1, Math.min(
        window.devicePixelRatio || 1, 2,
        Math.sqrt(16_000_000 / Math.max(1, viewport.width * viewport.height)),
      ));
      const element = canvas.current;
      const context = element.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable');
      element.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
      element.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
      element.style.height = viewport.height + 'px';
      element.style.width = viewport.width + 'px';
      renderTask = pdfPage.render({
        canvas: element, canvasContext: context, viewport,
        transform: pixelRatio !== 1 ? [pixelRatio, 0, 0, pixelRatio, 0, 0] : undefined,
      });
      return renderTask.promise;
    }).then(() => {
      if (cancelled) return;
      setRendering(false);
      if (!reportedFirst.current) {
        reportedFirst.current = true;
        onFirstPageRendered?.();
      }
      // Load upcoming page objects while the full byte download proceeds.
      if (page < pdfDocument.numPages) void pdfDocument.getPage(page + 1).catch(() => {});
      if (page + 1 < pdfDocument.numPages) void pdfDocument.getPage(page + 2).catch(() => {});
    }).catch(reason => {
      if (!cancelled && reason?.name !== 'RenderingCancelledException') {
        setRendering(false);
        setError(reason instanceof Error ? reason.message : 'Unable to render the selected page');
      }
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfDocument, page, zoom, pageAttempt, onFirstPageRendered]);

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
      setFullscreen(Boolean(window.document.fullscreenElement));
    } catch { /* School devices may not permit fullscreen. */ }
  };

  const retry = () => {
    if (pdfDocument) setPageAttempt(value => value + 1);
    else setAttempt(value => value + 1);
  };
  const cachedLabel = cached
    ? (cached.complete ? 'Saved for this room' :
      formatBytes(cached.bytes) + ' / ' + formatBytes(cached.size) + ' cached')
    : 'Checking local cache…';
  return (
    <section ref={wrapper} className="viewer" aria-label="PDF presenter">
      <header className="viewer-toolbar">
        <div className="viewer-filename">
          <button type="button" className="icon-button close-viewer" onClick={close} aria-label="Back to documents">←</button>
          <div><strong title={file.name}>{file.name}</strong><small>{formatBytes(file.size)} · {cachedLabel}</small></div>
        </div>
        <div className="viewer-controls">
          <button disabled={!pdfDocument || page <= 1} onClick={() => go(page - 1)} aria-label="Previous page">‹</button>
          <form onSubmit={event => { event.preventDefault(); go(Number(pageInput)); }}>
            <input aria-label="Page number" type="number" min={1} max={pdfDocument?.numPages ?? 1}
              value={pageInput} onChange={event => setPageInput(event.target.value)}/>
            <span>/ {pdfDocument?.numPages ?? '—'}</span>
          </form>
          <button disabled={!pdfDocument || page >= pdfDocument.numPages} onClick={() => go(page + 1)} aria-label="Next page">›</button>
          <span className="toolbar-divider"/>
          <button disabled={!pdfDocument || zoom <= 0.5} onClick={() => setZoom(z => Math.max(.5, +(z - .25).toFixed(2)))} aria-label="Zoom out">−</button>
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          <button disabled={!pdfDocument || zoom >= 2} onClick={() => setZoom(z => Math.min(2, +(z + .25).toFixed(2)))} aria-label="Zoom in">+</button>
          <button onClick={changeFullscreen} aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>⛶</button>
        </div>
      </header>
      {error && <div className="viewer-alert" role="alert">{error} <button onClick={retry}>Retry {pdfDocument ? 'page' : 'PDF'} ↻</button></div>}
      <div className="page-stage">
        {loading && <div className="page-loading"><div className="spinner"/><strong>Opening PDF</strong><span>Preparing document structure and requesting missing bytes…</span></div>}
        {pdfDocument && <div className="page-shell">
          <canvas ref={canvas} aria-label={'Page ' + page}/>
          {rendering && !error && <div className="page-overlay" aria-live="polite"><div className="spinner"/>Loading page {page}…</div>}
        </div>}
        {!loading && !pdfDocument && <div className="page-loading">PDF is not available yet. Cached bytes are preserved.<button className="outline-button" onClick={retry}>Retry PDF ↻</button></div>}
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
