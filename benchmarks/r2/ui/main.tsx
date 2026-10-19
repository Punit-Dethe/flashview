import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QRCodeSVG } from 'qrcode.react';
import './styles.css';

type Invitation = { pilot: string; role: 'host' | 'sender'; key: string };
type PilotFile = { id: string; name: string; size: number; hashes: string[]; hashBlockBytes: number;
  partBytes: number; state: 'uploading' | 'committing' | 'ready' | 'deleting'; token: string;
  offeredAt: number; uploadedAt?: number };
type Snapshot = { expiresAt: number; senderUrl?: string; files: PilotFile[] };
type Receipt = { state: 'queued' | 'receiving' | 'verified' | 'failed' | 'removed'; bytes: number;
  startedAt?: number; elapsedMs?: number; committedMs?: number; error?: string };
type Upload = { name: string; size: number; stage: string; bytes: number; total: number; startedAt: number;
  ok?: boolean; error?: string; hashingMs?: number; uploadMs?: number; elapsedMs?: number; id?: string };
const SESSION_KEY = 'flashview-private-pilot';

function readInvitation(): Invitation | null {
  const fragment = new URLSearchParams(location.hash.slice(1));
  let value: unknown;
  try {
    if (fragment.has('pilot')) {
      value = Object.fromEntries(fragment.entries());
      // Remove capabilities from the address bar before any other interaction.
      history.replaceState(null, '', location.pathname + location.search);
    } else value = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    const item = value as Invitation;
    if (!item || !/^[a-f0-9-]{36}$/i.test(item.pilot) || !['host', 'sender'].includes(item.role)
      || typeof item.key !== 'string' || item.key.length < 16) return null;
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(item)); } catch { /* In-memory session still works. */ }
    return item;
  } catch { return null; }
}
const invitation = readInvitation();
const sizeLabel = (size: number) => `${(size / 1048576).toFixed(size < 1048576 ? 2 : 1)} MB`;
const seconds = (ms?: number) => ms === undefined ? '—' : `${(ms / 1000).toFixed(2)} s`;

function Meter({ bytes, total, label }: { bytes: number; total: number; label: string }) {
  const percent = Math.min(100, total > 0 ? Math.round(bytes / total * 100) : 0);
  return <div className="meter"><div className="meter-label"><span>{label}</span><span>{percent}%</span></div>
    <progress max={Math.max(1, total)} value={bytes} aria-label={label} /></div>;
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState('Connecting to the experiment…');
  const [fatal, setFatal] = useState(false);
  const [receipts, setReceipts] = useState<Record<string, Receipt>>({});
  const receiptRef = useRef<Record<string, Receipt>>({});
  const filesRef = useRef<PilotFile[]>([]);
  const receiverRef = useRef<Worker | null>(null);
  const senderRef = useRef<Worker | null>(null);
  const pumpRef = useRef<() => void>(() => {});
  const [upload, setUpload] = useState<Upload | null>(null);
  const [notes, setNotes] = useState('');
  const [copied, setCopied] = useState('');
  const [actionError, setActionError] = useState('');
  const [preview, setPreview] = useState<{ id: string; name: string; url: string; image: boolean } | null>(null);
  const previewRef = useRef<string | null>(null);
  const [now, setNow] = useState(performance.now());
  const role = invitation?.role;
  const busy = !!upload && upload.ok === undefined && !upload.error;

  const updateReceipt = (id: string, next: Receipt) => {
    receiptRef.current = { ...receiptRef.current, [id]: next };
    setReceipts(receiptRef.current);
  };

  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!invitation) return;
    let disposed = false;
    let terminal = false;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();

    const pump = () => {
      if (disposed || terminal || role !== 'host' || receiverRef.current) return;
      const file = filesRef.current.find(item => item.state === 'ready'
        && (!receiptRef.current[item.id] || receiptRef.current[item.id].state === 'queued'));
      if (!file) return;
      const startedAt = performance.now();
      updateReceipt(file.id, { state: 'receiving', bytes: 0, startedAt });
      let worker: Worker;
      try { worker = new Worker('/cache-worker.js'); }
      catch (error) {
        updateReceipt(file.id, { state: 'failed', bytes: 0, error: String(error) });
        queueMicrotask(pump);
        return;
      }
      receiverRef.current = worker;
      const finish = () => {
        worker.terminate();
        receiverRef.current = null;
        pump();
      };
      worker.onmessage = ({ data }) => {
        if (disposed) return;
        if (data.type === 'ready') {
          worker.postMessage({ ...file, token: file.token, timeoutMs: 600000, layout: 'object',
            keepCache: true, hashBlockBytes: 8388608 });
        } else if (data.type === 'progress') {
          updateReceipt(file.id, { state: 'receiving', bytes: data.bytes, startedAt });
        } else if (typeof data.ok === 'boolean') {
          updateReceipt(file.id, data.ok
            ? { state: 'verified', bytes: data.bytes, startedAt,
              elapsedMs: data.verifiedAtMs, committedMs: data.committedAtMs }
            : { state: 'failed', bytes: 0, startedAt, error: data.error || 'Browser receipt failed.' });
          finish();
        }
      };
      worker.onerror = () => {
        if (disposed) return;
        updateReceipt(file.id, { state: 'failed', bytes: 0,
          error: 'The browser cache worker stopped. Try receiving again in current Chrome or Edge.' });
        finish();
      };
    };
    pumpRef.current = pump;

    const poll = async () => {
      try {
        const response = await fetch(`/api/pilots/${invitation.pilot}`, {
          headers: { Authorization: `Bearer ${invitation.key}` }, signal: abort.signal,
          cache: 'no-store',
        });
        if ([401, 403, 410].includes(response.status)) {
          terminal = true;
          if (!disposed) {
            setFatal(true);
            setConnection('This invitation is invalid or expired. Ask for a new experiment link.');
          }
          return;
        }
        if (!response.ok) throw Error('The experiment is temporarily unavailable.');
        const data = await response.json() as Snapshot;
        if (disposed) return;
        filesRef.current = data.files;
        setSnapshot(data);
        setConnection('Connected');
        pump();
      } catch (error) {
        if (!disposed) setConnection('Connection interrupted. Reconnecting… Keep this page open.');
      } finally {
        if (!disposed && !terminal) timer = setTimeout(poll, 1000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      abort.abort();
      receiverRef.current?.terminate();
      receiverRef.current = null;
      senderRef.current?.terminate();
      senderRef.current = null;
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, []);

  function sendFile(file: File) {
    if (!invitation || busy || fatal) return;
    setActionError('');
    if (file.size === 0 || file.size > 200 * 1048576) {
      setActionError('Choose a non-empty file of up to 200 MB.');
      return;
    }
    const startedAt = performance.now();
    setUpload({ name: file.name, size: file.size, stage: 'hashing', bytes: 0, total: file.size, startedAt });
    try {
      const worker = new Worker('/sender-worker.js');
      senderRef.current = worker;
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') setUpload(current => current && ({ ...current,
          stage: data.stage, bytes: data.bytes, total: data.total }));
        if (data.type === 'result') {
          setUpload(current => current && ({ ...current, ...data, stage: data.ok ? 'complete' : 'failed' }));
          worker.terminate(); senderRef.current = null;
        }
      };
      worker.onerror = () => {
        setUpload(current => current && ({ ...current, stage: 'failed', error:
          'The upload worker stopped. Check the classroom screen before starting a new transfer.' }));
        worker.terminate(); senderRef.current = null;
      };
      worker.postMessage({ pilot: invitation.pilot, token: invitation.key, file });
    } catch (error) {
      setUpload(current => current && ({ ...current, stage: 'failed', error: String(error) }));
    }
  }

  async function openPreview(file: PilotFile) {
    setActionError('');
    try {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('flashview-benchmark');
      const cached = await (await directory.getFileHandle(file.id)).getFile();
      const extension = file.name.split('.').pop()?.toLowerCase() || '';
      const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        webp: 'image/webp', pdf: 'application/pdf' } as Record<string, string>)[extension];
      if (!mime) return;
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      const url = URL.createObjectURL(new Blob([cached], { type: mime }));
      previewRef.current = url;
      setPreview({ id: file.id, name: file.name, url, image: mime.startsWith('image/') });
    } catch {
      setActionError('The cached copy could not be opened. It may have been removed with browser site data.');
    }
  }
  function closePreview() {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setPreview(null);
  }
  async function removeCache(file: PilotFile) {
    setActionError('');
    try {
      if (preview?.id === file.id) closePreview();
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('flashview-benchmark');
      await directory.removeEntry(file.id);
      updateReceipt(file.id, { ...receiptRef.current[file.id], state: 'removed' });
    } catch { setActionError('Could not remove the local copy. You can also clear this site’s storage in browser settings.'); }
  }
  function exportResults() {
    const report = { experiment: 'flashview-r2-real-device-pilot', exportedAt: new Date().toISOString(),
      role, notes, receiver: (snapshot?.files || []).map(file => ({
        name: file.name, size: file.size, cloudState: file.state,
        receipt: receipts[file.id] ? { state: receipts[file.id].state,
          receivedBytes: receipts[file.id].bytes, receiveAndVerifyMs: receipts[file.id].elapsedMs,
          cacheCommitMs: receipts[file.id].committedMs, error: receipts[file.id].error } : undefined,
      })), sender: upload ? { name: upload.name, size: upload.size, ok: upload.ok,
        hashingMs: upload.hashingMs, uploadMs: upload.uploadMs, elapsedMs: upload.elapsedMs, error: upload.error } : undefined };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `flashview-pilot-${Date.now()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const active = Object.values(receipts).find(item => item.state === 'receiving');
  const lastComplete = Object.values(receipts).filter(item => item.state === 'verified').at(-1);
  const elapsed = role === 'sender' && upload
    ? upload.elapsedMs ?? (busy ? now - upload.startedAt : undefined)
    : active?.startedAt !== undefined ? now - active.startedAt : lastComplete?.elapsedMs;
  const readyCount = Object.values(receipts).filter(item => item.state === 'verified').length;

  return <div className="app-shell">
    <header className="site-header"><a className="brand" href={location.pathname} aria-label="FlashView pilot">
      <span className="brand-mark" aria-hidden="true">f<span>*</span></span>flashview<span className="brand-dot">.</span>
    </a><span className="pilot-badge">FIELD TEST · R2</span></header>
    {!invitation ? <main className="private-state"><p className="eyebrow">PRIVATE EXPERIMENT</p>
      <h1>A real transfer.<br /><em>A clearer measure.</em></h1>
      <p>This isolated FlashView pilot tests a phone-to-classroom transfer through Cloudflare R2. Open your private host link, or scan the QR on the classroom screen to send a file.</p>
      <div className="notice">An experiment invitation is required. This page does not create a public room.</div>
      <input hidden type="file" aria-label="Benchmark source" />
    </main> : <main className={role === 'sender' ? 'workspace sender-workspace' : 'workspace'}>
      <div className="workspace-heading"><div><p className="eyebrow">REAL-DEVICE PERFORMANCE PILOT</p>
        <h1>{role === 'host' ? <>The receiving <em>desk.</em></> : <>Send it <em>across.</em></>}</h1>
        <p className="intro">{role === 'host' ? 'Scan on your phone. Send an original. Measure the browser receipt.'
          : 'Your original goes to cloud storage, then into the classroom browser’s private cache.'}</p></div>
        <div className={`connection ${fatal ? 'connection-error' : ''}`} role="status"><span aria-hidden="true" />{connection}</div>
      </div>
      <div className="pilot-grid">
        {role === 'host' && <aside className="invite-panel"><p className="eyebrow">01 / CONNECT YOUR PHONE</p>
          <h2>One scan. Two devices.</h2>
          <div className="qr-frame">{snapshot?.senderUrl ? <QRCodeSVG value={snapshot.senderUrl} size={220}
            marginSize={2} title="Scan to send a file to this experiment" /> : <span>Preparing invitation…</span>}</div>
          <button className="button secondary full" disabled={!snapshot?.senderUrl || fatal} onClick={async () => {
            try { await navigator.clipboard.writeText(snapshot!.senderUrl!); setCopied('Sender link copied.'); }
            catch { setCopied('Clipboard unavailable. Scan the QR code instead.'); }
          }}>Copy sender link <span aria-hidden="true">↗</span></button>
          <p className="copy-status" role="status">{copied || 'Open this link only on the sending device.'}</p>
          <dl className="room-facts"><div><dt>Experiment limit</dt><dd>10 files · 512 MB total</dd></div>
            <div><dt>Per original</dt><dd>Up to 200 MB</dd></div>
            <div><dt>Invitation expires</dt><dd>{snapshot ? new Date(snapshot.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Loading…'}</dd></div></dl>
          <p className="aside-note">Keep this receiving page open. Cloud access expires with this invitation; cleanup runs afterward. The private browser copy stays until you remove it or the browser clears site data.</p>
        </aside>}
        <section className="transfer-panel" aria-label="Transfer activity">
          <div className="measurement"><div><p className="eyebrow">{role === 'host' ? 'BROWSER RECEIPT + VERIFICATION' : 'THIS DEVICE · CURRENT TRANSFER'}</p>
            <div className="elapsed" aria-label="Elapsed time">{elapsed === undefined ? '—' : (Math.max(0, elapsed) / 1000).toFixed(2)}<span>seconds</span></div></div>
            <span className="measurement-caption">{role === 'host' ? 'Receipt worker start to verified local cache. Upload and discovery delay are separate.'
              : 'Includes preparing and uploading the original. Classroom receipt is measured separately.'}</span>
          </div>
          {role === 'sender' && <>
            <label className={`upload-target ${busy || fatal ? 'disabled' : ''}`}>
              <span className="upload-arrow" aria-hidden="true">↑</span><strong>{busy ? 'Transfer in progress' : 'Choose an original file'}</strong>
              <span>PDF, presentation, image or any file · up to 200 MB</span>
              <input type="file" aria-label="Benchmark source" disabled={busy || fatal || !snapshot}
                onChange={event => { const file = event.target.files?.[0]; if (file) sendFile(file); event.target.value = ''; }} />
            </label>
            <p className="keep-open">Keep this phone page open until <strong>Upload complete</strong> appears.</p>
            {upload && <article className={`upload-result ${upload.error ? 'failure' : ''}`} aria-live="polite">
              <div className="row-title"><strong>{upload.name}</strong><span>{sizeLabel(upload.size)}</span></div>
              {busy && <Meter bytes={upload.bytes} total={upload.total} label={upload.stage === 'hashing'
                ? 'Preparing integrity checks' : upload.stage === 'committing' ? 'Confirming cloud storage' : 'Uploading original'} />}
              {upload.ok && <><p className="success-text">✓ Upload complete</p><p>The cloud copy is ready. The classroom browser can finish receiving without this phone.</p>
                <dl className="timings"><div><dt>Integrity preparation</dt><dd>{seconds(upload.hashingMs)}</dd></div><div><dt>Cloud upload</dt><dd>{seconds(upload.uploadMs)}</dd></div></dl></>}
              {upload.error && <p role="alert">{upload.error} Check the classroom screen before selecting the file again.</p>}
            </article>}
          </>}
          {role === 'host' && <><div className="list-heading"><h2>Originals <span>{snapshot?.files.length || 0}</span></h2><span>{readyCount} verified</span></div>
            {!snapshot?.files.length && <div className="empty-list"><span className="empty-symbol" aria-hidden="true">↓</span>
              <h3>Ready for the first original.</h3><p>Scan the QR, select a file on your phone, and its progress will appear here.</p></div>}
            <div className="file-list">{snapshot?.files.map((file, index) => {
              const receipt = receipts[file.id];
              const extension = file.name.split('.').pop()?.toLowerCase() || '';
              const image = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension);
              const verified = receipt?.state === 'verified';
              return <article className="file-row" key={file.id} data-file-id={file.id}>
                <div className="file-number">{String(index + 1).padStart(2, '0')}</div><div className="file-content">
                  <div className="row-title"><strong title={file.name}>{file.name}</strong><span>{sizeLabel(file.size)}</span></div>
                  <p className={verified ? 'success-text' : receipt?.state === 'failed' ? 'error-text' : 'file-status'}>
                    {verified ? '✓ Cached and verified' : receipt?.state === 'failed' ? 'Receipt failed' : receipt?.state === 'removed' ? 'Local copy removed'
                      : receipt?.state === 'receiving' ? 'Receiving into private browser cache…' : file.state === 'ready' ? 'Cloud ready · waiting to receive'
                        : file.state === 'committing' ? 'Confirming cloud upload…' : file.state === 'deleting' ? 'Cloud original removed' : 'Phone is uploading…'}</p>
                  {receipt?.state === 'receiving' && <Meter bytes={receipt.bytes} total={file.size} label="Browser receipt" />}
                  {verified && <p className="detail">Receipt + verification: <strong>{seconds(receipt.elapsedMs)}</strong></p>}
                  {receipt?.error && <p className="error-text">{receipt.error} If private storage is unavailable, try current Chrome or Edge.</p>}
                  {verified && extension === 'pptx' && <p className="detail">Presentation preview is part of the next implementation phase.</p>}
                  <div className="row-actions">
                    {verified && (image || extension === 'pdf') && <button className="button small" onClick={() => void openPreview(file)}>{image ? 'Preview cached image' : 'Open cached PDF'}</button>}
                    {verified && <button className="text-button" onClick={() => void removeCache(file)}>Remove local cache</button>}
                    {receipt?.state === 'failed' && file.state === 'ready' && <button className="button secondary small" disabled={fatal} onClick={() => {
                      updateReceipt(file.id, { state: 'queued', bytes: 0 }); pumpRef.current();
                    }}>Retry receipt</button>}
                  </div>
                </div></article>;
            })}</div><p className="storage-note">Originals are cached privately in this browser. They are never saved to your computer’s Downloads folder.</p></>}
          {actionError && <p className="notice error-text" role="alert">{actionError}</p>}
          <section className="results-section"><div><label htmlFor="network-notes">Network notes <span>optional · stays in your exported report</span></label>
            <textarea id="network-notes" value={notes} onChange={event => setNotes(event.target.value)} rows={2}
              placeholder="For example: campus Wi-Fi → classroom Ethernet" /></div>
            <button className="button secondary" onClick={exportResults}>Export results <span aria-hidden="true">↗</span></button>
            <p>Exports a JSON measurement report. No original files or invitation keys are included.</p></section>
        </section>
      </div>
      {preview && <section className="preview-panel" aria-label="Cached file preview"><div className="preview-toolbar"><h2>{preview.name}</h2>
        <button className="button secondary small" onClick={closePreview}>Close preview</button></div>
        <p className="detail">Reading the verified local copy. Preview does not request or prioritize transfers.</p>
        {preview.image ? <img src={preview.url} alt={preview.name} /> : <iframe src={preview.url} title={`Cached PDF: ${preview.name}`} />}</section>}
    </main>}
    <footer><span>FLASHVIEW / R2 EXPERIMENT</span><span>Real devices. Separate upload & receipt measurements.</span></footer>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
