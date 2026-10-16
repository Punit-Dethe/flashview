import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdaptiveTransferWindow, WINDOW_INITIAL, WINDOW_MAX, WINDOW_MIN,
} from '../src/client/pdf/adaptiveWindow';

test('Stage 1 window cautiously increases from six to capped ten on healthy responses', () => {
  const controller = new AdaptiveTransferWindow();
  assert.equal(controller.limit, WINDOW_INITIAL);
  for (let i = 0; i < 12; i++) controller.success(80);
  assert.equal(controller.limit, WINDOW_INITIAL + 1);
  for (let i = 0; i < 100; i++) controller.success(80);
  assert.equal(controller.limit, WINDOW_MAX);
});
test('Stage 1 window backs off on sender timeout and cannot collapse below two', () => {
  const controller = new AdaptiveTransferWindow();
  controller.failure();
  assert.equal(controller.limit, 3);
  controller.failure();
  assert.equal(controller.limit, WINDOW_MIN);
  controller.failure();
  assert.equal(controller.limit, WINDOW_MIN);
  for (let i = 0; i < 30; i++) controller.success(70);
  assert.ok(controller.limit > WINDOW_MIN, 'healthy traffic must recover after backoff');
});
test('Stage 1 window detects persistent queue delay and recovers without sudden oscillations', () => {
  const controller = new AdaptiveTransferWindow();
  for (let i = 0; i < 12; i++) controller.success(50);
  assert.equal(controller.limit, 7);
  for (let i = 0; i < 12; i++) controller.success(400);
  assert.ok(controller.limit < 7, 'elevated round trip time should reduce active requests');
  const afterBackoff = controller.limit;
  for (let i = 0; i < 5; i++) controller.success(50);
  assert.equal(controller.limit, afterBackoff, 'recovery holds off additional requests');
});
test('invalid samples cannot change transfer behavior', () => {
  const controller = new AdaptiveTransferWindow();
  for (const sample of [0, -3, NaN, Infinity]) controller.success(sample);
  assert.equal(controller.limit, WINDOW_INITIAL);
});
