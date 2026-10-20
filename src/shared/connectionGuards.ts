export const AUTH_TIMEOUT_MS = 10_000;
export const MAX_PENDING_ROOM = 64;
export const MAX_PENDING_NODE = 256;
export const MAX_ROOM_SOCKETS = 128;
export const MAX_NODE_SOCKETS = 4096;
// Many classroom computers can share one campus/NAT address.
export const CREATION_LIMIT = 120;
export const CREATION_WINDOW_MS = 60 * 60 * 1000;
export const JOIN_LIMIT = 120;
export const JOIN_WINDOW_MS = 60_000;
export type RateWindow = { reset: number; count: number };

/** Fixed windows anchored at first use. Rejection never extends the deadline. */
export function consumeWindow(previous: RateWindow | null | undefined, limit: number, period: number, now: number):
  { allowed: boolean; window: RateWindow; retryAfterMs: number } {
  const current = previous && previous.reset > now ? previous : { reset: now + period, count: 0 };
  if (current.count >= limit) return { allowed: false, window: current, retryAfterMs: current.reset - now };
  return { allowed: true, window: { reset: current.reset, count: current.count + 1 }, retryAfterMs: 0 };
}

/** Do not evict a live quota bucket to make room: that would reset its budget. */
export class CreationBuckets {
  private entries = new Map<string, RateWindow>();
  constructor(private readonly capacity = 4096) {}
  prune(now: number): void {
    for (const [key, window] of this.entries) if (window.reset <= now) this.entries.delete(key);
  }
  take(key: string, now: number): { allowed: boolean; retryAfterMs: number } {
    if (!this.entries.has(key) && this.entries.size >= this.capacity) {
      this.prune(now);
      if (this.entries.size >= this.capacity) {
        let next = Infinity;
        for (const window of this.entries.values()) next = Math.min(next, window.reset);
        return { allowed: false, retryAfterMs: next - now };
      }
    }
    const result = consumeWindow(this.entries.get(key), CREATION_LIMIT, CREATION_WINDOW_MS, now);
    if (result.allowed) this.entries.set(key, result.window);
    return result;
  }
}

/** One Durable Object alarm services expiry and pending authentication together. */
export function nextRoomAlarm(expires: number, deadlines: Iterable<number>): number {
  let next = expires;
  for (const deadline of deadlines) next = Math.min(next, deadline);
  return next;
}

export function retryAfterSeconds(ms: number): string { return String(Math.max(1, Math.ceil(ms / 1000))); }
export const JOIN_RATE_MESSAGE = 'This room is temporarily busy accepting new connections. Your files are kept; retrying shortly.';
