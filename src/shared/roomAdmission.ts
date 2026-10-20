import { MAX_FILE_BYTES, MAX_STUDENT_FILES, type FileManifest } from './protocol';

/** Admission budgets count retained records/bytes until End room, not just online senders. */
export const MAX_ROOM_FILES = 300;
export const MAX_ROOM_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_ROOM_SESSIONS = 120;
export const MAX_ACTIVE_SENDERS = 30;

type Rejection = { kind: 'rejected'; code: string; message: string };
type Offer = { fileId?: unknown; name?: unknown; size?: unknown };
type Owner = { id: string; name: string; approved: boolean };
export type FileAdmission = Rejection | { kind: 'created' | 'updated' | 'replayed'; file: FileManifest };
const reject = (code: string, message: string): Rejection => ({ kind: 'rejected', code, message });

/** One synchronous transition. Rejections cannot mutate another owner's manifest. */
export function admitFile(files: Map<string, FileManifest>, owner: Owner, offer: Offer): FileAdmission {
  if (!owner.approved) return reject('APPROVAL_REQUIRED', 'Waiting for teacher approval.');
  const { fileId, size } = offer;
  if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{6,80}$/.test(fileId) ||
      !Number.isSafeInteger(size) || Number(size) < 1 || Number(size) > MAX_FILE_BYTES)
    return reject('INVALID_FILE', 'Files must be between 1 byte and 200 MiB.');
  const name = typeof offer.name === 'string'
    ? offer.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 130) : '';
  if (!name || name === '.' || name === '..') return reject('INVALID_NAME', 'File name required.');
  const existing = files.get(fileId);
  if (existing) {
    // Check immutable metadata and ownership BEFORE any pending -> approved change.
    if (existing.ownerId !== owner.id || existing.size !== size || existing.name !== name)
      return reject('FILE_CONFLICT', 'Conflicting document ID.');
    if (existing.status === 'pending' && existing.revoked !== true) {
      existing.status = 'approved';
      return { kind: 'updated', file: existing };
    }
    return { kind: 'replayed', file: existing };
  }
  let ownerFiles = 0, bytes = 0;
  for (const file of files.values()) {
    if (file.ownerId === owner.id) ownerFiles++;
    bytes += file.size;
  }
  if (ownerFiles >= MAX_STUDENT_FILES)
    return reject('SENDER_FILE_LIMIT', 'This room allows up to 10 files per person. Start a new room to share more.');
  if (files.size >= MAX_ROOM_FILES)
    return reject('ROOM_FILE_LIMIT', 'This room has reached its 300-file limit. Start a new room to share more.');
  if (Number(size) > MAX_ROOM_BYTES - bytes)
    return reject('ROOM_BYTE_LIMIT', 'This room has reached its 4 GiB file budget. Start a new room to share more.');
  const file: FileManifest = {
    fileId, name, size: Number(size), ownerId: owner.id, ownerName: owner.name, status: 'approved',
  };
  files.set(fileId, file);
  return { kind: 'created', file };
}

/** Existing capability holders are never evicted to make room for new joins. */
export function admitSender(active: number, sessions: number, resuming: boolean, replacing: boolean):
  { kind: 'accepted' } | (Rejection & { retryable: boolean }) {
  if (!(resuming && replacing) && active >= MAX_ACTIVE_SENDERS) return {
    ...reject('ROOM_ACTIVE_LIMIT', resuming
      ? 'Room temporarily unavailable: all 30 participant places are in use. Retrying…'
      : 'Room is full. Up to 30 people can connect at once.'), retryable: resuming,
  };
  if (!resuming && sessions >= MAX_ROOM_SESSIONS) return {
    ...reject('ROOM_SESSION_LIMIT', 'This room has reached its join limit. Ask the host to start a new room.'), retryable: false,
  };
  return { kind: 'accepted' };
}
