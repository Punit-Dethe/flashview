import { ROOM_TTL_MS } from './protocol';

/** A classroom expires two hours after its last authenticated host activity. */
export function roomExpiresAt(created: number, lastActivityAt: number = created): number {
  return Math.max(created, lastActivityAt) + ROOM_TTL_MS;
}

/** Avoid a Durable Object storage write and alarm reschedule on every heartbeat. */
export const ROOM_ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000;
export function shouldPersistRoomActivity(previous: number, now: number): boolean {
  return now - previous >= ROOM_ACTIVITY_WRITE_INTERVAL_MS;
}
