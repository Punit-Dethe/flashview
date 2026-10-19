import { MAX_RANGE_BYTES, ROOM_TTL_MS, type PdfManifest } from '../../shared/protocol';
import type { RoomSocket } from '../socket';
import { perf } from '../perf';
import { AdaptiveTransferWindow, WINDOW_INITIAL } from './adaptiveWindow';
import { packetChunksFromQuery, selectMissingChunkGroup } from './networkPacket';
import { shouldReconnectForRangeFailure } from './transferRecovery';
import { storageRetryDelay } from './storageRecovery';
import { isQuotaError, quotaExhausted } from './quotaRecovery';
import { CachedChunkIndex } from './chunkProgress';
import { withStorageDeadline } from './storageWatchdog';

export const CHUNK_BYTES = 65_536;
// Keep a bounded background pipeline regardless of whether a viewer is open.
// PDF viewing remains passive and does not request network bytes.
const BACKGROUND_WINDOW = WINDOW_INITIAL;
const MAX_BACKGROUND_REQUESTS = 16; // Each slot represents one network request, not one cache block.
const DB_NAME = 'flashview-room-cache';
const DB_VERSION = 2;
const MAX_MEMORY_BYTES = 48 * 1024 * 1024;
const STORAGE_DEADLINE_MS = 8_000;
type ChunkRecord = { key: string; room: string; document: string; index: number; data: ArrayBuffer };
type StorageRecovery = {
  file: PdfManifest; record: ChunkRecord; attempts: number;
  consecutiveQuota: number; blocked: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};
type RoomRecord = { id: string; expires: number };
export type CacheProgress = { fileId: string; bytes: number; size: number; complete: boolean; corrected?: boolean };

let openDatabase: Promise<IDBDatabase> | null = null;
function database(): Promise<IDBDatabase> {
  if (!openDatabase) {
    let timedOut = false;
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
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
      request.onsuccess = () => {
        // An open request cannot be aborted. If it completes after the
        // watchdog rejected it, close that orphaned connection immediately.
        if (timedOut) request.result.close();
        else resolve(request.result);
      };
      request.onerror = () => reject(request.error || new Error('Local document storage unavailable'));
    });
    openDatabase = withStorageDeadline(pending, 'Open browser storage', STORAGE_DEADLINE_MS,
      () => { timedOut = true; }).catch(error => {
      // Do not pin a permanently rejected promise; a later retry may work.
      openDatabase = null;
      throw error;
    });
  }
  return openDatabase;
}

async function readChunk(key: string): Promise<ArrayBuffer | null> {
  const db = await database();
  const tx = db.transaction('chunks', 'readonly');
  const pending = new Promise<ArrayBuffer | null>((resolve, reject) => {
    const request = tx.objectStore('chunks').get(key);
    request.onsuccess = () => resolve((request.result as ChunkRecord | undefined)?.data ?? null);
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error || Error('Browser storage read aborted'));
  });
  return withStorageDeadline(pending, 'Read cached chunk', STORAGE_DEADLINE_MS,
    () => { try { tx.abort(); } catch { /* Already settled. */ } });
}
async function saveChunk(record: ChunkRecord): Promise<void> {
  const db = await database();
  const tx = db.transaction('chunks', 'readwrite');
  const pending = new Promise<void>((resolve, reject) => {
    tx.objectStore('chunks').put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || Error('Browser storage write aborted'));
  });
  await withStorageDeadline(pending, 'Persist cached chunk', STORAGE_DEADLINE_MS,
    () => { try { tx.abort(); } catch { /* Already settled. */ } });
}
async function cachedIndices(room: string, fileId: string): Promise<Set<number>> {
  const db = await database();
  const tx = db.transaction('chunks', 'readonly');
  const pending = new Promise<Set<number>>((resolve, reject) => {
    const request = tx.objectStore('chunks')
      .index('document').getAllKeys(IDBKeyRange.only(room + '/' + fileId));
    request.onsuccess = () => {
      const indices = (request.result as string[])
        .map(k => Number(k.slice(k.lastIndexOf('/') + 1)))
        .filter(Number.isSafeInteger);
      resolve(new Set(indices));
    };
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error || Error('Browser storage index lookup aborted'));
  });
  return withStorageDeadline(pending, 'List cached chunks', STORAGE_DEADLINE_MS,
    () => { try { tx.abort(); } catch { /* Already settled. */ } });
}
/**
 * Read an entire completed PDF from the teacher's local browser.
 * Once complete, PDF.js can consume an ordinary Uint8Array instead of
 * custom range transport (eliminates streamed-page scheduling races).
 */
export async function readCompletedPdf(roomId: string, file: PdfManifest): Promise<Uint8Array | null> {
  // Loading every IndexedDB record with getAll() retains one whole-file-sized
  // collection of ArrayBuffers PLUS the reconstructed file. A cursor keeps
  // just one 64 KiB record live at a time, even for a 200 MiB transfer.
  const db = await database();
  const documentId = roomId + '/' + file.fileId;
  const count = Math.ceil(file.size / CHUNK_BYTES);
  const bytes = new Uint8Array(file.size);
  const seen = new Uint8Array(count);
  let received = 0;
  const tx = db.transaction('chunks', 'readonly');
  const pending = new Promise<boolean>((resolve, reject) => {
    const request = tx.objectStore('chunks').index('document')
      .openCursor(IDBKeyRange.only(documentId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(received === count);
        return;
      }
      const record = cursor.value as ChunkRecord;
      const index = record.index;
      const length = Math.min(CHUNK_BYTES, file.size - index * CHUNK_BYTES);
      // Database keys sort lexicographically (0, 1, 10, 2...), not numerically.
      // Place each verified piece at its own offset, checking for duplicates.
      if (!Number.isSafeInteger(index) || index < 0 || index >= count ||
          seen[index] || record.room !== roomId || record.document !== documentId ||
          record.key !== documentId + '/' + index ||
          !(record.data instanceof ArrayBuffer) || record.data.byteLength !== length) {
        resolve(false);
        return;
      }
      bytes.set(new Uint8Array(record.data), index * CHUNK_BYTES);
      seen[index] = 1;
      received++;
      cursor.continue();
    };
    request.onerror = () => reject(request.error || Error('Cannot read completed file'));
    tx.onabort = () => reject(tx.error || Error('Completed file read aborted'));
  });
  // Cursor scans may legitimately read thousands of small records; allow
  // more time than one chunk operation, but never hang the viewer forever.
  const complete = await withStorageDeadline(pending, 'Read completed file', 45_000,
    () => { try { tx.abort(); } catch { /* Already settled. */ } });
  return complete ? bytes : null;
}

/**
 * Assemble completed downloads as browser-owned Blob parts instead of creating
 * a second contiguous, file-sized JavaScript Uint8Array. The presenter still
 * uses its own complete Uint8Array, as required by the rendering libraries.
 */
export async function readCompletedBlob(roomId: string, file: PdfManifest): Promise<Blob | null> {
  const db = await database();
  const documentId = roomId + '/' + file.fileId;
  const count = Math.ceil(file.size / CHUNK_BYTES);
  const parts: (Blob | undefined)[] = new Array(count);
  let received = 0;
  const tx = db.transaction('chunks', 'readonly');
  const pending = new Promise<boolean>((resolve, reject) => {
    const request = tx.objectStore('chunks').index('document')
      .openCursor(IDBKeyRange.only(documentId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(received === count);
        return;
      }
      const record = cursor.value as ChunkRecord;
      const index = record.index;
      // IndexedDB keys sort alphabetically (0,1,10,2...), not numerically.
      const expected = Number.isSafeInteger(index) && index >= 0 && index < count
        ? Math.min(CHUNK_BYTES, file.size - index * CHUNK_BYTES) : -1;
      if (expected < 0 || parts[index] !== undefined ||
          record.room !== roomId || record.document !== documentId ||
          record.key !== documentId + '/' + index ||
          !(record.data instanceof ArrayBuffer) ||
          record.data.byteLength !== expected) {
        resolve(false);
        return;
      }
      // Turn each 64 KiB IDB record into browser-native data immediately,
      // without holding every JS ArrayBuffer until file assembly.
      parts[index] = new Blob([record.data]);
      received++;
      cursor.continue();
    };
    request.onerror = () => reject(request.error || Error('Cannot read completed download'));
    tx.onabort = () => reject(tx.error || Error('Completed download read aborted'));
  });
  const complete = await withStorageDeadline(pending, 'Read completed download', 45_000,
    () => { try { tx.abort(); } catch { /* Transaction already settled. */ } });
  return complete ? new Blob(parts as Blob[], { type: 'application/octet-stream' }) : null;
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
  private indices = new Map<string, Promise<CachedChunkIndex>>();
  private verifyingCompleted = new Map<string, Promise<CacheProgress>>();
  private jobs = new Map<string, PdfManifest>();
  private working = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private activeBackground = new Set<Promise<void>>();
  // A new file must wake the scheduler even if every existing request is hung.
  // The generation also catches offers arriving while an IndexedDB query awaits.
  private schedulingGeneration = 0;
  private wakeScheduler: (() => void) | null = null;
  // Adaptive limits count outstanding network requests, not individual 64 KiB
  // persistent blocks. The baseline at 64 KiB retains the same request count.
  private activePerFileRequests = new Map<string, number>();
  private reserved = new Map<string, Set<number>>();
  private nextIndex = new Map<string, number>();
  private cooldown = new Map<string, number>();
  private rotation = 0;
  private firstQueuedAt = new Map<string, number>();
  private lastPersistedByteAt = Date.now();
  private lastReconnectAt = 0;
  private stallReported = new Set<string>();
  private readonly adaptive = new Map<string, AdaptiveTransferWindow>();
  // Keep a fixed scheduler available for identical-file A/B tests.
  private readonly fixedTransfer = new URLSearchParams(location.search).get('transfer') === 'fixed';
  private readonly networkChunks = packetChunksFromQuery(location.search);
  private storageFailedFiles = new Set<string>();
  private storageRecovery = new Map<string, StorageRecovery>();
  onProgress: (progress: CacheProgress) => void = () => {};
  onStorageWarning: (text: string) => void = () => {};
  onStorageBlocked: (fileId: string) => void = () => {};
  onStorageRecovered: (fileId: string) => void = () => {};
  onStalled: (fileId: string) => void = () => {};
  private warned = false;

  constructor(readonly roomId: string, private readonly socket: RoomSocket) {
    void writeRoom(roomId).catch(() => this.warning());
  }
  private warning(): void {
    if (this.warned) return;
    this.warned = true;
    this.onStorageWarning('Browser storage is unavailable or full. Cached PDFs may not survive a refresh.');
  }
  /** Pause only the affected file after a failed IndexedDB write, not its peers.
   * Retry the exact original bytes with bounded backoff; never re-request
   * already received network data merely to test whether storage recovered.
   */
  private storageWriteFailed(file: PdfManifest, record: ChunkRecord, error: unknown): void {
    this.warning();
    this.storageFailedFiles.add(file.fileId);
    this.jobs.delete(file.fileId);
    if (this.storageRecovery.has(file.fileId)) return;
    const state: StorageRecovery = {
      file, record, attempts: 0, consecutiveQuota: isQuotaError(error) ? 1 : 0,
      blocked: false, timer: null,
    };
    this.storageRecovery.set(file.fileId, state);
    state.timer = setTimeout(() => void this.retryStorage(file.fileId), storageRetryDelay(0));
  }

  private async retryStorage(fileId: string): Promise<void> {
    const state = this.storageRecovery.get(fileId);
    if (!state || this.stopped || state.blocked) return;
    state.timer = null;
    try {
      const writing = saveChunk(state.record);
      this.pendingWrites.add(writing);
      try { await writing; }
      finally { this.pendingWrites.delete(writing); }
      if (this.stopped || this.storageRecovery.get(fileId) !== state) return;
      const indexed = await this.indexSet(state.file);
      if (this.stopped || this.storageRecovery.get(fileId) !== state) return;
      indexed.add(state.record.index);
      this.notePersistedByte(fileId);
      const progress = indexed.progress(state.file.fileId);
      this.onProgress(progress);
      this.notifyCacheWaiters(state.record.key);
      this.storageRecovery.delete(fileId);
      this.storageFailedFiles.delete(fileId);
      this.onStorageRecovered(fileId);
      // Rejoining the scheduler is safe: it skips all successfully persisted
      // chunks, and never restarts a shared socket or a healthy peer transfer.
      if (state.file.status === 'approved') this.prefetch(state.file);
    } catch (error) {
      if (this.stopped || this.storageRecovery.get(fileId) !== state) return;
      state.consecutiveQuota = isQuotaError(error) ? state.consecutiveQuota + 1 : 0;
      if (quotaExhausted(error, state.consecutiveQuota)) {
        // Don't retry forever against a permanently full origin. Keep one
        // failed chunk's original bytes, never send false completion, and let
        // the host deliberately retry after freeing storage.
        state.blocked = true;
        this.onStorageBlocked(fileId);
        return;
      }
      state.attempts++;
      state.timer = setTimeout(() => void this.retryStorage(fileId),
        storageRetryDelay(state.attempts));
    }
  }

  /** Retry only files explicitly paused after repeated quota failures. */
  retryBlockedStorage(): void {
    if (this.stopped) return;
    for (const [fileId, state] of this.storageRecovery) {
      if (!state.blocked) continue;
      state.blocked = false;
      state.consecutiveQuota = 0;
      state.attempts = 0;
      void this.retryStorage(fileId);
    }
  }

  private cancelStorageRetry(fileId: string): void {
    const state = this.storageRecovery.get(fileId);
    if (state?.timer !== null && state?.timer !== undefined) clearTimeout(state.timer);
    this.storageRecovery.delete(fileId);
    this.storageFailedFiles.delete(fileId);
    if (state?.blocked) this.onStorageRecovered(fileId);
  }
  private key(fileId: string, index: number): string {
    return this.roomId + '/' + fileId + '/' + index;
  }
  private indexSet(file: PdfManifest): Promise<CachedChunkIndex> {
    const fileId = file.fileId;
    let pending = this.indices.get(fileId);
    if (!pending) {
      // Reconstruct persisted bytes once per room cache hydration. Subsequent
      // committed writes update both the index and byte total in constant time.
      pending = cachedIndices(this.roomId, fileId)
        .then(keys => new CachedChunkIndex(file.size, keys))
        .catch(error => {
          this.warning();
          // A failed lookup is not evidence that stored chunks are missing.
          this.indices.delete(fileId);
          throw error;
        });
      this.indices.set(fileId, pending);
    }
    return pending;
  }
  /**
   * The in-memory index is fast, but another tab or browser quota cleanup can
   * remove IndexedDB entries behind it. Before publishing 100% or retiring
   * the file from the transfer queue, independently re-read persisted keys.
   * This happens only at the completion boundary and during low-rate room
   * snapshots, never for each chunk or network range.
   */
  private checkedProgress(file: PdfManifest, indexed: CachedChunkIndex): Promise<CacheProgress> {
    const initial = indexed.progress(file.fileId);
    if (!initial.complete) return Promise.resolve(initial);
    const existing = this.verifyingCompleted.get(file.fileId);
    if (existing) return existing;
    const verification = cachedIndices(this.roomId, file.fileId).then(persisted => {
      if (this.stopped) return { ...initial, complete: false };
      const stale = persisted.size !== indexed.size ||
        [...persisted].some(index => !indexed.has(index));
      if (stale) {
        // A missing IndexedDB key must invalidate the corresponding in-memory
        // copy as well. Otherwise chunk() returns memory immediately, skips
        // saveChunk(), and the scheduler loops forever without repairing disk.
        for (const index of indexed) {
          if (persisted.has(index)) continue;
          const key = this.key(file.fileId, index);
          const cached = this.memory.get(key);
          if (cached) {
            this.memoryBytes -= cached.byteLength;
            this.memory.delete(key);
          }
        }
        indexed.clear();
        for (const index of persisted) indexed.add(index);
      }
      const fresh = indexed.progress(file.fileId);
      if (stale && !fresh.complete) {
        const repaired = { ...fresh, corrected: true };
        // Correction is authoritative. A previously reported 100% can be
        // retracted when the backing bytes have disappeared.
        this.onProgress(repaired);
        return repaired;
      }
      return fresh;
    }).catch(() => {
      // Failed verification is not proof that the bytes remain on disk.
      // Throttle future attempts instead of spinning on a broken IndexedDB.
      this.warning();
      this.cooldown.set(file.fileId, Date.now() + storageRetryDelay(0));
      const uncertain: CacheProgress = {
        fileId: file.fileId, bytes: 0, size: file.size, complete: false, corrected: true,
      };
      this.onProgress(uncertain);
      return uncertain;
    }).finally(() => {
      this.verifyingCompleted.delete(file.fileId);
    });
    this.verifyingCompleted.set(file.fileId, verification);
    return verification;
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
    const indices = await this.indexSet(file);
    const state = await this.checkedProgress(file, indices);
    if (state.corrected && file.status === 'approved' && !this.storageFailedFiles.has(file.fileId))
      this.prefetch(file);
    return state;
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
    const indexed = await this.indexSet(file);
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
      const record: ChunkRecord = {
        key, room: this.roomId, document: this.roomId + '/' + file.fileId,
        index, data: data.slice().buffer,
      };
      const saving = saveChunk(record);
      this.pendingWrites.add(saving);
      try {
        await saving;
        if (perf.enabled) perf.record('cache_write_ms', performance.now() - writingSince, { bytes: data.byteLength });
        if (this.stopped) return data;
        const set = await this.indexSet(file);
        set.add(index);
        this.notePersistedByte(file.fileId);
        const state = await this.checkedProgress(file, set);
        if (state.complete) perf.elapsed('cache_complete_ms', 'cache:' + file.fileId, file.size);
        if (!this.stopped) this.onProgress(state);
        this.notifyCacheWaiters(key);
      } catch (error) {
        this.storageWriteFailed(file, record, error);
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
      const record: ChunkRecord = {
        key, room: this.roomId, document: this.roomId + '/' + file.fileId,
        index, data: piece.slice().buffer,
      };
      const saving = saveChunk(record);
      this.pendingWrites.add(saving);
      try {
        await saving;
        if (perf.enabled) perf.record('cache_write_ms', performance.now() - writingSince, { bytes: piece.byteLength });
        if (this.stopped) return;
        const set = await this.indexSet(file);
        set.add(index);
        this.notePersistedByte(file.fileId);
        const state = await this.checkedProgress(file, set);
        if (state.complete) perf.elapsed('cache_complete_ms', 'cache:' + file.fileId, file.size);
        if (!this.stopped) this.onProgress(state);
        this.notifyCacheWaiters(key);
      } catch (error) {
        this.storageWriteFailed(file, record, error);
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
      const indexed = await this.indexSet(file);
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

  private notePersistedByte(fileId: string): void {
    this.lastPersistedByteAt = Date.now();
    this.stallReported.delete(fileId);
  }

  /** Reconnect only after sustained zero progress and an actual range failure.
   * Do not restart healthy concurrent transfers or create another socket.
   */
  private recoverStalledTransfer(fileId: string, failure: unknown): void {
    // A file-specific rejection (offline sender, backpressure, invalid range,
    // quota failure) is not evidence that the shared host socket is broken.
    if (!shouldReconnectForRangeFailure(failure)) return;
    const queuedAt = this.firstQueuedAt.get(fileId);
    const now = Date.now();
    if (queuedAt === undefined || now - queuedAt < 25_000 ||
        now - this.lastPersistedByteAt < 20_000 ||
        now - this.lastReconnectAt < 45_000 || !this.socket.connected) return;
    this.lastReconnectAt = now;
    if (!this.stallReported.has(fileId)) {
      this.stallReported.add(fileId);
      this.onStalled(fileId);
    }
    this.socket.restartStalledTransfer();
  }

  /** Queue a file as soon as it is offered, not when the viewer opens. */
  prefetch(file: PdfManifest): void {
    if (this.stopped || this.storageFailedFiles.has(file.fileId)) return;
    if (!this.jobs.has(file.fileId)) {
      perf.mark('cache:' + file.fileId);
      this.firstQueuedAt.set(file.fileId, Date.now());
    }
    this.jobs.set(file.fileId, file);
    this.resume();
  }
  /** A disconnected student must not consume the background scheduler. */
  pause(fileId: string): void {
    this.cancelStorageRetry(fileId);
    this.schedulingGeneration++;
    this.wakeScheduler?.();
    this.jobs.delete(fileId);
    this.nextIndex.delete(fileId);
    this.cooldown.delete(fileId);
    this.adaptive.delete(fileId);
    this.firstQueuedAt.delete(fileId);
    this.stallReported.delete(fileId);
  }
  resume(): void {
    if (this.stopped) return;
    this.schedulingGeneration++;
    this.wakeScheduler?.();
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
        const seenGeneration = this.schedulingGeneration;
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
            let cached: CachedChunkIndex;
            try {
              cached = await this.indexSet(file);
            } catch {
              // An IndexedDB lookup timeout is file-local. Other students
              // must continue, and a later query may succeed. Never restart
              // the shared relay socket or assume existing bytes are absent.
              this.cooldown.set(fileId, Date.now() + 4500);
              retryAfter = 4500;
              continue;
            }
            if (this.stopped) return;
            const total = Math.ceil(file.size / CHUNK_BYTES);
            if (cached.size === total) {
              if ((this.reserved.get(fileId)?.size ?? 0) === 0) {
                this.jobs.delete(fileId);
                this.nextIndex.delete(fileId);
                this.cooldown.delete(fileId);
                this.reserved.delete(fileId);
                this.adaptive.delete(fileId);
                this.firstQueuedAt.delete(fileId);
                this.stallReported.delete(fileId);
                const verified = await this.checkedProgress(file, cached);
                if (verified.complete) {
                  this.onProgress(verified);
                  continue;
                }
                // Persisted keys disappeared after the in-memory cache said
                // 100%. Keep this file scheduled and re-fetch missing ranges.
                this.jobs.set(fileId, file);
              } else {
                continue;
              }
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
            }).catch(error => {
              if (this.jobs.has(fileId)) {
                this.cooldown.set(fileId, Date.now() + 4500);
                this.recoverStalledTransfer(fileId, error);
              }
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
          // Do not sleep forever on the last hung range when a new file arrives.
          // The generation guards against an offer during an awaited cache read,
          // before the wake callback has been registered.
          if (seenGeneration !== this.schedulingGeneration) continue;
          let wake!: () => void;
          const signalled = new Promise<void>(resolve => { wake = resolve; });
          this.wakeScheduler = wake;
          try {
            if (seenGeneration === this.schedulingGeneration)
              await Promise.race([...this.activeBackground, signalled]);
          } finally {
            if (this.wakeScheduler === wake) this.wakeScheduler = null;
          }
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
    this.schedulingGeneration++;
    this.wakeScheduler?.();
    this.wakeScheduler = null;
    this.jobs.clear();
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.memory.clear();
    this.memoryBytes = 0;
    this.indices.clear();
    this.verifyingCompleted.clear();
    for (const key of [...this.cacheWaiters.keys()]) this.notifyCacheWaiters(key);
    this.reserved.clear();
    this.activePerFileRequests.clear();
    this.nextIndex.clear();
    this.cooldown.clear();
    this.adaptive.clear();
    for (const recovery of this.storageRecovery.values()) {
      if (recovery.timer !== null) clearTimeout(recovery.timer);
    }
    this.storageRecovery.clear();
    this.storageFailedFiles.clear();
    this.firstQueuedAt.clear();
    this.stallReported.clear();
  }
  async clear(): Promise<void> {
    this.dispose();
    // Ensure an in-progress IndexedDB write cannot reappear after deletion.
    await Promise.allSettled([...this.pendingWrites]);
    await deleteRoomCache(this.roomId);
  }
}
