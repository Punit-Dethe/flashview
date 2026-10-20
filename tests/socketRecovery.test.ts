import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomSocket } from '../src/client/socket';

// A suspended phone can retain OPEN/CLOSING indefinitely without a close event.
class SuspendedSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: SuspendedSocket[] = [];
  readyState = 0;
  binaryType = '';
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) { SuspendedSocket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 2; } // No close acknowledgement from the dead network.
  addEventListener() {}
  accept() { this.readyState = 1; this.onopen?.(); }
  message(message: object) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

function setup(t: import('node:test').TestContext, role: 'student' | 'host' = 'student', policy = 'immediate') {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const previous = ['WebSocket', 'window', 'document'].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: SuspendedSocket });
  Object.defineProperty(globalThis, 'window', { configurable: true,
    value: { location: { protocol: 'https:', host: 'flashview.test', search: '?resumePolicy=' + policy } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible' } });
  SuspendedSocket.instances = [];
  const socket = new RoomSocket();
  socket.connect({ role, code: '123456' });
  const first = SuspendedSocket.instances[0];
  first.accept();
  first.message({ type: 'join.accepted', resumeToken: 'preserved-resume-token' });
  t.after(() => {
    socket.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { socket, first };
}

test('file-picker return replaces a half-open socket promptly without waiting for close acknowledgement', t => {
  const { socket, first } = setup(t);
  let rejected = 0;
  socket.requestRange('file123456', 0, 4, () => {}, () => rejected++);
  socket.pauseHeartbeat();
  socket.wake();
  assert.equal(SuspendedSocket.instances.length, 2, 'Reconnect starts in the return handler without a timer');
  // Real browsers can send focus, visibilitychange, change, and pageshow together.
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(500); socket.wake(); }
  t.mock.timers.tick(1000);
  assert.equal(SuspendedSocket.instances.length, 2, 'Trailing return events must reuse the new handshake');
  assert.equal(rejected, 1, 'Old requests must release scheduler slots immediately');
  const replacement = SuspendedSocket.instances[1];
  replacement.accept();
  assert.equal(JSON.parse(replacement.sent[0]).resumeToken, 'preserved-resume-token');
  replacement.message({ type: 'join.resumed' });
  first.onclose?.();
  first.message({ type: 'join.rejected' });
  assert.equal(socket.connected, true, 'Late callbacks from the replaced socket cannot disconnect its replacement');
});

test('foreground probes preserve healthy sockets and do not postpone a missing pong deadline', t => {
  const { socket, first } = setup(t);
  socket.wake();
  t.mock.timers.tick(500);
  socket.wake();
  first.message({ type: 'heartbeat.pong' });
  t.mock.timers.tick(3500);
  assert.equal(SuspendedSocket.instances.length, 1);
  assert.equal(socket.connected, true);
});

test('temporary room capacity preserves the private identity and retries admission automatically', t => {
  const { socket, first } = setup(t);
  first.message({ type: 'error', code: 'ROOM_ACTIVE_LIMIT', retryable: true,
    message: 'Room temporarily unavailable: all 30 participant places are in use. Retrying…' });
  first.onclose?.();
  t.mock.timers.tick(1500);
  assert.equal(SuspendedSocket.instances.length, 2);
  const replacement = SuspendedSocket.instances[1];
  replacement.accept();
  assert.equal(JSON.parse(replacement.sent[0]).resumeToken, 'preserved-resume-token');
  replacement.message({ type: 'join.resumed' });
  assert.equal(socket.connected, true);
});

test('new-join throttling honors the server deadline despite foreground events and preserves selected identity', t => {
  const { socket } = setup(t);
  socket.restartStalledTransfer();
  const limited = SuspendedSocket.instances[1]; limited.accept();
  limited.message({ type: 'error', code: 'JOIN_RATE_LIMIT', retryable: true, retryAfterMs: 30000 });
  limited.onclose?.();
  for (let i = 0; i < 20; i++) { socket.pauseHeartbeat(); socket.wake('online'); socket.restartStalledTransfer(); }
  t.mock.timers.tick(29999); assert.equal(SuspendedSocket.instances.length, 2);
  t.mock.timers.tick(1); assert.equal(SuspendedSocket.instances.length, 3);
  const admitted = SuspendedSocket.instances[2]; admitted.accept();
  assert.equal(JSON.parse(admitted.sent[0]).resumeToken, 'preserved-resume-token');
  admitted.message({ type: 'join.resumed' });
  socket.pauseHeartbeat(); socket.wake();
  assert.equal(SuspendedSocket.instances.length, 4, 'Successful authentication restores immediate foreground recovery');
});

test('stalled room authentication retires its socket even when close never completes', t => {
  const { socket } = setup(t);
  socket.restartStalledTransfer();
  SuspendedSocket.instances[1].accept();
  t.mock.timers.tick(10_000);
  t.mock.timers.tick(1_500);
  assert.equal(SuspendedSocket.instances.length, 3, 'A handshake timeout must schedule a new connection');
});

test('file selection during an unfinished join bounds the resumed handshake wait', t => {
  const { socket } = setup(t);
  socket.restartStalledTransfer();
  socket.pauseHeartbeat();
  socket.wake();
  assert.equal(SuspendedSocket.instances.length, 3, 'A picker-suspended handshake is replaced immediately');
  t.mock.timers.tick(1000);
  socket.wake();
  t.mock.timers.tick(1100);
  assert.equal(SuspendedSocket.instances.length, 3, 'A picker-suspended handshake must retry within 2.1 seconds');
});

test('receiver tab focus preserves a healthy transfer; a real freeze replaces its socket immediately', t => {
  const { socket, first } = setup(t, 'host');
  socket.pauseHeartbeat();
  socket.wake();
  first.message({ type: 'heartbeat.pong' });
  assert.equal(SuspendedSocket.instances.length, 1);
  socket.pauseHeartbeat(true);
  socket.wake();
  assert.equal(SuspendedSocket.instances.length, 2);
});

test('network restoration bypasses backoff once and coalesces trailing foreground signals', t => {
  const { socket } = setup(t);
  socket.wake('online');
  socket.wake('online');
  socket.wake();
  t.mock.timers.tick(3000);
  assert.equal(SuspendedSocket.instances.length, 2, 'Do not abort a fresh foreground handshake at the probe deadline');
});

test('return after a fully closed socket bypasses its scheduled backoff immediately', t => {
  const { socket, first } = setup(t);
  first.readyState = 3;
  first.onclose?.();
  socket.wake();
  assert.equal(SuspendedSocket.instances.length, 2);
});

test('the initial hello already carries a private high-entropy resume capability', t => {
  const { socket, first } = setup(t);
  const initial = JSON.parse(first.sent[0]).resumeToken;
  assert.match(initial, /^[a-f0-9]{64}$/);
  socket.connect({ role: 'student', code: '654321' });
  const next = SuspendedSocket.instances.at(-1)!;
  next.accept();
  assert.notEqual(JSON.parse(next.sent[0]).resumeToken, initial, 'A deliberately new join gets a new identity');
});

test('old async range success and failure cannot use the replacement connection', async t => {
  const { socket } = setup(t);
  const obsolete = socket.rangeResponse('same-request', 'same-file', 0);
  socket.pauseHeartbeat(); socket.wake();
  const replacement = SuspendedSocket.instances.at(-1)!;
  replacement.accept(); replacement.message({ type: 'join.resumed' });
  const sent = replacement.sent.length;
  obsolete.fail('Old file read failed');
  assert.equal(await obsolete.send(new ArrayBuffer(4)), false);
  assert.equal(replacement.sent.length, sent, 'Neither stale bytes nor errors reach the replacement');
  const replay = socket.rangeResponse('same-request', 'same-file', 0);
  assert.equal(await replay.send(new ArrayBuffer(4)), true, 'The replay can still send its own bytes');
});

test('the comparison policy preserves the old probe behavior on the same deployment', t => {
  const { socket, first } = setup(t, 'student', 'probe');
  socket.pauseHeartbeat();
  socket.wake();
  assert.equal(SuspendedSocket.instances.length, 1);
  first.message({ type: 'heartbeat.pong' });
  t.mock.timers.tick(2500);
  assert.equal(SuspendedSocket.instances.length, 1);
});

test('stale or foreign terminal metadata cannot disable an active private reconnect', t => {
  const { socket, first } = setup(t);
  first.message({ type: 'join.accepted', roomGeneration: 'generation-a', roomRevision: 5 });
  first.message({ type: 'file.state', roomGeneration: 'generation-a', roomRevision: 9 });
  first.message({ type: 'room.closed', roomGeneration: 'generation-b', roomRevision: 100 });
  first.message({ type: 'join.rejected', roomGeneration: 'generation-a', roomRevision: 8 });
  socket.pauseHeartbeat(); socket.wake();
  assert.equal(SuspendedSocket.instances.length, 2);
  const next = SuspendedSocket.instances[1]; next.accept();
  next.message({ type: 'join.resumed', roomGeneration: 'generation-a', roomRevision: 10 });
  assert.equal(socket.connected, true);
});
