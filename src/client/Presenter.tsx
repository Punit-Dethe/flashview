import { useCallback, useEffect, useState } from 'react';
import type { CacheProgress } from './pdf/roomCache';
import type { PdfManifest } from '../shared/protocol';
import { PresentationGuest } from './presentation';
import { Viewer } from './pdf/Viewer';

/** /present is separate from the host dashboard: it never opens a host socket. */
export function Presenter() {
  const [key] = useState(() => location.hash.slice(1));
  const [source, setSource] = useState<PresentationGuest | null>(null);
  const [file, setFile] = useState<PdfManifest | null>(null);
  const [cached, setCached] = useState<CacheProgress | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!/^[a-f0-9]{32}$/i.test(key) || typeof BroadcastChannel === 'undefined') {
      setUnavailable(true);
      return;
    }
    const guest = new PresentationGuest(key);
    let received = false;
    guest.onFile = pdf => {
      // Host only opens offline PDFs when the room cache is complete.
      if (pdf.status === 'approved' || pdf.status === 'offline') {
        received = true;
        setFile(pdf);
      }
    };
    guest.onProgress = progress => setCached(progress);
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

  const pageReady = useCallback(() => source?.firstPageRendered(), [source]);

  const close = () => {
    source?.close();
    window.close();
    setUnavailable(true);
    setFile(null);
  };

  return (
    <div className="presentation-layout">
      <div className="presentation-caption">
        <strong>FLASHVIEW / PRESENTATION</strong>
        <span>The classroom dashboard stays open in the original tab.</span>
      </div>
      {file && source && !unavailable
        ? <Viewer file={file} socket={source} close={close} cached={cached} onFirstPageRendered={pageReady}/>
        : <div className="presentation-state" role="status">
          {!unavailable && <span className="spinner"/>}
          <h1>{unavailable ? 'Presentation unavailable.' : 'Opening your presentation.'}</h1>
          <p>{unavailable
            ? 'Go back to your classroom dashboard and open the PDF again.'
            : 'Connecting to the classroom tab. Keep that tab open while presenting.'}</p>
          <button className="outline-button" onClick={close}>Close viewer ↗</button>
        </div>}
    </div>
  );
}
