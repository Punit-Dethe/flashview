import type { Page } from 'playwright';
import { readFile } from 'node:fs/promises';

export type CacheObservation = { fileId: string; completedAtMs: number };

/** Observe real completion events concurrently, before selecting any file. */
export async function observeCacheCompletion(page: Page): Promise<void> {
  // Execute browser source directly: tsx's function-name wrappers must not
  // leak Node-only helpers into serialized Playwright callbacks.
  await page.evaluate(await readFile(new URL('./cache-observer.js', import.meta.url), 'utf8'));
}

export async function waitForAllCached(page: Page, expected: number, timeout: number): Promise<CacheObservation[]> {
  await page.waitForFunction(count => {
    const state = (window as typeof window & {
      __cacheBenchmark?: { completions: Record<string, number> };
    }).__cacheBenchmark;
    return state && Object.keys(state.completions).length === count;
  }, expected, { timeout });
  return page.evaluate(() => Object.entries((window as typeof window & {
    __cacheBenchmark: { completions: Record<string, number> };
  }).__cacheBenchmark.completions).map(([fileId, completedAtMs]) => ({ fileId, completedAtMs })));
}

/** Independent bounded verification of the original private IndexedDB cache.
 * One hash block is live at a time; no browser download or full-file buffer.
 * Hash readback is reported separately from application's completion event.
 */
export async function verifyCachedFile(page: Page, input: {
  room: string; fileId: string; size: number; hashBlockBytes: number; hashes: string[];
}): Promise<number> {
  return page.evaluate(async args => {
    const started = performance.now();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('flashview-room-cache');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      for (let begin = 0, block = 0; begin < args.size; begin += args.hashBlockBytes, block++) {
        const bytes = new Uint8Array(Math.min(args.hashBlockBytes, args.size - begin));
        const tx = db.transaction('chunks', 'readonly');
        const stored = tx.objectStore('chunks');
        const reads: Promise<void>[] = [];
        for (let offset = begin; offset < begin + bytes.length; offset += 65_536) {
          const key = args.room + '/' + args.fileId + '/' + offset / 65_536;
          reads.push(new Promise((resolve, reject) => {
            const request = stored.get(key);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const value = request.result?.data;
              if (!(value instanceof ArrayBuffer) || value.byteLength !== Math.min(65_536, args.size - offset)) {
                reject(Error('Missing or invalid cached bytes')); return;
              }
              bytes.set(new Uint8Array(value), offset - begin);
              resolve();
            };
          }));
        }
        await Promise.all(reads);
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
          byte => byte.toString(16).padStart(2, '0')).join('');
        if (hash !== args.hashes[block]) throw Error('Cached original SHA-256 mismatch');
      }
      return performance.now() - started;
    } finally { db.close(); }
  }, input);
}
