import { MAX_FILE_BYTES, MAX_RANGE_BYTES, MAX_STUDENT_FILES, type PdfManifest } from '../shared/protocol';
import { RoomSocket, type ServerMessage } from './socket';
import { RoomPdfCache } from './pdf/roomCache';
import { configureWorkerPerf, perf } from './perf';
import { RoomRevisionTracker } from './roomRevision';
import type { WorkerCommand, WorkerEnvelope, WorkerEvent, WorkerReply } from './transferProtocol';
import { hashBlob, digestBytes } from './storage/integrity';
import { probeOpfs } from './storage/opfsStore';

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<WorkerEnvelope & { query?: string }>) => void;
  postMessage: (message: WorkerReply & { session: number }, transfer?: Transferable[]) => void;
};
let session = 0, query = '', role: unknown;
let socket: RoomSocket;
let cache: RoomPdfCache | null = null;
let versions = new RoomRevisionTracker();
let mailboxBusy = false;
const mailbox = new Map<string, WorkerEvent>();
const sources = new Map<string, { file: File; approved: boolean; stopped: boolean; known: boolean; offeredAt: number; sha256?: string; hashing?: boolean }>();
let integrityRequired: boolean | undefined, hashing = 0;
const stoppedSources = new Set<string>();
const reads = new Map<string, { fileId: string; timer: ReturnType<typeof setTimeout> }>();
function retireReads(fileId?: string): void {
  for (const [id, read] of reads) if (!fileId || read.fileId === fileId) { clearTimeout(read.timer); reads.delete(id); }
}
const localReads = new Map<number, AbortController>();
const manifests = new Map<string, PdfManifest>();
const receipts = new Set<string>();
const receiptSent = new Map<string, number>();
const progressPaint = new Map<string, number>();
let syncTimer: ReturnType<typeof setInterval> | null = null;

// One unacknowledged batch, bounded/coalesced pending metadata. No transfer bytes.
function emit(key: string, event: WorkerEvent): void {
  mailbox.delete(key); mailbox.set(key, event);
  if (mailbox.size > 1024) mailbox.delete(mailbox.keys().next().value!);
  flush();
}
function flush(): void {
  if (mailboxBusy || !mailbox.size) return;
  mailboxBusy = true;
  const events = [...mailbox.values()]; mailbox.clear();
  scope.postMessage({ session, type: 'events', events });
}
function receipt(fileId: string, bytes: number): void {
  if (!socket.connected || receipts.has(fileId) || Date.now() - (receiptSent.get(fileId) ?? -Infinity) < 7000) return;
  if (socket.send({ type: 'cache.progress', fileId, bytes })) receiptSent.set(fileId, Date.now());
}
function setRoom(roomId: string): void {
  if (!roomId || (cache?.roomId === roomId && !cache.closed)) return;
  cache?.dispose();
  const next = new RoomPdfCache(roomId, socket, query); cache = next;
  progressPaint.clear(); receipts.clear(); receiptSent.clear();
  next.onProgress = progress => {
    if (cache !== next) return;
    if (progress.corrected) {
      receipts.delete(progress.fileId); receiptSent.delete(progress.fileId);
      socket.send({ type: 'cache.progress', fileId: progress.fileId, bytes: 0, snapshot: true });
    }
    if (progress.complete) receipt(progress.fileId, progress.size);
    const now = performance.now();
    if (!progress.complete && !progress.corrected && now - (progressPaint.get(progress.fileId) ?? -Infinity) < 350) return;
    progressPaint.set(progress.fileId, now);
    emit('progress:' + progress.fileId, { type: 'progress', progress });
  };
  next.onStorageWarning = message => emit('warning', { type: 'warning', message });
  next.onStorageBlocked = fileId => emit('storage:' + fileId, { type: 'blocked', fileId });
  next.onStorageRecovered = fileId => emit('storage:' + fileId, { type: 'recovered', fileId });
  next.onStalled = fileId => emit('stalled:' + fileId, { type: 'stalled', fileId });
}
function queue(file: PdfManifest): void {
  manifests.set(file.fileId, file);
  if (file.status === 'approved' && !file.revoked) cache?.prefetch(file);
  else cache?.pause(file.fileId);
}
function offer(fileId: string): void {
  const source = sources.get(fileId);
  if (!source || source.stopped || source.known || Date.now() - source.offeredAt < 7000) return;
  if (integrityRequired === undefined) return;
  if (integrityRequired && !source.sha256) {
    if (source.hashing || hashing >= 2) return;
    source.hashing = true; hashing++;
    const hashStarted = performance.now();
    void hashBlob(source.file, () => sources.get(fileId) === source && !source.stopped).then(hash => {
      if (perf.enabled) perf.record('source_hash_ms', performance.now() - hashStarted, { bytes: source.file.size });
      if (sources.get(fileId) === source && !source.stopped) { source.sha256 = hash; offer(fileId); }
    }).catch(() => {
      if (sources.get(fileId) !== source || source.stopped) return;
      sources.delete(fileId);
      emit('file:' + fileId, { type: 'message', message: { type: 'file.rejected', fileId,
        code: 'SOURCE_READ_FAILED', message: 'Could not read this original. Please select it again.' } });
    }).finally(() => { hashing--; for (const id of sources.keys()) offer(id); });
    return;
  }
  if (socket.send({ type: 'file.offer', fileId, name: source.file.name, size: source.file.size,
    ...(source.sha256 ? { sha256: source.sha256 } : {}) })) source.offeredAt = Date.now();
}
function reconcile(files: PdfManifest[]): void {
  const known = new Map(files.map(file => [file.fileId, file]));
  for (const [id, source] of sources) {
    const file = known.get(id);
    if (file) { source.known = true; source.sha256 ??= file.sha256; source.approved = file.status === 'approved' && !file.revoked; source.stopped ||= file.revoked === true || file.status === 'rejected'; }
    else { source.known = false; offer(id); }
  }
}
async function respond(message: ServerMessage): Promise<void> {
  const { requestId, fileId, begin, end } = message;
  if (typeof requestId !== 'string' || typeof fileId !== 'string' || !Number.isSafeInteger(begin) || !Number.isSafeInteger(end)) return;
  const source = sources.get(fileId);
  let attempt: { fileId: string; timer: ReturnType<typeof setTimeout> };
  const response = socket.rangeResponse(requestId, fileId, Number(begin), () =>
    !!source && reads.get(requestId) === attempt && sources.get(fileId) === source && source.approved && !source.stopped);
  if (!source || !source.approved || source.stopped || Number(begin) < 0 || Number(end) > source.file.size ||
      Number(end) <= Number(begin) || Number(end) - Number(begin) > MAX_RANGE_BYTES || reads.size >= 48) {
    response.fail('File is no longer available'); return;
  }
  // Native Blob reads cannot be physically aborted, but a late result loses
  // authority and its logical slot well before the receiver's range deadline.
  attempt = { fileId, timer: setTimeout(() => {
    if (reads.get(requestId) !== attempt) return;
    reads.delete(requestId); response.fail('File read timed out');
  }, 15_000) }; reads.set(requestId, attempt);
  const current = () => reads.get(requestId) === attempt && sources.get(fileId) === source && source.approved && !source.stopped;
  try {
    const started = performance.now();
    const bytes = await source.file.slice(Number(begin), Number(end)).arrayBuffer();
    if (perf.enabled) perf.record('sender_read_ms', performance.now() - started, { bytes: bytes.byteLength });
    if (current() && !await response.send(bytes, source.sha256 ? await digestBytes(new Uint8Array(bytes)) : undefined) && current()) response.fail('Network sender is busy');
  } catch { if (current()) response.fail('Cannot read file from sender device'); }
  finally { clearTimeout(attempt.timer); if (reads.get(requestId) === attempt) reads.delete(requestId); }
}
function initialize(): void {
  socket = new RoomSocket({ protocol: location.protocol, host: location.host, search: query });
  socket.onStatus = status => {
    if (status !== 'connected') retireReads();
    if (status === 'connected') {
      receipts.clear(); receiptSent.clear(); cache?.connectionRestored();
      if (role === 'student') for (const fileId of stoppedSources) socket.send({ type: 'file.revoke', fileId });
      socket.send({ type: role === 'host' ? 'room.sync' : 'file.sync' });
      for (const source of sources.values()) source.offeredAt = -Infinity;
    }
    emit('status', { type: 'status', status });
  };
  socket.onMessage = message => {
    if (message.type === 'range.request') { void respond(message); return; }
    const observed = versions.observe(message);
    if (observed.resync) socket.send({ type: role === 'host' ? 'room.sync' : 'file.sync' });
    if (!observed.accept) return;
    if (role === 'student' && ['join.accepted', 'join.resumed', 'join.pending', 'file.manifest'].includes(message.type))
      integrityRequired = message.integrityRequired === true;
    if (role === 'host') {
      if (message.type === 'room.state') {
        if (typeof message.cacheId === 'string') setRoom(message.cacheId);
        else if (typeof message.code === 'string') setRoom(message.code);
        const files = Array.isArray(message.files) ? message.files as PdfManifest[] : [];
        const ids = new Set(files.map(file => file.fileId));
        for (const id of manifests.keys()) if (!ids.has(id)) { cache?.pause(id); manifests.delete(id); }
        for (const file of files) queue(file);
      } else if (message.type === 'file.announced' || message.type === 'file.updated') queue(message.file as PdfManifest);
      else if (message.type === 'cache.progress.receipt' && typeof message.fileId === 'string' &&
          manifests.get(message.fileId)?.size === message.bytes) { receipts.add(message.fileId); receiptSent.delete(message.fileId); }
    } else {
      if (Array.isArray(message.files)) {
        const files = message.files as PdfManifest[]; reconcile(files);
        for (const fileId of stoppedSources) if (files.some(file => file.fileId === fileId && !file.revoked))
          socket.send({ type: 'file.revoke', fileId });
      }
      if (message.type === 'host.online') socket.send({ type: 'file.sync' });
      if (message.type === 'file.state') {
        const file = message.file as PdfManifest, source = sources.get(file.fileId);
        if (source) { source.known = true; source.approved = file.status === 'approved' && !file.revoked; source.stopped ||= file.revoked === true || file.status === 'rejected'; }
      }
      const source = sources.get(String(message.fileId));
      if (source && message.type === 'file.approved') { source.known = true; source.approved = true; }
      if (source && (message.type === 'file.rejected' || message.type === 'file.pending')) {
        source.approved = false;
        if (message.type === 'file.rejected') { source.stopped = true; if (message.code) sources.delete(String(message.fileId)); }
      }
    }
    if (message.type === 'room.closed' || message.type === 'join.rejected') { cache?.dispose(); sources.clear(); retireReads(); }
    if (role === 'student') for (const id of sources.keys()) offer(id);
    const key = ['student.pending', 'student.updated', 'student.left'].includes(message.type)
      ? 'student:' + String((message.student as { id?: string })?.id ?? message.id)
      : message.type + ':' + String(message.fileId ?? (message.file as PdfManifest)?.fileId ?? '') +
        (message.type === 'preview.chunk' ? ':' + message.part : '');
    emit(key, { type: 'message', message });
  };
}
async function rpc(command: Extract<WorkerCommand, { type: 'rpc' }>): Promise<void> {
  const owner = session, currentCache = cache;
  const controller = new AbortController();
  try {
    if (localReads.size >= 128) throw Error('Too many local cache reads');
    localReads.set(command.id, controller);
    if (command.method === 'opfs-probe') {
      await probeOpfs();
      if (owner === session && !controller.signal.aborted) scope.postMessage({ session, type: 'result', id: command.id, value: true });
      return;
    }
    if (!currentCache || currentCache.roomId !== command.roomId) throw Error('Local cache room changed');
    const file = command.file && manifests.get(command.file.fileId);
    if (command.file && (!file || file.size !== command.file.size)) throw Error('Local file metadata changed');
    let value: unknown;
    if (command.method === 'progress' && file) value = await currentCache.progress(file, false);
    else if (command.method === 'preview' && command.fileId) value = await currentCache.getPreview(command.fileId);
    else if (command.method === 'save-preview' && command.fileId && command.dataUrl) await currentCache.savePreview(command.fileId, command.dataUrl);
    else if (command.method === 'read' && file) value = await currentCache.cachedRange(file, Number(command.begin), Number(command.end), controller.signal);
    else if (command.method === 'clear') { await currentCache.clear(); if (cache === currentCache) cache = null; }
    else throw Error('Invalid cache command');
    if (command.method !== 'clear' && currentCache !== cache) throw Error('Local cache room changed');
    if (owner === session && !controller.signal.aborted)
      scope.postMessage({ session, type: 'result', id: command.id, value }, value instanceof Uint8Array ? [value.buffer as ArrayBuffer] : []);
  } catch (error) {
    if (owner === session && !controller.signal.aborted) scope.postMessage({ session, type: 'result', id: command.id,
      error: error instanceof Error ? error.message : 'Local cache operation failed' });
  } finally { localReads.delete(command.id); }
}
scope.onmessage = event => {
  const { command } = event.data;
  if (event.data.query !== undefined) {
    query = event.data.query;
    configureWorkerPerf(new URLSearchParams(query).get('perf') === '1', record => emit('perf:' + record.metric, { type: 'perf', record }));
  }
  if (!socket) initialize();
  if (event.data.session < session) return;
  if (event.data.session !== session) {
    socket.close(); sources.clear(); stoppedSources.clear(); retireReads(); manifests.clear(); receipts.clear(); receiptSent.clear();
    for (const read of localReads.values()) read.abort(); localReads.clear();
    session = event.data.session; mailbox.clear(); mailboxBusy = false;
  }
  if (command.type === 'ack') { mailboxBusy = false; flush(); }
  else if (command.type === 'connect') {
    integrityRequired = undefined;
    role = command.identity.role; versions = new RoomRevisionTracker(typeof command.identity.roomGeneration === 'string' ? command.identity.roomGeneration : undefined);
    socket.connect(command.identity);
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(() => {
      if (!socket.connected) return;
      socket.send({ type: role === 'host' ? 'room.sync' : 'file.sync' });
      if (role === 'student') for (const id of sources.keys()) offer(id);
    }, 20_000);
  } else if (command.type === 'room') setRoom(command.roomId);
  else if (command.type === 'sources') {
    for (const { fileId, file } of command.files) {
      if (sources.size >= MAX_STUDENT_FILES || !file.size || file.size > MAX_FILE_BYTES || sources.has(fileId) || stoppedSources.has(fileId)) continue;
      sources.set(fileId, { file, approved: false, stopped: false, known: false, offeredAt: -Infinity }); offer(fileId);
    }
  } else if (command.type === 'send') {
    const message = command.message;
    if (message.type === 'file.offer' && typeof message.fileId === 'string') offer(message.fileId);
    else if (message.type === 'file.revoke' && typeof message.fileId === 'string') {
      sources.delete(message.fileId); stoppedSources.add(message.fileId); retireReads(message.fileId); socket.send(message);
    }
    else if (message.type !== 'cache.progress') socket.send(message);
  } else if (command.type === 'wake') socket.wake(command.reason);
  else if (command.type === 'pause') socket.pauseHeartbeat(command.frozen);
  else if (command.type === 'close') { socket.close(); sources.clear(); stoppedSources.clear(); retireReads(); if (syncTimer) clearInterval(syncTimer); syncTimer = null; }
  else if (command.type === 'stop') cache?.dispose();
  else if (command.type === 'retry-storage') cache?.retryBlockedStorage();
  else if (command.type === 'rpc') void rpc(command);
  else if (command.type === 'cancel') { localReads.get(command.id)?.abort(); localReads.delete(command.id); }
};
