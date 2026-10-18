import { MAX_RANGE_BYTES, ROOM_TTL_MS, type PdfManifest } from '../../shared/protocol';
import type { RoomSocket } from '../socket';
import { perf } from '../perf';
import { AdaptiveTransferWindow, WINDOW_INITIAL } from './adaptiveWindow';
import { packetChunksFromQuery, selectMissingChunkGroup } from './networkPacket';

export const CHUNK_BYTES = 65_536;
// Keep a bounded background pipeline regardless of whether a viewer is open.
// PDF viewing remains passive and does not request network bytes.
const BACKGROUND_WINDOW = WINDOW_INITIAL;
const MAX_BACKGROUND_REQUESTS = 16; // Each slot represents one network request, not one cache block.
const DB_NAME = 'flashview-room-cache';
const DB_VERSION = 2;
const MAX_MEMORY_BYTES = 48 * 1024 * 1024;
type ChunkRecord = { key: string; room: string; document: string; index: number; data: ArrayBuffer };
type RoomRecord = { id: string; expires: number };
export type CacheProgress = { fileId: string; bytes: number; size: number; complete: boolean };

let openDatabase: Promise<IDBDatabase> | null = null;
function database(): Promise<IDBDatabase> {
  if (!openDatabase) {
    openDatabase = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('chunks')) {
          const store = db.createObjectStore('chunks', { keyPath: 'key' });
          store.createIndex('room', 'room', { unique: false });
          store.createIndex('document', 'document', { unique: false });
        }
        if (!db.objectStoreNames.contains('rooms')) db.createObjectStore('rooms', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('previews')) {
          const store = db.createObjectStore('previews', { keyPath: 'key' });
          store.createIndex('room', 'room', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Local document storage unavailable'));
    }).catch(error => {
      openDatabase = null;
      throw error;
    });
  }
  return openDatabase!;
}

function completion(file: PdfManifest, indices: Set<number>): CacheProgress {
  const count = Math.ceil(file.size / CHUNK_BYTES);
  let bytes = 0;
  for (const i of indices) {
    if (i >= 0 && i < count) bytes += Math.min(CHUNK_BYTES, file.size - i * CHUNK_BYTES);
  }
  return { fileId: file.fileId, bytes, size: file.size, complete: indices.size === count && bytes === file.size };
}

async function readChunk(key: string): Promise<ArrayBuffer | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction('chunks', 'readonly').objectStore('chunks').get(key);
    request.onsuccess = () => resolve((request.result as ChunkRecord | undefined)?.data ?? null);
    request.onerror = () => reject(request.error);
  });
}
async function saveChunk(record: ChunkRecord): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('chunks', 'readwrite');
    tx.objectStore('chunks').put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
async function cachedIndices(room: string, fileId: string): Promise<Set<number>> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction('chunks', 'readonly').objectStore('chunks')
      .index('document').getAllKeys(IDBKeyRange.only(room + '/' + fileId));
    request.onsuccess = () => {
      const indices = (request.result as string[])
        .map(k => Number(k.slice(k.lastIndexOf('/') + 1)))
        .filter(Number.isSafeInteger);
      resolve(new Set(indices));
    };
    request.onerror = () => reject(request.error);
  });
}
/**
 * Read an entire completed PDF from the teacher's local browser.
 * Once complete, PDF.js can consume an ordinary Uint8Array instead of
 * custom range transport (eliminates streamed-page scheduling races).
 */
export async function readCompletedPdf(roomId: string, file: PdfManifest): Promise<Uint8Array | null> {
  const db = await database();
  const chunks = await new Promise<ChunkRecord[]>((resolve, reject) => {
    const request = db.transaction('chunks', 'readonly').objectStore('chunks')
      .index('document').getAll(IDBKeyRange.only(roomId + '/' + file.fileId));
    request.onsuccess = () => resolve(request.result as ChunkRecord[]);
    request.onerror = () => reject(request.error);
  });
  const count = Math.ceil(file.size / CHUNK_BYTES);
  if (chunks.length !== count) return null;
  chunks.sort((a, b) => a.index - b.index);
  const result = new Uint8Array(file.size);
  for (let i = 0; i < count; i++) {
    const chunk = chunks[i];
    const length = Math.min(CHUNK_BYTES, file.size - i * CHUNK_BYTES);
    if (chunk.index !== i || chunk.room !== roomId || chunk.data.byteLength !== length) return null;
    result.set(new Uint8Array(chunk.data), i * CHUNK_BYTES);
  }
  return result;
}

/** The exact same chunk assembly also reconstructs arbitrary completed files.
 * Kept as an alias so the PDF viewer and its existing cache path stay intact. */
export const readCompletedFile = readCompletedPdf;

async function writeRoom(room: string): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('rooms', 'readwrite');
    tx.objectStore('rooms').put({ id: room, expires: Date.now() + ROOM_TTL_MS } satisfies RoomRecord);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
/** Delete ONLY the chosen room's original PDF chunks, not files in other rooms. */
export async function deleteRoomCache(room: string): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['chunks', 'rooms', 'previews'], 'readwrite');
    const index = tx.objectStore('chunks').index('room');
    const request = index.openKeyCursor(IDBKeyRange.only(room));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      tx.objectStore('chunks').delete(cursor.primaryKey);
      cursor.continue();
    };
    const previewCursor = tx.objectStore('previews').index('room')
      .openKeyCursor(IDBKeyRange.only(room));
    previewCursor.onsuccess = () => {
      const cursor = previewCursor.result;
      if (!cursor) return;
      tx.objectStore('previews').delete(cursor.primaryKey);
      cursor.continue();
    };
    tx.objectStore('rooms').delete(room);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export async function cleanExpiredRoomCaches(activeRoom?: string): Promise<void> {
  let rooms: RoomRecord[];
  try {
    const db = await database();
    rooms = await new Promise((resolve, reject) => {
      const request = db.transaction('rooms', 'readonly').objectStore('rooms').getAll();
      request.onsuccess = () => resolve(request.result as RoomRecord[]);
      request.onerror = () => reject(request.error);
    });
  } catch { return; }
  for (const room of rooms) {
    if (room.expires <= Date.now() && room.id !== activeRoom) {
      try { await deleteRoomCache(room.id); } catch { /* Retry on next visit. */ }
    }
  }
}

/**
 * The classroom tab owns this cache and all background transfer jobs.
 * Persistent IndexedDB is shared across same-origin viewer tabs and survives refresh.
 * If storage is disabled or full, an LRU in-memory fallback still permits viewing.
 */
export class RoomPdfCache {
  private stopped = false;
  private inFlight = new Map<string, Promise<Uint8Array>>();
  // Passive presentation readers subscribe to the cache. Only the
  // background scheduler may create network range requests.
  private cacheWaiters = new Map<string, Set<() => void>>();
  private memory = new Map<string, Uint8Array>();
  private pendingWrites = new Set<Promise<void>>();
  private memoryBytes = 0;
  private indices = new Map<string, Promise<Set<number>>>();
  private jobs = new Map<string, PdfManifest>();
  private working = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private activeBackground = new Set<Promise<void>>();
  // Adaptive limits count outstanding network requests, not individual 64 KiB
  // persistent blocks. The baseline at 64 KiB retains the same request count.
  private activePerFileRequests = new Map<string, number>();
  private reserved = new Map<string, Set<number>>();
  private nextIndex = new Map<string, number>();
  private cooldown = new Map<string, number>();
  private rotation = 0;
  private readonly adaptive = new Map<string, AdaptiveTransferWindow>();
  // Keep a fixed scheduler available for identical-file A/B tests.
  private readonly fixedTransfer = new URLSearchParams(location.search).get('transfer') === 'fixed';
  private readonly networkChunks = packetChunksFromQuery(location.search);
  private storageFailedFiles = new Set<string>();
  onProgress: (progress: CacheProgress) => void = () => {};
  onStorageWarning: (text: string) => void = () => {};
  private warned = false;

  constructor(readonly roomId: string, private readonly socket: RoomSocket) {
    void writeRoom(roomId).catch(() => this.warning());
  }
  private warning(): void {
    if (this.warned) return;
    this.warned = true;
    this.onStorageWarning('Browser storage is unavailable or full. Cached PDFs may not survive a refresh.');
  }
  private key(fileId: string, index: number): string {
    return this.roomId + '/' + fileId + '/' + index;
  }
  private indexSet(fileId: string): Promise<Set<number>> {
    let pending = this.indices.get(fileId);
    if (!pending) {
      pending = cachedIndices(this.roomId, fileId).catch(() => {
        this.warning();
        return new Set<number>();
      });
      this.indices.set(fileId, pending);
    }
    return pending;
  }
  private putMemory(key: string, data: Uint8Array): void {
    if (data.byteLength > MAX_MEMORY_BYTES) return;
    const previous = this.memory.get(key);
    if (previous) this.memoryBytes -= previous.byteLength;
    this.memory.delete(key);
    this.memory.set(key, data);
    this.memoryBytes += data.byteLength;
    while (this.memoryBytes > MAX_MEMORY_BYTES) {
      const first = this.memory.keys().next().value;
      if (first === undefined) break;
      this.memoryBytes -= this.memory.get(first)!.byteLength;
      this.memory.delete(first);
    }
  }
  async savePreview(fileId: string, dataUrl: string): Promise<void> {
    if (this.stopped || !/^[a-zA-Z0-9_-]{6,80}$/.test(fileId) ||
        !/^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(dataUrl) ||
        dataUrl.length > 390000) return;
    try {
      const db = await database();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('previews', 'readwrite');
        tx.objectStore('previews').put({
          key: this.roomId + '/' + fileId, room: this.roomId, dataUrl,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch { this.warning(); }
  }
  async getPreview(fileId: string): Promise<string | null> {
    try {
      const db = await database();
      const result = await new Promise<{ dataUrl: string } | undefined>((resolve, reject) => {
        const request = db.transaction('previews', 'readonly').objectStore('previews')
          .get(this.roomId + '/' + fileId);
        request.onsuccess = () => resolve(request.result as { dataUrl: string } | undefined);
        request.onerror = () => reject(request.error);
      });
      return result?.dataUrl ?? null;
    } catch { return null; }
  }
  async progress(file: PdfManifest): Promise<CacheProgress> {
    const indices = await this.indexSet(file.fileId);
    return completion(file, indices);
  }
  private async chunk(file: PdfManifest, index: number): Promise<Uint8Array> {
    if (this.stopped) throw Error('Classroom cache closed');
    const key = this.key(file.fileId, index);
    const cached = this.memory.get(key);
    if (cached) return cached;
    // Attach to an already-requested chunk before querying IndexedDB.
    const running = this.inFlight.get(key);
    if (running) return running;
    // Our room/file index was loaded once from IndexedDB and is kept current
    // after every successful write. Avoid a database transaction for every
    // chunk already known to be missing.
    const indexed = await this.indexSet(file.fileId);
    if (indexed.has(index)) {
      try {
        const stored = await readChunk(key);
        if (stored && stored.byteLength === Math.min(CHUNK_BYTES, file.size - index * CHUNK_BYTES)) {
          const bytes = new Uint8Array(stored);
          this.putMemory(key, bytes);
          return bytes;
        }
        // Treat deleted/corrupt chunks as cache misses, not as completed data.
        indexed.delete(index);
      } catch { this.warning(); indexed.delete(index); }
    }
    // Another caller may have started fetching the same chunk during the
    // awaited IndexedDB lookup; do not duplicate a phone round trip.
    const afterRead = this.inFlight.get(key);
    if (afterRead) return afterRead;
    const begin = index * CHUNK_BYTES;
    const end = Math.min(file.size, begin + CHUNK_BYTES);
    const networkStartedAt = performance.now();
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      if (!this.socket.connected) return reject(Error('The sender is offline. Cached pages remain available.'));
      this.socket.requestRange(file.fileId, begin, end,
        (start: number, data: Uint8Array) => {
          if (start !== begin || data.byteLength !== end - begin) {
            reject(Error('Incomplete PDF byte range')); return;
          }
          if (!this.fixedTransfer && !this.stopped)
            this.tuner(file.fileId).success(performance.now() - networkStartedAt);
          resolve(data);
        }, (reason: string) => {
          if (!this.fixedTransfer && !this.stopped) this.tuner(file.fileId).failure();
          reject(Error(reason));
        });
    }).then(async data => {
      if (this.stopped) throw Error('Classroom cache closed');
      this.putMemory(key, data);
      const writingSince = perf.enabled ? performance.now() : 0;
      const saving = saveChunk({
        key, room: this.roomId, document: this.roomId + '/' + file.fileId,
        index, data: data.slice().buffer,
      });
      this.pendingWrites.add(saving);
      try {
        await saving;
        if (perf.enabled) perf.record('cache_write_ms', performance.now() - writingSince, { bytes: data.byteLength });
        if (this.stopped) return data;
        const set = await this.indexSet(file.fileId);
        set.add(index);
        const state = completion(file, set);
        if (state.complete) perf.elapsed('cache_complete_ms', 'cache:' + file.fileId, file.size);
        this.onProgress(state);
        this.notifyCacheWaiters(key);
      } catch {
        this.warning();
        this.storageFailedFiles.add(file.fileId);
        this.jobs.delete(file.fileId);
        // Storage can fail while an in-memory copy remains viewable.
        this.notifyCacheWaiters(key);
      }
      finally { this.pendingWrites.delete(saving); }
      return data;
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }
  /**
   * One 128/256 KiB WebSocket range response, saved as separate 64 KiB cache
   * blocks. Keep the existing independent IndexedDB transaction per block:
   * changing storage batching belongs to the NEXT isolated experiment.
   */
  private async chunkGroup(file: PdfManifest, indices: number[]): Promise<void> {
    if (indices.length < 2 || indices.length > 4) throw Error('Invalid network group');
    const begin = indices[0] * CHUNK_BYTES;
    const end = Math.min(file.size, (indices[indices.length - 1] + 1) * CHUNK_BYTES);
    if (end - begin > MAX_RANGE_BYTES) throw Error('Network range too large');
    const networkStartedAt = performance.now();
    const data = await new Promise<Uint8Array>((resolve, reject) => {
      if (!this.socket.connected) return reject(Error('The sender is offline. Cached pages remain available.'));
      this.socket.requestRange(file.fileId, begin, end, (start, bytes) => {
        if (start !== begin || bytes.byteLength !== end - begin) {
          reject(Error('Incomplete PDF byte range')); return;
        }
        if (!this.fixedTransfer && !this.stopped)
          this.tuner(file.fileId).success(performance.now() - networkStartedAt);
        resolve(bytes);
      }, reason => {
        if (!this.fixedTransfer && !this.stopped) this.tuner(file.fileId).failure();
        reject(Error(reason));
      });
    });
    if (this.stopped) throw Error('Classroom cache closed');
    await Promise.all(indices.map(async index => {
      const key = this.key(file.fileId, index);
      const offset = index * CHUNK_BYTES - begin;
      const piece = data.slice(offset, Math.min(offset + CHUNK_BYTES, data.byteLength));
      this.putMemory(key, piece);
      const writingSince = perf.enabled ? performance.now() : 0;
      const saving = saveChunk({
        key, room: this.roomId, document: this.roomId + '/' + file.fileId,
        index, data: piece.slice().buffer,
      });
      this.pendingWrites.add(saving);
      try {
        await saving;
        if (perf.enabled) perf.record('cache_write_ms', performance.now() - writingSince, { bytes: piece.byteLength });
        if (this.stopped) return;
        const set = await this.indexSet(file.fileId);
        set.add(index);
        const state = completion(file, set);
        if (state.complete) perf.elapsed('cache_complete_ms', 'cache:' + file.fileId, file.size);
        this.onProgress(state);
        this.notifyCacheWaiters(key);
      } catch {
        this.warning();
        this.storageFailedFiles.add(file.fileId);
        this.jobs.delete(file.fileId);
        // A persisted chunk is never acknowledged before its transaction
        // commits. In-memory bytes can still satisfy existing viewers.
        this.notifyCacheWaiters(key);
      } finally {
        this.pendingWrites.delete(saving);
      }
    }));
  }

  private notifyCacheWaiters(key: string): void {
    const waiting = this.cacheWaiters.get(key);
    if (!waiting) return;
    this.cacheWaiters.delete(key);
    for (const wake of waiting) wake();
  }

  /**
   * Read-only, demand-independent presentation path. Never requests phone
   * bytes, changes transfer concurrency or prioritizes a PDF.js page. A
   * missing chunk is satisfied ONLY by the continuously running background
   * transfer, or by bytes already present in IndexedDB/memory.
   */
  private async cachedChunk(file: PdfManifest, index: number, signal?: AbortSignal): Promise<Uint8Array> {
    const key = this.key(file.fileId, index);
    const expected = Math.min(CHUNK_BYTES, file.size - index * CHUNK_BYTES);
    while (!this.stopped) {
      if (signal?.aborted) throw Error('Presentation range cancelled');
      const memory = this.memory.get(key);
      if (memory?.byteLength === expected) return memory;
      const indexed = await this.indexSet(file.fileId);
      if (indexed.has(index)) {
        try {
          const bytes = await readChunk(key);
          if (bytes?.byteLength === expected) {
            const result = new Uint8Array(bytes);
            this.putMemory(key, result);
            return result;
          }
          indexed.delete(index);
        } catch { this.warning(); indexed.delete(index); }
      }
      // Subscribe before rechecking memory to avoid missing completion between
      // the asynchronous IndexedDB read and listener registration.
      await new Promise<void>((resolve, reject) => {
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(Error('Presentation range cancelled')); };
        const cleanup = () => {
          const listeners = this.cacheWaiters.get(key);
          listeners?.delete(wake);
          if (listeners?.size === 0) this.cacheWaiters.delete(key);
          signal?.removeEventListener('abort', abort);
        };
        let listeners = this.cacheWaiters.get(key);
        if (!listeners) { listeners = new Set(); this.cacheWaiters.set(key, listeners); }
        listeners.add(wake);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        else if (this.memory.has(key)) wake();
      });
    }
    throw Error('Classroom cache closed');
  }

  async cachedRange(file: PdfManifest, begin: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) ||
        begin < 0 || end <= begin || end > file.size || end - begin > MAX_RANGE_BYTES) {
      throw Error('Invalid PDF byte request');
    }
    const first = Math.floor(begin / CHUNK_BYTES);
    const last = Math.floor((end - 1) / CHUNK_BYTES);
    const parts = await Promise.all(
      Array.from({ length: last - first + 1 }, (_, i) => this.cachedChunk(file, first + i, signal)),
    );
    if (signal?.aborted) throw Error('Presentation range cancelled');
    const result = new Uint8Array(end - begin);
    for (let i = first; i <= last; i++) {
      const offset = i * CHUNK_BYTES;
      const from = Math.max(begin, offset);
      const to = Math.min(end, offset + parts[i - first].length);
      result.set(parts[i - first].subarray(from - offset, to - offset), from - begin);
    }
    return result;
  }

  /** Queue a file as soon as it is offered, not when the viewer opens. */
  prefetch(file: PdfManifest): void {
    if (this.stopped || this.storageFailedFiles.has(file.fileId)) return;
    if (!this.jobs.has(file.fileId)) perf.mark('cache:' + file.fileId);
    this.jobs.set(file.fileId, file);
    this.resume();
  }
  /** A disconnected student must not consume the background scheduler. */
  pause(fileId: string): void {
    this.jobs.delete(fileId);
    this.nextIndex.delete(fileId);
    this.cooldown.delete(fileId);
    this.adaptive.delete(fileId);
  }
  resume(): void {
    if (this.stopped) return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.work();
  }

  private tuner(fileId: string): AdaptiveTransferWindow {
    let value = this.adaptive.get(fileId);
    if (!value) {
      value = new AdaptiveTransferWindow();
      this.adaptive.set(fileId, value);
    }
    return value;
  }
  private reserveNext(file: PdfManifest, cached: Set<number>): number[] {
    const total = Math.ceil(file.size / CHUNK_BYTES);
    let reserved = this.reserved.get(file.fileId);
    if (!reserved) {
      reserved = new Set<number>();
      this.reserved.set(file.fileId, reserved);
    }
    const currentWindow = this.fixedTransfer ? BACKGROUND_WINDOW : this.tuner(file.fileId).limit;
    if ((this.activePerFileRequests.get(file.fileId) ?? 0) >= currentWindow) return [];
    // Full-file PPTX baseline: normal forward cache schedule. The presentation
    // renderer reads only after completion and never changes scheduling.
    const cursor = this.nextIndex.get(file.fileId) ?? 0;
    const selected = selectMissingChunkGroup(total, cursor, cached, reserved, this.networkChunks);
    if (!selected.length) return [];
    for (const index of selected) reserved.add(index);
    this.nextIndex.set(file.fileId, (selected[selected.length - 1] + 1) % total);
    return selected;
  }

  private async work(): Promise<void> {
    if (this.working || this.stopped || this.jobs.size === 0) return;
    this.working = true;
    let retryAfter = 0;
    try {
      // No artificial successful-batch timer. A settled transfer makes a
      // slot available to other students immediately, independent of tabs.
      while (!this.stopped && this.jobs.size > 0) {
        if (!this.socket.connected) { retryAfter = 4500; break; }
        const entries = [...this.jobs.entries()];
        if (entries.length === 0) break;
        const rotation = this.rotation++ % entries.length;
        let scheduled = false;
        // Fair round robin over files: give each file one slot per turn,
        // rather than blocking a whole classroom on one phone's slow batch.
        while (this.activeBackground.size < MAX_BACKGROUND_REQUESTS) {
          let assignedThisRound = false;
          for (let i = 0; i < entries.length && this.activeBackground.size < MAX_BACKGROUND_REQUESTS; i++) {
            const [fileId, file] = entries[(i + rotation) % entries.length];
            if (!this.jobs.has(fileId) || this.storageFailedFiles.has(fileId)) {
              this.jobs.delete(fileId); continue;
            }
            if (Date.now() < (this.cooldown.get(fileId) ?? 0)) continue;
            const cached = await this.indexSet(fileId);
            if (this.stopped) return;
            const total = Math.ceil(file.size / CHUNK_BYTES);
            if (cached.size === total) {
              if ((this.reserved.get(fileId)?.size ?? 0) === 0) {
                this.jobs.delete(fileId);
                this.nextIndex.delete(fileId);
                this.cooldown.delete(fileId);
                this.reserved.delete(fileId);
                this.adaptive.delete(fileId);
                this.onProgress(completion(file, cached));
              }
              continue;
            }
            const indices = this.reserveNext(file, cached);
            if (indices.length === 0) continue;
            scheduled = true;
            assignedThisRound = true;
            this.activePerFileRequests.set(fileId, (this.activePerFileRequests.get(fileId) ?? 0) + 1);
            // Each request settles independently. Failures back off ONLY
            // the affected student/file; successful peers continue.
            let task: Promise<void>;
            const transfer = indices.length === 1
              ? this.chunk(file, indices[0]).then(() => {})
              : this.chunkGroup(file, indices);
            task = transfer.then(() => {
              this.cooldown.delete(fileId);
            }).catch(() => {
              if (this.jobs.has(fileId)) this.cooldown.set(fileId, Date.now() + 4500);
            }).finally(() => {
              for (const index of indices) this.reserved.get(fileId)?.delete(index);
              const count = (this.activePerFileRequests.get(fileId) ?? 0) - 1;
              if (count > 0) this.activePerFileRequests.set(fileId, count);
              else this.activePerFileRequests.delete(fileId);
              this.activeBackground.delete(task);
            });
            this.activeBackground.add(task);
          }
          if (!assignedThisRound) break;
        }
        if (this.activeBackground.size > 0) {
          // A stalled request doesn't block other files unless all bounded
          // network slots really are in use. Page reads have separate slots.
          await Promise.race(this.activeBackground);
          continue;
        }
        if (this.jobs.size === 0) break;
        // Nothing currently schedulable: all remaining senders are offline
        // or under per-file retry backoff, not a normal download cycle.
        retryAfter = 4500;
        if (!scheduled) break;
      }
    } finally {
      this.working = false;
      if (!this.stopped && this.jobs.size > 0 && retryAfter > 0) {
        if (this.retryTimer !== null) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.work();
        }, retryAfter);
      }
    }
  }
  dispose(): void {
    this.stopped = true;
    this.jobs.clear();
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.memory.clear();
    this.memoryBytes = 0;
    this.indices.clear();
    for (const key of [...this.cacheWaiters.keys()]) this.notifyCacheWaiters(key);
    this.reserved.clear();
    this.activePerFileRequests.clear();
    this.nextIndex.clear();
    this.cooldown.clear();
    this.adaptive.clear();
    this.storageFailedFiles.clear();
  }
  async clear(): Promise<void> {
    this.dispose();
    // Ensure an in-progress IndexedDB write cannot reappear after deletion.
    await Promise.allSettled([...this.pendingWrites]);
    await deleteRoomCache(this.roomId);
  }
}
