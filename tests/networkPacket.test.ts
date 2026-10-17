import test from 'node:test';
import assert from 'node:assert/strict';
import { packetChunksFromQuery, selectMissingChunkGroup } from '../src/client/pdf/networkPacket';

test('validated network packet default is 256 KiB, with reversible 64/128 KiB fallbacks', () => {
  assert.equal(packetChunksFromQuery(''), 4);
  assert.equal(packetChunksFromQuery('?packet=64'), 1);
  assert.equal(packetChunksFromQuery('?packet=128'), 2);
  assert.equal(packetChunksFromQuery('?packet=256'), 4);
  assert.equal(packetChunksFromQuery('?packet=512'), 4);
  assert.equal(packetChunksFromQuery('?packet=garbage'), 4);
});

test('network packet grouping preserves cache holes and avoids duplicates', () => {
  const empty = new Set<number>();
  assert.deepEqual(selectMissingChunkGroup(10, 0, empty, empty, 4), [0,1,2,3]);
  assert.deepEqual(selectMissingChunkGroup(10, 0, new Set([2]), empty, 4), [0,1]);
  assert.deepEqual(selectMissingChunkGroup(10, 0, new Set([0,2]), empty, 4), [1]);
  assert.deepEqual(selectMissingChunkGroup(10, 0, empty, new Set([1,2]), 4), [0]);
  assert.deepEqual(selectMissingChunkGroup(10, 8, empty, empty, 4), [8,9]);
  assert.deepEqual(selectMissingChunkGroup(10, 10, empty, empty, 2), [0,1]);
  assert.deepEqual(selectMissingChunkGroup(10, 0, new Set([0,1,2,3,4,5,6,7,8,9]), empty, 4), []);
  assert.deepEqual(selectMissingChunkGroup(0, 0, empty, empty, 4), []);
  assert.deepEqual(selectMissingChunkGroup(10, 0, empty, empty, 1), [0]);
});

test('a resumable transfer skips cached runs without re-requesting their bytes', () => {
  const cached = new Set([0,1,2,6,7,8]);
  const reserved = new Set<number>();
  const picked: number[][] = [];
  let cursor = 0;
  while (true) {
    const group = selectMissingChunkGroup(11, cursor, cached, reserved, 4);
    if (!group.length) break;
    group.forEach(i => reserved.add(i));
    picked.push(group);
    cursor = (group.at(-1)! + 1) % 11;
  }
  assert.deepEqual(picked, [[3,4,5],[9,10]]);
});
