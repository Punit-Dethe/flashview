import { Reader } from '@zip.js/zip.js';
import { MAX_RANGE_BYTES } from '../../shared/protocol';
import type { PdfManifest } from '../../shared/protocol';
import type { PdfRangeSource } from '../presentation';

/** Read-only ZIP source over the host's BroadcastChannel -> IndexedDB cache.
 * This NEVER opens a WebSocket, requests network priority, or changes scheduling.
 * The room's independent background transfer is the only writer.
 */
export class CachedPptxReader extends Reader<undefined> {
  private closed = false;
  private pending = new Set<() => void>();
  constructor(private readonly file: PdfManifest, private readonly source: PdfRangeSource) {
    super(undefined);
    this.size = file.size;
  }

  async readUint8Array(offset: number, length: number): Promise<Uint8Array> {
    if (this.closed) throw new Error('Presentation closed');
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
        offset < 0 || length < 0 || offset + length > this.file.size) {
      throw new Error('Invalid PowerPoint byte range');
    }
    if (!length) return new Uint8Array();
    const output = new Uint8Array(length);
    for (let position = 0; position < length;) {
      if (this.closed) throw new Error('Presentation closed');
      const end = Math.min(length, position + MAX_RANGE_BYTES);
      const begin = offset + position;
      const bytes = await new Promise<Uint8Array>((resolve, reject) => {
        let finished = false;
        let stop: (() => void) | undefined;
        const settle = (error?: string, result?: Uint8Array) => {
          if (finished) return;
          finished = true;
          clearTimeout(watchdog);
          this.pending.delete(cancel);
          if (error) reject(new Error(error));
          else resolve(result!);
        };
        const cancel = () => {
          stop?.();
          settle('Presentation closed');
        };
        const watchdog = setTimeout(() => {
          stop?.();
          settle('The slide is still waiting for cached data. Retry when more bytes arrive.');
        }, 32_000);
        this.pending.add(cancel);
        stop = this.source.requestRange(this.file.fileId, begin, offset + end,
          (start, result) => {
            if (start !== begin || result.byteLength !== end - position)
              settle('Invalid cached PowerPoint range');
            else settle(undefined, result);
          }, message => settle(message));
        if (this.closed) cancel();
      });
      output.set(bytes, position);
      position = end;
    }
    return output;
  }

  close(): void {
    this.closed = true;
    for (const cancel of [...this.pending]) cancel();
  }
}
