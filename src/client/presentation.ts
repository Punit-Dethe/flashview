import type { PdfManifest } from '../shared/protocol';
import { MAX_RANGE_BYTES } from '../shared/protocol';
import type { RoomSocket } from './socket';

const PREFIX = 'flashview-present-';
type Pending = { cancel: () => void };
type Reply = (start: number, bytes: Uint8Array) => void;
type Failure = (message: string) => void;
export type PdfRangeSource = Pick<RoomSocket, 'requestRange'>;

/** The original room tab owns the only host WebSocket. */
export class PresentationHost {
  private tabs = new Map<string, { channel: BroadcastChannel; requests: Map<string, Pending>; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly socket: RoomSocket) {}

  open(file: PdfManifest): void {
    if (!this.socket.connected || file.status !== 'approved') throw Error('Classroom or PDF is offline.');
    if (typeof BroadcastChannel === 'undefined') throw Error('Presentation tabs are unsupported in this browser.');
    const key = crypto.randomUUID().replaceAll('-', '');
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
    this.tabs.set(key, { channel, requests, timer });
    channel.onmessage = (event: MessageEvent) => {
      const m = event.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') {
        channel.postMessage({ type: 'metadata', file });
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
        if (!this.socket.connected) {
          channel.postMessage({ type: 'error', id: m.id, message: 'Classroom connection interrupted.' });
          return;
        }
        const cancel = this.socket.requestRange(file.fileId, m.begin, m.end,
          (begin, bytes) => {
            requests.delete(m.id);
            channel.postMessage({ type: 'data', id: m.id, begin, bytes });
          },
          reason => {
            requests.delete(m.id);
            channel.postMessage({ type: 'error', id: m.id, message: reason });
          });
        requests.set(m.id, { cancel });
      }
    };
    const tab = window.open('/present#' + key, '_blank');
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
  onFile: (file: PdfManifest) => void = () => {};
  onClosed: () => void = () => {};

  constructor(key: string) {
    this.channel = new BroadcastChannel(PREFIX + key);
    this.channel.onmessage = (event: MessageEvent) => {
      const m = event.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'metadata') this.onFile(m.file as PdfManifest);
      if (m.type === 'closed') this.onClosed();
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
