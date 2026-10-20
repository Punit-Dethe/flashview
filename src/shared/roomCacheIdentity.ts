import { validRoomGeneration } from './roomControl';

/** Version is pinned at creation. Adopting lease credentials must not move legacy bytes. */
export type CacheRoom = { code: string; roomGeneration?: string; cacheVersion?: 2 | 3 };

export function roomCacheIdentity(room: CacheRoom): string {
  if (room.cacheVersion === 2 || room.cacheVersion === 3) {
    if (!validRoomGeneration(room.roomGeneration)) throw Error('Room cache generation is missing');
    return (room.cacheVersion === 3 ? 'opfs:' : 'generation:') + room.roomGeneration;
  }
  // Existing rooms drain using their original namespace. New rooms never search
  // this namespace for missing chunks or previews, even when their code matches.
  return room.code;
}

/** Old servers/saved sessions have no cacheId. Never derive one merely from a lease. */
export function hostCacheIdentity(session: { code: string; cacheId?: string }): string {
  if (session.cacheId === undefined || session.cacheId === session.code) return session.code;
  if (session.cacheId.startsWith('opfs:') && validRoomGeneration(session.cacheId.slice(5))) return session.cacheId;
  if (!session.cacheId.startsWith('generation:') || !validRoomGeneration(session.cacheId.slice(11)))
    throw Error('Invalid room cache identity');
  return session.cacheId;
}
