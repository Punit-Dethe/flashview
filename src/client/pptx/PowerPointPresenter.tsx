import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { PdfManifest } from '../../shared/protocol';
import type { CacheProgress } from '../pdf/roomCache';
import type { PdfRangeSource } from '../presentation';
import { CachedPptxReader } from './zipRange';
import { PartialPptxArchive, type PptxSlide } from './slideModel';
import '../styles.powerpoint.css';

type Props = { file: PdfManifest; source: PdfRangeSource; cached?: CacheProgress | null;
  close: () => void; onFirstSlideRendered?: () => void };

function PptxCanvas({ slide }: { slide: PptxSlide }) {
  return <div className="flashview-pptx-slide"
    style={{ aspectRatio: slide.width + '/' + slide.height, backgroundColor: slide.background }}>
    {slide.items.map(item => {
      const style: CSSProperties = {
        left: item.x / slide.width * 100 + '%',
        top: item.y / slide.height * 100 + '%',
        width: item.width / slide.width * 100 + '%',
        height: item.height / slide.height * 100 + '%',
        borderRadius: item.radius,
        backgroundColor: item.fill,
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

/** Experimental progressive PPTX preview. zip.js extracts cached slide parts;
 * it does NOT implement PowerPoint animations. All network transfer remains
 * controlled by the host's independent background cache scheduler. */
export default function PowerPointPresenter({ file, source, cached, close, onFirstSlideRendered }: Props) {
  const archiveRef = useRef<PartialPptxArchive | null>(null);
  const slideCache = useRef(new Map<string, PptxSlide>());
  const pending = useRef(new Map<string, Promise<PptxSlide>>());
  const firstShown = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [slideIndex, setSlideIndex] = useState(0);
  const [slide, setSlide] = useState<PptxSlide | null>(null);
  const [state, setState] = useState<'index' | 'loading' | 'partial' | 'ready' | 'error'>('index');
  const [error, setError] = useState('');
  const [retryCount, retry] = useState(0);
  const [indexRetry, retryIndex] = useState(0);
  const percent = cached?.complete ? 100 : Math.round(
    Math.max(0, Math.min(100, (cached?.bytes ?? 0) / Math.max(file.size, 1) * 100)));

  useEffect(() => {
    let disposed = false;
    const reader = new CachedPptxReader(file, source);
    const archive = new PartialPptxArchive(reader);
    archiveRef.current = archive;
    setState('index'); setPaths([]); setSlide(null); setSlideIndex(0);
    slideCache.current.clear(); pending.current.clear(); firstShown.current = false;
    void archive.index().then(slidePaths => {
      if (disposed) return;
      setPaths(slidePaths); setState('loading');
    }).catch(e => {
      if (disposed) return;
      setError(e instanceof Error ? e.message : 'Unable to inspect PowerPoint archive');
      setState('error');
    });
    return () => {
      disposed = true;
      reader.close();
      void archive.close().catch(() => {});
      if (archiveRef.current === archive) archiveRef.current = null;
    };
  }, [file.fileId, file.size, source, indexRetry]);

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
      task = archive.slide(path, early => {
        slideCache.current.set(path, early);
        if (active) { setSlide(early); setState('partial'); markVisible(); }
      });
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
    <div className="flashview-pptx-canvas">
      {slide ? <PptxCanvas slide={slide}/> : <div className="flashview-pptx-state" role="status">
        {state !== 'error' && <span className="spinner"/>}
        <h1>{state === 'error' ? 'Slide unavailable' :
          state === 'index' ? 'Reading PowerPoint slide index…' : 'Waiting for slide data…'}</h1>
        <p>{state === 'error' ? error : 'Previewing available bytes. Original file transfer continues independently.'}</p>
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
      {slide && state === 'partial' && <div className="flashview-pptx-image-progress" role="status">
        Slide visible · remaining images loading
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
      <span>Experimental static PPTX preview · animations not supported</span>
      <span>{percent}% downloaded</span>
    </div>
  </div>;
}
