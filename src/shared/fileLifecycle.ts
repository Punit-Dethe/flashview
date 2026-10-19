import type { FileManifest } from './protocol';

/** Presence can recover; an explicit owner stop is terminal for this file ID. */
export function resumeDisconnectedFile(file: FileManifest, approved: boolean): boolean {
  if (file.status !== 'offline' || file.revoked === true) return false;
  file.status = approved ? 'approved' : 'pending';
  return true;
}

export function revokeFile(file: FileManifest): void {
  // Retain the v1 offline presentation/status contract for old clients while
  // persisting a distinct terminal marker that reconnection cannot undo.
  file.status = 'offline';
  file.revoked = true;
}
