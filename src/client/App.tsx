import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { MAX_PDF_BYTES, type PdfManifest, type StudentInfo } from '../shared/protocol';
import { RoomSocket, type ServerMessage, type SocketStatus } from './socket';
import { Viewer, formatBytes } from './pdf/Viewer';

type Mode = 'welcome' | 'host' | 'student';
type HostSession = { roomId: string; code: string; joinToken: string; hostToken: string };
type ShareStatus = 'pending' | 'approved' | 'rejected' | 'offline';
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
  const filesOnPhone = useRef(new Map<string, SharedFile>());
  const fileInputRef = useRef<HTMLInputElement>(null);
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
  const [activeFile, setActiveFile] = useState<PdfManifest | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    socket.onStatus = setSocketStatus;
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
      if (type === 'join.accepted') { setJoinState('accepted'); setError(''); }
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
        setActiveFile(null);
      }
      if (type === 'error') setError(normalizedMessage(message));
    };

    if (initialSession) socket.connect({ role: 'host', roomId: initialSession.roomId, token: initialSession.hostToken });
    else if (initialJoin) socket.connect({ role: 'student', name: 'Student', joinToken: initialJoin });
    return () => socket.close();
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
      filesOnPhone.current.set(fileId, { file, status: 'pending' });
      setSentFiles(current => [...current, { fileId, name: file.name, size: file.size, status: 'pending' }]);
      if (!socket.send({ type: 'file.offer', fileId, name: file.name, size: file.size })) {
        setError('Connection lost. Reconnect and select the file again.');
      }
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
    setActiveFile(null);
    setMode('welcome');
    socket.close();
  }

  function startFresh(): void {
    socket.close();
    sessionStorage.removeItem('flashview-host');
    setHostSession(null);
    setJoinState('idle');
    setActiveFile(null);
    setError('');
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

      <main className={'app-content ' + (activeFile ? 'with-viewer' : '')}>
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
            {activeFile ? (
              <Viewer file={activeFile} socket={socket} close={() => setActiveFile(null)}/>
            ) : <>
              <div className="workspace-topline"><div className="eyebrow">LIVE ROOM / {hostSession.code}</div><button className="subtle-link" onClick={endRoom}>End session ↗</button></div>
              <h1 className="section-heading">Your classroom,<br/><em>connected.</em></h1>
              <p className="section-intro">Students join using the QR code, choose a PDF, and you decide what appears on screen.</p>
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
                  <div className="list-heading"><h2>Shared documents <sup>{documents.filter(f => f.status !== 'rejected').length}</sup></h2><span>PDF ONLY</span></div>
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
                          <button className="open-button" onClick={() => setActiveFile(file)}>Open ↗</button>
                        ) : <span className="unavailable">{file.status === 'offline' ? 'Sender offline' : file.status}</span>}
                      </article>
                    ))}
                  </div>
                  {approvedStudents > 0 && <p className="participants">{students.filter(s => s.approved).map(s => s.name).join(' · ')} connected</p>}
                </section>
              </div>
            </>}
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
                    <span className="file-icon">PDF</span><div className="file-meta"><strong>{f.name}</strong><span>{formatBytes(f.size)} · {f.status}</span></div>
                    {f.status !== 'offline' && <button className="plain-action" onClick={() => revoke(f.fileId)}>Stop sharing</button>}
                  </div>)}</div>}
                <div className="stay-online">Keep this tab open and your phone awake while your teacher is presenting. Unloaded pages need your connection.</div>
              </div>
            )}
            {joinState === 'rejected' && <button className="outline-button" onClick={startFresh}>Return home →</button>}
            {socketStatus === 'disconnected' && joinState !== 'idle' &&
              <div className="disconnect-notice">Connection lost. <button onClick={connectStudent}>Reconnect</button>
                <small>After reconnecting, choose your PDF again to restore sharing.</small></div>}
            <button className="subtle-link return-home" onClick={startFresh}>← Back to home</button>
          </div>
        )}
        {error && <div className="global-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss">×</button></div>}
      </main>
      <footer className="site-footer"><span>FLASHVIEW / AN OPEN CLASSROOM PROJECT</span><span>Designed for the time between sharing and seeing.</span></footer>
    </div>
  );
}
