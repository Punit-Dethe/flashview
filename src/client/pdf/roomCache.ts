import { MAX_RANGE_BYTES, ROOM_TTL_MS, type PdfManifest } from '../../shared/protocol';
import type { RoomSocket } from '../socket';

export const CHUNK_BYTES = 65_536;
const DB_NAME = 'flashview-room-cache';
const DB_VERSION = 1;
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
    const tx = db.transaction(['chunks', 'rooms'], 'readwrite');
    const index = tx.objectStore('chunks').index('room');
    const request = index.openKeyCursor(IDBKeyRange.only(room));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      tx.objectStore('chunks').delete(cursor.primaryKey);
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
  private memory = new Map<string, Uint8Array>();
  private memoryBytes = 0;
  private indices = new Map<string, Promise<Set<number>>>();
  private jobs = new Map<string, PdfManifest>();
  private working = false;
  private foreground = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
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
  async progress(file: PdfManifest): Promise<CacheProgress> {
    const indices = await this.indexSet(file.fileId);
    return completion(file, indices);
  }
  private async chunk(file: PdfManifest, index: number): Promise<Uint8Array> {
    if (this.stopped) throw Error('Classroom cache closed');
    const key = this.key(file.fileId, index);
    const cached = this.memory.get(key);
    if (cached) return cached;
    try {
      const stored = await readChunk(key);
      if (stored) {
        const bytes = new Uint8Array(stored);
        this.putMemory(key, bytes);
        return bytes;
      }
    } catch { this.warning(); }
    const running = this.inFlight.get(key);
    if (running) return running;
    const begin = index * CHUNK_BYTES;
    const end = Math.min(file.size, begin + CHUNK_BYTES);
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      if (!this.socket.connected) return reject(Error('The sender is offline. Cached pages remain available.'));
      this.socket.requestRange(file.fileId, begin, end,
        (start: number, data: Uint8Array) => {
          if (start !== begin || data.byteLength !== end - begin) {
            reject(Error('Incomplete PDF byte range')); return;
          }
          resolve(data);
        }, (reason: string) => reject(Error(reason)));
    }).then(async data => {
      if (this.stopped) throw Error('Classroom cache closed');
      this.putMemory(key, data);
      try {
        await saveChunk({
          key, room: this.roomId, document: this.roomId + '/' + file.fileId,
          index, data: data.slice().buffer,
        });
        const set = await this.indexSet(file.fileId);
        set.add(index);
        this.onProgress(completion(file, set));
      } catch { this.warning(); }
      return data;
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }
  async range(file: PdfManifest, begin: number, end: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) ||
      begin < 0 || end <= begin || end > file.size || end - begin > MAX_RANGE_BYTES) {
      throw Error('Invalid PDF byte request');
    }
    this.foreground++;
    try {
      const first = Math.floor(begin / CHUNK_BYTES);
      const last = Math.floor((end - 1) / CHUNK_BYTES);
      const pieces: Uint8Array[] = [];
      for (let i = first; i <= last; i++) pieces.push(await this.chunk(file, i));
      const combined = new Uint8Array(end - begin);
      let position = begin;
      for (let i = first; i <= last; i++) {
        const chunkStart = i * CHUNK_BYTES;
        const takeStart = Math.max(position, chunkStart);
        const takeEnd = Math.min(end, chunkStart + pieces[i-first].length);
        combined.set(pieces[i-first].subarray(takeStart - chunkStart, takeEnd - chunkStart), takeStart - begin);
        position = takeEnd;
      }
      return combined;
    } finally {
      this.foreground--;
    }
  }
  /** Called after the first page renders: fetch every remaining chunk once. */
  prefetch(file: PdfManifest): void {
    if (this.stopped || this.jobs.has(file.fileId)) return;
    this.jobs.set(file.fileId, file);
    void this.work();
  }
  /** Resume stopped background jobs when a student rejoins. */
  resume(): void { if (!this.stopped) void this.work(); }
  private async work(): Promise<void> {
    if (this.working || this.stopped || this.jobs.size === 0) return;
    this.working = true;
    try {
      for (const [fileId, file] of this.jobs) {
        const total = Math.ceil(file.size / CHUNK_BYTES);
        let finished = true;
        // Three chunks per round trip window keeps transfer moving under latency
        // without flooding a mobile sender or delaying interactive page requests.
        const parallel = 3;
        for (let i = 0; i < total; i += parallel) {
          if (this.stopped) return;
          while (this.foreground > 0 && !this.stopped) {
            await new Promise(resolve => setTimeout(resolve, 80));
          }
          if (!this.socket.connected) { finished = false; break; }
          try {
            await Promise.all(Array.from({ length: Math.min(parallel, total - i) },
              (_, offset) => this.chunk(file, i + offset)));
          } catch { finished = false; break; }
        }
        if (finished) this.jobs.delete(fileId);
        else break;
      }
    } finally {
      this.working = false;
      if (!this.stopped && this.jobs.size) {
        if (this.retryTimer !== null) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.work();
        }, 4500);
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
  }
  async clear(): Promise<void> {
    this.dispose();
    await deleteRoomCache(this.roomId);
  }
}
