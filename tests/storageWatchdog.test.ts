import test from 'node:test';
import assert from 'node:assert/strict';
import { withStorageDeadline } from '../src/client/pdf/storageWatchdog';

test('IDB deadline releases a promise that never settles and calls abort once', async () => {
  let aborted = 0;
  await assert.rejects(
    withStorageDeadline(new Promise<void>(() => {}), 'Index query', 15, () => { aborted++; }),
    /Index query timed out/,
  );
  assert.equal(aborted, 1);
});
test('IDB deadline preserves successful results and avoids aborting healthy reads', async () => {
  let aborted = 0;
  const result = await withStorageDeadline(Promise.resolve([2, 4]), 'Chunk keys', 50,
    () => { aborted++; });
  assert.deepEqual(result, [2, 4]);
  assert.equal(aborted, 0);
});
test('IDB deadline propagates an ordinary storage error without aborting a settled request', async () => {
  let aborted = 0;
  await assert.rejects(withStorageDeadline(Promise.reject(Error('Quota')), 'Write', 50,
    () => { aborted++; }), /Quota/);
  assert.equal(aborted, 0);
});
