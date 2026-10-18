/** A slow receiver must never accumulate an unbounded relay send queue.
 * Rejected packets are explicitly retried by the existing 4.5s sender/file
 * backoff instead of silently disappearing or crashing the Durable Object.
 */
export const RELAY_HOST_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export function canForwardToHost(bufferedAmount: number, packetBytes: number): boolean {
  return Number.isFinite(bufferedAmount) && bufferedAmount >= 0 &&
    Number.isSafeInteger(packetBytes) && packetBytes > 0 &&
    bufferedAmount + packetBytes <= RELAY_HOST_MAX_BUFFERED_BYTES;
}
