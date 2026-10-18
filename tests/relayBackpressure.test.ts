import test from 'node:test';
import assert from 'node:assert/strict';
import { canForwardToHost, RELAY_HOST_MAX_BUFFERED_BYTES } from '../src/shared/relayBackpressure';

test('receiver buffer budget includes new network packet, not only queued bytes', () => {
  assert.equal(canForwardToHost(0, 256 * 1024), true);
  assert.equal(canForwardToHost(RELAY_HOST_MAX_BUFFERED_BYTES - 256 * 1024, 256 * 1024), true);
  assert.equal(canForwardToHost(RELAY_HOST_MAX_BUFFERED_BYTES - 256 * 1024 + 1, 256 * 1024), false);
  assert.equal(canForwardToHost(RELAY_HOST_MAX_BUFFERED_BYTES, 1), false);
});
test('bad relay queue measurements never bypass bounded forwarding', () => {
  for (const buffered of [Infinity, NaN, -1]) assert.equal(canForwardToHost(buffered, 1024), false);
  for (const packet of [0, -1, 3.5, Infinity]) assert.equal(canForwardToHost(0, packet), false);
});
