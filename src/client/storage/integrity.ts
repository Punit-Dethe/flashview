import { createSHA256, sha256 } from 'hash-wasm';
import { withStorageDeadline } from '../pdf/storageWatchdog';

export const HASH_READ_BYTES = 1024 * 1024;
export const validSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function digestBytes(bytes: Uint8Array): Promise<string> {
  return sha256(bytes);
}
/** Bounded source/readback hashing. Never allocate a whole-file JS buffer. */
export async function hashBlob(blob: Blob, available: () => boolean = () => true): Promise<string> {
  const hash = await createSHA256();
  for (let offset = 0; offset < blob.size; offset += HASH_READ_BYTES) {
    if (!available()) throw Error('File verification cancelled');
    const bytes = await withStorageDeadline(blob.slice(offset, offset + HASH_READ_BYTES).arrayBuffer(),
      'Read original for verification', 15_000);
    if (!available()) throw Error('File verification cancelled');
    hash.update(new Uint8Array(bytes));
    if ((offset / HASH_READ_BYTES) % 4 === 3) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return hash.digest('hex');
}
