import { useEffect, useRef, useState } from 'react';
import {
  getDocument, GlobalWorkerOptions, PDFDataRangeTransport,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PdfManifest } from '../../shared/protocol';
import type { RoomSocket } from '../socket';

GlobalWorkerOptions.workerSrc = workerUrl;
const REQUEST_CHUNK = 65_536;

class LivePdfRanges extends PDFDataRangeTransport {
  private cancelled = false;
  private cancels: Array<() => void> = [];
  constructor(
    private readonly file: PdfManifest,
    private readonly socket: RoomSocket,
    private readonly onError: (reason: string) => void,
    private readonly onRequest: (bytes: number) => void,
  ) {
    super(file.size, null);
  }

  override requestDataRange(begin: number, end: number): void {
    if (this.cancelled) return;
    // PDF.js normally asks for 64 KiB aligned ranges. Split defensive larger requests.
    for (let offset = begin; offset < end; offset += REQUEST_CHUNK) {
      const finish = Math.min(offset + REQUEST_CHUNK, end);
      const stop = this.socket.requestRange(
        this.file.fileId, offset, finish,
        (start, bytes) => {
          if (this.cancelled) return;
          this.onRequest(bytes.byteLength);
          this.onDataRange(start, bytes);
        },
        reason => { if (!this.cancelled) this.onError(reason); },
      );
      this.cancels.push(stop);
    }
  }

  override abort(): void {
    this.cancelled = true;
    for (const cancel of this.cancels) cancel();
    this.cancels = [];
  }
}

export function Viewer({ file, socket, close }: {
  file: PdfManifest; socket: RoomSocket; close: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [received, setReceived] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    setDocument(null);
    setLoading(true);
    setError('');
    setPage(1);
    setPageInput('1');
    setReceived(0);
    const transport = new LivePdfRanges(file, socket,
      reason => { if (!disposed) setError(reason); },
      bytes => { if (!disposed) setReceived(n => n + bytes); },
    );
    const task = getDocument({
      range: transport,
      rangeChunkSize: REQUEST_CHUNK,
      disableStream: true,
      disableAutoFetch: true,
      disableRange: false,
      maxImageSize: 15_000_000,
    });
    task.onPassword = () => {
      if (!disposed) setError('This PDF is password protected. Password entry is not supported yet.');
    };
    task.promise.then(pdf => {
      if (disposed) return;
      setDocument(pdf);
      setLoading(false);
      setError('');
    }).catch(e => {
      if (!disposed) {
        setLoading(false);
        setError(e instanceof Error ? e.message : 'Unable to load this PDF');
      }
    });
    return () => {
      disposed = true;
      transport.abort();
      void task.destroy();
    };
  }, [file.fileId, file.size, socket]);

  useEffect(() => {
    if (!document || !canvas.current) return;
    let stopped = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null;
    setRendering(true);
    setError('');
    document.getPage(page).then(pdfPage => {
      if (stopped || !canvas.current) return;
      const viewport = pdfPage.getViewport({ scale: zoom });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const element = canvas.current;
      const context = element.getContext('2d');
      if (!context) throw new Error('Canvas is not available');
      element.height = Math.floor(viewport.height * pixelRatio);
      element.width = Math.floor(viewport.width * pixelRatio);
      element.style.height = viewport.height + 'px';
      element.style.width = viewport.width + 'px';
      const transform: [number, number, number, number, number, number] | undefined =
        pixelRatio !== 1 ? [pixelRatio, 0, 0, pixelRatio, 0, 0] : undefined;
      renderTask = pdfPage.render({ canvas: element, canvasContext: context, viewport, transform });
      return renderTask.promise;
    }).then(() => {
      if (!stopped) setRendering(false);
    }).catch(e => {
      if (!stopped && e?.name !== 'RenderingCancelledException') {
        setError(e instanceof Error ? e.message : 'Unable to render page');
        setRendering(false);
      }
    });
    return () => {
      stopped = true;
      renderTask?.cancel();
    };
  }, [document, page, zoom]);

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  const go = (number: number) => {
    if (!document || !Number.isFinite(number)) return;
    setPage(Math.max(1, Math.min(document.numPages, Math.floor(number))));
  };
  const changeFullscreen = async () => {
    try {
      if (window.document.fullscreenElement) await window.document.exitFullscreen();
      else await wrapper.current?.requestFullscreen();
      setFullscreen(Boolean(window.document.fullscreenElement));
    } catch { /* Browser/teacher device can deny fullscreen. */ }
  };
  return (
    <section ref={wrapper} className="viewer" aria-label="PDF presenter">
      <header className="viewer-toolbar">
        <div className="viewer-filename">
          <button type="button" className="icon-button close-viewer" onClick={close} aria-label="Back to documents">←</button>
          <div><strong title={file.name}>{file.name}</strong><small>{formatBytes(file.size)} · {formatBytes(received)} delivered</small></div>
        </div>
        <div className="viewer-controls">
          <button disabled={!document || page <= 1} onClick={() => go(page - 1)} aria-label="Previous page">‹</button>
          <form onSubmit={e => { e.preventDefault(); go(Number(pageInput)); }}>
            <input aria-label="Page number" type="number" min={1} max={document?.numPages ?? 1}
              value={pageInput} onChange={e => setPageInput(e.target.value)}/>
            <span>/ {document?.numPages ?? '—'}</span>
          </form>
          <button disabled={!document || page >= document.numPages} onClick={() => go(page + 1)} aria-label="Next page">›</button>
          <span className="toolbar-divider"/>
          <button disabled={!document || zoom <= 0.5} onClick={() => setZoom(z => Math.max(0.5, +(z - 0.25).toFixed(2)))} aria-label="Zoom out">−</button>
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          <button disabled={!document || zoom >= 2} onClick={() => setZoom(z => Math.min(2, +(z + 0.25).toFixed(2)))} aria-label="Zoom in">+</button>
          <button onClick={changeFullscreen} aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>⛶</button>
        </div>
      </header>
      {error && <div className="viewer-alert" role="alert">{error} <button onClick={() => setError('')}>Dismiss</button></div>}
      <div className="page-stage">
        {loading && <div className="page-loading"><div className="spinner"/><strong>Opening PDF</strong><span>Requesting document structure from the sender…</span></div>}
        {document && <div className="page-shell">
          <canvas ref={canvas} aria-label={'Page ' + page}/>
          {rendering && <div className="page-overlay" aria-live="polite"><div className="spinner"/>Loading page {page}…</div>}
        </div>}
        {!loading && !document && <div className="page-loading">Unable to open this PDF. Check that the student's phone is connected and the file is valid.</div>}
      </div>
      <footer className="viewer-footer">
        <span className="status-dot"/> Live PDF stream
        <span>Pages are requested as you navigate · Keep sender's phone online</span>
      </footer>
    </section>
  );
}

export function formatBytes(size: number): string {
  if (size < 1024) return size + ' B';
  if (size < 1024 ** 2) return (size / 1024).toFixed(1) + ' KB';
  return (size / (1024 ** 2)).toFixed(1) + ' MB';
}
