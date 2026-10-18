/** A slow receiver must never accumulate an unbounded relay send queue.
 * Rejected packets are explicitly retried by the existing 4.5s sender/file
 * backoff instead of silently disappearing or crashing the Durable Object.
 */
export const RELAY_HOST_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export function canForwardToHost(bufferedAmount: number | undefined, packetBytes: number): boolean {
  if (!Number.isSafeInteger(packetBytes) || packetBytes <= 0 ||
      packetBytes > RELAY_HOST_MAX_BUFFERED_BYTES) return false;
  // Cloudflare's hibernatable Durable Object server-side WebSockets may omit
  // bufferedAmount. Do not reject EVERY file byte in that environment.
  // The protocol already caps each range at 256 KiB and outstanding ranges
  // at 48. We can only enforce the stronger 4 MiB queue limit where the
  // runtime actually exposes a numeric bufferedAmount.
  if (bufferedAmount === undefined) return true;
  return Number.isFinite(bufferedAmount) && bufferedAmount >= 0 &&
    bufferedAmount + packetBytes <= RELAY_HOST_MAX_BUFFERED_BYTES;
}
