import test from 'node:test';
import assert from 'node:assert/strict';
import { ChunkWriteBatcher, writeBatchSizeFromQuery } from '../src/client/pdf/chunkWriteBatcher';

test('batching defaults to one write transaction per chunk', () => {
  assert.equal(writeBatchSizeFromQuery(''), 1);
  assert.equal(writeBatchSizeFromQuery('?batch=1'), 1);
  assert.equal(writeBatchSizeFromQuery('?batch=4'), 4);
  assert.equal(writeBatchSizeFromQuery('?batch=8'), 8);
  assert.equal(writeBatchSizeFromQuery('?batch=16'), 16);
  assert.equal(writeBatchSizeFromQuery('?batch=100'), 1);
  assert.equal(writeBatchSizeFromQuery('?batch=oops'), 1);
});

test('eight consecutive saved blocks use one atomic transaction', async () => {
  const writes: number[][] = [];
  const queue = new ChunkWriteBatcher<number>(8, async items => { writes.push(items); });
  await Promise.all(Array.from({length:8}, (_,i)=>queue.enqueue(i)));
  assert.deepEqual(writes, [[0,1,2,3,4,5,6,7]]);
});

test('partial final batches flush even if no further chunks arrive', async () => {
  const writes: number[][] = [];
  const queue = new ChunkWriteBatcher<number>(16, async items => { writes.push(items); }, 2);
  await Promise.all([queue.enqueue(3),queue.enqueue(4)]);
  assert.deepEqual(writes, [[3,4]]);
});

test('failed batch rejects all members; next batch still completes', async () => {
  const writes: number[][] = [];
  const queue = new ChunkWriteBatcher<number>(4, async items => {
    writes.push(items);
    if (writes.length === 1) throw Error('IndexedDB transaction abort');
  });
  const first = await Promise.allSettled([1,2,3,4].map(i=>queue.enqueue(i)));
  assert.equal(first.filter(x=>x.status==='rejected').length, 4);
  await Promise.all([5,6,7,8].map(i=>queue.enqueue(i)));
  assert.deepEqual(writes, [[1,2,3,4],[5,6,7,8]]);
});

test('small next batch drains when prior batch held the writer', async () => {
  const writes: number[][] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release=resolve; });
  const queue = new ChunkWriteBatcher<number>(4, async items => {
    writes.push(items);
    if (writes.length===1) await barrier;
  },2);
  const first = [1,2,3,4].map(i=>queue.enqueue(i));
  const last = queue.enqueue(5);
  await Promise.resolve();
  release();
  await Promise.all([...first,last]);
  assert.deepEqual(writes, [[1,2,3,4],[5]]);
});
