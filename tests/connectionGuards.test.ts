import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeWindow, CreationBuckets, CREATION_LIMIT, CREATION_WINDOW_MS, nextRoomAlarm, retryAfterSeconds } from '../src/shared/connectionGuards';

test('quota denial preserves the original reset and does not consume or extend the window', () => {
  const first = consumeWindow(null, 2, 1000, 100);
  const second = consumeWindow(first.window, 2, 1000, 200);
  assert.equal(second.allowed, true);
  const snapshot = structuredClone(second.window);
  const denied = consumeWindow(second.window, 2, 1000, 500);
  assert.equal(denied.allowed, false); assert.equal(denied.retryAfterMs, 600);
  assert.deepEqual(second.window, snapshot);
  assert.equal(consumeWindow(denied.window, 2, 1000, 1099).retryAfterMs, 1);
  const renewed = consumeWindow(JSON.parse(JSON.stringify(denied.window)), 2, 1000, 1100);
  assert.equal(renewed.allowed, true); assert.equal(renewed.window.count, 1); assert.equal(renewed.window.reset, 2100);
});

test('bounded Node source buckets never evict an active quota to admit a new source', () => {
  const buckets = new CreationBuckets(2);
  for (let i = 0; i < CREATION_LIMIT; i++) assert.equal(buckets.take('campus-a', 100).allowed, true);
  assert.equal(buckets.take('campus-a', 200).allowed, false);
  assert.equal(buckets.take('campus-b', 200).allowed, true);
  assert.equal(buckets.take('campus-c', 200).allowed, false);
  assert.equal(buckets.take('campus-a', 300).allowed, false, 'New sources cannot flush an exhausted live bucket');
  assert.equal(buckets.take('campus-c', 200 + CREATION_WINDOW_MS).allowed, true);
});

test('pending authentication wins over renewed room TTL, and completion releases that deadline', () => {
  assert.equal(nextRoomAlarm(10000, [500, 800]), 500);
  assert.equal(nextRoomAlarm(20000, [500, 800]), 500, 'Renewal cannot postpone pending cleanup');
  assert.equal(nextRoomAlarm(20000, [800]), 800);
  assert.equal(nextRoomAlarm(20000, []), 20000);
  assert.equal(nextRoomAlarm(400, [500]), 400, 'Expired rooms are not extended by a pending login');
  assert.equal(retryAfterSeconds(1001), '2'); assert.equal(retryAfterSeconds(0), '1');
});
