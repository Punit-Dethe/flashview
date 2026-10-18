import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useSwipeable } from 'react-swipeable';
import type { PdfManifest } from '../../shared/protocol';
import { readCompletedFile } from '../pdf/roomCache';
import { CompletedPptxArchive, type PptxSlide } from './slideModel';
import '../styles.powerpoint.css';

type Props = { file: PdfManifest; roomId: string;
  close: () => void; onFirstSlideRendered?: () => void };

function PptxCanvas({ slide, available }: { slide: PptxSlide; available: { width: number; height: number } }) {
  // Native fullscreen still preserves the slide's original aspect ratio.
  // Fit into the actual measured stage, not a hardcoded 16:9 / 92px gap.
  const scale = Math.min(available.width / slide.width, available.height / slide.height);
  const width = Math.max(1, Math.floor(slide.width * scale));
  const height = Math.max(1, Math.floor(slide.height * scale));
  return <div className="flashview-pptx-slide"
    style={{ width, height, aspectRatio: slide.width + '/' + slide.height, backgroundColor: slide.background }}>
    {slide.items.map(item => {
      const style: CSSProperties = {
        left: item.x / slide.width * 100 + '%',
        top: item.y / slide.height * 100 + '%',
        width: item.width / slide.width * 100 + '%',
        height: item.height / slide.height * 100 + '%',
        borderRadius: item.radius,
        backgroundColor: item.fill,
        border: item.stroke ? (item.strokeWidth ?? 1) + 'px solid ' + item.stroke : undefined,
      };
      if (item.kind === 'image') return item.src
        ? <img key={item.id} className="flashview-pptx-element" src={item.src}
            alt="" style={{ ...style, objectFit: 'contain' }}/>
        : <div key={item.id} className="flashview-pptx-element flashview-pptx-placeholder" style={style}/>;
      return <div key={item.id} className="flashview-pptx-element flashview-pptx-text"
        style={{ ...style, fontSize: 'min(3vw,' + (item.size || 24) + 'px)',
          color: item.color || '#1d2636', whiteSpace: 'pre-wrap' }}>
        {item.text}
      </div>;
    })}
  </div>;
}

/** Controlled full-download comparison: the original file is assembled from
 * IndexedDB, then zip.js reads that COMPLETE byte array. No network-dependent
 * slide ranges, early painting, or ZIP-tail transfer prioritization. This is
 * still a limited experimental renderer, not a full PowerPoint implementation. */
export default function PowerPointPresenter({ file, roomId, close, onFirstSlideRendered }: Props) {
  const archiveRef = useRef<CompletedPptxArchive | null>(null);
  const slideCache = useRef(new Map<string, PptxSlide>());
  const pending = useRef(new Map<string, Promise<PptxSlide>>());
  const firstShown = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasStage = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const [paths, setPaths] = useState<string[]>([]);
  const [slideIndex, setSlideIndex] = useState(0);
  const [slide, setSlide] = useState<PptxSlide | null>(null);
  const [state, setState] = useState<'index' | 'loading' | 'ready' | 'error'>('index');
  const [error, setError] = useState('');
  const [retryCount, retry] = useState(0);
  const [indexRetry, retryIndex] = useState(0);
  const swipe = useSwipeable({
    onSwipedLeft: () => setSlideIndex(index => Math.min(paths.length - 1, index + 1)),
    onSwipedRight: () => setSlideIndex(index => Math.max(0, index - 1)),
    delta: { left: 55, right: 55 },
    swipeDuration: 1400,
    trackMouse: true, trackTouch: true, preventScrollOnSwipe: true,
  });
  const attachCanvas = useCallback((node: HTMLDivElement | null) => {
    canvasStage.current = node;
    swipe.ref(node);
  }, [swipe.ref]);

  useEffect(() => {
    const element = canvasStage.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const width = Math.max(0, rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
      const height = Math.max(0, rect.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
      setAvailable(previous => previous.width === width && previous.height === height
        ? previous : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!paths.length || event.altKey || event.ctrlKey || event.metaKey ||
          event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement ||
          (event.target instanceof HTMLElement && event.target.isContentEditable)) return;
      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault();
        setSlideIndex(index => Math.min(paths.length - 1, index + 1));
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        setSlideIndex(index => Math.max(0, index - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paths.length]);

  useEffect(() => {
    let disposed = false;
    let archive: CompletedPptxArchive | null = null;
    archiveRef.current = null;
    setState('index'); setPaths([]); setSlide(null); setSlideIndex(0);
    slideCache.current.clear(); pending.current.clear(); firstShown.current = false;
    void (async () => {
      // The viewer never uses the partial cache reader. If IndexedDB is missing
      // even one chunk, fail explicitly rather than silently drawing half a slide.
      const bytes = await readCompletedFile(roomId, file);
      if (disposed) return;
      if (!bytes) throw Error('The PowerPoint is not fully cached. Reopen when it reaches 100%.');
      archive = new CompletedPptxArchive(bytes);
      archiveRef.current = archive;
      const slidePaths = await archive.index();
      if (disposed) return;
      setPaths(slidePaths); setState('loading');
    })().catch(e => {
      if (disposed) return;
      setError(e instanceof Error ? e.message : 'Unable to open complete PowerPoint');
      setState('error');
    });
    return () => {
      disposed = true;
      if (archive) void archive.close().catch(() => {});
      if (archiveRef.current === archive) archiveRef.current = null;
    };
  }, [file.fileId, file.size, roomId, indexRetry]);

  const markVisible = useCallback(() => {
    if (firstShown.current) return;
    firstShown.current = true;
    requestAnimationFrame(() => requestAnimationFrame(() => onFirstSlideRendered?.()));
  }, [onFirstSlideRendered]);

  useEffect(() => {
    const path = paths[slideIndex], archive = archiveRef.current;
    if (!path || !archive) return;
    let active = true;
    const existing = slideCache.current.get(path);
    if (existing) {
      setSlide(existing); setState('ready'); markVisible();
      return () => { active = false; };
    }
    setSlide(null); setState('loading'); setError('');
    let task = pending.current.get(path);
    if (!task) {
      // Do not paint text ahead of images in this baseline. Only the
      // fully extracted slide model is shown, so missing layering is not
      // attributable to an early partial slide paint.
      task = archive.slide(path, () => {});
      pending.current.set(path, task);
    }
    void task.then(result => {
      slideCache.current.set(path, result); pending.current.delete(path);
      if (!active) return;
      setSlide(result); setState('ready'); markVisible();
    }).catch(e => {
      pending.current.delete(path);
      if (!active) return;
      setError(e instanceof Error ? e.message : 'Could not read slide data');
      setState('error');
    });
    return () => { active = false; };
  }, [paths, slideIndex, retryCount, markVisible]);

  const move = (direction: number) =>
    setSlideIndex(index => Math.max(0, Math.min(paths.length - 1, index + direction)));
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (stageRef.current) void stageRef.current.requestFullscreen().catch(() => {});
  };

  return <div className="flashview-pptx-presenter" ref={stageRef}>
    <div className="flashview-pptx-canvas" ref={attachCanvas} onMouseDown={swipe.onMouseDown}
      aria-label="PowerPoint slide gesture area">
      {slide && available.width > 0 && available.height > 0
        ? <PptxCanvas slide={slide} available={available}/> : <div className="flashview-pptx-state" role="status">
        {state !== 'error' && <span className="spinner"/>}
        <h1>{state === 'error' ? 'Slide unavailable' :
          state === 'index' ? 'Opening complete PowerPoint…' : 'Rendering slide…'}</h1>
        <p>{state === 'error' ? error : 'Rendering from the fully downloaded PowerPoint in your browser.'}</p>
        {state === 'error' && <button type="button" onClick={() => {
          setError('');
          if (!paths.length) retryIndex(n => n + 1);
          else {
            slideCache.current.delete(paths[slideIndex]);
            pending.current.delete(paths[slideIndex]);
            retry(n => n + 1);
          }
        }}>Retry slide</button>}
      </div>}
    </div>
    <div className="flashview-pptx-controls">
      <span aria-live="polite">Slide {paths.length ? slideIndex + 1 : '—'} / {paths.length || '—'}</span>
      <button type="button" onClick={() => move(-1)} disabled={!paths.length || slideIndex === 0}
        aria-label="Previous slide">←</button>
      <button type="button" onClick={() => move(1)} disabled={!paths.length || slideIndex === paths.length - 1}
        aria-label="Next slide">→</button>
      <button type="button" onClick={toggleFullscreen} aria-label="Toggle fullscreen">Fullscreen</button>
      <button type="button" onClick={close} aria-label="Close presentation">Close</button>
    </div>
    <div className="flashview-pptx-caption" aria-live="polite">
      <span>Full-file zip.js comparison · limited static rendering</span>
      <span>100% cached</span>
    </div>
  </div>;
}
