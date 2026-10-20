import type { PdfManifest } from '../shared/protocol';
import { perf } from './perf';
import { deleteRoomCache, type CacheProgress } from './pdf/roomCache';
import type { ServerMessage, SocketStatus } from './socket';
import type { WorkerCommand, WorkerReply } from './transferProtocol';

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
/** Page-side commands/status only. Original transfer bytes never pass through React. */
export class RoomTransferClient {
  private worker: Worker | null = null;
  private session = 0;
  private status: SocketStatus = 'disconnected';
  private identity: Record<string, unknown> | null = null;
  private roomId = '';
  private sources = new Map<string, File>();
  private stoppedSources = new Set<string>();
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private restarts = 0;
  private failed = false;
  onMessage: (message: ServerMessage) => void = () => {};
  onStatus: (status: SocketStatus) => void = () => {};
  onProgress: (progress: CacheProgress) => void = () => {};
  onWarning: (message: string) => void = () => {};
  onStorageBlocked: (id: string) => void = () => {};
  onStorageRecovered: (id: string) => void = () => {};
  onStalled: (id: string) => void = () => {};
  get connected(): boolean { return this.status === 'connected'; }
  get unavailable(): boolean { return this.failed && !this.worker; }
  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./relayWorker.ts', import.meta.url), { type: 'module', name: 'warpview-transfer' });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<WorkerReply & { session: number }>) => {
      if (this.worker !== worker || event.data.session !== this.session) return;
      const reply = event.data;
      const owner = this.session;
      if (reply.type === 'result') {
        const request = this.pending.get(reply.id);
        if (!request) return;
        if (reply.error) request.reject(Error(reply.error)); else request.resolve(reply.value);
        return;
      }
      // Release the worker's bounded mailbox even when a UI callback fails.
      try { for (const event of reply.events) {
        if (owner !== this.session) break;
        if (event.type === 'message') {
          if (typeof event.message.roomGeneration === 'string' && this.identity &&
              ['room.state', 'join.pending', 'join.accepted', 'join.resumed'].includes(event.message.type))
            this.identity.roomGeneration = event.message.roomGeneration;
          if (typeof event.message.resumeToken === 'string' && this.identity?.role === 'student')
            this.identity.resumeToken = event.message.resumeToken;
          if (event.message.type === 'file.rejected' && event.message.code) this.sources.delete(String(event.message.fileId));
          this.onMessage(event.message);
        } else if (event.type === 'status') { this.status = event.status; this.onStatus(event.status); }
        else if (event.type === 'progress') this.onProgress(event.progress);
        else if (event.type === 'warning') this.onWarning(event.message);
        else if (event.type === 'blocked') this.onStorageBlocked(event.fileId);
        else if (event.type === 'recovered') this.onStorageRecovered(event.fileId);
        else if (event.type === 'stalled') this.onStalled(event.fileId);
        else if (event.type === 'perf') perf.record(event.record.metric, event.record.ms, event.record);
      } } finally { if (this.worker === worker && owner === this.session) this.post({ type: 'ack' }); }
    };
    const fail = (event: Event) => {
      event.preventDefault();
      if (this.worker !== worker) return;
      worker.terminate(); this.worker = null;
      this.status = 'disconnected'; this.onStatus('disconnected');
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(Error('Transfer worker restarted; retry the operation.')); }
      this.pending.clear();
      if (!this.identity && !this.roomId) return; // An idle warm-up can retry when a room is actually opened.
      if (this.identity && this.restarts++ < 2) {
        this.onWarning('Transfer interrupted. Reconnecting automatically; keep both pages open.');
        try {
          this.post({ type: 'room', roomId: this.roomId });
          this.post({ type: 'connect', identity: this.identity });
          for (const fileId of this.stoppedSources) this.post({ type: 'send', message: { type: 'file.revoke', fileId } });
          this.post({ type: 'sources', files: [...this.sources].map(([fileId, file]) => ({ fileId, file })) });
        } catch { this.onWarning('Transfers could not restart. Refresh this page and reselect sender files if needed.'); }
      } else { this.failed = true; this.onWarning('Transfers stopped. Refresh this page and reselect sender files if needed.'); }
    };
    worker.onerror = fail; worker.onmessageerror = fail;
    worker.postMessage({ session: this.session, query: location.search, command: { type: 'room', roomId: this.roomId } });
    return worker;
  }
  private post(command: WorkerCommand): boolean {
    if (this.failed) return false;
    try { this.ensureWorker().postMessage({ session: this.session, command }); return true; }
    catch {
      this.failed = true;
      this.worker?.terminate(); this.worker = null;
      for (const request of this.pending.values()) request.reject(Error('Transfer worker unavailable'));
      this.status = 'disconnected'; this.onStatus('disconnected');
      this.onWarning('This browser could not start file transfers. Refresh or use a browser with Web Worker support.');
      return false;
    }
  }
  connect(identity: Record<string, unknown>): void {
    for (const request of this.pending.values()) request.reject(Error('Room changed'));
    this.session++;
    this.identity = { ...identity };
    if (identity.role === 'student' && typeof identity.resumeToken !== 'string')
      this.identity.resumeToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
    this.sources.clear(); this.stoppedSources.clear(); this.restarts = 0; this.failed = false; this.status = 'connecting'; this.onStatus('connecting');
    this.post({ type: 'connect', identity: this.identity });
  }
  /** Fetch/initialize before room creation; no identity or socket is opened. */
  warm(): void { if (!this.worker && !this.failed) this.post({ type: 'room', roomId: this.roomId }); }
  send(message: Record<string, unknown>): boolean {
    if (message.type === 'file.revoke' && typeof message.fileId === 'string') {
      this.sources.delete(message.fileId); this.stoppedSources.add(message.fileId);
      return this.post({ type: 'send', message });
    }
    if (!this.connected) return false;
    return this.post({ type: 'send', message });
  }
  addSources(files: Array<{ fileId: string; file: File }>): void {
    const available = files.filter(entry => !this.stoppedSources.has(entry.fileId));
    for (const entry of available) this.sources.set(entry.fileId, entry.file);
    this.post({ type: 'sources', files: available });
  }
  wake(reason: 'focus' | 'online' = 'focus'): void { if (this.identity) this.post({ type: 'wake', reason }); }
  pauseHeartbeat(frozen = false): void { if (this.identity) this.post({ type: 'pause', frozen }); }
  close(): void {
    for (const request of this.pending.values()) request.reject(Error('Room closed'));
    this.session++;
    this.identity = null; this.sources.clear(); this.stoppedSources.clear(); this.status = 'disconnected';
    if (this.worker) this.post({ type: 'close' });
    this.onStatus('disconnected');
  }
  setRoom(roomId: string): void { this.roomId = roomId; this.post({ type: 'room', roomId }); }
  stopTransfers(): void { if (this.worker) this.post({ type: 'stop' }); }
  retryBlockedStorage(): void { this.post({ type: 'retry-storage' }); }
  request(method: 'progress' | 'preview' | 'save-preview' | 'read' | 'clear', args: {
    roomId: string; file?: PdfManifest; fileId?: string; dataUrl?: string; begin?: number; end?: number;
  }, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(Error('Presentation range cancelled'));
    if (this.pending.size >= 128) return Promise.reject(Error('Too many local cache operations; retry shortly.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const cancel = () => { this.post({ type: 'cancel', id }); finish(Error('Presentation range cancelled')); };
      const finish = (error?: Error, value?: unknown) => {
        const request = this.pending.get(id); if (!request) return;
        clearTimeout(request.timer); this.pending.delete(id); signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => { this.post({ type: 'cancel', id }); finish(Error('Local cache operation timed out; retry.')); }, method === 'read' ? 120_000 : 60_000);
      this.pending.set(id, { timer, resolve: value => finish(undefined, value), reject: error => finish(error) });
      signal?.addEventListener('abort', cancel, { once: true });
      if (!this.post({ type: 'rpc', id, method, ...args })) finish(Error('Transfer worker unavailable'));
    });
  }
}

/** Transitional passive reader. It cannot start, prioritize or cancel transfers. */
export class WorkerRoomCache {
  constructor(readonly roomId: string, private readonly transfer: RoomTransferClient) { transfer.setRoom(roomId); }
  progress(file: PdfManifest): Promise<CacheProgress> { return this.transfer.request('progress', { roomId: this.roomId, file }) as Promise<CacheProgress>; }
  getPreview(fileId: string): Promise<string | null> { return this.transfer.request('preview', { roomId: this.roomId, fileId }) as Promise<string | null>; }
  async savePreview(fileId: string, dataUrl: string): Promise<void> { await this.transfer.request('save-preview', { roomId: this.roomId, fileId, dataUrl }); }
  cachedRange(file: PdfManifest, begin: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.transfer.request('read', { roomId: this.roomId, file, begin, end }, signal) as Promise<Uint8Array>;
  }
  async clear(): Promise<void> {
    // A failed worker has already been terminated, so it cannot recreate bytes
    // after this cleanup. This is deletion only, never a UI transfer fallback.
    if (this.transfer.unavailable) await deleteRoomCache(this.roomId);
    else await this.transfer.request('clear', { roomId: this.roomId });
  }
  dispose(): void { this.transfer.stopTransfers(); }
}
