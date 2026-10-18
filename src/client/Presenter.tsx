import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { CacheProgress } from './pdf/roomCache';
import type { PdfManifest } from '../shared/protocol';
import { PresentationGuest } from './presentation';
import { Viewer } from './pdf/Viewer';
import { isPowerPointName } from '../shared/fileTypes';

const PowerPointPresenter = lazy(() => import('./pptx/PowerPointPresenter'));

/** /present is separate from the host dashboard: it never opens a host socket. */
export function Presenter() {
  const [key] = useState(() => location.hash.slice(1));
  const [source, setSource] = useState<PresentationGuest | null>(null);
  const [file, setFile] = useState<PdfManifest | null>(null);
  const [cached, setCached] = useState<CacheProgress | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const slideVisible = useRef(false);

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
    if (!slideVisible.current) {
      slideVisible.current = true;
      source?.report('first_slide_after_present_ms');
    }
  }, [source]);
  const pageReady = useCallback(() => {
    source?.firstPageRendered();
    markVisible();
  }, [source, markVisible]);
  useEffect(() => {
    if (!preview || !file || !source || slideVisible.current) return;
    // Mark after the preview is painted, not merely when bytes arrive.
    const first = requestAnimationFrame(() => {
      const second = requestAnimationFrame(() => markVisible());
      // A separate animation frame paints the preview between these callbacks.
      return second;
    });
    return () => cancelAnimationFrame(first);
  }, [preview, file, source, markVisible]);
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
            ? <Suspense fallback={<div className="presentation-state" role="status"><span className="spinner"/><h1>Loading complete PowerPoint…</h1></div>}>
                <PowerPointPresenter file={file} roomId={roomId} close={close} onFirstSlideRendered={pageReady}/>
              </Suspense>
            : <div className="presentation-state" role="status">
                <span className="spinner"/>
                <h1>Waiting for complete PowerPoint…</h1>
                <p>The presentation only opens when the original file is 100% cached.</p>
                <button className="outline-button" onClick={close}>Close viewer</button>
              </div>
          : <Viewer file={file} socket={source} close={close} cached={cached} previewImage={preview} cachedRoomId={roomId} onFirstPageRendered={pageReady}
              onTiming={reportTiming}/>
        : <div className="presentation-state" role="status">
          {!unavailable && <span className="spinner"/>}
          <h1>{unavailable ? 'Presentation unavailable.' : 'Opening your presentation.'}</h1>
          <p>{unavailable
            ? 'Go back to your classroom dashboard and open the file again.'
            : 'Connecting to the classroom tab. Keep that tab open while presenting.'}</p>
          <button className="outline-button" onClick={close}>Close viewer ↗</button>
        </div>}
    </div>
  );
}
