import test from 'node:test';
import assert from 'node:assert/strict';
import { admitFile, admitSender, MAX_ROOM_FILES, MAX_ROOM_BYTES, MAX_ROOM_SESSIONS, MAX_ACTIVE_SENDERS } from '../src/shared/roomAdmission';
import { MAX_FILE_BYTES, type FileManifest } from '../src/shared/protocol';
const owner = { id: 'owner-a', name: 'Alice', approved: true };
const offer = { fileId: 'original-file', name: 'original.bin', size: 4 };

test('room byte admission counts stopped/completed/offline originals, but replay never consumes capacity', () => {
  const files = new Map<string, FileManifest>();
  let total = 0;
  for (let i = 0; total < MAX_ROOM_BYTES; i++) {
    const size = Math.min(MAX_FILE_BYTES, MAX_ROOM_BYTES - total);
    const result = admitFile(files, { ...owner, id: 'owner-' + Math.floor(i / 10) },
      { ...offer, fileId: 'file-' + String(i).padStart(3, '0'), size });
    assert.equal(result.kind, 'created');
    result.file.status = 'offline'; result.file.revoked = true; result.file.cachedBytes = size;
    total += size;
  }
  const snapshot = structuredClone([...files]);
  assert.equal(admitFile(files, owner, { ...offer, size: 1 }).kind, 'rejected');
  assert.deepEqual([...files], snapshot);
  const first = files.get('file-000')!;
  const replay = admitFile(files, { ...owner, id: first.ownerId }, first);
  assert.equal(replay.kind, 'replayed');
  assert.equal(first.revoked, true); assert.equal(first.status, 'offline');
});

test('room manifest and sender limits include historical files; exact retries work at both limits', () => {
  const files = new Map<string, FileManifest>();
  for (let i = 0; i < MAX_ROOM_FILES; i++) {
    assert.equal(admitFile(files, { ...owner, id: 'owner-' + Math.floor(i / 10) },
      { ...offer, fileId: 'file-' + String(i).padStart(3, '0'), size: 1 }).kind, 'created');
  }
  const over = admitFile(files, owner, offer);
  assert.equal(over.kind, 'rejected');
  if (over.kind === 'rejected') assert.equal(over.code, 'ROOM_FILE_LIMIT');
  const first = files.get('file-000')!;
  assert.equal(admitFile(files, { ...owner, id: first.ownerId }, first).kind, 'replayed');
  const sender = admitFile(files, { ...owner, id: first.ownerId }, offer);
  if (sender.kind === 'rejected') assert.equal(sender.code, 'SENDER_FILE_LIMIT');
  else assert.fail('Sender capacity must remain bounded');
});

test('conflicting/unauthorized offers cannot approve, replace or reveal another owner manifest', () => {
  const file: FileManifest = { ...offer, ownerId: owner.id, ownerName: owner.name, status: 'pending' };
  const files = new Map([[file.fileId, file]]);
  for (const [sender, metadata] of [
    [{ ...owner, id: 'intruder' }, offer],
    [owner, { ...offer, size: 5 }],
    [owner, { ...offer, name: 'different.bin' }],
    [{ ...owner, approved: false }, offer],
  ] as const) {
    const result = admitFile(files, sender, metadata);
    assert.equal(result.kind, 'rejected');
    assert.equal('file' in result, false);
    assert.equal(file.status, 'pending'); assert.equal(file.size, 4); assert.equal(files.size, 1);
  }
  assert.equal(admitFile(files, owner, offer).kind, 'updated');
  assert.equal(file.status, 'approved');
  assert.equal(admitFile(files, owner, offer).kind, 'replayed');
});

test('invalid sizes/IDs and names do not reserve room budget', () => {
  const files = new Map<string, FileManifest>();
  for (const invalid of [
    { ...offer, size: 0 }, { ...offer, size: MAX_FILE_BYTES + 1 }, { ...offer, size: '4' },
    { ...offer, size: 3.5 }, { ...offer, fileId: '../bad' }, { ...offer, name: '\u0000 .. ' },
  ]) assert.equal(admitFile(files, owner, invalid).kind, 'rejected');
  assert.equal(files.size, 0);
  const sanitized = admitFile(files, owner, { ...offer, name: '\u0000 original.bin\n' });
  assert.equal(sanitized.kind, 'created');
  assert.equal(sanitized.file.name, 'original.bin');
});

test('full rooms preserve private resume sessions and distinguish retryable reconnects from new admissions', () => {
  assert.equal(admitSender(0, MAX_ROOM_SESSIONS - 1, false, false).kind, 'accepted');
  const historyFull = admitSender(0, MAX_ROOM_SESSIONS, false, false);
  assert.equal(historyFull.kind, 'rejected');
  assert.equal(admitSender(0, MAX_ROOM_SESSIONS + 10, true, false).kind, 'accepted', 'Never evict grandfathered sessions');
  const busy = admitSender(MAX_ACTIVE_SENDERS, MAX_ROOM_SESSIONS, true, false);
  assert.equal(busy.kind, 'rejected');
  if (busy.kind === 'rejected') assert.equal(busy.retryable, true);
  assert.equal(admitSender(MAX_ACTIVE_SENDERS, MAX_ROOM_SESSIONS, true, true).kind, 'accepted', 'A replacement uses its existing place');
  const fresh = admitSender(MAX_ACTIVE_SENDERS, 0, false, true);
  assert.equal(fresh.kind, 'rejected');
  if (fresh.kind === 'rejected') assert.equal(fresh.retryable, false);
});
