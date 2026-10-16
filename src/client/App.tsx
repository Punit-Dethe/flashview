import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { MAX_PDF_BYTES, type PdfManifest, type StudentInfo } from '../shared/protocol';
import { RoomSocket, type ServerMessage, type SocketStatus } from './socket';
import { formatBytes } from './pdf/Viewer';
import { PresentationHost } from './presentation';

type Mode = 'welcome' | 'host' | 'student';
type HostSession = { roomId: string; code: string; joinToken: string; hostToken: string };
type ShareStatus = 'announcing' | 'pending' | 'approved' | 'rejected' | 'offline';
type SharedFile = { file: File; status: ShareStatus };

function savedSession(): HostSession | null {
  try {
    const stored = sessionStorage.getItem('flashview-host');
    if (!stored) return null;
    const candidate = JSON.parse(stored) as Partial<HostSession>;
    return candidate.roomId && candidate.hostToken && candidate.code && candidate.joinToken
      ? candidate as HostSession : null;
  } catch { return null; }
}
const initialSession = savedSession();
const initialJoin = new URLSearchParams(window.location.search).get('join') || '';

function statusText(status: SocketStatus): string {
  if (status === 'connected') return 'Connected';
  if (status === 'connecting') return 'Connecting';
  return 'Offline';
}
function normalizedMessage(message: ServerMessage): string {
  return typeof message.message === 'string' ? message.message : 'Something went wrong. Please retry.';
}

export function App() {
  const socket = useRef(new RoomSocket()).current;
  const presentation = useRef(new PresentationHost(socket)).current;
  const filesOnPhone = useRef(new Map<string, SharedFile>());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modeRef = useRef<Mode>(initialSession ? 'host' : initialJoin ? 'student' : 'welcome');
  const [mode, setMode] = useState<Mode>(initialSession ? 'host' : initialJoin ? 'student' : 'welcome');
  const [hostSession, setHostSession] = useState<HostSession | null>(initialSession);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>('disconnected');
  const [error, setError] = useState('');
  const [joinCode, setJoinCode] = useState(initialJoin);
  const [studentName, setStudentName] = useState('');
  const [joinState, setJoinState] = useState<'idle' | 'pending' | 'accepted' | 'rejected'>('idle');
  const [students, setStudents] = useState<StudentInfo[]>([]);
  const [documents, setDocuments] = useState<PdfManifest[]>([]);
  const [sentFiles, setSentFiles] = useState<Array<{ fileId: string; name: string; size: number; status: ShareStatus }>>([]);
  const [busy, setBusy] = useState(false);

  function offerLocalFile(id: string, entry: SharedFile): void {
    if (entry.status === 'rejected' || entry.status === 'offline') return;
    socket.send({ type: 'file.offer', fileId: id, name: entry.file.name, size: entry.file.size });
  }

  /** Server manifest is the source of truth; recover any lost file.offer messages. */
  function reconcileFiles(serverFiles: PdfManifest[]): void {
    const known = new Map(serverFiles.map(file => [file.fileId, file]));
    for (const [id, entry] of filesOnPhone.current) {
      if (entry.status === 'offline' || entry.status === 'rejected') continue;
      const serverFile = known.get(id);
      if (serverFile) entry.status = serverFile.status;
      else {
        entry.status = 'announcing';
        offerLocalFile(id, entry);
      }
    }
    setSentFiles(existing => existing.map(item => {
      const local = filesOnPhone.current.get(item.fileId);
      return local ? { ...item, status: local.status } : item;
    }));
  }

  useEffect(() => {
    socket.onStatus = setSocketStatus;
    // On mobile, background tabs may have their timers and connections suspended.
    // Returning to the tab checks the socket and resumes it if necessary.
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      socket.wake();
      // A socket can look OPEN while an earlier broadcast was missed.
      if (socket.connected) socket.send({ type: modeRef.current === 'host' ? 'room.sync' : 'file.sync' });
    };
    const online = () => { socket.wake(); wake(); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pageshow', online);
    window.addEventListener('online', online);
    // Repair missed WebSocket notifications while the page is actually in use.
    // This is lightweight metadata, NOT a full PDF transfer.
    const syncTimer = setInterval(() => {
      if (!socket.connected || document.visibilityState !== 'visible') return;
      if (modeRef.current === 'host') socket.send({ type: 'room.sync' });
      else if (modeRef.current === 'student') {
        socket.send({ type: 'file.sync' });
        // Retry only file announcements for which no server receipt arrived.
        for (const [id, entry] of filesOnPhone.current) {
          if (entry.status === 'announcing') offerLocalFile(id, entry);
        }
      }
    }, 20_000);
    socket.onMessage = message => {
      const type = message.type;
      if (type === 'room.state') {
        setStudents(Array.isArray(message.students) ? message.students as StudentInfo[] : []);
        setDocuments(Array.isArray(message.files) ? message.files as PdfManifest[] : []);
        setError('');
      }
      if (type === 'student.pending' || type === 'student.updated') {
        const student = message.student as StudentInfo;
        if (!student?.id) return;
        setStudents(existing => [...existing.filter(s => s.id !== student.id), student]);
      }
      if (type === 'student.left') setStudents(existing => existing.filter(s => s.id !== message.id));
      if (type === 'file.announced' || type === 'file.updated') {
        const file = message.file as PdfManifest;
        if (!file?.fileId) return;
        setDocuments(existing => [...existing.filter(f => f.fileId !== file.fileId), file]);
      }
      if (type === 'join.pending') setJoinState('pending');
      if (type === 'join.accepted' || type === 'join.resumed') {
        setJoinState('accepted');
        setError('');
        if (Array.isArray(message.files)) reconcileFiles(message.files as PdfManifest[]);
        else socket.send({ type: 'file.sync' });
      }
      if (type === 'file.manifest' && Array.isArray(message.files)) {
        reconcileFiles(message.files as PdfManifest[]);
      }
      if (type === 'file.state') {
        const file = message.file as PdfManifest | undefined;
        if (file && typeof file.fileId === 'string') {
          const local = filesOnPhone.current.get(file.fileId);
          if (local) local.status = file.status;
          setSentFiles(existing => existing.map(item =>
            item.fileId === file.fileId ? { ...item, status: file.status } : item));
        }
      }
      if (type === 'join.rejected') { setJoinState('rejected'); setError('The teacher declined this connection.'); }
      if (type === 'host.offline') setError('The teacher disconnected. Waiting for the host to return.');
      if (type === 'file.pending' || type === 'file.approved' || type === 'file.rejected') {
        const status = type === 'file.pending' ? 'pending' : type === 'file.approved' ? 'approved' : 'rejected';
        const id = String(message.fileId);
        const current = filesOnPhone.current.get(id);
        if (current) current.status = status;
        setSentFiles(existing => existing.map(f => f.fileId === id ? { ...f, status } : f));
      }
      if (type === 'range.request') {
        void respondToRange(message);
      }
      if (type === 'room.closed') {
        setError('This classroom session has ended.');
        setHostSession(null);
        sessionStorage.removeItem('flashview-host');
        setJoinState('idle');
        presentation.closeAll();
      }
      if (type === 'error') setError(normalizedMessage(message));
    };

    if (initialSession) socket.connect({ role: 'host', roomId: initialSession.roomId, token: initialSession.hostToken });
    else if (initialJoin) socket.connect({ role: 'student', name: 'Student', joinToken: initialJoin });
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('pageshow', online);
      window.removeEventListener('online', online);
      clearInterval(syncTimer);
      presentation.closeAll();
      socket.close();
    };
  // The socket callback refers only to stable refs and state setters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  async function respondToRange(message: ServerMessage): Promise<void> {
    const { requestId, fileId, begin, end } = message;
    if (typeof requestId !== 'string' || typeof fileId !== 'string' ||
        typeof begin !== 'number' || typeof end !== 'number') return;
    const shared = filesOnPhone.current.get(fileId);
    if (!shared || shared.status !== 'approved' || begin < 0 || end > shared.file.size || begin >= end) {
      socket.send({ type: 'range.error', requestId, message: 'File is no longer available' });
      return;
    }
    try {
      const bytes = await shared.file.slice(begin, end).arrayBuffer();
      if (!socket.sendBytes(requestId, fileId, begin, bytes)) {
        socket.send({ type: 'range.error', requestId, message: 'Network sender is busy' });
      }
    } catch {
      socket.send({ type: 'range.error', requestId, message: 'Cannot read file from sender device' });
    }
  }

  async function createRoom(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/rooms', { method: 'POST' });
      if (!response.ok) throw new Error('Unable to create room (' + response.status + ')');
      const newSession = await response.json() as HostSession;
      sessionStorage.setItem('flashview-host', JSON.stringify(newSession));
      setHostSession(newSession);
      modeRef.current = 'host';
      setMode('host');
      setStudents([]);
      setDocuments([]);
      socket.connect({ role: 'host', roomId: newSession.roomId, token: newSession.hostToken });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cannot reach server');
    } finally { setBusy(false); }
  }

  function connectStudent(): void {
    if (!joinCode.trim()) return setError('Enter a code or use the QR code link.');
    setError('');
    setJoinState('idle');
    filesOnPhone.current.clear();
    setSentFiles([]);
    modeRef.current = 'student';
    setMode('student');
    const key = joinCode.trim();
    const identifier = /^\d{6}$/.test(key) ? { code: key } : { joinToken: key };
    socket.connect({ role: 'student', name: studentName.trim() || 'Student', ...identifier });
  }

  async function addPdf(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.target;
    const selectedFiles = Array.from(input.files ?? []);
    input.value = '';
    for (const file of selectedFiles) {
      if (file.size > MAX_PDF_BYTES || file.size === 0 || !file.name.toLowerCase().endsWith('.pdf')) {
        setError('Please choose PDFs smaller than 50 MB.');
        continue;
      }
      const prefix = await file.slice(0, 1024).text();
      if (!prefix.includes('%PDF-')) {
        setError(file.name + ' is not a valid PDF.');
        continue;
      }
      const fileId = crypto.randomUUID().replaceAll('-', '');
      const entry: SharedFile = { file, status: 'announcing' };
      filesOnPhone.current.set(fileId, entry);
      setSentFiles(current => [...current, { fileId, name: file.name, size: file.size, status: 'announcing' }]);
      if (!socket.connected) {
        setError('You are offline. The PDF is saved in this tab and will be announced when the connection returns.');
      } else offerLocalFile(fileId, entry);
    }
  }

  function revoke(fileId: string): void {
    filesOnPhone.current.delete(fileId);
    socket.send({ type: 'file.revoke', fileId });
    setSentFiles(current => current.map(f => f.fileId === fileId ? { ...f, status: 'offline' } : f));
  }

  function endRoom(): void {
    socket.send({ type: 'room.end' });
    sessionStorage.removeItem('flashview-host');
    setHostSession(null);
    presentation.closeAll();
    modeRef.current = 'welcome';
    setMode('welcome');
    socket.close();
  }

  function startFresh(): void {
    socket.close();
    sessionStorage.removeItem('flashview-host');
    setHostSession(null);
    setJoinState('idle');
    presentation.closeAll();
    setError('');
    modeRef.current = 'welcome';
    setMode('welcome');
    window.history.replaceState({}, '', '/');
  }

  const joinLink = hostSession ? window.location.origin + '/?join=' + encodeURIComponent(hostSession.joinToken) : '';
  const approvedStudents = students.filter(s => s.approved).length;

  return (
    <div className="app">
      <header className="site-header">
        <div className="brand" onClick={startFresh} role="button" tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter') startFresh(); }} aria-label="FlashView home">
          <span className="brand-mark">F<span className="brand-asterisk">✳</span></span>
          <span>flashview<span className="brand-dot">.</span></span>
        </div>
        <div className="header-right">
          <span className="header-caption">PDF sharing, without the wait.</span>
          {mode !== 'welcome' && <span className={'connection ' + socketStatus}><span className="status-dot"/>{statusText(socketStatus)}</span>}
        </div>
      </header>

      <main className="app-content">
        {mode === 'welcome' && (
          <div className="welcome">
            <div className="eyebrow"><span className="eyebrow-stroke"/> THE INSTANT CLASSROOM</div>
            <h1>From your phone.<br/><em>Onto the big screen.</em></h1>
            <p className="hero-description">Show a PDF on another device in moments. No downloads, no accounts, no unnecessary steps.</p>
            <div className="action-layout">
              <div className="action-card host-card">
                <span className="card-index">01 / PRESENT</span>
                <div className="action-icon">↗</div>
                <h2>Start a session</h2>
                <p>Set up a room on the smartboard and let students connect with a QR code.</p>
                <button className="primary-button" disabled={busy} onClick={createRoom}>
                  {busy ? 'Creating…' : 'Create a room'} <span>→</span>
                </button>
              </div>
              <div className="action-card join-card">
                <span className="card-index">02 / SHARE</span>
                <div className="action-icon">⌁</div>
                <h2>Join a session</h2>
                <p>Have a room code? Enter it here and send a PDF straight from your device.</p>
                <form onSubmit={e => { e.preventDefault(); connectStudent(); }} className="join-form">
                  <label htmlFor="code">ROOM CODE</label>
                  <input id="code" placeholder="6-digit room code" autoComplete="off" value={joinCode}
                    onChange={e => setJoinCode(e.target.value)} required/>
                  <label htmlFor="student-name">YOUR NAME <span>(optional)</span></label>
                  <input id="student-name" placeholder="e.g. Punit" maxLength={32} value={studentName}
                    onChange={e => setStudentName(e.target.value)}/>
                  <button className="outline-button" type="submit">Join room <span>↗</span></button>
                </form>
              </div>
            </div>
            <div className="micro-footer"><span>01 — Connect</span><span>02 — Choose your PDF</span><span>03 — Present instantly</span></div>
          </div>
        )}

        {mode === 'host' && hostSession && (
          <div className="workspace">
            <>
              <div className="workspace-topline"><div className="eyebrow">LIVE ROOM / {hostSession.code}</div><button className="subtle-link" onClick={endRoom}>End session ↗</button></div>
              <h1 className="section-heading">Your classroom,<br/><em>connected.</em></h1>
              <p className="section-intro">Students join using the QR code and choose a PDF. Present each document in a separate tab while your classroom queue stays here.</p>
              <div className="host-grid">
                <aside className="room-card">
                  <div className="card-index">YOUR ROOM <span className="room-live"><span className="status-dot"/> LIVE</span></div>
                  <div className="qr-plate"><QRCodeSVG value={joinLink} size={190} marginSize={1} bgColor="#ffffff" fgColor="#172b2d"/></div>
                  <div className="room-code-label">OR ENTER THIS CODE</div>
                  <div className="room-code">{hostSession.code}</div>
                  <button className="copy-link" onClick={() => void navigator.clipboard.writeText(joinLink)}>Copy invitation link ↗</button>
                  <div className="room-divider"/>
                  <div className="room-metric"><span>Students connected</span><strong>{approvedStudents.toString().padStart(2, '0')}</strong></div>
                  {students.filter(s => !s.approved).map(s => (
                    <div className="approval" key={s.id}>
                      <span><strong>{s.name}</strong><small>Wants to join</small></span>
                      <div><button className="mini-accept" onClick={() => socket.send({ type: 'student.accept', studentId: s.id })}>Allow</button>
                        <button className="mini-reject" aria-label={'Decline ' + s.name} onClick={() => socket.send({ type: 'student.reject', studentId: s.id })}>×</button></div>
                    </div>
                  ))}
                </aside>
                <section className="document-column">
                  <div className="list-heading"><h2>Shared documents <sup>{documents.filter(f => f.status !== 'rejected').length}</sup></h2><button type="button" className="subtle-link" onClick={() => socket.send({ type: 'room.sync' })}>Refresh submissions ↻</button></div>
                  {documents.length === 0 && (
                    <div className="empty-list"><span className="empty-art">▤</span>
                      <h3>Nothing shared yet.</h3><p>Once a student selects a PDF, it'll show up here — no full upload required.</p></div>
                  )}
                  <div className="document-list">
                    {documents.filter(f => f.status !== 'rejected').map(file => (
                      <article className="document-row" key={file.fileId}>
                        <div className="file-icon">PDF</div>
                        <div className="file-meta"><strong title={file.name}>{file.name}</strong><span>{file.ownerName} · {formatBytes(file.size)}</span></div>
                        {file.status === 'pending' ? (
                          <div className="row-actions"><button onClick={() => socket.send({ type: 'file.approve', fileId: file.fileId })}>Allow</button>
                            <button className="plain-action" onClick={() => socket.send({ type: 'file.reject', fileId: file.fileId })}>Decline</button></div>
                        ) : file.status === 'approved' ? (
                          <button className="open-button" onClick={() => {
                            try { presentation.open(file); }
                            catch (e) { setError(e instanceof Error ? e.message : 'Unable to open presentation'); }
                          }}>Present ↗</button>
                        ) : <span className="unavailable">{file.status === 'offline' ? 'Sender offline' : file.status}</span>}
                      </article>
                    ))}
                  </div>
                  {approvedStudents > 0 && <p className="participants">{students.filter(s => s.approved).map(s => s.name).join(' · ')} connected</p>}
                </section>
              </div>
            </>
          </div>
        )}

        {mode === 'host' && !hostSession && (
          <div className="simple-state"><h1>Session ended.</h1><p>Create a new classroom to continue.</p><button className="primary-button" onClick={startFresh}>Go home →</button></div>
        )}

        {mode === 'student' && (
          <div className="student-screen">
            <div className="eyebrow">JOIN / FLASHVIEW</div>
            <h1 className="section-heading">Share something<br/><em>worth showing.</em></h1>
            {joinState === 'idle' && (
              <div className="join-panel">
                <p>Connect to your teacher's room to send a PDF.</p>
                <form onSubmit={e => { e.preventDefault(); connectStudent(); }} className="join-form">
                  <label htmlFor="join-code">ROOM LINK OR 6-DIGIT CODE</label>
                  <input id="join-code" value={joinCode} autoComplete="off" onChange={e => setJoinCode(e.target.value)} required/>
                  <label htmlFor="join-name">YOUR NAME <span>(optional)</span></label>
                  <input id="join-name" value={studentName} placeholder="Your name" onChange={e => setStudentName(e.target.value)}/>
                  <button type="submit" className="primary-button">Connect to room →</button>
                </form>
              </div>
            )}
            {socketStatus === 'connecting' && joinState === 'accepted' &&
              <div className="stay-online" role="status">Restoring your classroom connection…</div>}
            {joinState === 'pending' && <div className="waiting-card"><span className="spinner"/><h2>Waiting for the teacher.</h2><p>Your request was delivered. Once approved, you can send a PDF.</p></div>}
            {joinState === 'accepted' && (
              <div className="send-workspace">
                <div className="accepted-mark"><span className="status-dot"/> CONNECTED TO CLASSROOM</div>
                <div className="upload-target" onClick={() => fileInputRef.current?.click()} role="button" tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter') fileInputRef.current?.click(); }}>
                  <span className="upload-glyph">↑</span><h2>Choose a PDF to share.</h2>
                  <p>Your teacher will see the file name immediately and can open pages on demand.</p>
                  <button className="primary-button" onClick={e => { e.stopPropagation(); fileInputRef.current?.click(); }}>Browse files <span>↗</span></button>
                  <small>PDF files only · Up to 50 MB</small>
                </div>
                <input ref={fileInputRef} type="file" accept=".pdf,application/pdf" multiple hidden onChange={addPdf}/>
                {sentFiles.length > 0 && <div className="sent-list"><h3>Files you're sharing</h3>
                  {sentFiles.map(f => <div className="sent-row" key={f.fileId}>
                    <span className="file-icon">PDF</span><div className="file-meta"><strong>{f.name}</strong><span>{formatBytes(f.size)} · {f.status === 'announcing' ? 'Sending announcement…' : f.status === 'pending' ? 'Received by server · awaiting teacher' : f.status === 'approved' ? 'Available while your phone stays online' : f.status}</span></div>
                    {f.status !== 'offline' && <button className="plain-action" onClick={() => revoke(f.fileId)}>Stop sharing</button>}
                  </div>)}</div>}
                <div className="stay-online">FlashView sends a document announcement first, not the complete PDF. A confirmation means your file is listed in the classroom. Keep this browser tab running for the teacher to view uncached pages.</div>
              </div>
            )}
            {joinState === 'rejected' && <button className="outline-button" onClick={startFresh}>Return home →</button>}
            {socketStatus === 'disconnected' && joinState !== 'idle' &&
              <div className="disconnect-notice">
                Connection interrupted. FlashView is reconnecting automatically.
                <button onClick={() => socket.wake()}>Retry now</button>
                <small>Keep this tab open. Previously selected PDFs remain available when the connection returns.</small>
              </div>}
            <button className="subtle-link return-home" onClick={startFresh}>← Back to home</button>
          </div>
        )}
        {error && <div className="global-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss">×</button></div>}
      </main>
      <footer className="site-footer"><span>FLASHVIEW / AN OPEN CLASSROOM PROJECT</span><span>Designed for the time between sharing and seeing.</span></footer>
    </div>
  );
}
