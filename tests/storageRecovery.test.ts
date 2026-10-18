import test from 'node:test';
import assert from 'node:assert/strict';
import { storageRetryDelay } from '../src/client/pdf/storageRecovery';

test('storage recovery retries briefly then backs off instead of hot-looping quota', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 99].map(storageRetryDelay),
    [3_500, 12_000, 30_000, 120_000, 300_000, 300_000, 300_000]);
  assert.equal(storageRetryDelay(-10), 3_500);
  assert.equal(storageRetryDelay(Number.NaN), 300_000);
});
