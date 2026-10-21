import type { PdfManifest } from '../shared/protocol';
import { MAX_RANGE_BYTES } from '../shared/protocol';
import { type CacheProgress, cleanExpiredRoomCaches } from './pdf/roomCache';
import type { RoomSocket } from './socket';
import { RoomTransferClient, WorkerRoomCache } from './transferClient';
import { perf, perfEnabled, type PerfName } from './perf';
import { RoomLease } from './roomControl';
import { isRoomLeaseIdentity, type RoomLeaseIdentity } from '../shared/roomControl';

const PREFIX = 'flashview-present-';
type Pending = { cancel: () => void };
type Reply = (start: number, bytes: Uint8Array) => void;
type Failure = (message: string) => void;
export type PdfRangeSource = Pick<RoomSocket, 'requestRange'>;

/** The original room tab owns the only host WebSocket. */
export class PresentationHost {
  private tabs = new Map<string, { file: PdfManifest; channel: BroadcastChannel; requests: Map<string, Pending> }>();
  private lease: RoomLeaseIdentity | null = null;
  private cache: WorkerRoomCache | null = null;
  onProgress: (status: CacheProgress) => void = () => {};
  onWarning: (message: string) => void = () => {};
  onStorageBlocked: (fileId: string) => void = () => {};
  onStorageRecovered: (fileId: string) => void = () => {};
  onStalled: (fileId: string) => void = () => {};
  constructor(private readonly socket: RoomTransferClient) {}
  bindTransferEvents(): void {
    this.socket.onProgress = progress => {
      this.onProgress(progress);
      for (const entry of this.tabs.values()) if (entry.file.fileId === progress.fileId)
        entry.channel.postMessage({ type: 'progress', progress });
    };
    this.socket.onWarning = message => this.onWarning(message);
    this.socket.onStorageBlocked = id => this.onStorageBlocked(id);
    this.socket.onStorageRecovered = id => this.onStorageRecovered(id);
    this.socket.onStalled = id => this.onStalled(id);
  }

  setRoom(roomId: string): void {
    this.bindTransferEvents();
    if (this.cache?.roomId === roomId) return;
    this.closeAll();
    this.lease = null;
    this.cache?.dispose();
    this.cache = new WorkerRoomCache(roomId, this.socket);
    void cleanExpiredRoomCaches(roomId);
  }
  async progress(file: PdfManifest): Promise<CacheProgress> {
    return this.cache?.progress(file) ?? {
      fileId: file.fileId, bytes: 0, size: file.size, complete: false,
    };
  }
  async clearRoom(): Promise<void> {
    this.closeAll();
    const cache = this.cache;
    if (cache) await cache.clear();
    // Retain a failed cleanup handle so Retry really retries the same room.
    if (this.cache === cache) this.cache = null;
  }
  stopTransfers(): void { this.cache?.dispose(); }
  setLease(identity: RoomLeaseIdentity): void {
    this.lease = { ...identity };
    for (const tab of this.tabs.values()) tab.channel.postMessage({ type: 'lease', lease: this.lease });
  }
  retryBlockedStorage(): void { this.socket.retryBlockedStorage(); }
  /** Reuse the first-slide image already stored for the presenter, without extra PDF requests. */
  async getPreview(fileId: string): Promise<string | null> {
    return this.cache?.getPreview(fileId) ?? null;
  }
  async savePreview(fileId: string, dataUrl: string): Promise<void> {
    if (!this.cache) return;
    await this.cache.savePreview(fileId, dataUrl);
    for (const tab of this.tabs.values()) {
      if (tab.file.fileId === fileId) {
        tab.channel.postMessage({ type: 'preview', fileId, dataUrl });
      }
    }
  }
  dispose(): void { this.closeAll(); this.cache?.dispose(); this.cache = null; }

  open(file: PdfManifest, locallyComplete = false): void {
    if (!this.cache) throw Error('Classroom cache is unavailable. Refresh the dashboard.');
    // A fully downloaded PDF is independent of the original sender and
    // classroom WebSocket. Allow it to present while the relay reconnects.
    // Viewer access depends on cached bytes, never the current sender socket.
    // Missing data simply waits for the independent transfer engine.
    void locallyComplete;
    if (typeof BroadcastChannel === 'undefined') throw Error('Presentation tabs are unsupported in this browser.');
    const key = crypto.randomUUID().replaceAll('-', '');
    const openedAt = perf.enabled ? performance.now() : 0;
    let firstSlideObserved = false;
    const channel = new BroadcastChannel(PREFIX + key);
    const requests = new Map<string, Pending>();
    const close = () => {
      const tab = this.tabs.get(key);
      if (!tab) return;
      for (const entry of requests.values()) entry.cancel();
      requests.clear();
      channel.close();
      this.tabs.delete(key);
    };
    this.tabs.set(key, { file, channel, requests });
    channel.onmessage = (event: MessageEvent) => {
      const m = event.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') {
        channel.postMessage({ type: 'metadata', file, roomId: this.cache?.roomId, lease: this.lease });
        void this.cache?.progress(file).then(progress =>
          channel.postMessage({ type: 'progress', progress })).catch(() => {});
        void this.cache?.getPreview(file.fileId).then(dataUrl => {
          if (dataUrl && this.tabs.has(key)) {
            channel.postMessage({ type: 'preview', fileId: file.fileId, dataUrl });
          }
        }).catch(() => {});
      } else if (m.type === 'first-page') {
        // The viewer has no influence on the transfer scheduler.
      } else if (m.type === 'perf' && perf.enabled) {
        if (m.metric === 'first_slide_after_present_ms' && !firstSlideObserved) {
          firstSlideObserved = true;
          perf.record('first_slide_after_present_ms', performance.now() - openedAt);
        } else if ((m.metric === 'page_render_ms' || m.metric === 'pdf_open_ms') &&
            Number.isFinite(m.ms) && m.ms >= 0 && m.ms < 300000) {
          perf.record(m.metric as PerfName, m.ms, { page: m.page });
        }
      } else if (m.type === 'cancel' && typeof m.id === 'string') {
        requests.get(m.id)?.cancel();
        requests.delete(m.id);
      } else if (m.type === 'close') {
        close();
      } else if (m.type === 'range') {
        if (typeof m.id !== 'string' || !/^[a-zA-Z0-9_-]{6,80}$/.test(m.id) ||
            !Number.isSafeInteger(m.begin) || !Number.isSafeInteger(m.end) ||
            m.begin < 0 || m.end <= m.begin || m.end > file.size ||
            m.end - m.begin > MAX_RANGE_BYTES || requests.has(m.id)) return;
        // Presenter is a passive read-only client. It must NEVER cause a
        // network request or alter concurrency/priority of file transfers.
        let cancelled = false;
        const controller = new AbortController();
        requests.set(m.id, { cancel: () => { cancelled = true; controller.abort(); } });
        void this.cache!.cachedRange(file, m.begin, m.end, controller.signal).then(bytes => {
          if (!cancelled && this.tabs.has(key)) channel.postMessage({
            type: 'data', id: m.id, begin: m.begin, bytes,
          });
        }).catch(error => {
          if (!cancelled && this.tabs.has(key)) channel.postMessage({
            type: 'error', id: m.id, message: String(error instanceof Error ? error.message : error),
          });
        }).finally(() => requests.delete(m.id));
      }
    };
    // A new tab otherwise receives a copy of the dashboard's sessionStorage,
    // including its host token. Remove it before loading the presenter.
    const tab = window.open('about:blank', '_blank');
    if (!tab) { close(); throw Error('Allow popups to open the presentation in a new tab.'); }
    try {
      tab.sessionStorage.removeItem('flashview-host');
      tab.opener = null;
      tab.location.replace('/present' + (perfEnabled ? '?perf=1' : '') + '#' + key);
    } catch {
      tab.close(); close();
      throw Error('Cannot open an isolated presentation tab in this browser.');
    }
  }

  removeFile(fileId: string): void {
    for (const [key,entry] of this.tabs) if (entry.file.fileId === fileId) {
      entry.channel.postMessage({ type:'closed' });
      for (const request of entry.requests.values()) request.cancel();
      entry.channel.close();
      this.tabs.delete(key);
    }
  }
  closeAll(): void {
    for (const entry of this.tabs.values()) {
      entry.channel.postMessage({ type: 'closed' });
      for (const request of entry.requests.values()) request.cancel();
      entry.channel.close();
    }
    this.tabs.clear();
  }
}

/** Local byte bridge plus a restricted liveness lease; never authenticates as host. */
export class PresentationGuest implements PdfRangeSource {
  private lease = new RoomLease();
  private channel: BroadcastChannel;
  private pending = new Map<string, { resolve: Reply; reject: Failure; timer: ReturnType<typeof setTimeout> }>();
  private activeRanges = new Set<(reason?: string) => void>();
  onFile: (file: PdfManifest, roomId: string) => void = () => {};
  onClosed: () => void = () => {};
  onProgress: (progress: CacheProgress) => void = () => {};
  onPreview: (dataUrl: string) => void = () => {};

  constructor(key: string) {
    this.channel = new BroadcastChannel(PREFIX + key);
    this.channel.onmessage = (event: MessageEvent) => {
      const m = event.data;
      if (!m || typeof m !== 'object') return;
      if ((m.type === 'metadata' || m.type === 'lease') && isRoomLeaseIdentity(m.lease)) this.lease.start(m.lease);
      if (m.type === 'metadata' && typeof m.roomId === 'string') this.onFile(m.file as PdfManifest, m.roomId);
      if (m.type === 'closed') { this.lease.stop(); this.onClosed(); }
      if (m.type === 'progress' && m.progress) this.onProgress(m.progress as CacheProgress);
      if (m.type === 'preview' && typeof m.dataUrl === 'string')
        this.onPreview(m.dataUrl);
      if (m.type === 'data' || m.type === 'error') {
        const pending = this.pending.get(m.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(m.id);
        if (m.type === 'data' && m.bytes instanceof Uint8Array) pending.resolve(m.begin, m.bytes);
        else pending.reject(String(m.message || 'PDF range unavailable'));
      }
    };
  }

  ready(): void { this.channel.postMessage({ type: 'ready' }); }
  firstPageRendered(): void { this.channel.postMessage({ type: 'first-page' }); }
  report(metric: 'first_slide_after_present_ms' | 'page_render_ms' | 'pdf_open_ms',
    ms = 0, page?: number): void {
    if (perf.enabled) this.channel.postMessage({ type: 'perf', metric, ms, page });
  }
  requestRange(_fileId: string, begin: number, end: number, resolve: Reply, reject: Failure): () => void {
    // BroadcastChannel may lose a message while the host tab is suspended.
    // Reissue each attempt with a fresh ID; keep the PDF.js range reader
    // ALIVE instead of permanently failing it on a transient timeout.
    let id: string | null = null;
    let cancelled = false;
    let failures = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      if (id !== null) {
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          this.channel.postMessage({ type: 'cancel', id });
        }
        id = null;
      }
      this.activeRanges.delete(stop);
    };
    const stop = (reason?: string) => {
      if (cancelled) return;
      cleanup();
      if (reason) reject(reason);
    };
    const retry = (reason: string) => {
      if (cancelled) return;
      // Invalid ranges and corrupt files will never become valid by retrying.
      if (/invalid pdf byte|invalid.*range|incomplete pdf byte|password/i.test(reason)) {
        stop(reason);
        return;
      }
      // Back off a repeated failure, but never abandon a page simply because
      // the student was temporarily backgrounded or the network switched.
      const delay = Math.min(600 * 2 ** Math.min(failures++, 4), 8_000);
      retryTimer = setTimeout(sendRequest, delay);
    };
    const sendRequest = () => {
      if (cancelled) return;
      const requestId = crypto.randomUUID().replaceAll('-', '');
      id = requestId;
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) retry('Classroom did not respond');
      }, 25_000);
      this.pending.set(requestId, {
        resolve: (start, bytes) => {
          if (cancelled || id !== requestId) return;
          cleanup();
          resolve(start, bytes);
        },
        reject: reason => {
          if (cancelled || id !== requestId) return;
          retry(reason);
        },
        timer,
      });
      this.channel.postMessage({ type: 'range', id: requestId, begin, end });
    };
    this.activeRanges.add(stop);
    sendRequest();
    return () => stop();
  }
  close(): void {
    this.lease.stop();
    for (const stop of [...this.activeRanges]) stop('Presentation closed');
    this.pending.clear();
    this.channel.postMessage({ type: 'close' });
    this.channel.close();
  }
}
