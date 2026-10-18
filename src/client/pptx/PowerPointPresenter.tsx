import '../styles.powerpoint.css';
import { useEffect, useRef, useState } from 'react';
import type { PdfManifest } from '../../shared/protocol';
import { readCompletedFile } from '../pdf/roomCache';
import { inspectPptx } from './inspect';

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
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Engine | null>(null);
  const firstVisible = useRef(false);
  const [stage, setStage] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [slideIndex, setSlideIndex] = useState(0);
  const [slideCount, setSlideCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let viewer: Engine | null = null;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    setStage('loading');
    setSlideIndex(0);
    setSlideCount(0);
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
        showCompatibilityToasts: false,
        fileName: file.name,
        onLoad: ({ slideCount: count }) => {
          if (cancelled) return;
          if (watchdog) clearTimeout(watchdog);
          setSlideCount(count);
          setSlideIndex(0);
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

  const next = () => viewerRef.current?.next();
  const previous = () => viewerRef.current?.prev();
  const fullscreen = () => {
    const viewer = viewerRef.current;
    if (viewer) void viewer.enterPresentation().catch(error =>
      setError(error instanceof Error ? error.message : 'Fullscreen was blocked by the browser.'));
  };

  return <div className="flashview-pptx-presenter">
    <div ref={hostRef} className="flashview-pptx-canvas" aria-label="PowerPoint slides" />
    {stage !== 'ready' && <div className="flashview-pptx-state" role="status">
      {stage === 'loading' && <span className="spinner" />}
      <h1>{stage === 'loading' ? 'Opening PowerPoint…' : 'Unable to open PowerPoint'}</h1>
      <p>{stage === 'loading'
        ? 'Preparing the fully downloaded presentation in your browser.'
        : error}</p>
      {stage === 'error' && <button type="button" onClick={close}>Close presentation</button>}
    </div>}
    {stage === 'ready' && <div className="flashview-pptx-controls">
      <span aria-live="polite">Slide {slideIndex + 1} / {slideCount}</span>
      <button type="button" onClick={previous} disabled={slideIndex === 0} aria-label="Previous slide">←</button>
      <button type="button" onClick={next} disabled={slideIndex >= slideCount - 1} aria-label="Next slide">→</button>
      <button type="button" onClick={fullscreen} aria-label="Start slideshow">Fullscreen</button>
      <button type="button" onClick={close} aria-label="Close presentation">Close</button>
    </div>}
    {error && stage === 'ready' && <div className="flashview-pptx-warning" role="alert">{error}</div>}
  </div>;
}
