import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { PixelIcon } from './PixelIcon';
import { assignParticipantColors } from './participantColors';
import { MAX_FILE_BYTES, MAX_STUDENT_FILES, type PdfManifest, type StudentInfo } from '../shared/protocol';
import { isPdfName, isPowerPointName, safeDownloadName } from '../shared/fileTypes';
import { RoomSocket, type ServerMessage, type SocketStatus } from './socket';
import { formatBytes } from './pdf/Viewer';
import { makeFirstPagePreview } from './pdf/firstPagePreview';
import { PresentationHost } from './presentation';
import { DocumentCard } from './DocumentCard';
import { StudentTransferCard } from './StudentTransferCard';
import { TransferPill } from './TransferPill';
import { summarizeTransfers } from './transferProgress';
import { cleanExpiredRoomCaches, readCompletedBlob, readCompletedFile, type CacheProgress } from './pdf/roomCache';
import { PerfPanel } from './PerfPanel';
import { fileAccentStyle } from './fileAccent';
import { perf } from './perf';
/** A late initial IndexedDB snapshot must never rewind live saved-byte progress. */
function retainNewestProgress(previous: CacheProgress | undefined, incoming: CacheProgress): CacheProgress {
  // An independent IndexedDB verification can retract a stale 100% cache.
  // Normal live byte progress stays monotonic so an old snapshot cannot rewind it.
  if (incoming.corrected || !previous || previous.size !== incoming.size) return incoming;
  return incoming.bytes >= previous.bytes ? incoming : previous;
}

type Mode = 'welcome' | 'host' | 'student';
type HostSession = { roomId: string; code: string; joinToken: string; hostToken: string; autoApprove?: boolean };
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
// Open the upload workspace on the first render, before QR authentication.
const initialJoinRoomCode = /^\d{6}(?=\.|$)/.exec(initialJoin)?.[0] ?? '';

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
  // Serialize thumbnail rendering on low-powered phones. Upload requests are
  // offered first and handled independently of this cosmetic work.
  const previewRenderQueue = useRef<Promise<void>>(Promise.resolve());
  const previewDelivered = useRef(new Set<string>());
  const previewFailed = useRef(new Set<string>());
  const incomingPreviews = useRef(new Map<string, { parts: string[]; received: number; created: number }>());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modeRef = useRef<Mode>(initialSession ? 'host' : initialJoin ? 'student' : 'welcome');
  const [mode, setMode] = useState<Mode>(initialSession ? 'host' : initialJoin ? 'student' : 'welcome');
  const [hostSession, setHostSession] = useState<HostSession | null>(initialSession);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>('disconnected');
  const [error, setError] = useState('');
  const [blockedStorageFiles, setBlockedStorageFiles] = useState<string[]>([]);
  const [retryingBlockedStorage, setRetryingBlockedStorage] = useState(false);
  const [joinCode, setJoinCode] = useState(initialJoin);
  const [studentName, setStudentName] = useState('');
  const [joinState, setJoinState] = useState<'idle' | 'connecting' | 'pending' | 'accepted' | 'rejected'>(initialJoin ? 'connecting' : 'idle');
  const [students, setStudents] = useState<StudentInfo[]>([]);
  const [documents, setDocuments] = useState<PdfManifest[]>([]);
  const [participantColors, setParticipantColors] = useState<Record<string,string>>({});
  const [sentFiles, setSentFiles] = useState<Array<{ fileId: string; name: string; size: number; status: ShareStatus }>>([]);
  const [busy, setBusy] = useState(false);
  const [autoApprove, setAutoApprove] = useState(true);
  const [currentRoomCode, setCurrentRoomCode] = useState(initialJoinRoomCode);
  const [cacheProgress, setCacheProgress] = useState<Record<string, CacheProgress>>({});
  const [studentCacheProgress, setStudentCacheProgress] = useState<Record<string, CacheProgress>>({});
  const [phonePreviews, setPhonePreviews] = useState<Record<string, string>>({});
  const [hostAvailable, setHostAvailable] = useState(true);
  const hostFilesRef = useRef<PdfManifest[]>([]);
  // Do not mistake "WebSocket.send returned" for "relay stored completion".
  // The relay explicitly receipts an idempotent completion message; if its
  // receipt is missed, the next low-frequency room sync will retry it.
  const completionAcks = useRef(new Set<string>());
  const completionLastSent = useRef(new Map<string, number>());
  const cacheProgressSnapshot = useRef(cacheProgress);
  cacheProgressSnapshot.current = cacheProgress;
  const acknowledgeComplete = (fileId: string, bytes: number): void => {
    if (modeRef.current !== 'host' || !socket.connected || completionAcks.current.has(fileId)) return;
    const now = Date.now();
    if (now - (completionLastSent.current.get(fileId) ?? -Infinity) < 7000) return;
    if (socket.send({ type: 'cache.progress', fileId, bytes }))
      completionLastSent.current.set(fileId, now);
  };
  const [documentPreviews, setDocumentPreviews] = useState<Record<string, string>>({});
  const previewLookups = useRef(new Set<string>());
  const previewRoom = useRef(initialSession?.code ?? '');
  // PPTX thumbnails are host-only, complete-file-only cosmetic work.
  // Serialize idle jobs and never run alongside a background file transfer.
  const pptxThumbAttempts = useRef(new Map<string, number>());
  const pptxThumbQueue = useRef<Promise<void>>(Promise.resolve());
  const [pptxThumbnailRetryTick, triggerPptxThumbnailRetry] = useState(0);
  const thumbnailTransferBusy = useRef(false);
  thumbnailTransferBusy.current = documents.some(file =>
    file.status === 'approved' && !cacheProgress[file.fileId]?.complete);
  const transferSamples = useRef(new Map<string, { bytes: number; time: number }>());
  const [downloadSpeed, setDownloadSpeed] = useState<Record<string, number>>({});
  const [savingFiles, setSavingFiles] = useState<Record<string, boolean>>({});
  const [queueView, setQueueView] = useState<'grid' | 'list'>('grid');
  const [mobileHostConfigOpen, setMobileHostConfigOpen] = useState(false);
  const [endConfirm, setEndConfirm] = useState(false);
  const [endAcknowledged, setEndAcknowledged] = useState(false);
  const [ending, setEnding] = useState(false);
  const [copied, setCopied] = useState(false);
  const transferSummary = summarizeTransfers(sentFiles, studentCacheProgress);
  const [showDonePill, setShowDonePill] = useState(false);
  // Assign by participant ID, not by file or display name. Existing colors
  // never shift when another student joins, leaves, or sends another file.
  useEffect(() => {
    if (mode !== 'host') return;
    const ids = [...students.map(student => student.id),
      ...documents.map(file => file.ownerId)];
    setParticipantColors(current => assignParticipantColors(current, ids));
  }, [mode, students, documents]);
  // The host confirms whole files, not incremental byte counts.
  useEffect(() => {
    if (mode !== 'student' || !transferSummary.complete) {
      setShowDonePill(false);
      return;
    }
    setShowDonePill(true);
    const timer = setTimeout(() => setShowDonePill(false), 3300);
    return () => clearTimeout(timer);
  }, [mode, transferSummary.complete, transferSummary.count]);
  const connectionInterrupted = socketStatus !== 'connected' || !hostAvailable;
  const transferPhase: 'connecting' | 'uploading' | 'done' | null =
    mode !== 'student' || joinState !== 'accepted' ? null :
      // A temporary disconnect does not change upload semantics: the
      // student must keep this page open until the host confirms completion.
      !transferSummary.complete && transferSummary.count > 0 ? 'uploading' :
      showDonePill && transferSummary.complete ? 'done' :
      connectionInterrupted ? 'connecting' : null;

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
        // Only finished PDFs need an acknowledgement during host restoration.
        if (progress.complete) acknowledgeComplete(file.fileId, file.size);
        else if (socket.connected && file.cachedBytes === file.size) {
          // Clear an old "Done" when the host's cached bytes were deleted.
          socket.send({ type: 'cache.progress', fileId: file.fileId, bytes: 0, snapshot: true });
        }
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

  // Do not burden mobile senders with PowerPoint parsing or add preview
  // packets to the relay. Once ALL approved files are fully cached on the
  // host, make small first-slide JPEG thumbnails using the existing OOXML
  // engine. This occurs at idle priority; downloads always come first.
  useEffect(() => {
    const room = hostSession?.code;
    if (!room || mode !== 'host') return;
    if (thumbnailTransferBusy.current) return;
    for (const file of documents) {
      if (!isPowerPointName(file.name) || !cacheProgress[file.fileId]?.complete ||
          documentPreviews[file.fileId]) continue;
      const key = room + '/' + file.fileId;
      const attempt = pptxThumbAttempts.current.get(key) ?? 0;
      if (attempt >= 2) continue;
      pptxThumbAttempts.current.set(key, attempt + 1);
      pptxThumbQueue.current = pptxThumbQueue.current.catch(() => {}).then(async () => {
        // Yield both parsing and JPEG encoding until the browser has breathing
        // room. Never initiate PPTX thumbnail work from the phone.
        await new Promise<void>(resolve => {
          if ('requestIdleCallback' in window) window.requestIdleCallback(() => resolve(), { timeout: 4000 });
          else setTimeout(resolve, 350);
        });
        if (previewRoom.current !== room || modeRef.current !== 'host') return;
        if (thumbnailTransferBusy.current) {
          // A fresh upload began while we were waiting for idle time.
          pptxThumbAttempts.current.delete(key);
          return;
        }
        const bytes = await readCompletedFile(room, file);
        if (!bytes || previewRoom.current !== room) throw Error('Complete PPTX cache unavailable');
        const { makePowerPointThumbnail } = await import('./pptx/makeThumbnail');
        const preview = await makePowerPointThumbnail(bytes);
        if (!preview || previewRoom.current !== room) throw Error('Thumbnail rendering returned no image');
        await presentation.savePreview(file.fileId, preview);
        if (previewRoom.current === room)
          setDocumentPreviews(current => current[file.fileId]
            ? current : { ...current, [file.fileId]: preview });
      }).catch(error => {
        // Don't permanently silence a transient browser/image decode failure.
        // Only one delayed retry; never let retries affect the transfer queue.
        console.warn('[FlashView] PPTX thumbnail attempt failed:', error);
        if (attempt === 0 && previewRoom.current === room) {
          setTimeout(() => {
            if (previewRoom.current === room)
              triggerPptxThumbnailRetry(value => value + 1);
          }, 8_000);
        }
      });
    }
  }, [hostSession?.code, mode, documents, cacheProgress, documentPreviews, presentation, pptxThumbnailRetryTick]);

  function offerLocalFile(id: string, entry: SharedFile): void {
    if (entry.status === 'rejected' || entry.status === 'offline') return;
    socket.send({ type: 'file.offer', fileId: id, name: entry.file.name, size: entry.file.size });
  }

  /** Restore progress from the authenticated relay's file manifest.
   * A mobile picker can suspend this page and lose all live progress events.
   */
  function acceptCachedManifest(file: PdfManifest): void {
    const local = filesOnPhone.current.get(file.fileId);
    if (!local || local.file.size !== file.size ||
        typeof file.cachedBytes !== 'number' || !Number.isSafeInteger(file.cachedBytes) ||
        file.cachedBytes < 0 || file.cachedBytes > file.size) return;
    const update: CacheProgress = {
      fileId: file.fileId, size: file.size, bytes: file.cachedBytes,
      complete: file.cachedBytes === file.size,
    };
    // A manifest is authoritative, including downward correction if the
    // teacher's browser storage was cleared after an earlier completion.
    // Live push events are still monotonic; only explicit sync may reset.
    setStudentCacheProgress(current => ({
      ...current, [file.fileId]: update,
    }));
  }

  /** Server manifest is the source of truth; recover any lost file.offer messages. */
  function reconcileFiles(serverFiles: PdfManifest[]): void {
    const known = new Map(serverFiles.map(file => [file.fileId, file]));
    for (const file of serverFiles) acceptCachedManifest(file);
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
    // Keep JSON frames under the relay's strict 8 KiB control-message
    // cap. A compact 70 KB JPEG needs at most 14 such frames, not ~75.
    const size = 6_800;
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

  function prepareLocalPreview(fileId: string): void {
    const shared = filesOnPhone.current.get(fileId);
    if (!shared || !isPdfName(shared.file.name) || shared.status === 'offline' || shared.status === 'rejected' ||
        previewFailed.current.has(fileId) || firstPageImages.current.has(fileId) ||
        previewRendering.current.has(fileId)) return;
    previewRendering.current.add(fileId);
    // Local thumbnail generation is separate from admission and delivery.
    // Only one phone canvas/PDF.js render is active at a time; the network
    // sender remains free to serve bytes concurrently.
    previewRenderQueue.current = previewRenderQueue.current.catch(() => {}).then(async () => {
      if (!filesOnPhone.current.has(fileId)) return;
      perf.mark('preview:' + fileId);
      try {
        const url = await makeFirstPagePreview(shared.file);
        perf.elapsed('preview_generate_ms', 'preview:' + fileId, shared.file.size);
        if (!filesOnPhone.current.has(fileId)) return;
        firstPageImages.current.set(fileId, url);
        // This is the phone's own File, not a JPEG sent back from the host.
        setPhonePreviews(current => ({ ...current, [fileId]: url }));
        if (shared.status === 'approved') sendPreview(fileId, url);
      } catch {
        if (perf.enabled) perf.elapsed('preview_generate_ms', 'preview:' + fileId, shared.file.size);
        previewFailed.current.add(fileId);
      }
    }).finally(() => previewRendering.current.delete(fileId));
  }

  function preparePreview(fileId: string): void {
    const shared = filesOnPhone.current.get(fileId);
    if (!shared || !isPdfName(shared.file.name) ||
        shared.status !== 'approved' || previewDelivered.current.has(fileId)) return;
    const saved = firstPageImages.current.get(fileId);
    if (saved) sendPreview(fileId, saved);
    // Never start expensive PDF.js work synchronously on a file approval:
    // the selection handler already schedules the independent local preview
    // at an idle opportunity after the transfer has been announced.
  }

  useEffect(() => {
    socket.onStatus = status => {
      setSocketStatus(status);
      if (status === 'connected') {
        if (modeRef.current === 'host') {
          completionAcks.current.clear();
          completionLastSent.current.clear();
        }
        presentation.resume();
        if (modeRef.current === 'student') {
          // A file selected during mobile reconnect must be announced as
          // soon as the new connection is authenticated, not 20 seconds later.
          socket.send({ type: 'file.sync' });
          for (const [fileId, entry] of filesOnPhone.current)
            if (entry.status === 'announcing') offerLocalFile(fileId, entry);
        }
      }
      // Only after a genuine drop is a preview eligible for retransmission.
      if (status === 'disconnected' && modeRef.current === 'student') {
        previewDelivered.current.clear();
      }
    };
    presentation.onProgress = progress => {
      if (progress.corrected) {
        // The relay may already have receipted the previous completed state.
        // Explicitly clear it so the phone no longer shows a false Done.
        completionAcks.current.delete(progress.fileId);
        completionLastSent.current.delete(progress.fileId);
        if (socket.connected) socket.send({
          type: 'cache.progress', fileId: progress.fileId, bytes: 0, snapshot: true,
        });
      }
      if (progress.bytes > 0)
        setError(previous => previous.startsWith('File transfer stalled') ? '' : previous);
      setCacheProgress(existing => ({
        ...existing, [progress.fileId]: retainNewestProgress(existing[progress.fileId], progress),
      }));
      // Single acknowledgement AFTER IndexedDB confirms the entire PDF.
      // Intermediate progress stays local; it cannot slow PDF byte delivery.
      if (progress.complete) acknowledgeComplete(progress.fileId, progress.size);
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
    presentation.onStorageBlocked = fileId => {
      setBlockedStorageFiles(current => current.includes(fileId) ? current : [...current, fileId]);
      setRetryingBlockedStorage(false);
    };
    presentation.onStorageRecovered = fileId => {
      setBlockedStorageFiles(current => current.filter(id => id !== fileId));
      setRetryingBlockedStorage(false);
    };
    presentation.onStalled = () => setError(
      'File transfer stalled. FlashView is reconnecting and retrying automatically; keep both devices open.',
    );
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
    const online = () => {
      if (document.visibilityState !== 'visible') {
        socket.pauseHeartbeat(true);
        return;
      }
      socket.wake('online');
      wake();
    };
    const freeze = () => socket.pauseHeartbeat(true);
    const pagehide = (event: PageTransitionEvent) => {
      if (event.persisted) freeze();
    };
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('freeze', freeze);
    document.addEventListener('resume', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('pageshow', wake);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('online', online);
    // Repair missed WebSocket notifications while the page is actually in use.
    // This is lightweight metadata, NOT a full PDF transfer.
    const syncTimer = setInterval(() => {
      if (!socket.connected || document.visibilityState !== 'visible') return;
      if (modeRef.current === 'host') {
        socket.send({ type: 'room.sync' });
        // Only whole-file receipts; never add per-chunk relay metadata traffic.
        for (const file of hostFilesRef.current) {
          if (cacheProgressSnapshot.current[file.fileId]?.complete)
            acknowledgeComplete(file.fileId, file.size);
        }
      } else if (modeRef.current === 'student') {
        socket.send({ type: 'file.sync' });
        // Retry only file announcements for which no server receipt arrived.
        for (const [id, entry] of filesOnPhone.current) {
          if (entry.status === 'announcing') offerLocalFile(id, entry);
        }
      }
    }, 20_000);
    socket.onMessage = message => {
      const type = message.type;
      if (type === 'cache.progress.receipt' && modeRef.current === 'host' &&
          typeof message.fileId === 'string' &&
          typeof message.bytes === 'number') {
        const file = hostFilesRef.current.find(file => file.fileId === message.fileId);
        if (file && file.size === message.bytes) {
          completionAcks.current.add(file.fileId);
          completionLastSent.current.delete(file.fileId);
        }
      }
      if (type === 'room.state') {
        setStudents(Array.isArray(message.students) ? message.students as StudentInfo[] : []);
        const files = Array.isArray(message.files) ? message.files as PdfManifest[] : [];
        setDocuments(files);
        if (typeof message.autoApprove === 'boolean') {
          setHostSession(previous => previous ? { ...previous, autoApprove: message.autoApprove as boolean } : previous);
        }
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
      if (type === 'join.pending') {
        if (typeof message.roomCode === 'string') setCurrentRoomCode(message.roomCode);
        setJoinState('pending');
      }
      if (type === 'join.accepted' || type === 'join.resumed') {
        if (typeof message.roomCode === 'string') setCurrentRoomCode(message.roomCode);
        setJoinState('accepted');
        setHostAvailable(true);
        // Joining can finish after a quick file selection. Preserve local
        // validation errors (for example an eleventh file) across that reply.
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
        // PDF thumbnails are the only preview format. Unknown binary files
        // must never be interpreted or displayed as active document content.
        if (typeof id !== 'string' ||
            !hostFilesRef.current.some(f => f.fileId === id && isPdfName(f.name))) return;
        const part = message.part;
        const total = message.total;
        const data = message.data;
        if (typeof id !== 'string' || !Number.isSafeInteger(part) ||
            !Number.isSafeInteger(total) || typeof data !== 'string' ||
            Number(part) < 0 || Number(total) < 1 || Number(total) > 80 ||
            Number(part) >= Number(total) || data.length > 7000 ||
            (data.length > 5000 && Number(total) > 16)) return;
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
          acceptCachedManifest(file);
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
      if (type === 'join.rejected') {
        returnHome();
        setError('The teacher declined this connection.');
      }
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
        returnHome();
      }
      if (type === 'error') {
        const text = normalizedMessage(message);
        if (modeRef.current === 'student' &&
            /room not found|room expired|room is full|host is offline|invalid join/i.test(text)) {
          returnHome();
          setError(text);
        } else if (modeRef.current === 'student' &&
            /classroom connection interrupted|temporarily unavailable/i.test(text)) {
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
      document.removeEventListener('freeze', freeze);
      document.removeEventListener('resume', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('pageshow', wake);
      window.removeEventListener('pagehide', pagehide);
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
    setBlockedStorageFiles([]);
    setRetryingBlockedStorage(false);
    try {
      const response = await fetch('/api/rooms?autoApprove=' + (autoApprove ? '1' : '0'), { method: 'POST' });
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
      completionAcks.current.clear();
      completionLastSent.current.clear();
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
    setJoinState('connecting');
    filesOnPhone.current.clear();
    firstPageImages.current.clear();
    previewRendering.current.clear();
    previewDelivered.current.clear();
    previewFailed.current.clear();
    setSentFiles([]);
    setStudentCacheProgress({});
    setPhonePreviews({});
    const key = joinCode.trim();
    setCurrentRoomCode(/^\d{6}(?=\.|$)/.exec(key)?.[0] ?? '');
    setHostAvailable(true);
    modeRef.current = 'student';
    setMode('student');
    const identifier = /^\d{6}$/.test(key) ? { code: key } : { joinToken: key };
    socket.connect({ role: 'student', name: studentName.trim() || 'Student', ...identifier });
  }

  async function addFiles(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    // File pickers on mobile can freeze timers and temporarily suspend sockets.
    // Resume immediately on selection instead of waiting for backoff/polling.
    socket.wake();
    const input = event.target;
    const selectedFiles = Array.from(input.files ?? []);
    input.value = '';
    // Validate the whole selection before announcing it. PDF magic-byte
    // checks remain PDF-only; all other formats transfer unchanged.
    const batch: Array<{ fileId: string; entry: SharedFile }> = [];
    for (const file of selectedFiles) {
      // The relay counts all file manifests from this student, including
      // revoked ones. Reject surplus selections BEFORE adding a phantom
      // "Uploading" card that the server can never accept.
      if (filesOnPhone.current.size + batch.length >= MAX_STUDENT_FILES) {
        setError('This room allows up to ' + MAX_STUDENT_FILES +
          ' files per person. Start a new room to share more.');
        break;
      }
      if (file.size === 0 || file.size > MAX_FILE_BYTES) {
        setError(file.name + ' must be between 1 byte and 200 MiB.');
        continue;
      }
      try {
        if (isPdfName(file.name)) {
          const prefix = await file.slice(0, 1024).text();
          if (!prefix.includes('%PDF-')) {
            setError(file.name + ' is not a valid PDF.');
            continue;
          }
        }
        batch.push({
          fileId: crypto.randomUUID().replaceAll('-', ''),
          entry: { file, status: 'announcing' },
        });
      } catch {
        setError(file.name + ' could not be read. Please choose it again.');
      }
    }
    if (!batch.length) return;
    for (const { fileId, entry } of batch) {
      filesOnPhone.current.set(fileId, entry);
      perf.mark('offer:' + fileId);
    }
    setSentFiles(current => [...current, ...batch.map(({ fileId, entry }) => ({
      fileId, name: entry.file.name, size: entry.file.size, status: entry.status,
    }))]);
    // Announce the files before doing any decoding. Start a low-resolution
    // local preview shortly afterward; it never awaits host-side reception.
    // Authentication is sufficient to send a manifest. Even if the phone has
    // a stale host.offline notification, the relay can save the file offer
    // for the desktop when it returns.
    if (!socket.connected) socket.wake();
    else for (const { fileId, entry } of batch) offerLocalFile(fileId, entry);
    // Only PDFs generate preview JPEGs. No native decoding, execution, or
    // rendering is attempted for other arbitrary binary file formats.
    // Never rely on background-tab timers/idle callbacks here: Firefox can
    // suspend them, which would also delay the host's first-slide preview.
    // PDF.js decoding happens off the main thread and thumbnails stay small.
    for (const { fileId, entry } of batch) {
      if (isPdfName(entry.file.name)) prepareLocalPreview(fileId);
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

  async function downloadFile(file: PdfManifest): Promise<void> {
    if (savingFiles[file.fileId] || !hostSession) return;
    setSavingFiles(current => ({ ...current, [file.fileId]: true }));
    try {
      // Never download partial/corrupt files. The presenter and downloads
      // share the SAME already-committed 64 KiB browser cache.
      // Downloading only needs immutable browser-native Blob bytes, unlike
      // the presenter which needs a full JavaScript buffer for rendering.
      const blob = await readCompletedBlob(hostSession.code, file);
      if (!blob) throw Error('File is not fully cached yet. Retry once received.');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = safeDownloadName(file.name);
      link.style.display = 'none';
      document.body.appendChild(link);
      try { link.click(); } finally {
        link.remove();
        // Give the browser time to start saving before revoking its URL.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save this file.');
    } finally {
      setSavingFiles(current => ({ ...current, [file.fileId]: false }));
    }
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
      returnHome();
    } catch {
      setError('Could not clear this room’s local PDF cache. Please retry before ending the room.');
    } finally { setEnding(false); }
  }

  async function copyInvite(): Promise<void> {
    if (!joinLink) return;
    try {
      await navigator.clipboard.writeText(joinLink);
      setCopied(true);
    } catch { setError('Could not copy invitation. Check your clipboard permissions.'); }
  }

  function returnHome(): void {
    // Prevent stale socket notifications or QR invitations surviving an exit.
    modeRef.current = 'welcome';
    socket.close();
    presentation.closeAll();
    sessionStorage.removeItem('flashview-host');
    setMode('welcome');
    setHostSession(null);
    setJoinState('idle');
    setJoinCode('');
    setStudentName('');
    setCurrentRoomCode('');
    setHostAvailable(true);
    setError('');
    setBlockedStorageFiles([]);
    setRetryingBlockedStorage(false);
    setStudents([]);
    setDocuments([]);
    setParticipantColors({});
    setSentFiles([]);
    setCacheProgress({});
    setStudentCacheProgress({});
    setPhonePreviews({});
    setDocumentPreviews({});
    setDownloadSpeed({});
    setSavingFiles({});
    setQueueView('grid');
    setMobileHostConfigOpen(false);
    setEndConfirm(false);
    setEndAcknowledged(false);
    setCopied(false);
    setShowDonePill(false);
    hostFilesRef.current = [];
    completionAcks.current.clear();
    transferSamples.current.clear();
    filesOnPhone.current.clear();
    firstPageImages.current.clear();
    previewRendering.current.clear();
    previewDelivered.current.clear();
    previewFailed.current.clear();
    incomingPreviews.current.clear();
    previewLookups.current.clear();
    previewRoom.current = '';
    window.history.replaceState({}, '', '/');
  }

  function startFresh(): void {
    if (modeRef.current === 'host' && hostSession) { setEndConfirm(true); return; }
    returnHome();
  }

  const joinLink = hostSession ? window.location.origin + '/?join=' + encodeURIComponent(hostSession.joinToken) : '';

  return (
    <div className={'app premium-app' + (mode === 'host' && hostSession ? ' is-host-workspace' : '') +
      (mode === 'student' && (joinState === 'connecting' || joinState === 'accepted' || joinState === 'pending') ? ' is-student-room' : '')}>
      {mode !== 'host' && !(mode === 'student' && joinState !== 'idle' && joinState !== 'rejected') && (
        <header className="site-header reference-nav">
          <div className="brand" onClick={startFresh} role="button" tabIndex={0}
            onKeyDown={e=>{if(e.key==='Enter')startFresh();}} aria-label="FlashView home">
            <span className="reference-logo-mark" aria-hidden="true">
              <svg viewBox="0 0 26 26"><rect width="26" height="26" rx="8" fill="#0e0f14"/>
                <path d="M14.5 4 7 14.5h5L10.5 22 19 11h-5z" fill="#fff"/></svg>
            </span>
            <span>flashview</span>
          </div>
          <nav aria-label="Site navigation">
            <a href="#how">How it works</a>
            <a href="#privacy">Privacy</a>
            <a href="#how">Share any file</a>
          </nav>
          <button type="button" className="primary-button reference-pill nav-start"
            onClick={()=>document.getElementById('start-room')?.scrollIntoView({behavior:'smooth',block:'center'})}>
            Start a room
          </button>
        </header>
      )}
      <main className="app-content">
        {mode === 'welcome' && (
          <div className="welcome reference-welcome">
            <section className="reference-sky">
              <div className="reference-hero">
                <h1 className="reference-serif">From your phone, onto the big screen.</h1>
                <div className="reference-actions" id="start-room">
                  <div className="reference-pane host-card">
                    <div className="reference-pane-icon"><PixelIcon kind="folder"/></div>
                    <h2 className="reference-serif">Start a room on the board</h2>
                    <p>Open this on the classroom computer. Students scan the code and share files here.</p>
                    <div className="reference-pane-bottom">
                      <label className="reference-toggle">
                        <span><strong>Approve each person</strong><small>Off: anyone with the code can join</small></span>
                        <input type="checkbox" aria-label="Require approval" checked={!autoApprove}
                          onChange={event=>setAutoApprove(!event.target.checked)}/>
                        <span className="reference-switch" aria-hidden="true"/>
                      </label>
                      <button type="button" className="primary-button reference-pill"
                        disabled={busy} onClick={createRoom}>
                        {busy?'Creating…':'Create a room'}
                      </button>
                    </div>
                  </div>
                  <div className="reference-pane join-card">
                    <div className="reference-pane-icon"><PixelIcon kind="doc"/></div>
                    <h2 className="reference-serif">Send from your device</h2>
                    <p>Enter the six digits shown on the board, then choose your files.</p>
                    <form onSubmit={e=>{e.preventDefault();connectStudent();}} className="join-form reference-join-form">
                      <div className="reference-digits" aria-label="Six-digit room code">
                        {Array.from({length:6},(_,index)=>(
                          <input key={index} id={index===0?'code':undefined}
                            type="text" inputMode="numeric" autoComplete="off"
                            aria-label={index===0?'Room code':'Digit '+(index+1)}
                            maxLength={index===0?undefined:1}
                            value={joinCode[index]??''}
                            onChange={e=>{
                              const digits=e.target.value.replace(/\D/g,'');
                              if(digits.length>1){
                                setJoinCode(digits.slice(0,6));
                                return;
                              }
                              const updated=joinCode.padEnd(6,' ').split('');
                              updated[index]=digits||' ';
                              setJoinCode(updated.join('').trimEnd());
                              if(digits&&index<5)
                                (e.target.parentElement?.querySelectorAll('input')[index+1] as HTMLInputElement | undefined)?.focus();
                            }}
                            onKeyDown={e=>{
                              if(e.key==='Backspace'&&!e.currentTarget.value&&index>0)
                                (e.currentTarget.parentElement?.querySelectorAll('input')[index-1] as HTMLInputElement | undefined)?.focus();
                            }}
                            onPaste={e=>{
                              const pasted=e.clipboardData.getData('text').replace(/\D/g,'').slice(0,6);
                              if(pasted){e.preventDefault();setJoinCode(pasted);}
                            }}/>
                        ))}
                      </div>
                      <input id="student-name" className="reference-name-input"
                        placeholder="Your name (optional)" aria-label="Your name (optional)" maxLength={32}
                        value={studentName} onChange={e=>setStudentName(e.target.value)}/>
                      <button className="primary-button reference-pill" type="submit">Join room</button>
                    </form>
                  </div>
                </div>
              </div>
            </section>
            <section className="reference-section" id="how">
              <h2 className="reference-serif">Three steps between a phone and a smartboard.</h2>
              <ol className="reference-steps">
                <li><PixelIcon kind="folder"/><h3>Open the board</h3>
                  <p>The classroom computer shows a QR code and a six-digit code.</p></li>
                <li><PixelIcon kind="doc"/><h3>Scan, then pick a file</h3>
                  <p>Up to a whole class can join one room and send files at once.</p></li>
                <li><PixelIcon kind="folder"/><h3>Present instantly</h3>
                  <p>Open PDFs directly while their remaining bytes are still arriving.</p></li>
              </ol>
            </section>
            <section className="reference-section" id="privacy">
              <div className="reference-trust">
                <div><h3>No server file storage</h3>
                  <p>Files pass through a live relay and aren't stored on Cloudflare.</p></div>
                <div><h3>No accounts</h3>
                  <p>No Drive, email or messaging login on a shared classroom computer.</p></div>
                <div><h3>Clear when you end</h3>
                  <p>End the room to erase its browser cache. Save a copy only if you choose to.</p></div>
              </div>
            </section>
            <footer className="reference-footer">
              <span>Flashview. An easier way to present.</span>
              <span>Made for classrooms and conference rooms</span>
            </footer>
          </div>
        )}

        {mode === 'host' && hostSession && (
          <div className="workspace premium-workspace reference-room">
            <div className="workspace-split">
              <aside className={'workspace-left'+(mobileHostConfigOpen?' mobile-config-expanded':'')}
                aria-label="Room invitation and participants">
                <div className="mobile-host-toolbar">
                  <div className="mobile-host-identity">
                    <strong className="mobile-host-code">{hostSession.code}</strong>
                    <span className="mobile-host-byline">by flashview</span>
                  </div>
                  <button type="button" className="mobile-host-config-toggle"
                    aria-expanded={mobileHostConfigOpen} aria-controls="mobile-host-config-panel"
                    onClick={()=>setMobileHostConfigOpen(open=>!open)}>
                    Configure
                    <svg viewBox="0 0 20 20" aria-hidden="true">
                      <path d="m5 8 5 5 5-5" fill="none" stroke="currentColor"
                        strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                </div>
                <div className="mobile-host-config-panel" id="mobile-host-config-panel">
                  <div className="sidebar-brand" aria-label="FlashView">flashview</div>
                <section className="room-card premium-invite" aria-label="Live room QR code">
                  <div className="qr-side">
                    <div className="qr-plate">
                      <QRCodeSVG value={joinLink} size={244} marginSize={1} bgColor="#ffffff" fgColor="#0e0f14"/>
                    </div>
                  </div>
                  <div className="invite-content">
                    <div className="room-code-label">Or enter this code on FlashView</div>
                    <div className="room-code">{hostSession.code}</div>
                    <div className="invite-actions">
                      <button type="button" className="outline-button reference-pill"
                        onClick={()=>void copyInvite()}>{copied?'Link copied':'Copy link'}</button>
                      <button type="button" className="outline-button reference-pill end-room-button"
                        onClick={()=>setEndConfirm(true)}>End room</button>
                    </div>
                  </div>
                </section>
                <div className="room-admission-status">
                  <div><strong>Approve each person</strong>
                    <small>{hostSession.autoApprove?'Anyone with the code can join':'Each person waits for your OK'}</small></div>
                  <span className={'reference-switch visual-only'+(!hostSession.autoApprove?' is-on':'')} aria-hidden="true"/>
                </div>
                <section className="sidebar-participants" aria-label="Participants">
                  <div className="sidebar-participants-heading">
                    <h2>In the room · {students.filter(s=>s.approved).length}</h2>
                    <span className={'connection reference-room-connection '+socketStatus}
                      aria-label={'Room '+statusText(socketStatus)} title={statusText(socketStatus)}>
                      <span className="status-dot" aria-hidden="true"/>
                    </span>
                  </div>
                  <div className="sidebar-participants-scroll">
                    {students.some(s=>!s.approved)&&<span className="mobile-host-request-label">Requests to join</span>}
                    {students.length===0&&<p className="sidebar-participants-empty">No one has joined yet.</p>}
                    {students.filter(s=>!s.approved).map(s=>(
                      <div className="approval sidebar-approval" data-participant-id={s.id} key={s.id}>
                        <span className="participant-avatar" aria-hidden="true"
                          style={participantColors[s.id]?{'--participant-color':participantColors[s.id]} as CSSProperties:undefined}>{s.name.trim().charAt(0).toUpperCase()||'?'}</span>
                        <span className="participant-info"><strong>{s.name}</strong><small>Waiting for approval</small></span>
                        <div className="participant-actions">
                          <button className="mini-accept" onClick={()=>socket.send({type:'student.accept',studentId:s.id})}>Allow</button>
                          <button className="mini-reject" onClick={()=>socket.send({type:'student.reject',studentId:s.id})}
                            aria-label={'Decline '+s.name}>×</button>
                        </div>
                      </div>
                    ))}
                    {students.filter(s=>s.approved).map(s=>(
                      <div className="participant-row" data-participant-id={s.id} key={s.id}>
                        <span className="participant-avatar" aria-hidden="true"
                          style={participantColors[s.id]?{'--participant-color':participantColors[s.id]} as CSSProperties:undefined}>{s.name.trim().charAt(0).toUpperCase()||'?'}</span>
                        <span className="participant-info"><strong>{s.name}</strong><small>Connected</small></span>
                      </div>
                    ))}
                  </div>
                </section>
                </div>
              </aside>
              <section className="workspace-right" aria-label="Shared documents" data-testid="documents-scroll-region">
                <div className="document-column">
                  {blockedStorageFiles.length > 0 && (
                    <div className="storage-blocked" role="alert" data-testid="storage-blocked">
                      <strong>Browser storage is full — {blockedStorageFiles.length} {blockedStorageFiles.length === 1 ? 'file' : 'files'} paused.</strong>
                      <p>Free browser or device space, then retry saving. Keep senders connected.
                        Do not clear FlashView site data during this room; cached chunks may be lost.</p>
                      <button type="button" disabled={retryingBlockedStorage} onClick={() => {
                        setRetryingBlockedStorage(true);
                        presentation.retryBlockedStorage();
                      }}>{retryingBlockedStorage ? 'Retrying…' : 'Retry saving'}</button>
                    </div>
                  )}
                  <div className="list-heading">
                    <div className="list-heading-title">
                      <h1 className="reference-serif">Files <sup>{documents.filter(f=>f.status!=='rejected').length}</sup></h1>
                    </div>
                    <div className="reference-room-tools">
                      <div className="reference-view-selector" role="group" aria-label="View">
                        <button type="button" className={queueView==='grid'?'is-active':''}
                          aria-label="Grid view" aria-pressed={queueView==='grid'} onClick={()=>setQueueView('grid')}>
                          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>
                        </button>
                        <button type="button" className={queueView==='list'?'is-active':''}
                          aria-label="List view" aria-pressed={queueView==='list'} onClick={()=>setQueueView('list')}>
                          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className={'document-list document-grid'+(queueView==='list'?' is-list':'')}>
                    {documents.filter(f=>f.status!=='rejected').length===0&&(
                      <div className="empty-list">
                        <PixelIcon kind="folder"/>
                        <h3>Waiting for the first file</h3>
                        <p>Scan the code with your phone and send something.</p>
                      </div>
                    )}
                    {documents.filter(f=>f.status!=='rejected').map(file=>(
                      <DocumentCard key={file.fileId} file={file}
                        participantColor={participantColors[file.ownerId]}
                        previewUrl={documentPreviews[file.fileId]}
                        progress={cacheProgress[file.fileId]}
                        bytesPerSecond={downloadSpeed[file.fileId]}
                        onPresent={()=>{
                          const complete=Boolean(cacheProgress[file.fileId]?.complete);
                          if(!isPdfName(file.name)&&!(isPowerPointName(file.name)&&complete))return;
                          try{presentation.open(file,complete);}
                          catch(e){setError(e instanceof Error?e.message:'Unable to open presentation');}
                        }}
                        onDownload={()=>void downloadFile(file)}
                        saving={Boolean(savingFiles[file.fileId])}/>
                    ))}
                  </div>
                  <p className="reference-room-hint">Files stay only in this room's browser cache until you end the room. Download what you need before ending it.</p>
                </div>
              </section>
            </div>
          </div>
        )}

        {mode === 'host' && !hostSession && (
          <div className="simple-state"><h1>Room ended.</h1><p>Create a new classroom to continue.</p><button className="primary-button" onClick={startFresh}>Go home →</button></div>
        )}

        {mode === 'student' && (
          <div className={'student-screen' + (joinState === 'connecting' || joinState === 'accepted' || joinState === 'pending' ? ' room-files-screen' : '')}>
            {(joinState === 'idle' || joinState === 'rejected') && (
              <div className="room-entry">
                <div className="room-entry-kicker">JOIN A ROOM</div>
                <h1>Join your room</h1>
                {joinState === 'idle' ? (
                  <form onSubmit={e => { e.preventDefault(); connectStudent(); }} className="join-form">
                    <label htmlFor="join-code">Room link or code</label>
                    <input id="join-code" value={joinCode} autoComplete="off"
                      placeholder="Enter six-digit code" onChange={e => setJoinCode(e.target.value)} required/>
                    <label htmlFor="join-name">Your name <span>(optional)</span></label>
                    <input id="join-name" value={studentName} placeholder="Your name"
                      onChange={e => setStudentName(e.target.value)}/>
                    <button type="submit" className="primary-button">Join room</button>
                  </form>
                ) : <button type="button" className="outline-button" onClick={startFresh}>Back home</button>}
              </div>
            )}
            {(joinState === 'connecting' || joinState === 'accepted' || joinState === 'pending') && (
              <div className="student-drive">
                <header className="student-drive-header">
                  <div className="student-drive-header-copy">
                    <div className="student-drive-logo">flashview<span>.</span></div>
                    <span className="student-drive-room">Room {currentRoomCode || '••••••'}</span>
                  </div>
                  <button type="button" className="student-leave-button" onClick={startFresh}
                    aria-label="Leave room">Leave</button>
                </header>
                <div className="student-drive-body">
                  {joinState === 'pending' ? (
                    <div className="student-drive-pending" role="status">
                      <span className="spinner" aria-hidden="true"/>
                      <strong>Waiting to join</strong>
                      <p>The host will approve your request.</p>
                    </div>
                  ) : (
                    <>
                      <input ref={fileInputRef} type="file"
                        multiple hidden onChange={addFiles}/>
                      {sentFiles.some(f => f.status !== 'rejected') ? (
                        <section className="student-drive-content" aria-label="Your uploads">
                          <div className="student-files-grid">
                            {sentFiles.filter(f => f.status !== 'rejected').map(f =>
                              <StudentTransferCard key={f.fileId} file={f}
                                progress={studentCacheProgress[f.fileId]} preview={phonePreviews[f.fileId]}
                                onStop={() => revoke(f.fileId)}/>)}
                          </div>

                        </section>
                      ) : (
                        <div className="student-drive-empty">
                          <PixelIcon kind="folder" className="student-empty-pixel-icon"/>
                          <h2>{joinState === 'connecting' ? 'Ready to share' : 'No files yet'}</h2>
                          <p>{joinState === 'connecting' ? 'Connecting to your room…' : 'Tap New to share a file.'}</p>
                        </div>
                      )}
                      <div className="student-transfer-actions">
                        {transferPhase && <TransferPill phase={transferPhase}/>}
                        <button type="button" className="student-add-fab" onClick={browseFiles}
                          disabled={joinState !== 'accepted'}
                          aria-label="Add files" title="Add files"><span aria-hidden="true">+</span><span>New</span></button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
        {endConfirm && mode === 'host' && hostSession && (
          <div className="dialog-backdrop">
            <section className="end-dialog" role="dialog" aria-modal="true" aria-labelledby="end-title">
              <div className="eyebrow">END ROOM / {hostSession.code}</div>
              <h2 id="end-title">End this room?</h2>
              <p>This will close all presentation tabs, disconnect students, and delete the files
                and previews FlashView has cached on <strong>this computer</strong> for this room.</p>
              <p>Original files on students' devices won't be touched. This action cannot be undone.</p>
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
