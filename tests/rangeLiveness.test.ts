import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneExpiredRanges } from '../src/shared/rangeLiveness';

test('full relay queue purges expired requests before admitting a retry', () => {
  const now = 400_000, timeout = 20_000;
  const pending = new Map<string, { created: number }>();
  for (let i = 0; i < 48; i++) pending.set('old-' + i, { created: now - timeout - 1 });
  assert.equal(pending.size, 48);
  const expired = pruneExpiredRanges(pending, now, timeout);
  assert.equal(expired.length, 48);
  assert.equal(pending.size, 0);
  pending.set('new-attempt', { created: now });
  assert.equal(pruneExpiredRanges(pending, now + 100, timeout).length, 0);
  assert.equal(pending.size, 1);
});

test('pruning preserves current requests in a mixed queue', () => {
  const pending = new Map([
    ['current', { created: 30_000 }],
    ['stale', { created: 1 }],
  ]);
  assert.deepEqual(pruneExpiredRanges(pending, 40_000, 20_000), ['stale']);
  assert.deepEqual([...pending.keys()], ['current']);
});
