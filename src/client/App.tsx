import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { PixelIcon } from './PixelIcon';
import { SiteHeader } from './SiteHeader';
import { JoinWelcome } from './JoinWelcome';
import { invitationFor, invitationUrl, readInvitation, rememberInvitation } from './joinInvitation';
import { assignParticipantColors, participantForeground } from './participantColors';
import { MAX_FILE_BYTES, MAX_STUDENT_FILES, type PdfManifest, type StudentInfo } from '../shared/protocol';
import { hostCacheIdentity } from '../shared/roomCacheIdentity';
import { isPdfName, isPowerPointName, safeDownloadName } from '../shared/fileTypes';
import { type ServerMessage, type SocketStatus } from './socket';
import { RoomTransferClient } from './transferClient';
import { formatBytes } from './formatBytes';
import { PresentationHost } from './presentation';
import { DocumentCard } from './DocumentCard';
import { StudentTransferCard } from './StudentTransferCard';
import { TransferPill } from './TransferPill';
import { summarizeTransfers } from './transferProgress';
import { cleanExpiredRoomCaches, readCompletedBlob, type CacheProgress } from './pdf/roomCache';
import { PerfPanel } from './PerfPanel';
import { fileAccentStyle } from './fileAccent';
import { perf } from './perf';
import { RoomLease, endRoomAndClear } from './roomControl';
import { RoomRevisionTracker } from './roomRevision';
/** A late initial IndexedDB snapshot must never rewind live saved-byte progress. */
function retainNewestProgress(previous: CacheProgress | undefined, incoming: CacheProgress): CacheProgress {
  // An independent IndexedDB verification can retract a stale 100% cache.
  // Normal live byte progress stays monotonic so an old snapshot cannot rewind it.
  if (incoming.corrected || !previous || previous.size !== incoming.size) return incoming;
  return incoming.bytes >= previous.bytes ? incoming : previous;
}

type Mode = 'welcome' | 'host' | 'student';
type HostSession = { roomId: string; code: string; joinToken: string; hostToken: string; autoApprove?: boolean;
  roomGeneration?: string; leaseToken?: string; cacheId?: string; closeRequested?: boolean; serverClosed?: boolean;
  participantColors?: Record<string,string> };
type ShareStatus = 'announcing' | 'pending' | 'approved' | 'rejected' | 'offline';
type SharedFile = { file: File; status: ShareStatus };

function savedSession(): HostSession | null {
  try {
    const stored = sessionStorage.getItem('flashview-host');
    if (!stored) return null;
    const candidate = JSON.parse(stored) as Partial<HostSession>;
    if (candidate.code) hostCacheIdentity(candidate as HostSession);
    return candidate.roomId && candidate.hostToken && candidate.code && candidate.joinToken
      ? candidate as HostSession : null;
  } catch { return null; }
}
const initialInvitation = readInvitation(new URL(window.location.href), window.history.state);
const initialSession = initialInvitation ? null : savedSession();
const initialJoin = initialInvitation?.credential ?? '';
const initialJoinRoomCode = initialInvitation?.code ?? '';

function statusText(status: SocketStatus): string {
  if (status === 'connected') return 'Connected';
  if (status === 'connecting') return 'Connecting';
  return 'Offline';
}
function normalizedMessage(message: ServerMessage): string {
  return typeof message.message === 'string' ? message.message : 'Something went wrong. Please retry.';
}

export function App() {
  const socket = useRef(new RoomTransferClient()).current;
  const roomVersions = useRef(new RoomRevisionTracker(initialSession?.roomGeneration)).current;
  const presentation = useRef(new PresentationHost(socket)).current;
  const hostLease = useRef(new RoomLease()).current;
  const hostSessionRef = useRef<HostSession | null>(initialSession);
  const closeRequestedRef = useRef(initialSession?.closeRequested === true);
  const endingRef = useRef(false);
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
  const admissionError = useRef('');
  const [blockedStorageFiles, setBlockedStorageFiles] = useState<string[]>([]);
  const [retryingBlockedStorage, setRetryingBlockedStorage] = useState(false);
  const [joinCode, setJoinCode] = useState(initialJoin);
  const [studentName, setStudentName] = useState(initialInvitation?.name ?? '');
  const [joinState, setJoinState] = useState<'idle' | 'connecting' | 'pending' | 'accepted' | 'rejected'>(initialInvitation?.entered ? 'connecting' : 'idle');
  const [students, setStudents] = useState<StudentInfo[]>([]);
  const [documents, setDocuments] = useState<PdfManifest[]>([]);
  // Shared-file ownership outlives live sockets, including stopped originals.
  const contributors = [...new Map(documents
    .filter(file => !file.deleted && (file.status === 'approved' || file.status === 'offline' || file.revoked))
    .map(file => [file.ownerId, { id: file.ownerId, name: file.ownerName }])).values()];
  const [participantColors, setParticipantColors] = useState<Record<string,string>>(() =>
    Object.fromEntries(Object.entries(initialSession?.participantColors ?? {}).filter(
      ([,color]) => typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color))));
  const [senderColor, setSenderColor] = useState<string>();
  const deliveredColors = useRef(new Map<string, {student: StudentInfo; color: string}>());
  const [sentFiles, setSentFiles] = useState<Array<{ fileId: string; name: string; size: number; status: ShareStatus }>>([]);
  const [busy, setBusy] = useState(false);
  const [autoApprove, setAutoApprove] = useState(true);
  const [currentRoomCode, setCurrentRoomCode] = useState(initialJoinRoomCode);
  const [cacheProgress, setCacheProgress] = useState<Record<string, CacheProgress>>({});
  const [studentCacheProgress, setStudentCacheProgress] = useState<Record<string, CacheProgress>>({});
  const [phonePreviews, setPhonePreviews] = useState<Record<string, string>>({});
  const [hostAvailable, setHostAvailable] = useState(true);
  const hostFilesRef = useRef<PdfManifest[]>([]);
  const [documentPreviews, setDocumentPreviews] = useState<Record<string, string>>({});
  const documentPreviewsRef = useRef(documentPreviews);
  documentPreviewsRef.current = documentPreviews;
  const previewLookups = useRef(new Set<string>());
  const activeCacheId = hostSession ? hostCacheIdentity(hostSession) : '';
  const previewRoom = useRef(initialSession ? hostCacheIdentity(initialSession) : '');
  // PPTX thumbnails are host-only, complete-file-only cosmetic work.
  // Serialize idle jobs and never run alongside a background file transfer.
  const pptxThumbAttempts = useRef(new Map<string, number>());
  const pptxThumbPending = useRef(new Set<string>());
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
  useEffect(() => {
    const session = hostSessionRef.current;
    if (mode !== 'host' || !session) return;
    // Keep ownership colors stable when the host refreshes after someone leaves.
    const updated = {...session,participantColors};
    hostSessionRef.current = updated;
    try { sessionStorage.setItem('flashview-host',JSON.stringify(updated)); } catch { /* Cosmetic only. */ }
  }, [mode, participantColors]);
  // Cosmetic metadata travels on membership/reconnect changes, never per chunk.
  useEffect(() => {
    if (mode !== 'host' || socketStatus !== 'connected') {
      deliveredColors.current.clear();
      return;
    }
    for (const student of students) {
      const color = participantColors[student.id], previous = deliveredColors.current.get(student.id);
      if (color && (previous?.student !== student || previous.color !== color) &&
          socket.send({type:'participant.color',studentId:student.id,color}))
        deliveredColors.current.set(student.id,{student,color});
    }
  }, [mode, students, participantColors, socketStatus, socket]);
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
    socket.warm();
    void cleanExpiredRoomCaches(initialSession ? hostCacheIdentity(initialSession) : undefined);
  }, []);

  useEffect(() => {
    if (!hostSession) return;
    for (const file of documents) {
      void presentation.progress(file).then(progress => {
        setCacheProgress(existing => ({
          ...existing, [file.fileId]: retainNewestProgress(existing[file.fileId], progress),
        }));
      }).catch(() => {});
    }
  }, [activeCacheId, documents, presentation, socket]);

  // The host already stores each phone-produced first-page JPEG for the presenter.
  // Reload thumbnails from that cache when a room recovers, with no new transfer.
  useEffect(() => {
    const roomCode = activeCacheId;
    if (previewRoom.current !== roomCode) {
      previewRoom.current = roomCode;
      previewLookups.current.clear();
      setDocumentPreviews({});
    }
    if (!roomCode) return;
    for (const file of documents) {
      if (file.deleted || previewLookups.current.has(file.fileId)) continue;
      previewLookups.current.add(file.fileId);
      void presentation.getPreview(file.fileId).then(url => {
        if (!url || previewRoom.current !== roomCode) return;
        setDocumentPreviews(current => current[file.fileId] ? current : { ...current, [file.fileId]: url });
      }).catch(() => {});
    }
  }, [activeCacheId, documents, presentation]);

  // Do not burden mobile senders with PowerPoint parsing or add preview
  // packets to the relay. Once ALL approved files are fully cached on the
  // host, make small first-slide JPEG thumbnails using the existing OOXML
  // engine. This occurs at idle priority; downloads always come first.
  useEffect(() => {
    const room = activeCacheId;
    if (!room || mode !== 'host') return;
    if (thumbnailTransferBusy.current) return;
    for (const file of documents) {
      if (file.deleted || !isPowerPointName(file.name) || !cacheProgress[file.fileId]?.complete ||
          documentPreviews[file.fileId]) continue;
      const key = room + '/' + file.fileId;
      if (pptxThumbPending.current.has(key) || (pptxThumbAttempts.current.get(key) ?? 0) >= 2) continue;
      pptxThumbPending.current.add(key);
      let attempt = 0;
      pptxThumbQueue.current = pptxThumbQueue.current.catch(() => {}).then(async () => {
        // Yield both parsing and JPEG encoding until the browser has breathing
        // room. Never initiate PPTX thumbnail work from the phone.
        await new Promise<void>(resolve => {
          if ('requestIdleCallback' in window) window.requestIdleCallback(() => resolve(), { timeout: 4000 });
          else setTimeout(resolve, 350);
        });
        if (previewRoom.current !== room || modeRef.current !== 'host' || documentPreviewsRef.current[file.fileId] ||
            !hostFilesRef.current.some(current => current.fileId === file.fileId && !current.deleted)) return;
        if (thumbnailTransferBusy.current) {
          // A fresh upload began while we were waiting for idle time.
          return;
        }
        attempt = (pptxThumbAttempts.current.get(key) ?? 0) + 1;
        pptxThumbAttempts.current.set(key, attempt);
        const original = await readCompletedBlob(room, file);
        if (!original || previewRoom.current !== room) throw Error('Complete PPTX cache unavailable');
        if (documentPreviewsRef.current[file.fileId] || !hostFilesRef.current.some(current => current.fileId === file.fileId && !current.deleted)) return;
        // Reading storage can overlap a fresh upload; recheck before any parsing.
        if (thumbnailTransferBusy.current) {
          pptxThumbAttempts.current.set(key, attempt - 1);
          return;
        }
        const { makePowerPointThumbnail } = await import('./pptx/makeThumbnail');
        const preview = await makePowerPointThumbnail(original);
        if (!preview || previewRoom.current !== room) throw Error('Thumbnail rendering returned no image');
        if (!hostFilesRef.current.some(current => current.fileId === file.fileId && !current.deleted)) return;
        await presentation.savePreview(file.fileId, preview);
        if (previewRoom.current === room)
          setDocumentPreviews(current => current[file.fileId]
            ? current : { ...current, [file.fileId]: preview });
      }).catch(error => {
        // Don't permanently silence a transient browser/image decode failure.
        // Only one delayed retry; never let retries affect the transfer queue.
        console.warn('[WarpView] PPTX thumbnail attempt failed:', error);
        if (attempt === 1 && previewRoom.current === room) {
          setTimeout(() => {
            if (previewRoom.current === room)
              triggerPptxThumbnailRetry(value => value + 1);
          }, 8_000);
        }
      }).finally(() => pptxThumbPending.current.delete(key));
    }
  }, [activeCacheId, mode, documents, cacheProgress, documentPreviews, presentation, pptxThumbnailRetryTick]);

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
        const { makeFirstPagePreview } = await import('./pdf/firstPagePreview');
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
    presentation.bindTransferEvents();
    socket.onStatus = status => {
      setSocketStatus(status);
      if (status === 'connected') {
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
      if (progress.bytes > 0)
        setError(previous => previous.startsWith('File transfer stalled') ? '' : previous);
      setCacheProgress(existing => ({
        ...existing, [progress.fileId]: retainNewestProgress(existing[progress.fileId], progress),
      }));
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
      'File transfer stalled. WarpView is reconnecting and retrying automatically; keep both devices open.',
    );
    // On mobile, background tabs may have their timers and connections suspended.
    // Returning to the tab checks the socket and resumes it if necessary.
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      if (closeRequestedRef.current) return;
      void hostLease.renew();
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
    socket.onMessage = message => {
      const type = message.type;
      const metadata = roomVersions.observe(message);
      if (metadata.resync && socket.connected)
        socket.send({ type: modeRef.current === 'host' ? 'room.sync' : 'file.sync' });
      // Authenticate/upgrade the host session independently of an old list snapshot.
      if (!metadata.accept && (type !== 'room.state' || !metadata.scopeMatches)) return;
      if (type === 'participant.color' && modeRef.current === 'student' &&
          typeof message.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(message.color))
        setSenderColor(message.color);
      if (type === 'room.state') {
        const session = hostSessionRef.current;
        if (session && typeof message.roomGeneration === 'string' && typeof message.leaseToken === 'string' &&
            !closeRequestedRef.current) {
          const updated = { ...session, roomGeneration: message.roomGeneration, leaseToken: message.leaseToken,
            ...(typeof message.cacheId === 'string' ? { cacheId: message.cacheId } : {}),
            ...(typeof message.autoApprove === 'boolean' ? { autoApprove: message.autoApprove } : {}) };
          if (hostCacheIdentity(updated) !== hostCacheIdentity(session)) {
            // Recovery from a saved session that lost its namespace metadata.
            // A new generation must never inherit another room's completion.
            presentation.setRoom(hostCacheIdentity(updated));
            setCacheProgress({});
            setDownloadSpeed({});
            transferSamples.current.clear();
          }
          if (updated.roomGeneration !== session.roomGeneration || updated.leaseToken !== session.leaseToken ||
              updated.autoApprove !== session.autoApprove || updated.cacheId !== session.cacheId) rememberHostSession(updated);
          configureHostLease(updated);
        }
        if (metadata.accept) {
          setStudents(Array.isArray(message.students) ? message.students as StudentInfo[] : []);
          const files = Array.isArray(message.files) ? message.files as PdfManifest[] : [];
          setDocuments(files);
          if (typeof message.autoApprove === 'boolean') {
            setHostSession(previous => previous ? { ...previous, autoApprove: message.autoApprove as boolean } : previous);
          }
          hostFilesRef.current = files;
          for (const file of files) if (file.deleted) presentation.removeFile(file.fileId);
        }
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
        if (file.deleted) {
          presentation.removeFile(file.fileId);
          setDocumentPreviews(current => { const next={...current}; delete next[file.fileId]; return next; });
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
            corrected: message.bytes === 0 && Number.isSafeInteger(message.fileRevision),
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
        const previousNotice = admissionError.current;
        if (previousNotice) setError(current => current === previousNotice ? '' : current);
        admissionError.current = '';
        if (typeof message.roomCode === 'string') setCurrentRoomCode(message.roomCode);
        setJoinState('pending');
      }
      if (type === 'join.accepted' || type === 'join.resumed') {
        const entry = readInvitation(new URL(window.location.href), window.history.state);
        if (entry?.entered && typeof message.resumeToken === 'string') rememberInvitation({ ...entry,
          code: typeof message.roomCode === 'string' ? message.roomCode : entry.code, resumeToken: message.resumeToken });
        const previousNotice = admissionError.current;
        if (previousNotice) setError(current => current === previousNotice ? '' : current);
        admissionError.current = '';
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
        if (typeof message.approved === 'boolean') setJoinState(message.approved ? 'accepted' : 'pending');
        if (typeof message.hostOnline === 'boolean') setHostAvailable(message.hostOnline);
        if (typeof message.roomCode === 'string') setCurrentRoomCode(message.roomCode);
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
            !hostFilesRef.current.some(f => f.fileId === id && !f.deleted && isPdfName(f.name))) return;
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
        setError(typeof message.message === 'string' ? message.message : 'The teacher declined this connection.');
      }
      if (type === 'file.pending' || type === 'file.approved' || type === 'file.rejected') {
        const status = type === 'file.pending' ? 'pending' : type === 'file.approved' ? 'approved' : 'rejected';
        const id = String(message.fileId);
        const current = filesOnPhone.current.get(id);
        if (status === 'rejected' && typeof message.code === 'string') {
          // Admission failed before a manifest was created. Stop replaying the
          // offer and release its local slot; other transfers keep running.
          filesOnPhone.current.delete(id);
          firstPageImages.current.delete(id);
          previewDelivered.current.delete(id);
          previewFailed.current.delete(id);
          setPhonePreviews(previous => {
            const next = { ...previous }; delete next[id]; return next;
          });
          setError((current ? current.file.name + ': ' : '') + normalizedMessage(message));
        }
        if (current) {
          current.status = status;
          if (status === 'approved') {
            perf.elapsed('file_receipt_ms', 'offer:' + id, current?.file.size);
            preparePreview(id);
          }
        }
        setSentFiles(existing => existing.map(f => f.fileId === id ? { ...f, status } : f));
      }
      if (type === 'room.closed') {
        if (modeRef.current === 'host' && hostSessionRef.current) {
          if (!closeRequestedRef.current) void completeEnd({ ...hostSessionRef.current, serverClosed: true });
        } else returnHome();
      }
      if (type === 'error') {
        const text = normalizedMessage(message);
        if (message.code === 'JOIN_RATE_LIMIT' && message.retryable === true) {
          admissionError.current = text; setError(text); return;
        }
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
      presentation.setRoom(hostCacheIdentity(initialSession));
      if (initialSession.closeRequested) {
        setEndConfirm(true);
        void completeEnd(initialSession);
      } else {
        configureHostLease(initialSession);
        socket.connect({ role: 'host', roomId: initialSession.roomId, token: initialSession.hostToken, roomGeneration: initialSession.roomGeneration });
      }
    }
    else if (initialInvitation?.entered) socket.connect({ role: 'student', name: initialInvitation.name?.trim() || 'Student', resumeToken: initialInvitation.resumeToken,
      ...(/^\d{6}$/.test(initialJoin) ? { code: initialJoin } : { joinToken: initialJoin }),
    });
    if (initialInvitation) rememberInvitation(initialInvitation);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('freeze', freeze);
      document.removeEventListener('resume', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('pageshow', wake);
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('online', online);
      hostLease.stop();
      presentation.dispose();
      socket.close();
    };
  // The socket callback refers only to stable refs and state setters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);


  async function createRoom(): Promise<void> {
    setBusy(true);
    setError('');
    setBlockedStorageFiles([]);
    setRetryingBlockedStorage(false);
    try {
      const response = await fetch('/api/rooms?cache=2&autoApprove=' + (autoApprove ? '1' : '0'), { method: 'POST' });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(typeof body?.error === 'string' ? body.error : 'Unable to create room (' + response.status + ')');
      }
      const newSession = await response.json() as HostSession;
      roomVersions.reset(newSession.roomGeneration);
      rememberHostSession(newSession);
      closeRequestedRef.current = false;
      modeRef.current = 'host';
      setMode('host');
      setStudents([]);
      setDocuments([]);
      setCacheProgress({});
      setDownloadSpeed({});
      hostFilesRef.current = [];
      transferSamples.current.clear();
      presentation.setRoom(hostCacheIdentity(newSession));
      configureHostLease(newSession);
      socket.connect({ role: 'host', roomId: newSession.roomId, token: newSession.hostToken, roomGeneration: newSession.roomGeneration });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cannot reach server');
    } finally { setBusy(false); }
  }

  function connectStudent(name = studentName): void {
    if (!joinCode.trim()) return setError('Enter a code or use the QR code link.');
    const key = joinCode.trim();
    const invitation = invitationFor(key, currentRoomCode);
    if (!invitation) return setError('Enter a valid six-digit room code or scan the QR code again.');
    roomVersions.reset();
    setError('');
    setJoinState('connecting');
    setSenderColor(undefined);
    filesOnPhone.current.clear();
    firstPageImages.current.clear();
    previewRendering.current.clear();
    previewDelivered.current.clear();
    previewFailed.current.clear();
    setSentFiles([]);
    setStudentCacheProgress({});
    setPhonePreviews({});
    const chosenName = name.trim().slice(0, 32);
    setStudentName(chosenName);
    const resumeToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
    rememberInvitation({ ...invitation, entered: true, name: chosenName, resumeToken });
    setCurrentRoomCode(invitation.code);
    setHostAvailable(true);
    modeRef.current = 'student';
    setMode('student');
    const identifier = /^\d{6}$/.test(key) ? { code: key } : { joinToken: key };
    socket.connect({ role: 'student', name: chosenName || 'Student', resumeToken, ...identifier });
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
    socket.addSources(batch.map(({ fileId, entry }) => ({ fileId, file: entry.file })));
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
      const blob = await readCompletedBlob(hostCacheIdentity(hostSession), file);
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

  function rememberHostSession(session: HostSession): void {
    sessionStorage.setItem('flashview-host', JSON.stringify(session));
    hostSessionRef.current = session;
    setHostSession(session);
  }
  function configureHostLease(session: HostSession): void {
    if (session.closeRequested || !session.roomGeneration || !session.leaseToken) return;
    const identity = { roomId: session.roomId, roomGeneration: session.roomGeneration, leaseToken: session.leaseToken };
    hostLease.start(identity);
    presentation.setLease(identity);
  }
  async function completeEnd(session: HostSession): Promise<void> {
    if (endingRef.current) return;
    if (!session.serverClosed && !session.roomGeneration) {
      setError('Reconnect to the classroom before ending it.');
      socket.wake();
      return;
    }
    endingRef.current = true;
    setEnding(true);
    setError('');
    try {
      await endRoomAndClear(session, pending => {
        rememberHostSession(pending);
        closeRequestedRef.current = true;
        hostLease.stop();
        socket.close();
        presentation.stopTransfers();
      }, () => presentation.clearRoom());
      returnHome();
    } catch (error) {
      setEndConfirm(true);
      setError(error instanceof Error ? error.message : 'Could not finish ending this room. Retry.');
    } finally { endingRef.current = false; setEnding(false); }
  }
  async function endRoom(): Promise<void> {
    if (!hostSessionRef.current || endingRef.current) return;
    await completeEnd(hostSessionRef.current);
  }

  async function copyRoomCode(): Promise<void> {
    if (!hostSession) return;
    try {
      await navigator.clipboard.writeText(hostSession.code);
      setCopied(true);
    } catch { setError('Could not copy room code. Check your clipboard permissions.'); }
  }

  function returnHome(): void {
    roomVersions.reset();
    // Prevent stale socket notifications or QR invitations surviving an exit.
    modeRef.current = 'welcome';
    admissionError.current = '';
    hostLease.stop();
    hostSessionRef.current = null;
    closeRequestedRef.current = false;
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
    setCopied(false);
    setShowDonePill(false);
    hostFilesRef.current = [];
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

  function focusRoomForm(action: 'create' | 'join'): void {
    const panel = document.getElementById(action === 'create' ? 'create-room' : 'join-room');
    panel?.scrollIntoView({ block: 'center', behavior: 'auto' });
    const control = panel?.querySelector<HTMLElement>(action === 'join' ? '#code' : '.reference-toggle input');
    control?.focus({ preventScroll: true });
  }
  useEffect(() => {
    if (mode !== 'welcome') return;
    const focusHash = () => {
      if (location.hash === '#create-room' || location.hash === '#join-room') {
        focusRoomForm(location.hash === '#create-room' ? 'create' : 'join');
      } else if (location.hash === '#instructions' || location.hash === '#how-it-works') {
        document.getElementById(location.hash.slice(1))?.scrollIntoView();
      }
    };
    const frame = requestAnimationFrame(focusHash);
    window.addEventListener('hashchange', focusHash);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('hashchange', focusHash); };
  }, [mode]);

  const joinLink = hostSession ? invitationUrl(window.location.origin, hostSession.joinToken, hostSession.code) : '';
  const showInviteEntry = mode === 'student' && joinState === 'idle' && Boolean(initialInvitation);

  return (
    <div className={'app premium-app' + (mode === 'welcome' ? ' is-home' : '') + (showInviteEntry ? ' is-invite-entry' : '') + (mode === 'host' && hostSession ? ' is-host-workspace' : '') +
      (mode === 'student' && (joinState === 'connecting' || joinState === 'accepted' || joinState === 'pending') ? ' is-student-room' : '')}>
      {mode === 'student' && (joinState === 'idle' || joinState === 'rejected') && (
        <SiteHeader landing={showInviteEntry} onHome={startFresh}/>
      )}
      <main className="app-content">
        {mode === 'welcome' && (
          <div className="welcome reference-welcome">
            <section className="reference-sky">
              <SiteHeader landing publicNavigation onHome={() => window.scrollTo({ top: 0, behavior: 'auto' })}
                onRoomAction={focusRoomForm}/>
              <div className="reference-hero">
                <h1 className="reference-serif home-headline">From your phone,<br/>onto the big screen.</h1>
                <div className="hero-room-stage">
                  <div className="reference-actions" id="start-room">
                    <div className="reference-pane host-card" id="create-room">
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
                    <div className="reference-pane join-card" id="join-room">
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
              </div>
            </section>
            <section className="reference-section" id="instructions">
              <h2 className="reference-serif">Three steps between a phone and a smartboard.</h2>
              <ol className="reference-steps">
                <li><PixelIcon kind="folder"/><h3>Create on the big screen</h3>
                  <p>Choose whether people need approval, then create a room. Keep this tab open to receive files.</p></li>
                <li><PixelIcon kind="doc"/><h3>Join from your device</h3>
                  <p>Scan the QR or enter the six-digit code. Add a name or skip it, then choose your files.</p></li>
                <li><PixelIcon kind="folder"/><h3>Present, then clear</h3>
                  <p>Present PDFs and PowerPoint, or download an original. End the room when you are done to remove its room files.</p></li>
              </ol>
            </section>
            <section className="reference-section home-how" id="how-it-works">
              <div className="home-how-heading">
                <h2 className="reference-serif">A short journey.<br/>A separate place to present.</h2>
                <p>Your device sends the original through a live relay to the room’s browser cache.
                  A separate preview tab reads that cache, while transfers keep working in the background.</p>
              </div>
              <div className="home-file-path" aria-label="Files travel from your device, through the live relay, to the room browser cache">
                <div className="home-path-device">
                  <div className="home-device-screen"><PixelIcon kind="doc"/></div>
                  <strong>Your device</strong><span>The original file</span>
                </div>
                <svg className="file-path-arrow" viewBox="0 0 64 24" fill="none" aria-hidden="true">
                  <path d="M2 12h58m-8-8 8 8-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <div className="home-path-relay">
                  <PixelIcon kind="transfer"/>
                  <strong>Live relay</strong><span>No server file storage</span>
                </div>
                <svg className="file-path-arrow" viewBox="0 0 64 24" fill="none" aria-hidden="true">
                  <path d="M2 12h58m-8-8 8 8-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <div className="home-path-room">
                  <div className="home-browser-frame">
                    <div className="home-browser-bar"><span aria-hidden="true"><i/><i/><i/></span><span>Room browser</span></div>
                    <div className="home-browser-files"><PixelIcon kind="pdf"/><PixelIcon kind="ppt"/></div>
                    <span className="home-browser-caption">Room files</span>
                  </div>
                  <div className="home-preview-branch"><strong>A separate preview tab</strong><span>Transfers keep working while you present.</span></div>
                </div>
              </div>
              <a className="home-architecture-link" href="/architecture">Explore the architecture
                <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </a>
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
              <span>WarpView. An easier way to present.</span>
              <span>Made for classrooms and conference rooms</span>
            </footer>
          </div>
        )}

        {mode === 'host' && hostSession && (
          <div className="workspace premium-workspace reference-room">
            <div className="workspace-split">
              <aside className={'workspace-left'+(mobileHostConfigOpen?' mobile-config-expanded':'')}
                aria-label="Room invitation and people who shared files">
                <div className="mobile-host-toolbar">
                  <div className="mobile-host-identity">
                    <strong className="mobile-host-code">{hostSession.code}</strong>
                    <span className="mobile-host-byline">by warpview</span>
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
                  <div className="sidebar-brand" aria-label="WarpView">warpview</div>
                <section className="room-card premium-invite" aria-label="Live room QR code">
                  <div className="qr-side">
                    <div className="qr-plate">
                      <QRCodeSVG value={joinLink} size={440} marginSize={1} bgColor="#ffffff" fgColor="#0e0f14"/>
                    </div>
                  </div>
                  <div className="invite-content">
                    <div className="invite-code">
                      <div className="room-code-label">Use this code to join</div>
                      <div className="room-code" aria-label={'Room code '+hostSession.code}>{hostSession.code}</div>
                    </div>
                    <div className="invite-actions">
                      <button type="button" className="outline-button reference-pill"
                        onClick={()=>void copyRoomCode()}>{copied?'Code copied':'Copy code'}</button>
                      <button type="button" className="outline-button reference-pill end-room-button"
                        onClick={()=>setEndConfirm(true)}>End room</button>
                    </div>
                  </div>
                </section>
                <section className="sidebar-participants" aria-label="People who shared files">
                  <div className="sidebar-participants-heading">
                    <h2>Shared by</h2>
                    <span className={'connection reference-room-connection '+socketStatus}
                      aria-label={'Room '+statusText(socketStatus)} title={statusText(socketStatus)}>
                      <span className="status-dot" aria-hidden="true"/>
                    </span>
                  </div>
                  <div className="sidebar-participants-scroll">
                    {students.some(s=>!s.approved)&&<span className="mobile-host-request-label">Requests to join</span>}
                    {contributors.length===0&&<p className="sidebar-participants-empty">No files shared yet.</p>}
                    {students.filter(s=>!s.approved).map(s=>(
                      <div className="approval sidebar-approval" data-participant-id={s.id} key={s.id}>
                        <span className="participant-avatar" aria-hidden="true"
                          style={participantColors[s.id]?{'--participant-color':participantColors[s.id],'--participant-ink':participantForeground(participantColors[s.id])} as CSSProperties:undefined}>{Array.from(s.name.trim())[0]?.toUpperCase()||'?'}</span>
                        <span className="participant-info"><strong>{s.name}</strong><small>Waiting for approval</small></span>
                        <div className="participant-actions">
                          <button className="mini-accept" onClick={()=>socket.send({type:'student.accept',studentId:s.id})}>Allow</button>
                          <button className="mini-reject" onClick={()=>socket.send({type:'student.reject',studentId:s.id})}
                            aria-label={'Decline '+s.name}>×</button>
                        </div>
                      </div>
                    ))}
                    <div className="contributor-chips">
                    {contributors.map(s=>(
                      <div className="participant-row" data-participant-id={s.id} key={s.id}>
                        <span className="participant-avatar" aria-hidden="true"
                          style={participantColors[s.id]?{'--participant-color':participantColors[s.id],'--participant-ink':participantForeground(participantColors[s.id])} as CSSProperties:undefined}>{Array.from(s.name.trim())[0]?.toUpperCase()||'?'}</span>
                        <span className="participant-info"><strong title={s.name}>{s.name}</strong></span>
                      </div>
                    ))}
                    </div>
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
                        Do not clear WarpView site data during this room; cached chunks may be lost.</p>
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
                        onDelete={()=>{
                          if(!socket.send({type:'file.remove',fileId:file.fileId}))
                            setError('Reconnect to delete this file.');
                        }}
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

        {showInviteEntry && <JoinWelcome code={currentRoomCode} name={studentName} onName={setStudentName} onJoin={connectStudent}/>}
        {mode === 'student' && !showInviteEntry && (
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
                    <div className="student-drive-logo">warpview<span>.</span></div>
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
                          style={senderColor?{'--participant-color':senderColor,'--participant-ink':participantForeground(senderColor)} as CSSProperties:undefined}
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
            <section className="end-dialog" role="dialog" aria-modal="true" aria-labelledby="end-title" aria-describedby="end-description">
              <h2 id="end-title" className="reference-serif">Room files will be deleted.</h2>
              <p id="end-description">Ending room <strong>{hostSession.code}</strong> clears its files and previews
                from <strong>this computer</strong>, closes presentation tabs, and disconnects everyone.</p>
              <p>Original files on people's devices stay untouched. Clearing this room's cache cannot be undone.</p>
              {hostSession.closeRequested && <p>A close request has been recorded. Retry to confirm closure and finish clearing this device.</p>}
              <div className="end-dialog-actions">
                <button className="outline-button reference-pill" autoFocus disabled={ending || hostSession.closeRequested}
                  onClick={() => setEndConfirm(false)}>Keep room open</button>
                <button className="end-danger" disabled={ending}
                  onClick={() => void endRoom()}>{ending ? 'Ending…' : hostSession.closeRequested ? 'Retry end & cleanup' : 'End & clear cache'}</button>
              </div>
            </section>
          </div>
        )}
        {error && <div className="global-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss">×</button></div>}
      </main>
      <PerfPanel/>
      <footer className="site-footer"><span>WARPVIEW / AN OPEN CLASSROOM PROJECT</span><span>Designed for the time between sharing and seeing.</span></footer>
    </div>
  );
}
