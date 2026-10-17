import { useEffect, useState } from 'react';
import type { PdfManifest } from '../shared/protocol';
import type { CacheProgress } from './pdf/roomCache';
import { formatBytes } from './pdf/Viewer';
import { fileAccentStyle } from './fileAccent';

type Props = {
  file: PdfManifest;
  previewUrl?: string;
  progress?: CacheProgress;
  bytesPerSecond?: number;
  onPresent: () => void;
};

const CIRCUMFERENCE = 2 * Math.PI * 16;

/** One visually stable square: loading layer -> softly revealed first-page JPEG. */
export function DocumentCard({ file, previewUrl, progress, bytesPerSecond = 0, onPresent }: Props) {
  const [imageState, setImageState] = useState({ url: '', ready: false, failed: false });
  const [fallbackTimeout, setFallbackTimeout] = useState(false);
  useEffect(() => {
    if (previewUrl) return;
    setFallbackTimeout(false);
    const timeout = setTimeout(() => setFallbackTimeout(true), 6_000);
    return () => clearTimeout(timeout);
  }, [previewUrl, file.fileId]);

  const cached = Boolean(progress?.complete);
  const percent = cached ? 100 :
    Math.max(0, Math.min(100, ((progress?.bytes ?? 0) / Math.max(1, file.size)) * 100));
  const available = file.status === 'approved' || cached;
  const imageFailed = imageState.url === previewUrl && imageState.failed;
  const showingImage = Boolean(previewUrl) && imageState.url === previewUrl &&
    imageState.ready && !imageFailed;
  // Avoid showing an icon just because the PDF cache completed before the JPEG.
  // Keep the stable spinner briefly, then fall back if no thumbnail arrives.
  const showFallback = imageFailed || (!previewUrl && (fallbackTimeout || file.status === 'offline'));
  const progressLabel = cached ? 'Fully cached' :
    Math.round(percent) + '% cached' + (bytesPerSecond > 0 ? ' · ' + formatBytes(bytesPerSecond) + '/s' : '');

  return (
    <article className="document-row document-card" style={fileAccentStyle(file.fileId)}>
      <div className="document-card-visual">
        <div className="document-thumb" aria-hidden="true">
          {previewUrl && !imageFailed && (
            <img className={'document-thumb-image' + (showingImage ? ' is-visible' : '')}
              src={previewUrl} alt="" loading="lazy" decoding="async"
              onLoad={() => setImageState({ url: previewUrl, ready: true, failed: false })}
              onError={() => setImageState({ url: previewUrl, ready: false, failed: true })}/>
          )}
          {!showingImage && (
            <div className="document-thumb-placeholder">
              {showFallback ? (
                <span className="document-pdf-symbol" aria-hidden="true"><span>PDF</span></span>
              ) : <span className="document-thumb-spinner" aria-hidden="true"/>}
            </div>
          )}
        </div>
        <div className={'cache-ring' + (cached ? ' is-complete' : '')}
          role="progressbar"
          aria-label={'Cached progress for ' + file.name}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}
          title={progressLabel}>
          <svg viewBox="0 0 44 44" aria-hidden="true">
            <circle className="ring-track" cx="22" cy="22" r="16" strokeWidth="4.5" fill="none"/>
            <circle className="ring-fill" cx="22" cy="22" r="16" strokeWidth="4.5" fill="none"
              strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE * (1 - percent / 100)}/>
            {cached && <path d="M16 22.5l4.1 4.1L29 17.5" stroke="currentColor" strokeWidth="3"
              strokeLinecap="round" strokeLinejoin="round" fill="none"/>}
          </svg>
        </div>
        {available ? (
          <button type="button" className="document-card-open" onClick={onPresent}
            aria-label={'Present ' + file.name} title={'Present ' + file.name}>
            <span>Present <span aria-hidden="true">↗</span></span>
          </button>
        ) : <span className="document-not-ready" title={file.status === 'offline' ? 'Sender offline' : 'Awaiting approval'}/>}
      </div>
      <div className="document-card-info">
        <h3 title={file.name}>{file.name}</h3>
        <p><span title={file.ownerName}>{file.ownerName}</span><span aria-hidden="true">·</span>{formatBytes(file.size)}</p>
      </div>
    </article>
  );
}
