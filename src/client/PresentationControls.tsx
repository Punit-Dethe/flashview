import { useEffect, useState, type ReactNode } from 'react';
import './styles.presentation-controls.css';

type Props = {
  page: number;
  pageCount: number;
  unit: 'page' | 'slide';
  go: (page: number) => void;
  fullscreen: boolean;
  onFullscreen: () => void;
  close: () => void;
  children?: ReactNode;
};

export function PresentationZoomControls({ zoom, disabled, onChange }: {
  zoom: number;
  disabled: boolean;
  onChange: (zoom: number) => void;
}) {
  return <>
    <button type="button" disabled={disabled || zoom <= .5}
      onClick={() => onChange(Math.max(.5, +(zoom - .25).toFixed(2)))}
      aria-label="Zoom out" title="Zoom out">−</button>
    <button type="button" className="zoom-reset" disabled={zoom === 1}
      onClick={() => onChange(1)} aria-label="Reset zoom to fit" title="Reset to fit">
      {Math.round(zoom * 100)}%
    </button>
    <button type="button" disabled={disabled || zoom >= 2}
      onClick={() => onChange(Math.min(2, +(zoom + .25).toFixed(2)))}
      aria-label="Zoom in" title="Zoom in">+</button>
  </>;
}

/** Shared chrome; each renderer retains its own navigation and rendering. */
export function PresentationControls({ page, pageCount, unit, go, fullscreen,
  onFullscreen, close, children }: Props) {
  const [input, setInput] = useState(String(page));
  useEffect(() => setInput(String(page)), [page]);
  const submit = () => {
    const value = Number(input);
    if (!pageCount || !Number.isFinite(value)) return;
    const next = Math.max(1, Math.min(pageCount, Math.floor(value)));
    setInput(String(next));
    go(next);
  };
  return <nav className="presentation-controls" aria-label="Presentation controls">
    <div className="presentation-page-controls">
      <button type="button" disabled={!pageCount || page <= 1}
        onClick={() => go(page - 1)} aria-label={'Previous ' + unit} title={'Previous ' + unit + ' (←)'}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>
      </button>
      <form onSubmit={event => { event.preventDefault(); submit(); }}>
        <input aria-label={unit === 'page' ? 'Page number' : 'Slide number'} type="number"
          min={1} max={pageCount || 1} disabled={!pageCount} value={input}
          onChange={event => setInput(event.target.value)}/>
        <span>/ {pageCount || '—'}</span>
      </form>
      <button type="button" disabled={!pageCount || page >= pageCount}
        onClick={() => go(page + 1)} aria-label={'Next ' + unit} title={'Next ' + unit + ' (→)'}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6"/></svg>
      </button>
    </div>
    {children && <div className="presentation-zoom-controls">{children}</div>}
    <div className="presentation-exit-controls">
      <button type="button" onClick={onFullscreen}
        aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        title={fullscreen ? 'Exit fullscreen (Esc)' : 'Enter fullscreen'}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={fullscreen
          ? 'M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6'
          : 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5'}/></svg>
      </button>
      <button type="button" className="presentation-close" onClick={close}>Close</button>
    </div>
  </nav>;
}
