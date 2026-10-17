import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { MAX_PDF_BYTES, type PdfManifest, type StudentInfo } from '../shared/protocol';
import { RoomSocket, type ServerMessage, type SocketStatus } from './socket';
import { formatBytes } from './pdf/Viewer';
import { makeFirstPagePreview } from './pdf/firstPagePreview';
import { PresentationHost } from './presentation';
import { DocumentCard } from './DocumentCard';
import { StudentTransferCard } from './StudentTransferCard';
import { TransferPill } from './TransferPill';
import { summarizeTransfers } from './transferProgress';
import { cleanExpiredRoomCaches, type CacheProgress } from './pdf/roomCache';
import { PerfPanel } from './PerfPanel';
import { fileAccentStyle } from './fileAccent';
import { perf } from './perf';
/** A late initial IndexedDB snapshot must never rewind live saved-byte progress. */
function retainNewestProgress(previous: CacheProgress | undefined, incoming: CacheProgress): CacheProgress {
  if (!previous || previous.size !== incoming.size) return incoming;
  return incoming.bytes >= previous.bytes ? incoming : previous;
}

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
  const firstPageImages = useRef(new Map<string, string>());
  const previewRendering = useRef(new Set<string>());
  const previewDelivered = useRef(new Set<string>());
  const previewFailed = useRef(new Set<string>());
  const incomingPreviews = useRef(new Map<string, { parts: string[]; received: number; created: number }>());
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
  const [cacheProgress, setCacheProgress] = useState<Record<string, CacheProgress>>({});
  const [studentCacheProgress, setStudentCacheProgress] = useState<Record<string, CacheProgress>>({});
  const [phonePreviews, setPhonePreviews] = useState<Record<string, string>>({});
  const [hostAvailable, setHostAvailable] = useState(true);
  const [pillDismissed, setPillDismissed] = useState(false);
  const [pillLeaving, setPillLeaving] = useState(false);
  const hostFilesRef = useRef<PdfManifest[]>([]);
  const progressSentRef = useRef(new Map<string, { bytes: number; at: number }>());
  const [documentPreviews, setDocumentPreviews] = useState<Record<string, string>>({});
  const previewLookups = useRef(new Set<string>());
  const previewRoom = useRef(initialSession?.code ?? '');
  const transferSamples = useRef(new Map<string, { bytes: number; time: number }>());
  const [downloadSpeed, setDownloadSpeed] = useState<Record<string, number>>({});
  const [endConfirm, setEndConfirm] = useState(false);
  const [endAcknowledged, setEndAcknowledged] = useState(false);
  const [ending, setEnding] = useState(false);
  const [joinDialogOpen, setJoinDialogOpen] = useState(false);
  const [switchingRoom, setSwitchingRoom] = useState(false);
  const [switchCode, setSwitchCode] = useState('');
  const [copied, setCopied] = useState(false);
  const transferSummary = summarizeTransfers(sentFiles, studentCacheProgress);
  const studentNeedsConnection = socketStatus !== 'connected' || !hostAvailable || joinState === 'pending';
  const showTransferPill = mode === 'student' && (
    (transferSummary.count > 0 && (!transferSummary.complete || !pillDismissed)) ||
    ((joinState === 'accepted' || joinState === 'pending') && studentNeedsConnection && !transferSummary.complete)
  );

  useEffect(() => {
    if (mode !== 'student' || !transferSummary.complete) return;
    // A completion is acknowledged by the classroom cache and should be
    // visible briefly before the dock retires itself.
    const fade = setTimeout(() => setPillLeaving(true), 2900);
    const hide = setTimeout(() => setPillDismissed(true), 3250);
    return () => { clearTimeout(fade); clearTimeout(hide); };
  }, [mode, transferSummary.complete, transferSummary.count]);

  useEffect(() => {
    // Abandoned rooms expire automatically; delete their old browser-stored PDFs
    // on the next visit even if no new room is created.
    void cleanExpiredRoomCaches(initialSession?.code);
  }, []);

  useEffect(() => {
    if (!hostSession) return;
    for (const file of documents) {
      void presentation.progress(file).then(progress => {
        setCacheProgress(existing => ({
          ...existing, [file.fileId]: retainNewestProgress(existing[file.fileId], progress),
        }));
        if (socket.connected && progress.bytes > 0) socket.send({
          type: 'cache.progress', fileId: file.fileId, bytes: progress.bytes,
        });
      }).catch(() => {});
    }
  }, [hostSession?.code, documents, presentation, socket]);

  // The host already stores each phone-produced first-page JPEG for the presenter.
  // Reload thumbnails from that cache when a room recovers, with no new transfer.
  useEffect(() => {
    const roomCode = hostSession?.code ?? '';
    if (previewRoom.current !== roomCode) {
      previewRoom.current = roomCode;
      previewLookups.current.clear();
      setDocumentPreviews({});
    }
    if (!roomCode) return;
    for (const file of documents) {
      if (previewLookups.current.has(file.fileId)) continue;
      previewLookups.current.add(file.fileId);
      void presentation.getPreview(file.fileId).then(url => {
        if (!url || previewRoom.current !== roomCode) return;
        setDocumentPreviews(current => current[file.fileId] ? current : { ...current, [file.fileId]: url });
      }).catch(() => {});
    }
  }, [hostSession?.code, documents, presentation]);

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

  function sendPreview(fileId: string, dataUrl: string): void {
    const base64 = dataUrl.split(',')[1];
    if (!base64 || base64.length > 380000 || !socket.connected ||
        previewDelivered.current.has(fileId)) return;
    const size = 4900;
    const total = Math.ceil(base64.length / size);
    if (total > 80) return;
    for (let part = 0; part < total; part++) {
      if (!socket.send({
        type: 'preview.chunk', fileId, part, total,
        data: base64.slice(part * size, (part + 1) * size),
      })) return;
    }
    previewDelivered.current.add(fileId);
  }

  function preparePreview(fileId: string): void {
    const shared = filesOnPhone.current.get(fileId);
    if (!shared || shared.status !== 'approved' ||
        previewFailed.current.has(fileId) || previewDelivered.current.has(fileId)) return;
    const saved = firstPageImages.current.get(fileId);
    if (saved) { sendPreview(fileId, saved); return; }
    if (previewRendering.current.has(fileId)) return;
    previewRendering.current.add(fileId);
    perf.mark('preview:' + fileId);
    void makeFirstPagePreview(shared.file).then(url => {
      perf.elapsed('preview_generate_ms', 'preview:' + fileId, shared.file.size);
      if (!filesOnPhone.current.has(fileId)) return;
      firstPageImages.current.set(fileId, url);
      setPhonePreviews(current => ({ ...current, [fileId]: url }));
      sendPreview(fileId, url);
    }).catch(() => {
      // If preview generation fails, emit an explicit error sample.
      // A failed preview must not block the original PDF transfer.
      if (perf.enabled) {
        perf.elapsed('preview_generate_ms', 'preview:' + fileId, shared.file.size);
      }
      // Never repeatedly run an expensive failed decoder on every 20s sync.
      previewFailed.current.add(fileId);
    }).finally(() => previewRendering.current.delete(fileId));
  }

  useEffect(() => {
    socket.onStatus = status => {
      setSocketStatus(status);
      if (status === 'connected') {
        presentation.resume();
        if (modeRef.current === 'student') socket.send({ type: 'file.sync' });
      }
      // Only after a genuine drop is a preview eligible for retransmission.
      if (status === 'disconnected' && modeRef.current === 'student') {
        previewDelivered.current.clear();
      }
    };
    presentation.onProgress = progress => {
      setCacheProgress(existing => ({
        ...existing, [progress.fileId]: retainNewestProgress(existing[progress.fileId], progress),
      }));
      // Only the classroom's completed IndexedDB writes count as uploaded.
      // The relay forwards this small acknowledgement to the file's owner.
      if (modeRef.current === 'host' && socket.connected) {
        const now = performance.now();
        const last = progressSentRef.current.get(progress.fileId);
        if (!last || progress.complete || now - last.at >= 850) {
          socket.send({ type: 'cache.progress', fileId: progress.fileId, bytes: progress.bytes });
          progressSentRef.current.set(progress.fileId, { bytes: progress.bytes, at: now });
        }
      }
      const now = performance.now();
      const sample = transferSamples.current.get(progress.fileId);
      if (!sample) {
        transferSamples.current.set(progress.fileId, { bytes: progress.bytes, time: now });
      } else if (now - sample.time >= 1000 || progress.complete) {
        const seconds = Math.max(.001, (now - sample.time) / 1000);
        const bytesPerSecond = Math.max(0, Math.round((progress.bytes - sample.bytes) / seconds));
        setDownloadSpeed(existing => ({
          ...existing, [progress.fileId]: progress.complete ? 0 : bytesPerSecond,
        }));
        transferSamples.current.set(progress.fileId, { bytes: progress.bytes, time: now });
      }
    };
    presentation.onWarning = message => setError(message);
    // On mobile, background tabs may have their timers and connections suspended.
    // Returning to the tab checks the socket and resumes it if necessary.
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      socket.wake();
      // A socket can look OPEN while an earlier broadcast was missed.
      if (socket.connected) socket.send({ type: modeRef.current === 'host' ? 'room.sync' : 'file.sync' });
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') socket.pauseHeartbeat();
      else wake();
    };
    // focus is essential on mobile: an OS file picker doesn't always trigger
    // visibilitychange, and browsers may suspend the heartbeat while browsing.
    const online = () => wake();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('focus', wake);
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
        const files = Array.isArray(message.files) ? message.files as PdfManifest[] : [];
        setDocuments(files);
        hostFilesRef.current = files;
        for (const file of files) presentation.queue(file);
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
        hostFilesRef.current = [...hostFilesRef.current.filter(f => f.fileId !== file.fileId), file];
        presentation.queue(file);
      }
      if (type === 'cache.progress.request' && modeRef.current === 'host') {
        // Fresh snapshots after a phone rejoins; old completed transfers stay done.
        for (const file of hostFilesRef.current) {
          void presentation.progress(file).then(progress => {
            if (socket.connected && progress.bytes > 0) socket.send({
              type: 'cache.progress', fileId: file.fileId, bytes: progress.bytes,
            });
          }).catch(() => {});
        }
      }
      if (type === 'cache.progress' && modeRef.current === 'student' &&
          typeof message.fileId === 'string' &&
          typeof message.bytes === 'number' && Number.isSafeInteger(message.bytes) &&
          typeof message.size === 'number' && Number.isSafeInteger(message.size)) {
        const local = filesOnPhone.current.get(message.fileId);
        if (local && local.file.size === message.size && message.bytes >= 0 &&
            message.bytes <= local.file.size) {
          const update: CacheProgress = {
            fileId: message.fileId, size: local.file.size, bytes: message.bytes,
            complete: message.complete === true && message.bytes === local.file.size,
          };
          setStudentCacheProgress(current => ({
            ...current, [update.fileId]: retainNewestProgress(current[update.fileId], update),
          }));
        }
      }
      if (type === 'host.offline') setHostAvailable(false);
      if (type === 'host.online') {
        setHostAvailable(true);
        if (modeRef.current === 'student') socket.send({ type: 'file.sync' });
      }
      if (type === 'join.pending') setJoinState('pending');
      if (type === 'join.accepted' || type === 'join.resumed') {
        setJoinState('accepted');
        setHostAvailable(true);
        setError('');
        socket.send({ type: 'file.sync' });
        if (Array.isArray(message.files)) reconcileFiles(message.files as PdfManifest[]);
        else socket.send({ type: 'file.sync' });
      }
      if (type === 'file.manifest' && Array.isArray(message.files)) {
        reconcileFiles(message.files as PdfManifest[]);
        for (const file of message.files as PdfManifest[]) {
          if (file.status === 'approved') preparePreview(file.fileId);
        }
      }
      if (type === 'preview.chunk') {
        const id = message.fileId;
        const part = message.part;
        const total = message.total;
        const data = message.data;
        if (typeof id !== 'string' || !Number.isSafeInteger(part) ||
            !Number.isSafeInteger(total) || typeof data !== 'string' ||
            Number(part) < 0 || Number(total) < 1 || Number(total) > 80 ||
            Number(part) >= Number(total) || data.length > 5000) return;
        let current = incomingPreviews.current.get(id);
        if (!current || current.parts.length !== total || Date.now() - current.created > 90_000) {
          perf.mark('preview-receive:' + id);
          current = { parts: new Array<string>(Number(total)), received: 0, created: Date.now() };
          incomingPreviews.current.set(id, current);
        }
        if (current.parts[Number(part)] === undefined) {
          current.parts[Number(part)] = data;
          current.received++;
        }
        if (current.received === total) {
          incomingPreviews.current.delete(id);
          perf.elapsed('preview_receive_ms', 'preview-receive:' + id);
          const url = 'data:image/jpeg;base64,' + current.parts.join('');
          if (url.length <= 390000 && modeRef.current === 'host') {
            // One preview serves both thumbnail grid and presenter; only the
            // picture fade is animated, not the surrounding card geometry.
            setDocumentPreviews(current => ({ ...current, [id]: url }));
            void presentation.savePreview(id, url);
          }
        }
      }
      if (type === 'file.state') {
        const file = message.file as PdfManifest | undefined;
        if (file && typeof file.fileId === 'string') {
          const local = filesOnPhone.current.get(file.fileId);
          if (local) {
            local.status = file.status;
            if (file.status === 'approved') {
              perf.elapsed('file_receipt_ms', 'offer:' + file.fileId, file.size);
              preparePreview(file.fileId);
            }
          }
          setSentFiles(existing => existing.map(item =>
            item.fileId === file.fileId ? { ...item, status: file.status } : item));
        }
      }
      if (type === 'join.rejected') { setJoinState('rejected'); setError('The teacher declined this connection.'); }
      if (type === 'file.pending' || type === 'file.approved' || type === 'file.rejected') {
        const status = type === 'file.pending' ? 'pending' : type === 'file.approved' ? 'approved' : 'rejected';
        const id = String(message.fileId);
        const current = filesOnPhone.current.get(id);
        if (current) {
          current.status = status;
          if (status === 'approved') {
            perf.elapsed('file_receipt_ms', 'offer:' + id, current?.file.size);
            preparePreview(id);
          }
        }
        setSentFiles(existing => existing.map(f => f.fileId === id ? { ...f, status } : f));
      }
      if (type === 'range.request') {
        void respondToRange(message);
      }
      if (type === 'room.closed') {
        if (modeRef.current === 'host') void presentation.clearRoom().catch(() => {});
        setError('This classroom session has ended.');
        setHostSession(null);
        sessionStorage.removeItem('flashview-host');
        setJoinState('idle');
        presentation.closeAll();
      }
      if (type === 'error') {
        const text = normalizedMessage(message);
        if (modeRef.current === 'student' && /host is offline|classroom connection interrupted|temporarily unavailable/i.test(text)) {
          // The teacher can briefly leave or reconnect; this is an expected
          // recoverable state and belongs in the bottom status pill.
          setHostAvailable(false);
        } else setError(text);
      }
    };

    if (initialSession) {
      presentation.setRoom(initialSession.code);
      socket.connect({ role: 'host', roomId: initialSession.roomId, token: initialSession.hostToken });
    }
    else if (initialJoin) socket.connect({ role: 'student', name: 'Student',
      ...(/^\d{6}$/.test(initialJoin) ? { code: initialJoin } : { joinToken: initialJoin }),
    });
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('focus', wake);
      window.removeEventListener('pageshow', online);
      window.removeEventListener('online', online);
      clearInterval(syncTimer);
      presentation.dispose();
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
      const readStart = perf.enabled ? performance.now() : 0;
      const bytes = await shared.file.slice(begin, end).arrayBuffer();
      if (perf.enabled) perf.record('sender_read_ms', performance.now() - readStart, { bytes: bytes.byteLength });
      if (!await socket.sendBytesWhenReady(requestId, fileId, begin, bytes)) {
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
      setCacheProgress({});
      setDownloadSpeed({});
      hostFilesRef.current = [];
      progressSentRef.current.clear();
      transferSamples.current.clear();
      presentation.setRoom(newSession.code);
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
    firstPageImages.current.clear();
    previewRendering.current.clear();
    previewDelivered.current.clear();
    previewFailed.current.clear();
    setSentFiles([]);
    setStudentCacheProgress({});
    setPhonePreviews({});
    setPillDismissed(false);
    setPillLeaving(false);
    setHostAvailable(true);
    modeRef.current = 'student';
    setMode('student');
    const key = joinCode.trim();
    const identifier = /^\d{6}$/.test(key) ? { code: key } : { joinToken: key };
    socket.connect({ role: 'student', name: studentName.trim() || 'Student', ...identifier });
  }

  async function addPdf(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    // File pickers on mobile can freeze timers and temporarily suspend sockets.
    // Resume immediately on selection instead of waiting for backoff/polling.
    socket.wake();
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
      perf.mark('offer:' + fileId);
      setSentFiles(current => [...current, { fileId, name: file.name, size: file.size, status: 'announcing' }]);
      setPillDismissed(false);
      setPillLeaving(false);
      if (!socket.connected || !hostAvailable) socket.wake();
      else offerLocalFile(fileId, entry);
    }
  }

  // The native file input fires 'cancel' when a picker is dismissed without
  // selection; React's InputHTMLAttributes doesn't expose this newer event.
  useEffect(() => {
    if (mode !== 'student' || joinState !== 'accepted') return;
    const input = fileInputRef.current;
    if (!input) return;
    const onCancel = () => socket.wake();
    input.addEventListener('cancel', onCancel);
    return () => input.removeEventListener('cancel', onCancel);
  }, [mode, joinState, socket]);

  function browseFiles(): void {
    socket.pauseHeartbeat();
    fileInputRef.current?.click();
  }

  function revoke(fileId: string): void {
    filesOnPhone.current.delete(fileId);
    firstPageImages.current.delete(fileId);
    previewDelivered.current.delete(fileId);
    previewFailed.current.delete(fileId);
    socket.send({ type: 'file.revoke', fileId });
    setSentFiles(current => current.map(f => f.fileId === fileId ? { ...f, status: 'offline' } : f));
  }

  async function endRoom(): Promise<void> {
    if (!hostSession || !endAcknowledged || ending) return;
    setEnding(true);
    try {
      // Do not delete students' original files or browser data belonging to other rooms.
      // If deletion fails, keep the room open instead of falsely claiming it was erased.
      await presentation.clearRoom();
      socket.send({ type: 'room.end' });
      sessionStorage.removeItem('flashview-host');
      setHostSession(null);
      setCacheProgress({});
      setDownloadSpeed({});
      transferSamples.current.clear();
      setEndConfirm(false);
      setEndAcknowledged(false);
      modeRef.current = 'welcome';
      setMode('welcome');
      socket.close();
    } catch {
      setError('Could not clear this room’s local PDF cache. Please retry before ending the room.');
    } finally { setEnding(false); }
  }

  async function switchToRoom(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (switchingRoom) return;
    const identifier = switchCode.trim();
    if (!/^\d{6}$/.test(identifier) &&
        !/^\d{6}\.[A-Za-z0-9_-]+$/.test(identifier)) {
      setError('Enter a valid six-digit room code or invitation token.');
      return;
    }
    setSwitchingRoom(true);
    try {
      // Discard only this room's cache; never touch files on student devices.
      if (hostSession) {
        await presentation.clearRoom();
        socket.send({ type: 'room.end' });
        sessionStorage.removeItem('flashview-host');
      }
      socket.close();
      presentation.dispose();
      setHostSession(null);
      setStudents([]);
      setDocuments([]);
      setCacheProgress({});
      setDownloadSpeed({});
      hostFilesRef.current = [];
      progressSentRef.current.clear();
      setStudentCacheProgress({});
      setPhonePreviews({});
      setPillDismissed(false);
      setPillLeaving(false);
      setJoinDialogOpen(false);
      setJoinCode(identifier);
      setJoinState('idle');
      setError('');
      modeRef.current = 'student';
      setMode('student');
      window.history.replaceState({}, '', '/?join=' + encodeURIComponent(identifier));
      socket.connect({
        role: 'student',
        name: studentName.trim() || 'Student',
        ...(/^\d{6}$/.test(identifier) ? { code: identifier } : { joinToken: identifier }),
      });
    } catch {
      setError('Unable to clear the current room. Please try again.');
    } finally {
      setSwitchingRoom(false);
    }
  }

  async function copyInvite(): Promise<void> {
    if (!joinLink) return;
    try {
      await navigator.clipboard.writeText(joinLink);
      setCopied(true);
    } catch { setError('Could not copy invitation. Check your clipboard permissions.'); }
  }

  function startFresh(): void {
    if (modeRef.current === 'host' && hostSession) { setEndConfirm(true); return; }
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

  return (
    <div className={'app premium-app' + (mode === 'host' && hostSession ? ' is-host-workspace' : '')}>
      {!(mode === 'host' && hostSession) && (
      <header className="site-header">
        <div className="brand" onClick={startFresh} role="button" tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter') startFresh(); }} aria-label="FlashView home">
          <span className="brand-mark">F<span className="brand-asterisk">✳</span></span>
          <span>flashview<span className="brand-dot">.</span></span>
        </div>
        <div className="header-right">
          <span className="header-caption">An easier way to present.</span>
          {mode !== 'welcome' && <span className={'connection ' + socketStatus}><span className="status-dot"/>{statusText(socketStatus)}</span>}
        </div>
      </header>
      )}

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
          <div className="workspace premium-workspace">
            <div className="workspace-split">
              <aside className="workspace-left" aria-label="Room invitation and participants">
                <div className="sidebar-brand" aria-label="FlashView">
                  flashview<span className="sidebar-brand-dot" aria-hidden="true">.</span>
                </div>
                <section className="room-card premium-invite" aria-label="Live room QR code">
                  <div className="qr-side">
                    <div className="qr-plate">
                      <QRCodeSVG value={joinLink} size={244} marginSize={1} bgColor="#ffffff" fgColor="#151619"/>
                    </div>
                  </div>
                  <div className="invite-content">
                    <div className="room-code-label">ROOM CODE</div>
                    <div className="room-code">{hostSession.code}</div>
                    <div className="invite-actions">
                      <button type="button" className="primary-button" onClick={() => void copyInvite()}>
                        {copied ? 'Copied' : 'Copy link'} <span aria-hidden="true">{copied ? '✓' : '↗'}</span>
                      </button>
                      <button type="button" className="outline-button end-room-button"
                        onClick={() => setEndConfirm(true)}>End session</button>
                    </div>
                    <button type="button" className="outline-button join-another-button" onClick={() => {
                      setSwitchCode('');
                      setJoinDialogOpen(true);
                    }}>Join another room <span aria-hidden="true">↗</span></button>
                  </div>
                </section>
                <section className="sidebar-participants" aria-label="Participants">
                  <div className="sidebar-participants-heading">
                    <h2>Participants</h2>
                    <span className="sidebar-participant-count">{students.length}</span>
                    <span className={'connection sidebar-connection ' + socketStatus} title={statusText(socketStatus)}
                      aria-label={statusText(socketStatus)}><span className="status-dot"/></span>
                  </div>
                  <div className="sidebar-participants-scroll">
                    {students.length === 0 &&
                      <p className="sidebar-participants-empty">No one has joined yet.</p>}
                    {students.filter(s => !s.approved).map(s => (
                      <div className="approval sidebar-approval" key={s.id}>
                        <span className="participant-avatar" aria-hidden="true">{s.name.trim().charAt(0).toUpperCase() || '?'}</span>
                        <span className="participant-info"><strong>{s.name}</strong><small>Waiting for approval</small></span>
                        <div className="participant-actions">
                          <button className="mini-accept" onClick={() => socket.send({ type: 'student.accept', studentId: s.id })}>Allow</button>
                          <button className="mini-reject" onClick={() => socket.send({ type: 'student.reject', studentId: s.id })} aria-label={'Decline ' + s.name}>×</button>
                        </div>
                      </div>
                    ))}
                    {students.filter(s => s.approved).map(s => (
                      <div className="participant-row" key={s.id}>
                        <span className="participant-avatar" aria-hidden="true">{s.name.trim().charAt(0).toUpperCase() || '?'}</span>
                        <span className="participant-info"><strong>{s.name}</strong><small>Connected</small></span>
                        <span className="participant-online" aria-label="Approved">●</span>
                      </div>
                    ))}
                  </div>
                </section>
              </aside>
              <section className="workspace-right" aria-label="Shared documents" data-testid="documents-scroll-region">
                <div className="document-column">
                  <div className="list-heading">
                    <div className="list-heading-title">
                      <h1>Documents <sup>{documents.filter(f => f.status !== 'rejected').length}</sup></h1>
                    </div>
                    <button type="button" className="subtle-link" onClick={() => socket.send({ type: 'room.sync' })}
                      aria-label="Refresh submissions" title="Refresh submissions">↻</button>
                  </div>
                  <div className="document-list document-grid">
                    {documents.filter(f => f.status !== 'rejected').length === 0 && (
                      <div className="empty-list">
                        <span className="empty-art" aria-hidden="true">▤</span>
                        <h3>Nothing shared yet</h3>
                        <p>Once a participant shares a PDF, it will appear here.</p>
                      </div>
                    )}
                    {documents.filter(f => f.status !== 'rejected').map(file => (
                      <DocumentCard key={file.fileId}
                        file={file} previewUrl={documentPreviews[file.fileId]}
                        progress={cacheProgress[file.fileId]}
                        bytesPerSecond={downloadSpeed[file.fileId]}
                        onPresent={() => {
                          try { presentation.open(file, Boolean(cacheProgress[file.fileId]?.complete)); }
                          catch (e) { setError(e instanceof Error ? e.message : 'Unable to open presentation'); }
                        }}/>
                    ))}
                  </div>

                </div>
              </section>
            </div>
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
                <div className="upload-target" onClick={browseFiles} role="button" tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter') browseFiles(); }}>
                  <span className="upload-glyph">↑</span><h2>Choose a PDF to share.</h2>
                  <p>Your teacher will see the file name immediately and can open pages on demand.</p>
                  <button className="primary-button" onClick={e => { e.stopPropagation(); browseFiles(); }}>Browse files <span>↗</span></button>
                  <small>PDF files only · Up to 50 MB</small>
                </div>
                <input ref={fileInputRef} type="file" accept=".pdf,application/pdf" multiple hidden onChange={addPdf}/>
                {sentFiles.length > 0 && <section className="sent-list student-transfer-section" aria-label="Your uploads">
                  <header className="student-transfer-heading">
                    <h3>Your files</h3>
                    <span>{transferSummary.ready} of {transferSummary.count} ready</span>
                  </header>
                  <div className="student-files-grid">
                    {sentFiles.map(f => <StudentTransferCard key={f.fileId} file={f}
                      progress={studentCacheProgress[f.fileId]} preview={phonePreviews[f.fileId]}
                      onStop={() => revoke(f.fileId)}/>)}
                  </div>
                  <p className="student-transfer-hint">{transferSummary.complete ?
                    'All files are saved on the classroom computer. You can leave this page.' :
                    'Keep this page open until every file shows a checkmark.'}</p>
                </section>}
              </div>
            )}
            {joinState === 'rejected' && <button className="outline-button" onClick={startFresh}>Return home →</button>}

            <button className="subtle-link return-home" onClick={startFresh}>← Back to home</button>
            {showTransferPill && <TransferPill connecting={studentNeedsConnection}
              leaving={pillLeaving && transferSummary.complete}
              summary={transferSummary} onReconnect={() => {
                socket.wake();
                if (socket.connected) socket.send({ type: 'file.sync' });
              }}/>}
          </div>
        )}
        {joinDialogOpen && mode === 'host' && hostSession && (
          <div className="dialog-backdrop" onMouseDown={event => {
            if (event.target === event.currentTarget && !switchingRoom) setJoinDialogOpen(false);
          }}>
            <section className="end-dialog switch-dialog" role="dialog" aria-modal="true" aria-labelledby="switch-title">
              <div className="eyebrow">JOIN ANOTHER ROOM</div>
              <h2 id="switch-title">Have a room code?</h2>
              <p>Enter the six-digit code shared by your teacher. Joining will end your current room and clear its saved PDF copies on this computer.</p>
              <form className="join-form" onSubmit={event => void switchToRoom(event)}>
                <label htmlFor="switch-code">ROOM CODE</label>
                <input id="switch-code" inputMode="numeric" autoFocus required autoComplete="off"
                  placeholder="000 000" value={switchCode} onChange={event => setSwitchCode(event.target.value.replace(/\s/g, ''))}/>
                <label htmlFor="switch-name">YOUR NAME <span>(optional)</span></label>
                <input id="switch-name" maxLength={32} placeholder="Your name" value={studentName}
                  onChange={event => setStudentName(event.target.value)}/>
                <div className="end-dialog-actions">
                  <button type="button" className="outline-button" disabled={switchingRoom} onClick={() => setJoinDialogOpen(false)}>Cancel</button>
                  <button type="submit" className="primary-button" disabled={switchingRoom}>{switchingRoom ? 'Joining…' : 'Join room →'}</button>
                </div>
              </form>
            </section>
          </div>
        )}
        {endConfirm && mode === 'host' && hostSession && (
          <div className="dialog-backdrop">
            <section className="end-dialog" role="dialog" aria-modal="true" aria-labelledby="end-title">
              <div className="eyebrow">END SESSION / {hostSession.code}</div>
              <h2 id="end-title">End this classroom?</h2>
              <p>This will close all presentation tabs, disconnect students, and delete the PDFs
                and previews FlashView has cached on <strong>this computer</strong> for this room.</p>
              <p>Original PDFs on students' devices won't be touched. This action cannot be undone.</p>
              <label className="end-check">
                <input type="checkbox" checked={endAcknowledged}
                  onChange={event => setEndAcknowledged(event.target.checked)}/>
                I understand that cached room files will be deleted.
              </label>
              <div className="end-dialog-actions">
                <button className="outline-button" disabled={ending} onClick={() => {
                  setEndConfirm(false); setEndAcknowledged(false);
                }}>Keep room open</button>
                <button className="end-danger" disabled={!endAcknowledged || ending}
                  onClick={() => void endRoom()}>{ending ? 'Clearing…' : 'End & clear cache'}</button>
              </div>
            </section>
          </div>
        )}
        {error && <div className="global-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss">×</button></div>}
      </main>
      <PerfPanel/>
      <footer className="site-footer"><span>FLASHVIEW / AN OPEN CLASSROOM PROJECT</span><span>Designed for the time between sharing and seeing.</span></footer>
    </div>
  );
}
