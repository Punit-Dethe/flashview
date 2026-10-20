import type { FileManifest } from '../../shared/protocol';
import { digestBytes, hashBlob, validSha256 } from './integrity';
import { withStorageDeadline } from '../pdf/storageWatchdog';
import { validRoomGeneration } from '../../shared/roomControl';
import { perf } from '../perf';

// This database is separate so a new cache never blocks a legacy room's DB upgrade.
const DATABASE = 'warpview-originals-v1';
const ROOT = 'warpview-originals-v1';
export const CACHE_BLOCK_BYTES = 65_536;
const MAX_BATCH_BYTES = 1024 * 1024;
type Block = { key: string; document: string; index: number; length: number; hash: string };
type Original = { key: string; room: string; fileId: string; size: number; sha256: string; sealed: boolean };
type SyncHandle = { write(bytes: Uint8Array, options: { at: number }): number;
  read(bytes: Uint8Array, options: { at: number }): number; flush(): void; close(): void; getSize(): number; truncate(size: number): void };
type SyncFile = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> };
type Pending = { index: number; bytes: Uint8Array; signal?: AbortSignal; resolve: () => void; reject: (e: unknown) => void };
const batches = new Map<string, { room: string; fileId: string; bytes: number; pending: Pending[]; timer: ReturnType<typeof setTimeout> }>();

export const isOpfsRoom = (room: string): boolean => room.startsWith('opfs:') && validRoomGeneration(room.slice(5));
const documentKey = (room: string, fileId: string) => room + '/' + fileId;
const roomLock = (room: string) => 'warpview-cache:' + room;
/** Probe the worker-only API before allocating a new relay room. */
export async function probeOpfs(): Promise<void> {
  if (!navigator.storage?.getDirectory || !navigator.locks) throw Error('Private browser file storage is unavailable');
  const probe = async () => {
    const root = await navigator.storage.getDirectory(), name = 'warpview-probe-' + crypto.randomUUID();
    try { const file = await root.getFileHandle(name, { create: true }) as SyncFile; (await openSync(file)).close(); }
    finally { await root.removeEntry(name).catch(() => {}); }
  };
  await withStorageDeadline(probe(), 'Check private browser storage', 8000);
}
let opening: Promise<IDBDatabase> | undefined;
async function database(): Promise<IDBDatabase> {
  if (!opening) {
    let expired = false;
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('rooms', { keyPath: 'key' });
        const files = db.createObjectStore('files', { keyPath: 'key' });
        files.createIndex('room', 'room');
        const blocks = db.createObjectStore('blocks', { keyPath: 'key' });
        blocks.createIndex('document', 'document');
      };
      request.onsuccess = () => {
        if (expired) { request.result.close(); return; }
        request.result.onversionchange = () => { request.result.close(); opening = undefined; }; resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });
    opening = withStorageDeadline(pending, 'Open original metadata', 8000, () => { expired = true; })
      .catch(error => { opening = undefined; throw error; });
  }
  return opening;
}
async function get<T>(store: string, key: string): Promise<T | undefined> {
  const db = await database();
  const tx = db.transaction(store, 'readonly');
  const pending = new Promise<T | undefined>((resolve, reject) => {
    const request = tx.objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error);
  });
  return withStorageDeadline(pending, 'Read original metadata', 8000, () => { try { tx.abort(); } catch {} });
}
async function transaction(stores: string[], mutate: (tx: IDBTransaction) => void): Promise<void> {
  const db = await database(), tx = db.transaction(stores, 'readwrite');
  const pending = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? Error('Metadata write aborted'));
    try { mutate(tx); } catch (error) { tx.abort(); reject(error); }
  });
  await withStorageDeadline(pending, 'Commit original metadata', 8000, () => { try { tx.abort(); } catch {} });
}
async function blocksFor(key: string): Promise<Block[]> {
  const db = await database(), tx = db.transaction('blocks', 'readonly');
  const pending = new Promise<Block[]>((resolve, reject) => {
    const request = tx.objectStore('blocks').index('document').getAll(key);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error);
  });
  return withStorageDeadline(pending, 'Read original checkpoints', 8000, () => { try { tx.abort(); } catch {} });
}
async function withRoom<T>(room: string, exclusive: boolean, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!isOpfsRoom(room) || !navigator.storage?.getDirectory || !navigator.locks)
    throw Error('Private file storage is unavailable in this browser');
  const controller = new AbortController();
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, 12_000);
  try {
    return await navigator.locks.request(roomLock(room), { mode: exclusive ? 'exclusive' : 'shared', signal: controller.signal }, async () => {
      clearTimeout(timeout);
      if (signal?.aborted) throw Error('Original operation cancelled');
      return action();
    });
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}
async function withFile<T>(key: string, action: () => Promise<T>, shared = false): Promise<T> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12_000);
  try {
    return await navigator.locks.request('warpview-original:' + key,
      { mode: shared ? 'shared' : 'exclusive', signal: controller.signal }, async () => {
        clearTimeout(timer); return action();
      });
  } finally { clearTimeout(timer); }
}
async function ensureOpen(room: string): Promise<void> {
  if ((await get<{ closed: boolean }>('rooms', room))?.closed) throw Error('Room cache is closed');
}
async function directory(room: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  const operation = async () => {
    const root = await navigator.storage.getDirectory();
    const store = await root.getDirectoryHandle(ROOT, { create });
    return store.getDirectoryHandle(room.slice(5), { create });
  };
  return withStorageDeadline(operation(), 'Open private cache directory', 8000);
}
async function fileHandle(room: string, fileId: string, create: boolean): Promise<SyncFile> {
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(fileId)) throw Error('Invalid cached original identity');
  return withStorageDeadline((await directory(room, create)).getFileHandle(fileId + '.bin', { create }),
    'Open private original', 8000) as Promise<SyncFile>;
}
async function openSync(file: SyncFile): Promise<SyncHandle> {
  let expired = false;
  const pending = file.createSyncAccessHandle().then(handle => {
    if (expired) { handle.close(); throw Error('Obsolete private file writer'); }
    return handle;
  });
  return withStorageDeadline(pending, 'Open private file writer', 8000, () => { expired = true; });
}
function snapshot(file: FileSystemFileHandle): Promise<File> {
  return withStorageDeadline(file.getFile(), 'Read private original', 8000);
}
function fullRead(handle: SyncHandle, length: number, at: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let read = 0;
  while (read < length) {
    const count = handle.read(bytes.subarray(read), { at: at + read });
    if (!Number.isInteger(count) || count <= 0 || count > length - read) throw Error('Truncated original');
    read += count;
  }
  return bytes;
}
/** One immutable file identity per room generation. Never rewrite a sealed original. */
export async function prepareOriginal(room: string, file: FileManifest): Promise<void> {
  if (!validSha256(file.sha256)) throw Error('Original verification metadata is missing');
  const key = documentKey(room, file.fileId);
  await withRoom(room, false, () => withFile(key, async () => {
    await ensureOpen(room);
    const previous = await get<Original>('files', key);
    if (previous) {
      if (previous.size !== file.size || previous.sha256 !== file.sha256) throw Error('Original identity changed');
      return;
    }
    await transaction(['files'], tx => tx.objectStore('files').put({
      key, room, fileId: file.fileId, size: file.size, sha256: file.sha256!, sealed: false,
    } satisfies Original));
  }));
}
/** Coalesce cache blocks; flush bytes, close the writer, THEN commit checkpoints. */
export function saveOriginalBlock(room: string, fileId: string, index: number, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
  const key = documentKey(room, fileId);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Error('File transfer cancelled')); return; }
    let batch = batches.get(key);
    if (!batch) {
      batch = { room, fileId, bytes: 0, pending: [], timer: setTimeout(() => void flushBatch(key), 16) };
      batches.set(key, batch);
    }
    batch.pending.push({ index, bytes, signal, resolve, reject }); batch.bytes += bytes.byteLength;
    if (batch.bytes >= MAX_BATCH_BYTES) { clearTimeout(batch.timer); void flushBatch(key); }
  });
}
async function flushBatch(key: string): Promise<void> {
  const batch = batches.get(key); if (!batch) return;
  batches.delete(key); clearTimeout(batch.timer);
  const started = performance.now();
  try {
    await withRoom(batch.room, false, () => withFile(key, async () => {
      await ensureOpen(batch.room);
      const original = await get<Original>('files', key);
      if (!original || original.sealed) throw Error('Original is unavailable for writing');
      const handle = await openSync(await fileHandle(batch.room, batch.fileId, true));
      const records: Block[] = [];
      try {
        for (const pending of batch.pending) {
          if (pending.signal?.aborted) continue;
          const { index, bytes } = pending, at = index * CACHE_BLOCK_BYTES;
          if (!Number.isSafeInteger(index) || index < 0 || bytes.byteLength !== Math.min(CACHE_BLOCK_BYTES, original.size - at))
            throw Error('Invalid original block');
          let written = 0;
          while (written < bytes.byteLength) {
            const count = handle.write(bytes.subarray(written), { at: at + written });
            if (!Number.isInteger(count) || count <= 0 || count > bytes.byteLength - written) throw Error('Short original write');
            written += count;
          }
          records.push({ key: key + '/' + index, document: key, index, length: bytes.byteLength, hash: await digestBytes(bytes) });
        }
        handle.flush();
      } finally { handle.close(); }
      await transaction(['blocks'], tx => {
        for (const record of records) {
          const pending = batch.pending.find(item => item.index === record.index);
          if (!pending?.signal?.aborted) tx.objectStore('blocks').put(record);
        }
      });
    }));
    for (const pending of batch.pending) pending.signal?.aborted ? pending.reject(Error('File transfer cancelled')) : pending.resolve();
  } catch (error) { for (const pending of batch.pending) pending.reject(error); }
  finally { if (perf.enabled) perf.record('opfs_checkpoint_ms', performance.now() - started, { bytes: batch.bytes }); }
}
export async function readOriginalBlock(room: string, fileId: string, index: number): Promise<ArrayBuffer | null> {
  const key = documentKey(room, fileId);
  return withRoom(room, false, () => withFile(key, async () => {
    await ensureOpen(room);
    const block = await get<Block>('blocks', key + '/' + index);
    if (!block) return null;
    let bytes: Uint8Array;
    try {
      const data = await snapshot(await fileHandle(room, fileId, false));
      bytes = new Uint8Array(await withStorageDeadline(data.slice(index * CACHE_BLOCK_BYTES,
        index * CACHE_BLOCK_BYTES + block.length).arrayBuffer(), 'Read private block', 8000));
    }
    catch (error) { if ((error as DOMException).name === 'NotFoundError') return null; throw error; }
    return bytes.byteLength === block.length && await digestBytes(bytes) === block.hash ? bytes.buffer as ArrayBuffer : null;
  }, true));
}
/** Restore only checksummed committed blocks; sparse/uncommitted bytes never count. */
export async function originalIndices(room: string, fileId: string): Promise<Set<number>> {
  const key = documentKey(room, fileId);
  const started = performance.now();
  return withRoom(room, false, () => withFile(key, async () => {
    await ensureOpen(room);
    const original = await get<Original>('files', key), blocks = await blocksFor(key);
    const valid = new Set<number>(), invalid: Block[] = [];
    if (!original) return valid;
    let handle: SyncHandle | undefined;
    try {
      handle = await openSync(await fileHandle(room, fileId, false));
      if (handle.getSize() > original.size) { handle.truncate(original.size); handle.flush(); }
      for (const block of blocks) {
        const expected = Math.min(CACHE_BLOCK_BYTES, original.size - block.index * CACHE_BLOCK_BYTES);
        try {
          if (!Number.isSafeInteger(block.index) || block.index < 0 || expected <= 0 || block.length !== expected ||
              block.key !== key + '/' + block.index || block.document !== key || !validSha256(block.hash) ||
              await digestBytes(fullRead(handle, expected, block.index * CACHE_BLOCK_BYTES)) !== block.hash) invalid.push(block);
          else valid.add(block.index);
        } catch { invalid.push(block); }
        if (valid.size % 64 === 63) await new Promise(resolve => setTimeout(resolve, 0));
      }
    } catch (error) {
      if ((error as DOMException).name !== 'NotFoundError') throw error;
      invalid.push(...blocks);
    } finally { handle?.close(); }
    if (invalid.length) await transaction(['blocks', 'files'], tx => {
      for (const block of invalid) tx.objectStore('blocks').delete(block.key);
      tx.objectStore('files').put({ ...original, sealed: false });
    });
    return valid;
  })).finally(() => { if (perf.enabled) perf.record('opfs_scan_ms', performance.now() - started); });
}
export async function sealOriginal(room: string, file: FileManifest, available: () => boolean): Promise<boolean> {
  const key = documentKey(room, file.fileId);
  const started = performance.now();
  return withRoom(room, false, () => withFile(key, async () => {
    await ensureOpen(room);
    const original = await get<Original>('files', key);
    if (!original || original.sha256 !== file.sha256 || original.size !== file.size) throw Error('Original identity changed');
    const data = await snapshot(await fileHandle(room, file.fileId, false));
    if (!available()) throw Error('Original verification cancelled');
    // originalIndices has checked every committed block immediately before
    // this call. A prior seal plus unchanged checksummed blocks is still valid.
    if (original.sealed && data.size === file.size) return true;
    if (data.size !== file.size || await hashBlob(data, available) !== file.sha256) {
      // Drop only this file's checkpoints. A retry cannot trust corrupt bytes.
      const blocks = await blocksFor(key);
      await transaction(['blocks', 'files'], tx => {
        for (const block of blocks) tx.objectStore('blocks').delete(block.key);
        tx.objectStore('files').put({ ...original, sealed: false });
      });
      return false;
    }
    if (!available()) throw Error('Original verification cancelled');
    await transaction(['files'], tx => tx.objectStore('files').put({ ...original, sealed: true }));
    return true;
  })).finally(() => { if (perf.enabled) perf.record('opfs_seal_ms', performance.now() - started); });
}
/** Readers hold a shared lease; deletion waits, and partial files cannot be acquired. */
export class CompletedFileStore {
  async acquire(room: string, file: FileManifest): Promise<{ file: File; release: () => void } | null> {
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let acquired!: (value: { file: File; release: () => void } | null) => void, failed!: (error: unknown) => void;
    const ready = new Promise<{ file: File; release: () => void } | null>((resolve, reject) => { acquired = resolve; failed = reject; });
    void withRoom(room, false, () => withFile(documentKey(room, file.fileId), async () => {
      await ensureOpen(room);
      const original = await get<Original>('files', documentKey(room, file.fileId));
      if (!original?.sealed || original.size !== file.size || original.sha256 !== file.sha256) { acquired(null); return; }
      const data = await snapshot(await fileHandle(room, file.fileId, false));
      if (data.size !== file.size) { acquired(null); return; }
      if (await hashBlob(data) !== original.sha256) { acquired(null); return; }
      acquired({ file: data, release }); await released;
    }, true)).catch(failed);
    return ready;
  }
  async snapshot(room: string, file: FileManifest): Promise<Blob | null> {
    const lease = await this.acquire(room, file); if (!lease) return null;
    try { return await withStorageDeadline(new Response(lease.file.stream()).blob(), 'Prepare completed local file', 45_000); }
    finally { lease.release(); }
  }
}
export async function deleteOriginalRoom(room: string): Promise<void> {
  await withRoom(room, true, async () => {
    // Keep a tombstone: an obsolete writer cannot recreate a cleared room.
    await transaction(['rooms'], tx => tx.objectStore('rooms').put({ key: room, closed: true }));
    const db = await database();
    const tx = db.transaction('files');
    const listing = new Promise<Original[]>((resolve, reject) => {
      const request = tx.objectStore('files').index('room').getAll(room);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      tx.onabort = () => reject(tx.error);
    });
    const files = await withStorageDeadline(listing, 'List originals for cleanup', 8000, () => { try { tx.abort(); } catch {} });
    for (const file of files) {
      const blocks = await blocksFor(file.key);
      await transaction(['blocks', 'files'], tx => {
        for (const block of blocks) tx.objectStore('blocks').delete(block.key);
        tx.objectStore('files').delete(file.key);
      });
    }
    const remove = async () => { await (await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT)).removeEntry(room.slice(5), { recursive: true }); };
    try { await withStorageDeadline(remove(), 'Clear private room files', 45_000); }
    catch (error) { if ((error as DOMException).name !== 'NotFoundError') throw error; }
  });
}
