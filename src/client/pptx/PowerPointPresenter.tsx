import '../styles.powerpoint.css';
import { useEffect, useRef, useState } from 'react';
import type { PdfManifest } from '../../shared/protocol';
import { readCompletedFile } from '../pdf/roomCache';
import { inspectPptx } from './inspect';
import { PresentationControls, PresentationZoomControls } from '../PresentationControls';

type Engine = ReturnType<typeof import('pptx-vanilla-viewer').createPptxViewer>;

type Props = {
  file: PdfManifest;
  roomId: string | null;
  close: () => void;
  onFirstSlideRendered?: () => void;
};

/** Runs only in a separate /present tab. It never talks to the relay or affects
 * background transfer concurrency. A PPTX is eligible only after complete cache. */
export default function PowerPointPresenter({ file, roomId, close, onFirstSlideRendered }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Engine | null>(null);
  const canvasSize = useRef({ width: 1, height: 1 });
  const firstVisible = useRef(false);
  const [stage, setStage] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [slideIndex, setSlideIndex] = useState(0);
  const [slideCount, setSlideCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [immersiveFallback, setImmersiveFallback] = useState(false);
  const [fullscreenNotice, setFullscreenNotice] = useState('');

  useEffect(() => {
    const host = hostRef.current;
    if (!host || stage !== 'ready') return;
    const resize = () => {
      const viewer = viewerRef.current;
      if (!viewer || !host.clientWidth || !host.clientHeight) return;
      // The engine's numeric zoom is an absolute canvas scale. Our 100% is
      // fit-to-window, just like PDF, and stays fitted across window changes.
      const fit = Math.min(host.clientWidth / canvasSize.current.width,
        host.clientHeight / canvasSize.current.height);
      if (zoom === 1) viewer.zoomToFit();
      else viewer.setZoom(fit * zoom);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => observer.disconnect();
  }, [stage, zoom]);

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === wrapperRef.current);
    const keyboard = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === 'Escape') { setImmersiveFallback(false); return; }
      const viewer = viewerRef.current;
      if (!viewer || !['ArrowRight', 'PageDown', 'ArrowLeft', 'PageUp'].includes(event.key)) return;
      event.preventDefault();
      // Own navigation in both windowed and fullscreen views; don't also let
      // the renderer process the same key a second time.
      event.stopImmediatePropagation();
      if (['ArrowRight', 'PageDown'].includes(event.key)) viewer.next();
      else viewer.prev();
    };
    document.addEventListener('fullscreenchange', sync);
    window.addEventListener('keydown', keyboard, true);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      window.removeEventListener('keydown', keyboard, true);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let viewer: Engine | null = null;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    setStage('loading');
    setSlideIndex(0);
    setSlideCount(0);
    setZoom(1);
    firstVisible.current = false;

    const fail = (message: string) => {
      if (cancelled) return;
      if (watchdog) clearTimeout(watchdog);
      setError(message);
      setStage('error');
    };
    async function start() {
      if (!roomId || !hostRef.current) {
        fail('The classroom cache is unavailable. Reopen this presentation from the host.');
        return;
      }
      const bytes = await readCompletedFile(roomId, file);
      if (cancelled) return;
      if (!bytes) {
        fail('This PowerPoint is not fully downloaded yet. Retry after the transfer completes.');
        return;
      }
      // Inspect the full local archive using zip.js. The presentation renderer
      // remains a separate, lazily loaded dependency with its own PPTX parser.
      await inspectPptx(bytes);
      if (cancelled) return;
      const { createPptxViewer } = await import('pptx-vanilla-viewer');
      if (cancelled || !hostRef.current) return;
      viewer = createPptxViewer(hostRef.current, {
        editable: false,
        showToolbar: false,
        showThumbnails: false,
        fitPadding: 0,
        maxFitScale: null,
        customization: { hiddenPanels: ['titleBar', 'statusBar', 'notes'] },
        showCompatibilityToasts: false,
        fileName: file.name,
        onLoad: ({ slideCount: count, canvasSize: size }) => {
          if (cancelled) return;
          if (watchdog) clearTimeout(watchdog);
          setSlideCount(count);
          setSlideIndex(0);
          canvasSize.current = size;
          setStage('ready');
          if (!firstVisible.current) {
            firstVisible.current = true;
            // Report only after the initial slide has had a chance to paint.
            requestAnimationFrame(() => requestAnimationFrame(() => {
              if (!cancelled) onFirstSlideRendered?.();
            }));
          }
        },
        onSlideChange: index => { if (!cancelled) setSlideIndex(index); },
        onError: message => fail(message || 'Unable to render this PowerPoint.'),
      });
      viewerRef.current = viewer;
      // Load only after the complete file has been reconstructed locally.
      // No URL or remote file storage is passed to the engine.
      await viewer.loadFile(bytes);
    }
    watchdog = setTimeout(() =>
      fail('Opening the PowerPoint took too long. Close and retry the presentation.'), 45_000);
    void start().catch(error => fail(error instanceof Error ? error.message : 'PowerPoint could not be opened.'));
    return () => {
      cancelled = true;
      if (watchdog) clearTimeout(watchdog);
      viewerRef.current = null;
      viewer?.destroy();
    };
  }, [file.fileId, file.size, roomId]);

  const changeFullscreen = async () => {
    const target = wrapperRef.current;
    if (!target) return;
    setFullscreenNotice('');
    if (immersiveFallback) { setImmersiveFallback(false); return; }
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.fullscreenEnabled && target.requestFullscreen) await target.requestFullscreen();
      else {
        setImmersiveFallback(true);
        setFullscreenNotice('Browser fullscreen is unavailable here. Using the full-window view; F11 may hide desktop browser chrome.');
      }
    } catch {
      setImmersiveFallback(true);
      setFullscreenNotice('The browser blocked native fullscreen. Using the full-window view; try F11 on desktop.');
    }
  };

  return <div ref={wrapperRef} className="flashview-pptx-presenter">
    <div ref={hostRef} className="flashview-pptx-canvas" aria-label="PowerPoint slides" />
    {stage !== 'ready' && <div className="flashview-pptx-state" role="status">
      {stage === 'loading' && <span className="spinner" />}
      <h1>{stage === 'loading' ? 'Opening PowerPoint…' : 'Unable to open PowerPoint'}</h1>
      <p>{stage === 'loading'
        ? 'Preparing the fully downloaded presentation in your browser.'
        : error}</p>
    </div>}
    <PresentationControls page={slideIndex + 1} pageCount={stage === 'ready' ? slideCount : 0} unit="slide"
      go={page => viewerRef.current?.goToSlide(page - 1)} fullscreen={fullscreen || immersiveFallback}
      onFullscreen={changeFullscreen} close={close}>
      <PresentationZoomControls zoom={zoom} disabled={stage !== 'ready'} onChange={setZoom}/>
    </PresentationControls>
    {fullscreenNotice && <div className="viewer-fullscreen-notice" role="status">{fullscreenNotice}</div>}
    {error && stage === 'ready' && <div className="flashview-pptx-warning" role="alert">{error}</div>}
  </div>;
}
