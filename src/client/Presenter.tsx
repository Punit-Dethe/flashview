import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { CacheProgress } from './pdf/roomCache';
import type { PdfManifest } from '../shared/protocol';
import { PresentationGuest } from './presentation';
import { Viewer } from './pdf/Viewer';
import { isPowerPointName } from '../shared/fileTypes';
import { usePreviewReady } from './PresentationTransition';

const PowerPointPresenter = lazy(() => import('./pptx/PowerPointPresenter'));

/** /present is separate from the host dashboard: it never opens a host socket. */
export function Presenter() {
  const reveal = usePreviewReady();
  const [key] = useState(() => location.hash.slice(1));
  const [source, setSource] = useState<PresentationGuest | null>(null);
  const [file, setFile] = useState<PdfManifest | null>(null);
  const [cached, setCached] = useState<CacheProgress | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const slideVisible = useRef(false);
  useEffect(() => { if (unavailable) reveal(); }, [unavailable, reveal]);

  useEffect(() => {
    if (!/^[a-f0-9]{32}$/i.test(key) || typeof BroadcastChannel === 'undefined') {
      setUnavailable(true);
      return;
    }
    const guest = new PresentationGuest(key);
    let received = false;
    guest.onFile = (pdf, room) => {
      setRoomId(room);
      // Host only opens offline PDFs when the room cache is complete.
      if (pdf.status === 'approved' || pdf.status === 'offline') {
        received = true;
        setFile(pdf);
      }
    };
    guest.onProgress = progress => setCached(progress);
    guest.onPreview = url => setPreview(url);
    guest.onClosed = () => {
      setUnavailable(true);
      setFile(null);
    };
    setSource(guest);
    guest.ready();
    const retry = setInterval(() => {
      if (!received) guest.ready();
    }, 1200);
    const waitLimit = setTimeout(() => {
      if (!received) setUnavailable(true);
    }, 10_000);
    const unload = () => guest.close();
    window.addEventListener('pagehide', unload);
    return () => {
      clearInterval(retry);
      clearTimeout(waitLimit);
      window.removeEventListener('pagehide', unload);
      guest.close();
    };
  }, [key]);

  const markVisible = useCallback(() => {
    reveal();
    if (!slideVisible.current) {
      slideVisible.current = true;
      source?.report('first_slide_after_present_ms');
    }
  }, [source, reveal]);
  const pageReady = useCallback(() => {
    source?.firstPageRendered();
    markVisible();
  }, [source, markVisible]);
  const reportTiming = useCallback((metric: 'pdf_open_ms' | 'page_render_ms',
    duration: number, page?: number) => {
    source?.report(metric, duration, page);
  }, [source]);

  const close = () => {
    source?.close();
    window.close();
    setUnavailable(true);
    setFile(null);
  };

  return (
    <div className="presentation-layout">
      {file && source && !unavailable
        ? isPowerPointName(file.name)
          ? cached?.complete && roomId
            ? <Suspense fallback={null}>
                <PowerPointPresenter file={file} roomId={roomId} close={close}
                  onFirstSlideRendered={pageReady} onError={reveal}/>
              </Suspense>
            : null
          : <Viewer file={file} socket={source} close={close} cached={cached} previewImage={preview} cachedRoomId={roomId} onFirstPageRendered={pageReady}
              onPreviewReady={markVisible} onError={reveal} onTiming={reportTiming}/>
        : unavailable && <div className="presentation-state" role="status">
          <h1>Presentation unavailable.</h1>
          <p>Go back to your classroom dashboard and open the file again.</p>
          <button className="outline-button" onClick={close}>Close viewer ↗</button>
        </div>}
    </div>
  );
}
