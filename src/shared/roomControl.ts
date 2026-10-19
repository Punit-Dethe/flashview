import { roomExpiresAt } from './roomLifetime';

export type RoomLeaseIdentity = { roomId: string; roomGeneration: string; leaseToken: string };
export type RoomControlConfig = {
  roomGeneration: string; leaseToken: string; hostToken: string;
  created: number; lastActivityAt?: number;
};
export const ROOM_LEASE_INTERVAL_MS = 60_000;
export const validRoomGeneration = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const validControlToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);

export function isRoomLeaseIdentity(value: unknown): value is RoomLeaseIdentity {
  if (!value || typeof value !== 'object') return false;
  const item = value as RoomLeaseIdentity;
  return typeof item.roomId === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(item.roomId) &&
    validRoomGeneration(item.roomGeneration) && validControlToken(item.leaseToken);
}

/** Absence is generation-specific: retrying an old close cannot end a reused code. */
export function authorizeRoomControl(config: RoomControlConfig | null, generation: string,
  token: string, action: 'lease' | 'end', now: number): 'absent' | 'denied' | 'expired' | 'allowed' {
  if (!config || config.roomGeneration !== generation) return 'absent';
  if (token !== (action === 'lease' ? config.leaseToken : config.hostToken)) return 'denied';
  return now >= roomExpiresAt(config.created, config.lastActivityAt) ? 'expired' : 'allowed';
}

export class RoomControlInputError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
type ChunkReader = {
  read(): Promise<{ done?: boolean; value?: Uint8Array }>;
  cancel(): Promise<unknown>;
};
/** Control commands carry no files. Bound the actual body, even without Content-Length. */
export async function readRoomControlGeneration(reader: ChunkReader | undefined): Promise<string> {
  if (!reader) throw new RoomControlInputError(400, 'Room generation required');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    length += value.byteLength;
    if (length > 256) {
      await reader.cancel().catch(() => {});
      throw new RoomControlInputError(413, 'Control command too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const input = JSON.parse(new TextDecoder().decode(bytes)) as { roomGeneration?: unknown };
    if (validRoomGeneration(input?.roomGeneration)) return input.roomGeneration;
  } catch { /* Return a bounded, non-sensitive validation error. */ }
  throw new RoomControlInputError(400, 'Invalid room generation');
}
