import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { digestBytes, hashBlob, HASH_READ_BYTES } from '../src/client/storage/integrity';
import { RoomFileEngine } from '../src/shared/roomFileEngine';
import { roomCacheIdentity, hostCacheIdentity } from '../src/shared/roomCacheIdentity';

test('incremental original hashing is bounded, exact and cancellable', async () => {
  const bytes = Buffer.alloc(5 * HASH_READ_BYTES + 17, 93), blob = new Blob([bytes]);
  let largest = 0;
  const slice = blob.slice.bind(blob);
  blob.slice = (start, end) => { largest = Math.max(largest, Number(end) - Number(start)); return slice(start, end); };
  assert.equal(await hashBlob(blob), createHash('sha256').update(bytes).digest('hex'));
  assert.equal(largest, HASH_READ_BYTES);
  assert.equal(await digestBytes(bytes), await hashBlob(blob));
  await assert.rejects(hashBlob(blob, () => false), /cancelled/);
});

test('OPFS admission pins original SHA-256 without changing legacy offers', () => {
  const engine = new RoomFileEngine(), owner = { id: 'sender', name: 'Student', approved: true };
  const command = { fileId: 'original-1', name: 'a.bin', size: 7 };
  assert.equal(engine.offer(owner, command, true).kind, 'rejected');
  assert.equal(engine.files.size, 0);
  const hash = 'a'.repeat(64);
  const accepted = engine.offer(owner, { ...command, sha256: hash }, true);
  assert.equal(accepted.kind, 'created');
  assert.equal(engine.files.get(command.fileId)?.sha256, hash);
  assert.equal(engine.offer(owner, { ...command, sha256: 'b'.repeat(64) }, true).kind, 'rejected');
  assert.equal(engine.offer(owner, { ...command, sha256: hash }, true).kind, 'replayed');
  assert.equal(engine.offer(owner, { ...command, fileId: 'legacy-file' }).kind, 'created');
});

test('OPFS room namespaces never adopt or erase a legacy cache namespace', () => {
  const generation = '11111111-2222-4333-8444-555555555555';
  assert.equal(roomCacheIdentity({ code: '123456', roomGeneration: generation, cacheVersion: 3 }), 'opfs:' + generation);
  assert.equal(roomCacheIdentity({ code: '123456', roomGeneration: generation, cacheVersion: 2 }), 'generation:' + generation);
  assert.equal(roomCacheIdentity({ code: '123456', roomGeneration: generation }), '123456');
  assert.equal(hostCacheIdentity({ code: '123456', cacheId: 'opfs:' + generation }), 'opfs:' + generation);
  assert.throws(() => hostCacheIdentity({ code: '123456', cacheId: 'opfs:invalid' }));
});
