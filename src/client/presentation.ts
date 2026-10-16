import type { PdfManifest } from '../shared/protocol';
import { MAX_RANGE_BYTES } from '../shared/protocol';
import { RoomPdfCache, type CacheProgress, cleanExpiredRoomCaches } from './pdf/roomCache';
import type { RoomSocket } from './socket';
import { perf, perfEnabled, type PerfName } from './perf';

const PREFIX = 'flashview-present-';
type Pending = { cancel: () => void };
type Reply = (start: number, bytes: Uint8Array) => void;
type Failure = (message: string) => void;
export type PdfRangeSource = Pick<RoomSocket, 'requestRange'>;

/** The original room tab owns the only host WebSocket. */
export class PresentationHost {
  private tabs = new Map<string, { file: PdfManifest; channel: BroadcastChannel; requests: Map<string, Pending>; timer: ReturnType<typeof setTimeout> }>();
  private cache: RoomPdfCache | null = null;
  private lastProgressPaint = new Map<string, number>();
  onProgress: (status: CacheProgress) => void = () => {};
  onWarning: (message: string) => void = () => {};
  constructor(private readonly socket: RoomSocket) {}

  setRoom(roomId: string): void {
    if (this.cache?.roomId === roomId) return;
    this.closeAll();
    this.cache?.dispose();
    this.lastProgressPaint.clear();
    const cache = new RoomPdfCache(roomId, this.socket);
    cache.onProgress = progress => {
      // Persist every chunk immediately but paint/publish only a few times per
      // second. Never postpone the completion event: PDF.js may switch to its
      // complete-local-file path when progress.complete becomes true.
      const now = performance.now();
      const previous = this.lastProgressPaint.get(progress.fileId) ?? -Infinity;
      if (!progress.complete && now - previous < 350) return;
      this.lastProgressPaint.set(progress.fileId, now);
      this.onProgress(progress);
      for (const entry of this.tabs.values()) {
        if (entry.file.fileId === progress.fileId)
          entry.channel.postMessage({ type: 'progress', progress });
      }
    };
    cache.onStorageWarning = message => this.onWarning(message);
    this.cache = cache;
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
    this.cache = null;
    if (cache) await cache.clear();
  }
  resume(): void { this.cache?.resume(); }
  async savePreview(fileId: string, dataUrl: string): Promise<void> {
    if (!this.cache) return;
    await this.cache.savePreview(fileId, dataUrl);
    for (const tab of this.tabs.values()) {
      if (tab.file.fileId === fileId) {
        tab.channel.postMessage({ type: 'preview', fileId, dataUrl });
      }
    }
  }
  /** Do not wait for the presentation window; begin caching on file arrival. */
  queue(file: PdfManifest): void {
    if (file.status === 'approved') this.cache?.prefetch(file);
    else this.cache?.pause(file.fileId);
  }
  dispose(): void { this.closeAll(); this.cache?.dispose(); this.cache = null; this.lastProgressPaint.clear(); }

  open(file: PdfManifest): void {
    if (!this.cache) throw Error('Classroom cache is unavailable. Refresh the dashboard.');
    if (!this.socket.connected && file.status !== 'offline') throw Error('Classroom connection interrupted.');
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
      clearTimeout(tab.timer);
      channel.close();
      this.tabs.delete(key);
    };
    const timer = setTimeout(close, 2 * 60 * 60 * 1000);
    this.tabs.set(key, { file, channel, requests, timer });
    channel.onmessage = (event: MessageEvent) => {
      const m = event.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') {
        channel.postMessage({ type: 'metadata', file, roomId: this.cache?.roomId });
        void this.cache?.progress(file).then(progress =>
          channel.postMessage({ type: 'progress', progress })).catch(() => {});
        void this.cache?.getPreview(file.fileId).then(dataUrl => {
          if (dataUrl && this.tabs.has(key)) {
            channel.postMessage({ type: 'preview', fileId: file.fileId, dataUrl });
          }
        }).catch(() => {});
      } else if (m.type === 'first-page') {
        this.cache?.prefetch(file);
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
        // Cached bytes are available even after the student leaves.
        // All misses use one shared room cache, not a fresh viewer transfer.
        let cancelled = false;
        requests.set(m.id, { cancel: () => { cancelled = true; } });
        void this.cache!.range(file, m.begin, m.end).then(bytes => {
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
    const tab = window.open('/present' + (perfEnabled ? '?perf=1' : '') + '#' + key, '_blank');
    if (!tab) { close(); throw Error('Allow popups to open the presentation in a new tab.'); }
    try { tab.opener = null; } catch { /* Browser manages opener restrictions. */ }
  }

  closeAll(): void {
    for (const entry of this.tabs.values()) {
      entry.channel.postMessage({ type: 'closed' });
      for (const request of entry.requests.values()) request.cancel();
      clearTimeout(entry.timer);
      entry.channel.close();
    }
    this.tabs.clear();
  }
}

/** A presenter only talks to its same-origin room tab; never authenticates as host. */
export class PresentationGuest implements PdfRangeSource {
  private channel: BroadcastChannel;
  private pending = new Map<string, { resolve: Reply; reject: Failure; timer: ReturnType<typeof setTimeout> }>();
  onFile: (file: PdfManifest, roomId: string) => void = () => {};
  onClosed: () => void = () => {};
  onProgress: (progress: CacheProgress) => void = () => {};
  onPreview: (dataUrl: string) => void = () => {};

  constructor(key: string) {
    this.channel = new BroadcastChannel(PREFIX + key);
    this.channel.onmessage = (event: MessageEvent) => {
      const m = event.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'metadata' && typeof m.roomId === 'string') this.onFile(m.file as PdfManifest, m.roomId);
      if (m.type === 'closed') this.onClosed();
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
    const id = crypto.randomUUID().replaceAll('-', '');
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject('The PDF request timed out. Keep the classroom tab open.');
    }, 25_000);
    this.pending.set(id, { resolve, reject, timer });
    this.channel.postMessage({ type: 'range', id, begin, end });
    return () => {
      const item = this.pending.get(id);
      if (!item) return;
      clearTimeout(item.timer);
      this.pending.delete(id);
      this.channel.postMessage({ type: 'cancel', id });
    };
  }
  close(): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject('Presentation closed');
    }
    this.pending.clear();
    this.channel.postMessage({ type: 'close' });
    this.channel.close();
  }
}
