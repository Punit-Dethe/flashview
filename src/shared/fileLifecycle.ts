import type { FileManifest } from './protocol';

/** Disconnection is recoverable; an explicit owner stop is terminal for this ID. */
export function resumeDisconnectedFile(file: FileManifest, approved: boolean): boolean {
  if (file.status !== 'offline' || file.revoked === true) return false;
  file.status = approved ? 'approved' : 'pending';
  return true;
}

export function revokeFile(file: FileManifest): void {
  // Preserve the existing offline status for older clients while distinguishing
  // an explicit stop from a temporary loss of the sender's connection.
  file.status = 'offline';
  file.revoked = true;
}
