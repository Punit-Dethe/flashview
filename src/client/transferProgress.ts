import type { CacheProgress } from './pdf/roomCache';

export type TransferFile = { fileId: string; name: string; size: number; status: string };
export type TransferSummary = {
  count: number; ready: number; bytes: number; size: number; percent: number; complete: boolean;
};

/** Aggregate *classroom-saved* bytes, not attempted WebSocket sends.
 * Weighted by PDF size so a tiny finished PDF cannot mask a large unfinished one.
 * Explicitly stopped/rejected shares are no longer part of the active transfer batch.
 */
export function summarizeTransfers(
  files: readonly TransferFile[], progress: Readonly<Record<string, CacheProgress>>,
): TransferSummary {
  const active = files.filter(f => f.status !== 'offline' && f.status !== 'rejected');
  let bytes = 0, size = 0, ready = 0;
  for (const file of active) {
    if (!Number.isSafeInteger(file.size) || file.size <= 0) continue;
    size += file.size;
    const cached = progress[file.fileId];
    const complete = Boolean(cached?.complete && cached.size === file.size && cached.bytes >= file.size);
    if (complete) ready++;
    bytes += complete ? file.size :
      cached?.size === file.size ? Math.max(0, Math.min(file.size, cached.bytes)) : 0;
  }
  return {
    count: active.length, ready, bytes, size,
    percent: size ? Math.min(100, (bytes / size) * 100) : 0,
    complete: active.length > 0 && ready === active.length,
  };
}
