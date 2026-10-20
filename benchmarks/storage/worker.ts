// Benchmark-only reference drivers. Never imported into the application bundle.
import { createSHA256 } from 'hash-wasm';
import { hashBlob, digestBytes } from '../../src/client/storage/integrity';
import { prepareOriginal, saveOriginalBlock, originalIndices, sealOriginal,
  CompletedFileStore, deleteOriginalRoom } from '../../src/client/storage/opfsStore';
import type { FileManifest } from '../../src/shared/protocol';

type Mode = 'idb-current' | 'idb-batched' | 'opfs';
type Block = { index: number; data: ArrayBuffer; hash: string };
const BLOCK = 65536, WINDOW = 1024 * 1024;
const ensure = (condition: unknown, message: string): void => { if (!condition) throw Error(message); };
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? Error('Transaction failed')); });
}
function requested<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
/** Same integrity checks, bounded reads, and 64 KiB data model as the OPFS driver.
 * Current-style writes use one default-durability transaction per block;
 * the alternative uses one strict-durability transaction per <=1 MiB batch.
 * This is a comparison driver, not a production fallback implementation. */
class ReferenceIdb {
  private constructor(private db: IDBDatabase, private name: string, private batched: boolean) {}
  static async open(batched: boolean): Promise<ReferenceIdb> {
    const name = 'warpview-storage-comparison-' + crypto.randomUUID(), request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('blocks', { keyPath: 'index' }); };
    return new ReferenceIdb(await requested(request), name, batched);
  }
  async write(parts: Uint8Array[], first: number): Promise<void> {
    const records = await Promise.all(parts.map(async (part, offset): Promise<Block> => ({ index: first + offset,
      data: part.slice().buffer as ArrayBuffer, hash: await digestBytes(part) })));
    if (this.batched) {
      const tx = this.db.transaction('blocks', 'readwrite', { durability: 'strict' }), completed = done(tx);
      for (const record of records) tx.objectStore('blocks').put(record);
      await completed;
    } else await Promise.all(records.map(async record => {
      const tx = this.db.transaction('blocks', 'readwrite'), completed = done(tx);
      tx.objectStore('blocks').put(record); await completed;
    }));
  }
  async read(first: number, count: number): Promise<Block[]> {
    const tx = this.db.transaction('blocks'), completed = done(tx);
    const records = await Promise.all(Array.from({ length: count }, (_, offset) => requested<Block>(tx.objectStore('blocks').get(first + offset))));
    await completed; return records;
  }
  async scan(size: number): Promise<number> {
    const count = Math.ceil(size / BLOCK); let found = 0;
    for (let first = 0; first < count; first += WINDOW / BLOCK) {
      for (const block of await this.read(first, Math.min(WINDOW / BLOCK, count - first))) {
        ensure(block && block.data.byteLength === Math.min(BLOCK, size - block.index * BLOCK), 'Missing/truncated IDB block');
        ensure(await digestBytes(new Uint8Array(block.data)) === block.hash, 'Changed IDB block'); found++;
      }
    }
    return found;
  }
  async snapshot(size: number): Promise<Blob> {
    const parts: Blob[] = [], count = Math.ceil(size / BLOCK);
    for (let first = 0; first < count; first += WINDOW / BLOCK)
      for (const block of await this.read(first, Math.min(WINDOW / BLOCK, count - first))) parts.push(new Blob([block.data]));
    return new Blob(parts);
  }
  async remove(): Promise<void> { this.db.close(); await requested(indexedDB.deleteDatabase(this.name)); }
}
export async function runStorageCase(input: { source: File; mode: Mode; expected: string; nativeTrace?: boolean }) {
  const { source, mode, expected } = input, started = performance.now();
  const native: Record<string, { count: number; totalMs: number; maxMs: number }> = {};
  if (input.nativeTrace && mode === 'opfs') {
    const prototype = FileSystemFileHandle.prototype as any, open = prototype.createSyncAccessHandle;
    const record = (name: string, start: number) => {
      const ms = performance.now() - start, sample = native[name] ??= { count: 0, totalMs: 0, maxMs: 0 };
      sample.count++; sample.totalMs += ms; sample.maxMs = Math.max(sample.maxMs, ms);
    };
    prototype.createSyncAccessHandle = async function(...args: unknown[]) {
      const start = performance.now(), handle = await open.apply(this, args); record('open', start);
      return new Proxy(handle, { get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => { const start = performance.now(); try { return value.apply(target, args); } finally { record(String(key), start); } };
      } });
    };
  }
  // Both use precisely the same source/range/persisted-content checks.
  const root = await hashBlob(source); ensure(root === expected, 'Source mismatch');
  const sourceHashMs = performance.now() - started;
  const room = 'opfs:' + crypto.randomUUID();
  const file: FileManifest = { fileId: 'comparison-original', name: source.name, ownerId: 'synthetic', ownerName: 'Synthetic',
    size: source.size, status: 'approved', sha256: root };
  let idb: ReferenceIdb | undefined, cleaned = false;
  try {
    const receiving = performance.now();
    if (mode === 'opfs') await prepareOriginal(room, file); else idb = await ReferenceIdb.open(mode === 'idb-batched');
    for (let offset = 0; offset < source.size; offset += WINDOW) {
      const bytes = new Uint8Array(await source.slice(offset, offset + WINDOW).arrayBuffer());
      // Sender and receiver checksum the same <=256 KiB wire intervals.
      for (let at = 0; at < bytes.length; at += 262144) {
        const packet = bytes.subarray(at, at + 262144), sent = await digestBytes(packet);
        ensure(sent === await digestBytes(packet), 'Range mismatch');
      }
      const parts = Array.from({ length: Math.ceil(bytes.length / BLOCK) }, (_, i) => bytes.slice(i * BLOCK, (i + 1) * BLOCK));
      if (idb) await idb.write(parts, offset / BLOCK);
      else await Promise.all(parts.map((part, index) => saveOriginalBlock(room, file.fileId, offset / BLOCK + index, part)));
    }
    const persistedMs = performance.now() - receiving, verifying = performance.now();
    if (idb) {
      ensure(await idb.scan(source.size) === Math.ceil(source.size / BLOCK), 'Incomplete IDB journal');
      ensure(await hashBlob(await idb.snapshot(source.size)) === root, 'Persisted IDB root mismatch');
    } else {
      ensure((await originalIndices(room, file.fileId)).size === Math.ceil(source.size / BLOCK), 'Incomplete OPFS journal');
      ensure(await sealOriginal(room, file, () => true), 'Persisted OPFS root mismatch');
    }
    const verifyMs = performance.now() - verifying, resuming = performance.now();
    const restored = idb ? await idb.scan(source.size) : (await originalIndices(room, file.fileId)).size;
    ensure(restored === Math.ceil(source.size / BLOCK), 'Restore mismatch');
    const resumeMs = performance.now() - resuming, reading = performance.now();
    const completed = idb ? await idb.snapshot(source.size) : await new CompletedFileStore().snapshot(room, file);
    ensure(completed?.size === source.size, 'Completed file unavailable');
    // IDB has not verified its snapshot yet; OPFS acquisition already has.
    if (idb) ensure(await hashBlob(completed!) === root, 'Completed IDB root mismatch');
    const completedReadMs = performance.now() - reading;
    // Independent final streaming digest, outside all measured stages.
    const independent = await createSHA256(), reader = completed!.stream().getReader();
    for (;;) { const part = await reader.read(); if (part.done) break; independent.update(part.value); }
    ensure(independent.digest('hex') === expected, 'Independent final original mismatch');
    const cleanup = performance.now(); if (idb) await idb.remove(); else await deleteOriginalRoom(room);
    idb = undefined; cleaned = true;
    return { mode, bytes: source.size, sourceHashMs, persistedMs, verifyMs, readyMs: persistedMs + verifyMs,
      resumeMs, completedReadMs, cleanupMs: performance.now() - cleanup, exact: true, ...(input.nativeTrace ? { native } : {}) };
  } finally { if (!cleaned) { if (idb) await idb.remove(); else if (mode === 'opfs') await deleteOriginalRoom(room); } }
}
