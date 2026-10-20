import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomRevisionTracker } from '../src/client/roomRevision';
const event = (type: string, roomRevision: number, roomGeneration = 'room-generation-a') => ({ type, roomRevision, roomGeneration });
test('room revision rejects stale snapshots and coalesces recovery without dropping equal-version effects', () => {
  const tracker = new RoomRevisionTracker('room-generation-a');
  assert.equal(tracker.observe(event('file.updated', 7)).accept, true);
  assert.equal(tracker.observe(event('student.updated', 7)).accept, true);
  assert.deepEqual(tracker.observe(event('room.state', 6)), { accept: false, scopeMatches: true, resync: true });
  assert.equal(tracker.observe(event('file.updated', 5)).resync, false);
  assert.equal(tracker.observe(event('room.state', 8)).accept, true);
  assert.equal(tracker.observe(event('file.updated', 7)).resync, true);
});
test('a stale resync reply permits a fresh request and cannot leave recovery latched forever', () => {
  const tracker = new RoomRevisionTracker(); tracker.observe(event('file.state', 10));
  assert.equal(tracker.observe(event('cache.progress', 9)).resync, true);
  assert.equal(tracker.observe(event('file.manifest', 9)).resync, true);
  assert.equal(tracker.observe(event('file.manifest', 10)).accept, true);
});
test('different room generations cannot replace a bound namespace; deliberate new rooms reset the cursor', () => {
  const tracker = new RoomRevisionTracker('room-generation-a'); tracker.observe(event('room.state', 20));
  assert.deepEqual(tracker.observe(event('room.state', 100, 'room-generation-b')), { accept: false, scopeMatches: false, resync: true });
  assert.equal(tracker.observe(event('room.state', 21)).accept, true);
  tracker.reset('room-generation-b'); assert.equal(tracker.observe(event('room.state', 1, 'room-generation-b')).accept, true);
});
test('legacy unstamped metadata and byte transport keep their existing behavior', () => {
  const tracker = new RoomRevisionTracker(); tracker.observe(event('room.state', 30));
  assert.equal(tracker.observe({ type: 'file.updated', file: {} }).accept, true);
  assert.equal(tracker.observe(event('range.request', 1)).accept, true);
});
