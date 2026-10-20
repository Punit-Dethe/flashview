import test from 'node:test';
import assert from 'node:assert/strict';
import { hostCacheIdentity, roomCacheIdentity } from '../src/shared/roomCacheIdentity';

const generation = '12345678-1234-4234-8234-123456789abc';
test('new cache identities follow immutable generations, never reusable join codes', () => {
  const room = { code: '123456', roomGeneration: generation, cacheVersion: 2 as const };
  assert.equal(roomCacheIdentity(room), 'generation:' + generation);
  assert.equal(roomCacheIdentity({ ...room, code: '654321' }), roomCacheIdentity(room));
  assert.notEqual(roomCacheIdentity({ ...room, roomGeneration: crypto.randomUUID() }), roomCacheIdentity(room));
  assert.throws(() => roomCacheIdentity({ code: room.code, cacheVersion: 2 }));
});

test('existing rooms retain legacy cache keys even after gaining generation-scoped leases', () => {
  assert.equal(roomCacheIdentity({ code: '123456' }), '123456');
  assert.equal(roomCacheIdentity({ code: '123456', roomGeneration: generation }), '123456');
  assert.equal(hostCacheIdentity({ code: '123456' }), '123456');
  assert.equal(hostCacheIdentity({ code: '123456', cacheId: '123456' }), '123456');
  assert.equal(hostCacheIdentity({ code: '123456', cacheId: 'generation:' + generation }), 'generation:' + generation);
  for (const cacheId of ['', 'generation:bad', '654321', 'anything/else'])
    assert.throws(() => hostCacheIdentity({ code: '123456', cacheId }));
});
