/** Quota failures must not permanently disable an upload.
 * Retry only the failed 64 KiB browser storage write with bounded backoff;
 * never hot-loop against a full quota or tie this to the network scheduler.
 */
export function storageRetryDelay(failures: number): number {
  const delays = [3_500, 12_000, 30_000, 120_000, 300_000];
  const index = Number.isFinite(failures) ? Math.max(0, Math.floor(failures)) : delays.length - 1;
  return delays[Math.min(index, delays.length - 1)];
}
