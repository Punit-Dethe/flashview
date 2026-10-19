import { ROOM_LEASE_INTERVAL_MS, isRoomLeaseIdentity, type RoomLeaseIdentity } from '../shared/roomControl';

type Fetcher = typeof fetch;
type HostEndSession = { roomId: string; roomGeneration?: string; hostToken: string;
  closeRequested?: boolean; serverClosed?: boolean };
class RoomCommandError extends Error {
  constructor(readonly status: number) { super('Room control failed (' + status + ')'); }
}

async function command(identity: { roomId: string; roomGeneration: string }, token: string,
  action: 'lease' | 'end', signal: AbortSignal, fetcher: Fetcher): Promise<{ state: string; roomGeneration: string }> {
  const response = await fetcher('/api/rooms/' + encodeURIComponent(identity.roomId) + '/' + action, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomGeneration: identity.roomGeneration }), signal, cache: 'no-store',
  });
  if (!response.ok) throw new RoomCommandError(response.status);
  const result = await response.json() as { state: string; roomGeneration: string };
  if (result.roomGeneration !== identity.roomGeneration) throw Error('Room generation changed');
  return result;
}

/** Scoped liveness only. Neither this capability nor this service can request file bytes. */
export class RoomLease {
  private identity: RoomLeaseIdentity | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private revision = 0;
  constructor(private readonly fetcher: Fetcher = fetch,
    private readonly interval = ROOM_LEASE_INTERVAL_MS) {}
  private wake = () => { void this.renew(); };

  start(identity: RoomLeaseIdentity): void {
    if (!isRoomLeaseIdentity(identity)) return;
    if (this.identity?.roomId === identity.roomId && this.identity.roomGeneration === identity.roomGeneration &&
        this.identity.leaseToken === identity.leaseToken) return;
    this.stop();
    this.identity = { ...identity };
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.wake);
      window.addEventListener('pageshow', this.wake);
      window.addEventListener('focus', this.wake);
    }
    void this.renew();
  }

  async renew(): Promise<void> {
    if (!this.identity || this.controller) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const identity = this.identity;
    const revision = this.revision;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 12_000);
    let delay = this.interval;
    try {
      const result = await command(identity, identity.leaseToken, 'lease', controller.signal, this.fetcher);
      if (revision !== this.revision) return;
      if (result.state === 'absent' || result.state === 'closed') { this.stop(); return; }
      if (result.state !== 'active') throw Error('Unexpected lease response');
    } catch (error) {
      if (revision === this.revision && error instanceof RoomCommandError && [401, 403, 404, 410].includes(error.status)) {
        this.stop();
        return;
      }
      // A missed renewal is recoverable; never clear local files or restart transfers.
      delay = Math.min(this.interval, 15_000);
    } finally {
      clearTimeout(timeout);
      if (revision === this.revision) {
        this.controller = null;
        if (this.identity) this.timer = setTimeout(() => { void this.renew(); }, delay);
      }
    }
  }

  stop(): void {
    this.revision++;
    this.identity = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.wake);
      window.removeEventListener('pageshow', this.wake);
      window.removeEventListener('focus', this.wake);
    }
  }
}

/** Persist intent before the request; confirm server closure before deleting local bytes.
 * On any failure the caller retains the session and can retry across refresh.
 */
export async function endRoomAndClear<T extends HostEndSession>(session: T,
  persist: (session: T) => void, clearCache: () => Promise<void>, fetcher: Fetcher = fetch): Promise<void> {
  if (!session.serverClosed && !session.roomGeneration) throw Error('Reconnect to the classroom before ending it.');
  let pending = { ...session, closeRequested: true };
  persist(pending);
  if (!pending.serverClosed) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const result = await command({ roomId: pending.roomId, roomGeneration: pending.roomGeneration! },
        pending.hostToken, 'end', controller.signal, fetcher);
      if (result.state !== 'closed' && result.state !== 'absent') throw Error('Room closure was not confirmed');
    } catch {
      throw Error('Could not confirm classroom closure. Your session and cached files are retained. Retry ending the room.');
    } finally { clearTimeout(timeout); }
    pending = { ...pending, serverClosed: true };
    persist(pending);
  }
  try { await clearCache(); }
  catch { throw Error('The classroom is closed, but this device’s cache could not be cleared. Retry cleanup.'); }
}
