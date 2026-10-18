import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_TTL_MS } from '../src/shared/protocol';
import {
  ROOM_ACTIVITY_WRITE_INTERVAL_MS, roomExpiresAt, shouldPersistRoomActivity,
} from '../src/shared/roomLifetime';

test('rooms expire after two hours of inactivity, including legacy stored rooms', () => {
  const created = 10_000;
  assert.equal(roomExpiresAt(created), created + ROOM_TTL_MS);
  assert.equal(roomExpiresAt(created, created), created + ROOM_TTL_MS);
  assert.equal(roomExpiresAt(created, created - 1000), created + ROOM_TTL_MS);
});

test('activity renews expiration independently of original room creation', () => {
  const created = 10_000;
  const later = created + ROOM_TTL_MS - 20_000;
  assert.equal(roomExpiresAt(created, later), later + ROOM_TTL_MS);
  assert.ok(roomExpiresAt(created, later) > created + ROOM_TTL_MS);
});

test('Cloudflare persists renewal only periodically, not per heartbeat or range', () => {
  const previous = 123_000;
  assert.equal(shouldPersistRoomActivity(previous, previous + 25_000), false);
  assert.equal(shouldPersistRoomActivity(previous, previous + ROOM_ACTIVITY_WRITE_INTERVAL_MS - 1), false);
  assert.equal(shouldPersistRoomActivity(previous, previous + ROOM_ACTIVITY_WRITE_INTERVAL_MS), true);
});
