import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { decodeRangePacket, encodeRangePacket, MAX_FILE_BYTES } from '../src/shared/protocol';
import { MAX_ROOM_BYTES, MAX_ROOM_SESSIONS, MAX_ACTIVE_SENDERS } from '../src/shared/roomAdmission';
import { AUTH_TIMEOUT_MS, MAX_PENDING_NODE, MAX_PENDING_ROOM, CREATION_LIMIT, JOIN_LIMIT } from '../src/shared/connectionGuards';

type Message = { type: string; [key: string]: unknown };
type Event = { binary: false; msg: Message } | { binary: true; data: Buffer };

class TestPeer {
  revisions: number[] = [];
  events: Event[] = [];
  waiters: Array<{ predicate: (event: Event) => boolean; done: (event: Event) => void }> = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (data, binary) => {
      const event: Event = binary
        ? { binary: true, data: Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer) }
        : { binary: false, msg: JSON.parse(data.toString()) as Message };
      if (!event.binary && Number.isSafeInteger(event.msg.roomRevision)) this.revisions.push(Number(event.msg.roomRevision));
      const index = this.waiters.findIndex(waiter => waiter.predicate(event));
      if (index >= 0) this.waiters.splice(index, 1)[0].done(event);
      else this.events.push(event);
    });
  }
  send(msg: Record<string, unknown>): void { this.ws.send(JSON.stringify({ v: 1, ...msg })); }
  async wait(type: string, label = type): Promise<Message> {
    const event = await this.waitFor(e => !e.binary && e.msg.type === type, label);
    assert.equal(event.binary, false);
    return event.msg;
  }
  async waitBinary(): Promise<Buffer> {
    const event = await this.waitFor(e => e.binary, 'binary');
    assert.equal(event.binary, true);
    return event.data;
  }
  waitFor(predicate: (event: Event) => boolean, label = 'event'): Promise<Event> {
    const existing = this.events.findIndex(predicate);
    if (existing !== -1) return Promise.resolve(this.events.splice(existing, 1)[0]);
    return new Promise<Event>((resolve, reject) => {
      const waiter = { predicate, done: (event: Event) => { clearTimeout(timer); resolve(event); } };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(item => item !== waiter);
        reject(new Error('Timeout waiting for server message: ' + label + '; received ' +
          JSON.stringify(this.events.map(event => event.binary ? 'binary' :
            { type: event.msg.type, code: event.msg.code, message: event.msg.message }))));
      }, 5000);
    });
  }
  close(): void { this.ws.close(); }
}

async function connect(port: number, auth: Record<string, unknown>): Promise<TestPeer> {
  const room = String(auth.code ?? auth.joinToken ?? auth.roomId ?? '').split('.')[0];
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?room=' + encodeURIComponent(room), {
    origin: 'http://127.0.0.1:' + port,
  });
  const peer = new TestPeer(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  peer.send({ type: 'hello', ...auth });
  return peer;
}
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function startServer(portHint?: number): Promise<{ port: number; child: ChildProcessWithoutNullStreams }> {
  const port = portHint ?? await unusedPort();
  const child = spawn(process.execPath, process.env.FLASHVIEW_BACKEND === 'cloudflare'
    ? ['node_modules/wrangler/bin/wrangler.js', 'dev', '--name', 'warpview-test-' + port, '--persist-to', '.wrangler/test-state/' + port, '--inspector-port', '0', '--port', String(port), '--ip', '127.0.0.1']
    : ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
  });
  let output = '';
  child.stderr.on('data', data => { output += String(data); });
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error('Server crashed: ' + output);
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/health');
      if (response.ok) return { port, child };
    } catch { /* Server starting. */ }
    await delay(100);
  }
  child.kill();
  throw new Error('Server never started: ' + output);
}

async function rawConnect(port: number, code: string): Promise<TestPeer> {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?room=' + code, { origin: 'http://127.0.0.1:' + port });
  const peer = new TestPeer(ws);
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return peer;
}

test('connection guard bounds idle sockets, expires them, and keeps authenticated file transfer and HTTP lease alive', { timeout: 30000 }, async () => {
  const { port, child } = await startServer();
  const peers: TestPeer[] = [];
  try {
    const origin = 'http://127.0.0.1:' + port;
    const room = await (await fetch(origin + '/api/rooms?autoApprove=1', { method: 'POST' })).json() as {
      code: string; roomId: string; roomGeneration: string; hostToken: string; leaseToken: string;
    };
    const host = await connect(port, { role: 'host', roomId: room.roomId, token: room.hostToken }); peers.push(host); await host.wait('room.state');
    const count = process.env.FLASHVIEW_BACKEND === 'cloudflare' ? MAX_PENDING_ROOM : MAX_PENDING_NODE;
    const idle = await Promise.all(Array.from({ length: count }, () => rawConnect(port, room.code)));
    peers.push(...idle);
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws?room=' + room.code, { origin });
      ws.on('error', () => {});
      ws.once('unexpected-response', (request, response) => {
        response.on('error', () => {}); response.resume();
        const status = response.statusCode!; request.destroy(); resolve(status);
      });
      ws.once('open', () => { ws.terminate(); reject(Error('Idle capacity was exceeded')); });
    });
    assert.equal(status, 503);
    // One admitted hello releases its pending slot immediately, not after 10 s.
    const phone = idle[0]; phone.send({ type: 'hello', role: 'student', code: room.code }); await phone.wait('join.accepted');
    const replacementIdle = await rawConnect(port, room.code); peers.push(replacementIdle);
    const lease = await fetch(origin + '/api/rooms/' + room.roomId + '/lease', { method: 'POST',
      headers: { Authorization: 'Bearer ' + room.leaseToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomGeneration: room.roomGeneration }) });
    assert.equal(lease.status, 200, 'Connection pressure cannot block scoped HTTP control');
    const began = Date.now();
    const pending = [...idle.slice(1), replacementIdle];
    // Cloudflare owns the final TCP close; a received Close frame can leave the
    // native client CLOSING temporarily. It must already be unusable for data,
    // and a fresh authenticated hello must be admitted without that TCP wait.
    while (pending.some(peer => peer.ws.readyState === WebSocket.OPEN) && Date.now() - began < AUTH_TIMEOUT_MS + 5000) await delay(25);
    assert.ok(pending.every(peer => peer.ws.readyState !== WebSocket.OPEN),
      'All idle handshakes expire without more requests: ' + JSON.stringify({
        remaining: pending.filter(p => p.ws.readyState !== WebSocket.CLOSED).length,
        timeoutNotices: pending.filter(p => p.events.some(e => !e.binary && e.msg.message === 'Authentication timed out')).length,
        states: [...new Set(pending.map(p => p.ws.readyState))],
        closeFrames: pending.filter(p => (p.ws as WebSocket & { _closeFrameReceived?: boolean })._closeFrameReceived).length,
      }));
    const fresh = await rawConnect(port, room.code); peers.push(fresh);
    fresh.send({ type: 'hello', role: 'student', code: room.code }); await fresh.wait('join.accepted');
    assert.equal(phone.ws.readyState, WebSocket.OPEN);
    phone.send({ type: 'file.offer', fileId: 'after-idle-expiry', name: 'original.bin', size: 4 }); await phone.wait('file.state');
    host.send({ type: 'range.request', requestId: 'after-idle-range', fileId: 'after-idle-expiry', begin: 0, end: 4 }); await phone.wait('range.request');
    phone.ws.send(encodeRangePacket({ type: 'range.data', requestId: 'after-idle-range', fileId: 'after-idle-expiry', begin: 0 }, Uint8Array.of(3, 1, 4, 1)));
    const packet = await host.waitBinary();
    assert.deepEqual([...decodeRangePacket(packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength) as ArrayBuffer).bytes], [3, 1, 4, 1]);
  } finally { for (const peer of peers) peer.ws.terminate(); child.kill(); }
});

test('new-join rate survives host rejections while private sender and host reconnects bypass it', { timeout: 30000 }, async () => {
  const { port, child } = await startServer();
  const peers: TestPeer[] = [];
  try {
    const room = await (await fetch('http://127.0.0.1:' + port + '/api/rooms?autoApprove=1', { method: 'POST' })).json() as {
      roomId: string; hostToken: string; joinToken: string;
    };
    const auth = { role: 'host', roomId: room.roomId, token: room.hostToken };
    const host = await connect(port, auth); peers.push(host); await host.wait('room.state');
    const original = await connect(port, { role: 'student', joinToken: room.joinToken }); peers.push(original);
    const joined = await original.wait('join.accepted'); await host.wait('student.updated');
    original.send({ type: 'file.offer', fileId: 'rate-retained-file', name: 'original.bin', size: 4 }); await original.wait('file.state');
    original.close(); await host.wait('student.left');
    for (let i = 1; i < JOIN_LIMIT; i++) {
      const p = await connect(port, { role: 'student', joinToken: room.joinToken }); peers.push(p); await p.wait('join.accepted', 'fresh join ' + i);
      const student = (await host.wait('student.updated')).student as { id: string };
      host.send({ type: 'student.reject', studentId: student.id }); await p.wait('join.rejected'); await host.wait('student.left');
    }
    const fresh = await connect(port, { role: 'student', joinToken: room.joinToken }); peers.push(fresh);
    const denied = await fresh.wait('error');
    assert.equal(denied.code, 'JOIN_RATE_LIMIT'); assert.equal(denied.retryable, true);
    assert.ok(Number(denied.retryAfterMs) > 0 && Number(denied.retryAfterMs) <= 60000);
    const resumed = await connect(port, { role: 'student', joinToken: room.joinToken, resumeToken: joined.resumeToken }); peers.push(resumed);
    assert.equal(((await resumed.wait('join.resumed')).files as Array<{ fileId: string }>)[0].fileId, 'rate-retained-file');
    const nextHost = await connect(port, auth); peers.push(nextHost);
    assert.equal(((await nextHost.wait('room.state')).files as unknown[]).length, 1);
  } finally { for (const peer of peers) peer.ws.terminate(); child.kill(); }
});

test('room creation is source-limited with Retry-After and Cloudflare quota survives process restart', { timeout: 45000 }, async () => {
  let { port, child } = await startServer();
  const origin = 'http://127.0.0.1:' + port;
  try {
    assert.equal((await fetch(origin + '/api/rooms', { method: 'POST', headers: { Origin: 'https://unrelated.example' } })).status, 403);
    for (let i = 0; i < CREATION_LIMIT; i++) {
      const created = await fetch(origin + '/api/rooms', { method: 'POST' }); assert.equal(created.status, 201);
      if (process.env.FLASHVIEW_BACKEND === 'cloudflare')
        assert.equal(created.headers.get('X-WarpView-Creation-Guard'), 'enforced');
      const room = await created.json() as { roomId: string; roomGeneration: string; hostToken: string };
      assert.equal((await fetch(origin + '/api/rooms/' + room.roomId + '/end', { method: 'POST',
        headers: { Authorization: 'Bearer ' + room.hostToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomGeneration: room.roomGeneration }) })).status, 200);
    }
    const denied = await fetch(origin + '/api/rooms', { method: 'POST', headers: { 'X-Forwarded-For': '198.51.100.123' } });
    assert.equal(denied.status, 429); assert.ok(Number(denied.headers.get('Retry-After')) > 0);
    if (process.env.FLASHVIEW_BACKEND === 'cloudflare') {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      // This child is the emulator created above; terminate its own subprocesses
      // as well on Windows so a stale workerd cannot keep the selected port.
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill();
      await exited;
      ({ child } = await startServer(port));
      const restored = await fetch(origin + '/api/rooms', { method: 'POST' });
      assert.equal(restored.status, 429, 'A new isolate/process cannot reset the durable source bucket');
    }
  } finally { child.kill(); }
});

test('shared file engine versions completion, reset, Stop and private resume consistently across metadata restoration', { timeout: 35000 }, async () => {
  let { port, child } = await startServer();
  const peers: TestPeer[] = [];
  try {
    const origin = 'http://127.0.0.1:' + port;
    const room = await (await fetch(origin + '/api/rooms?autoApprove=1', { method: 'POST' })).json() as {
      roomId: string; hostToken: string; joinToken: string;
    };
    const hostAuth = { role: 'host', roomId: room.roomId, token: room.hostToken };
    let host = await connect(port, hostAuth); peers.push(host); await host.wait('room.state');
    let phone = await connect(port, { role: 'student', joinToken: room.joinToken }); peers.push(phone);
    const joined = await phone.wait('join.accepted');
    const offer = { type: 'file.offer', fileId: 'engine-original', name: 'original.bin', size: 4 };
    phone.send(offer);
    assert.equal(((await phone.wait('file.state')).file as { revision: number }).revision, 1);
    await host.wait('file.announced');
    host.send({ type: 'cache.progress', fileId: offer.fileId, bytes: 4 });
    assert.equal((await host.wait('cache.progress.receipt')).fileRevision, 2);
    assert.equal((await phone.wait('cache.progress')).fileRevision, 2);
    host.send({ type: 'cache.progress', fileId: offer.fileId, bytes: 4 });
    assert.equal((await host.wait('cache.progress.receipt')).fileRevision, 2, 'Lost receipts retry without a new transition');
    host.send({ type: 'cache.progress', fileId: offer.fileId, bytes: 0, snapshot: true });
    const reset = await phone.wait('cache.progress'); assert.equal(reset.bytes, 0); assert.equal(reset.fileRevision, 3);
    phone.send(offer);
    assert.equal(((await phone.wait('file.state')).file as { revision: number }).revision, 3);
    phone.send({ type: 'file.revoke', fileId: offer.fileId });
    assert.equal(((await host.wait('file.updated')).file as { revision: number }).revision, 4);
    phone.send({ type: 'file.revoke', fileId: offer.fileId });
    assert.equal(((await host.wait('file.updated')).file as { revision: number }).revision, 4, 'Duplicate Stop is idempotent');
    phone.send({ ...offer, fileId: 'engine-live-file' }); await phone.wait('file.state'); await host.wait('file.announced');
    phone.close(); await host.wait('student.left');
    if (process.env.FLASHVIEW_BACKEND === 'cloudflare') {
      const previousRevision = Math.max(...host.revisions);
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill();
      await exited; ({ child } = await startServer(port));
      host = await connect(port, hostAuth); peers.push(host);
      assert.ok(Number((await host.wait('room.state')).roomRevision) > previousRevision,
        'Room revision must survive restart and advance for the new host');
    }
    phone = await connect(port, { role: 'student', joinToken: room.joinToken, resumeToken: joined.resumeToken }); peers.push(phone);
    const restored = (await phone.wait('join.resumed')).files as Array<{ fileId: string; revision: number; status: string; revoked?: boolean; cachedBytes?: number }>;
    const stopped = restored.find(file => file.fileId === offer.fileId)!;
    assert.equal(stopped.revision, 4); assert.equal(stopped.revoked, true); assert.equal(stopped.cachedBytes, 0);
    const live = restored.find(file => file.fileId === 'engine-live-file')!;
    assert.equal(live.revision, 3); assert.equal(live.status, 'approved');
    host.send({ type: 'range.request', requestId: 'engine-readback', fileId: live.fileId, begin: 0, end: 4 });
    await phone.wait('range.request');
    phone.ws.send(encodeRangePacket({ type: 'range.data', requestId: 'engine-readback', fileId: live.fileId, begin: 0 }, Uint8Array.of(2, 7, 1, 8)));
    const binary = await host.waitBinary();
    assert.deepEqual([...decodeRangePacket(binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength) as ArrayBuffer).bytes], [2, 7, 1, 8]);
  } finally { for (const peer of peers) peer.ws.terminate(); child.kill(); }
});

test('shared room engine keeps pending snapshots private and retires offline capabilities with ordered metadata', { timeout: 25000 }, async () => {
  const { port, child } = await startServer(); const peers: TestPeer[] = [];
  try {
    const room = await (await fetch('http://127.0.0.1:' + port + '/api/rooms', { method: 'POST' })).json() as {
      roomId: string; hostToken: string; joinToken: string; roomGeneration: string;
    };
    const host = await connect(port, { role: 'host', roomId: room.roomId, token: room.hostToken }); peers.push(host);
    const initial = await host.wait('room.state'); assert.equal(initial.roomGeneration, room.roomGeneration);
    const first = await connect(port, { role: 'student', joinToken: room.joinToken }); peers.push(first);
    const capability = (await first.wait('join.pending')).resumeToken;
    const ownerId = ((await host.wait('student.pending')).student as { id: string }).id;
    host.send({ type: 'student.accept', studentId: ownerId }); await first.wait('join.accepted');
    const offer = { type: 'file.offer', fileId: 'private-original', name: 'private.bin', size: 4 };
    first.send(offer); await first.wait('file.state'); await host.wait('file.announced');
    const pending = await connect(port, { role: 'student', joinToken: room.joinToken }); peers.push(pending); await pending.wait('join.pending');
    await host.wait('student.pending');
    pending.send({ type: 'file.sync' }); const snapshot = await pending.wait('file.manifest');
    assert.equal(snapshot.approved, false); assert.deepEqual(snapshot.files, []);
    assert.equal(snapshot.roomGeneration, room.roomGeneration); assert.equal(snapshot.hostOnline, true);
    first.close(); await host.wait('student.left');
    // Rejection must also retire a capability whose old socket is already gone.
    host.send({ type: 'student.reject', studentId: ownerId });
    host.send({ type: 'room.sync' }); await host.wait('room.state');
    const fresh = await connect(port, { role: 'student', joinToken: room.joinToken, resumeToken: capability }); peers.push(fresh);
    await fresh.wait('join.pending');
    const newId = ((await host.wait('student.pending')).student as { id: string }).id;
    assert.notEqual(newId, ownerId, 'A retired capability cannot recover the old identity or files');
    host.send({ type: 'student.accept', studentId: newId }); await fresh.wait('join.accepted');
    fresh.send(offer); assert.equal((await fresh.wait('file.rejected')).code, 'FILE_CONFLICT');
    for (const peer of peers) {
      assert.ok(peer.revisions.length > 0);
      assert.ok(peer.revisions.every((revision, i) => i === 0 || revision >= peer.revisions[i - 1]),
        'Wire metadata versions must never decrease on one connection');
    }
  } finally { for (const peer of peers) peer.ws.terminate(); child.kill(); }
});

test('shared file admission bounds retained bytes, rejects conflicts and preserves full-room retries and healthy ranges', { timeout: 35000 }, async () => {
  const { port, child } = await startServer();
  const peers: TestPeer[] = [];
  try {
    const room = await (await fetch('http://127.0.0.1:' + port + '/api/rooms?autoApprove=1', { method: 'POST' })).json() as {
      roomId: string; code: string; hostToken: string; joinToken: string;
    };
    const host = await connect(port, { role: 'host', roomId: room.roomId, token: room.hostToken }); peers.push(host);
    await host.wait('room.state');
    const phones: TestPeer[] = [];
    for (let i = 0; i < 4; i++) {
      const phone = await connect(port, { role: 'student', joinToken: room.joinToken }); peers.push(phone); phones.push(phone);
      await phone.wait('join.accepted');
    }
    const offer = (i: number) => ({ type: 'file.offer', fileId: 'budget-file-' + i, name: 'original-' + i + '.bin', size: MAX_FILE_BYTES });
    for (let i = 0; i < 20; i++) {
      const phone = phones[Math.floor(i / 10)]; phone.send(offer(i)); await phone.wait('file.state');
    }
    phones[2].send({ ...offer(20), size: MAX_ROOM_BYTES - 20 * MAX_FILE_BYTES - 100 });
    await phones[2].wait('file.state');
    phones[3].send(offer(0));
    const conflict = await phones[3].wait('file.rejected');
    assert.equal(conflict.code, 'FILE_CONFLICT'); assert.equal(conflict.file, undefined);
    // Two simultaneous offers compete for the last 100 bytes. Reserve before
    // Cloudflare persistence yields, so exactly one can enter the manifest.
    for (const i of [2, 3]) phones[i].send({ ...offer(30 + i), size: 100 });
    const outcomes = await Promise.all([2, 3].map(i => phones[i].waitFor(e => !e.binary &&
      (e.msg.type === 'file.state' || e.msg.type === 'file.rejected'))));
    assert.equal(outcomes.filter(e => !e.binary && e.msg.type === 'file.state').length, 1);
    assert.equal(outcomes.filter(e => !e.binary && e.msg.code === 'ROOM_BYTE_LIMIT').length, 1);
    phones[0].send(offer(0));
    assert.equal(((await phones[0].wait('file.state')).file as { fileId: string }).fileId, offer(0).fileId,
      'Exact replay succeeds at capacity');
    phones[0].send({ type: 'file.revoke', fileId: offer(0).fileId });
    phones[0].send(offer(0));
    const stopped = (await phones[0].wait('file.state')).file as { revoked: boolean; status: string };
    assert.equal(stopped.revoked, true); assert.equal(stopped.status, 'offline');
    phones[2].send({ ...offer(90), size: 1 });
    assert.equal((await phones[2].wait('file.rejected')).code, 'ROOM_BYTE_LIMIT', 'Stop does not discard already cached bytes');
    host.send({ type: 'room.sync' });
    const files = (await host.wait('room.state')).files as Array<{ size: number }>;
    assert.equal(files.length, 22); assert.equal(files.reduce((sum, file) => sum + file.size, 0), MAX_ROOM_BYTES);
    host.send({ type: 'range.request', requestId: 'healthy-budget-range', fileId: offer(1).fileId, begin: 0, end: 4 });
    await phones[0].wait('range.request');
    phones[0].ws.send(encodeRangePacket({ type: 'range.data', requestId: 'healthy-budget-range', fileId: offer(1).fileId, begin: 0 }, Uint8Array.of(5, 1, 8, 9)));
    const packet = await host.waitBinary();
    assert.deepEqual([...decodeRangePacket(packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength) as ArrayBuffer).bytes], [5, 1, 8, 9]);
  } finally { for (const peer of peers) peer.ws.terminate(); child.kill(); }
});

test('shared participant admission keeps takeover at capacity and retries disconnected resume without losing ownership', { timeout: 35000 }, async () => {
  const { port, child } = await startServer();
  const peers: TestPeer[] = [];
  try {
    const room = await (await fetch('http://127.0.0.1:' + port + '/api/rooms?autoApprove=1', { method: 'POST' })).json() as {
      roomId: string; hostToken: string; joinToken: string;
    };
    const host = await connect(port, { role: 'host', roomId: room.roomId, token: room.hostToken }); peers.push(host); await host.wait('room.state');
    let firstToken: unknown;
    const phones: TestPeer[] = [];
    for (let i = 0; i < MAX_ACTIVE_SENDERS; i++) {
      const phone = await connect(port, { role: 'student', joinToken: room.joinToken }); peers.push(phone); phones.push(phone);
      const joined = await phone.wait('join.accepted'); if (i === 0) firstToken = joined.resumeToken;
    }
    const offer = { type: 'file.offer', fileId: 'capacity-resume-file', name: 'original.bin', size: 4 };
    phones[0].send(offer); await phones[0].wait('file.state');
    const surplus = await connect(port, { role: 'student', joinToken: room.joinToken }); peers.push(surplus);
    assert.equal((await surplus.wait('join.rejected')).code, 'ROOM_ACTIVE_LIMIT');
    phones[0].ws.pause();
    const replacement = await connect(port, { role: 'student', joinToken: room.joinToken, resumeToken: firstToken }); peers.push(replacement);
    await replacement.wait('join.resumed');
    replacement.close(); await host.wait('student.left');
    const newcomer = await connect(port, { role: 'student', joinToken: room.joinToken }); peers.push(newcomer);
    await newcomer.wait('join.accepted');
    const busy = await connect(port, { role: 'student', joinToken: room.joinToken, resumeToken: firstToken }); peers.push(busy);
    const retry = await busy.wait('error'); assert.equal(retry.code, 'ROOM_ACTIVE_LIMIT'); assert.equal(retry.retryable, true);
    newcomer.close(); await host.wait('student.left');
    const resumed = await connect(port, { role: 'student', joinToken: room.joinToken, resumeToken: firstToken }); peers.push(resumed);
    const restored = await resumed.wait('join.resumed');
    assert.equal((restored.files as Array<{ fileId: string; status: string }>)[0].fileId, offer.fileId);
    assert.equal((restored.files as Array<{ status: string }>)[0].status, 'approved');
    host.send({ type: 'room.sync' });
    assert.equal(((await host.wait('room.state')).students as unknown[]).length, MAX_ACTIVE_SENDERS);
  } finally { for (const peer of peers) { peer.ws.resume(); peer.ws.terminate(); } child.kill(); }
});

test('historical joins are bounded without expiring existing private resume capabilities', { timeout: 45000 }, async () => {
  const { port, child } = await startServer();
  const peers: TestPeer[] = [];
  try {
    const room = await (await fetch('http://127.0.0.1:' + port + '/api/rooms?autoApprove=1', { method: 'POST' })).json() as {
      roomId: string; hostToken: string; joinToken: string;
    };
    const host = await connect(port, { role: 'host', roomId: room.roomId, token: room.hostToken }); peers.push(host); await host.wait('room.state');
    let firstToken: unknown;
    for (let i = 0; i < MAX_ROOM_SESSIONS; i++) {
      const phone = await connect(port, { role: 'student', joinToken: room.joinToken }); peers.push(phone);
      const joined = await phone.wait('join.accepted'); if (i === 0) firstToken = joined.resumeToken;
      phone.close(); await host.wait('student.left');
    }
    const surplus = await connect(port, { role: 'student', joinToken: room.joinToken }); peers.push(surplus);
    assert.equal((await surplus.wait('join.rejected')).code, 'ROOM_SESSION_LIMIT');
    const resumed = await connect(port, { role: 'student', joinToken: room.joinToken, resumeToken: firstToken }); peers.push(resumed);
    await resumed.wait('join.resumed');
  } finally { for (const peer of peers) peer.ws.terminate(); child.kill(); }
});

test('rejecting a sender immediately releases its place, authority and pending ranges without a close acknowledgement', { timeout: 25000 }, async () => {
  const { port, child } = await startServer();
  const peers: TestPeer[] = [];
  try {
    const room = await (await fetch('http://127.0.0.1:' + port + '/api/rooms?autoApprove=1', { method: 'POST' })).json() as {
      roomId: string; hostToken: string; joinToken: string;
    };
    const host = await connect(port, { role: 'host', roomId: room.roomId, token: room.hostToken }); peers.push(host); await host.wait('room.state');
    const phone = await connect(port, { role: 'student', joinToken: room.joinToken }); peers.push(phone);
    await phone.wait('join.accepted');
    const student = (await host.wait('student.updated')).student as { id: string };
    const fileId = 'reject-pending-file';
    phone.send({ type: 'file.offer', fileId, name: 'original.bin', size: 4 }); await phone.wait('file.state');
    host.send({ type: 'range.request', requestId: 'rejected-range', fileId, begin: 0, end: 4 }); await phone.wait('range.request');
    phone.ws.pause();
    host.send({ type: 'student.reject', studentId: student.id });
    assert.equal((await host.wait('range.error')).requestId, 'rejected-range');
    await host.wait('student.left');
    phone.ws.send(encodeRangePacket({ type: 'range.data', requestId: 'rejected-range', fileId, begin: 0 }, Uint8Array.of(1, 2, 3, 4)));
    phone.send({ type: 'file.revoke', fileId });
    phone.send({ type: 'file.offer', fileId: 'rejected-new-file', name: 'late.bin', size: 4 });
    await delay(100);
    host.send({ type: 'room.sync' });
    const state = await host.wait('room.state');
    const files = state.files as Array<{ fileId: string; status: string; revoked?: boolean }>;
    assert.equal((state.students as unknown[]).length, 0);
    assert.equal(files.length, 1); assert.equal(files[0].status, 'offline'); assert.equal(files[0].revoked, undefined);
    assert.equal(host.events.some(event => event.binary), false, 'A rejected socket cannot forward pending original bytes');
    const next = await connect(port, { role: 'student', joinToken: room.joinToken }); peers.push(next); await next.wait('join.accepted');
    next.send({ type: 'file.offer', fileId, name: 'original.bin', size: 4 });
    assert.equal((await next.wait('file.rejected')).code, 'FILE_CONFLICT');
  } finally { for (const peer of peers) { peer.ws.resume(); peer.ws.terminate(); } child.kill(); }
});

test('room cache identity is generation-scoped and stable across sync and host replacement', { timeout: 25000 }, async () => {
  const { port, child } = await startServer();
  const peers: TestPeer[] = [];
  try {
    const create = async (query = '?cache=2') => await (await fetch('http://127.0.0.1:' + port + '/api/rooms' + query,
      { method: 'POST' })).json() as { roomId: string; code: string; hostToken: string; roomGeneration: string; cacheId: string };
    const room = await create();
    assert.equal(room.cacheId, 'generation:' + room.roomGeneration);
    assert.notEqual(room.cacheId, room.code);
    const auth = { role: 'host', roomId: room.roomId, token: room.hostToken };
    const host = await connect(port, auth); peers.push(host);
    assert.equal((await host.wait('room.state')).cacheId, room.cacheId);
    host.send({ type: 'room.sync' });
    assert.equal((await host.wait('room.state')).cacheId, room.cacheId);
    const replacement = await connect(port, auth); peers.push(replacement);
    assert.equal((await replacement.wait('room.state')).cacheId, room.cacheId);
    const other = await create();
    assert.notEqual(other.cacheId, room.cacheId);
    const legacy = await create('');
    assert.equal(legacy.cacheId, legacy.code, 'A still-open old client creates a compatible room');
    const oldHost = await connect(port, { role: 'host', roomId: legacy.roomId, token: legacy.hostToken }); peers.push(oldHost);
    assert.equal((await oldHost.wait('room.state')).cacheId, legacy.code);
  } finally { for (const peer of peers) peer.close(); child.kill(); }
});

test('replaced peers cannot stop files or end the room while their close handshake is pending', { timeout: 25000 }, async () => {
  const { port, child } = await startServer();
  const peers: TestPeer[] = [];
  try {
    const room = await (await fetch('http://127.0.0.1:' + port + '/api/rooms?autoApprove=1', { method: 'POST' })).json() as {
      roomId: string; code: string; hostToken: string; joinToken: string;
    };
    const auth = { role: 'host', roomId: room.roomId, token: room.hostToken };
    const host = await connect(port, auth); peers.push(host); await host.wait('room.state');
    const phone = await connect(port, { role: 'student', joinToken: room.joinToken }); peers.push(phone);
    const joined = await phone.wait('join.accepted');
    phone.send({ type: 'file.offer', fileId: 'active-handover', name: 'original.bin', size: 4 });
    await phone.wait('file.approved'); await host.wait('file.announced');
    phone.ws.pause(); // Keep the obsolete client OPEN without receiving the relay's close frame.
    const nextPhone = await connect(port, { role: 'student', joinToken: room.joinToken, resumeToken: joined.resumeToken }); peers.push(nextPhone);
    await nextPhone.wait('join.resumed');
    phone.send({ type: 'file.revoke', fileId: 'active-handover' });
    await delay(100);
    nextPhone.send({ type: 'file.sync' });
    const manifest = await nextPhone.wait('file.manifest');
    assert.equal((manifest.files as Array<{ status: string }>)[0].status, 'approved');
    host.ws.pause();
    const nextHost = await connect(port, auth); peers.push(nextHost); await nextHost.wait('room.state');
    host.send({ type: 'room.end' });
    await delay(100);
    nextHost.send({ type: 'room.sync' });
    assert.equal((await nextHost.wait('room.state')).code, room.code);
  } finally {
    for (const peer of peers) { peer.ws.resume(); peer.ws.terminate(); }
    child.kill('SIGTERM');
  }
});

test('receiver takeover releases all obsolete pending range slots immediately', { timeout: 25000 }, async () => {
  const { port, child } = await startServer();
  const peers: TestPeer[] = [];
  try {
    const room = await (await fetch('http://127.0.0.1:' + port + '/api/rooms?autoApprove=1', { method: 'POST' })).json() as {
      roomId: string; hostToken: string; joinToken: string;
    };
    const auth = { role: 'host', roomId: room.roomId, token: room.hostToken };
    const host = await connect(port, auth); peers.push(host); await host.wait('room.state');
    const phone = await connect(port, { role: 'student', joinToken: room.joinToken }); peers.push(phone);
    await phone.wait('join.accepted');
    phone.send({ type: 'file.offer', fileId: 'handover-slots', name: 'original.bin', size: 4 });
    await phone.wait('file.approved'); await host.wait('file.announced');
    for (let i = 0; i < 48; i++) {
      host.send({ type: 'range.request', requestId: 'obsolete-' + i, fileId: 'handover-slots', begin: 0, end: 4 });
      await phone.wait('range.request');
    }
    const next = await connect(port, auth); peers.push(next); await next.wait('room.state');
    next.send({ type: 'range.request', requestId: 'current-range', fileId: 'handover-slots', begin: 0, end: 4 });
    assert.equal((await phone.wait('range.request')).requestId, 'current-range');
    const bytes = Uint8Array.of(8, 0, 33, 255);
    phone.ws.send(encodeRangePacket({ type: 'range.data', requestId: 'current-range', fileId: 'handover-slots', begin: 0 }, bytes.buffer));
    const result = await next.waitBinary();
    assert.deepEqual(decodeRangePacket(Uint8Array.from(result).buffer).bytes, bytes);
  } finally { for (const peer of peers) peer.close(); child.kill('SIGTERM'); }
});

test('an existing phone resumes while the receiver is offline without losing its files or approval', { timeout: 25000 }, async () => {
  const { port, child } = await startServer();
  const peers: TestPeer[] = [];
  try {
    const room = await (await fetch('http://127.0.0.1:' + port + '/api/rooms?autoApprove=1', { method: 'POST' })).json() as {
      roomId: string; hostToken: string; joinToken: string;
    };
    const auth = { role: 'host', roomId: room.roomId, token: room.hostToken };
    const host = await connect(port, auth); peers.push(host); await host.wait('room.state');
    const phone = await connect(port, { role: 'student', joinToken: room.joinToken }); peers.push(phone);
    const joined = await phone.wait('join.accepted');
    phone.send({ type: 'file.offer', fileId: 'retained-file', name: 'retained.bin', size: 4 });
    await phone.wait('file.approved'); await host.wait('file.announced');
    host.close(); await phone.wait('host.offline');
    const replacement = await connect(port, { role: 'student', joinToken: room.joinToken, resumeToken: joined.resumeToken });
    peers.push(replacement);
    const resumed = await replacement.wait('join.resumed');
    assert.equal((resumed.files as Array<{ fileId: string }>)[0].fileId, 'retained-file');
    await replacement.wait('host.offline');
    const next = await connect(port, auth); peers.push(next);
    const state = await next.wait('room.state');
    assert.equal((state.students as unknown[]).length, 1);
    await replacement.wait('host.online');
    next.send({ type: 'range.request', requestId: 'resumed-range', fileId: 'retained-file', begin: 0, end: 4 });
    await replacement.wait('range.request');
    const bytes = Uint8Array.of(42, 10, 0, 255);
    replacement.ws.send(encodeRangePacket({ type: 'range.data', requestId: 'resumed-range', fileId: 'retained-file', begin: 0 }, bytes.buffer));
    assert.deepEqual(decodeRangePacket(Uint8Array.from(await next.waitBinary()).buffer).bytes, bytes);
  } finally { for (const peer of peers) peer.close(); child.kill('SIGTERM'); }
});

test('an explicit file stop cancels requests and remains terminal after reconnect and offer replay', { timeout: 25000 }, async () => {
  const { port, child } = await startServer();
  const peers: TestPeer[] = [];
  try {
    const room = await (await fetch('http://127.0.0.1:' + port + '/api/rooms?autoApprove=1', { method: 'POST' })).json() as {
      roomId: string; hostToken: string; joinToken: string;
    };
    const host = await connect(port, { role: 'host', roomId: room.roomId, token: room.hostToken }); peers.push(host);
    await host.wait('room.state');
    const phone = await connect(port, { role: 'student', joinToken: room.joinToken }); peers.push(phone);
    const joined = await phone.wait('join.accepted');
    const offer = { type: 'file.offer', fileId: 'stopped-file', name: 'original.bin', size: 4 };
    phone.send(offer); await phone.wait('file.approved'); await host.wait('file.announced');
    host.send({ type: 'range.request', requestId: 'stop-request', fileId: offer.fileId, begin: 0, end: 4 });
    await phone.wait('range.request');
    phone.send({ type: 'file.revoke', fileId: offer.fileId });
    await host.wait('file.updated');
    assert.equal((await host.wait('range.error')).requestId, 'stop-request');
    const next = await connect(port, { role: 'student', joinToken: room.joinToken, resumeToken: joined.resumeToken }); peers.push(next);
    const resumed = await next.wait('join.resumed');
    const file = (resumed.files as Array<{ status: string; revoked?: boolean }>)[0];
    assert.equal(file.status, 'offline'); assert.equal(file.revoked, true);
    next.send(offer);
    assert.equal(((await next.wait('file.state')).file as { status: string }).status, 'offline');
    next.ws.send(encodeRangePacket({ type: 'range.data', requestId: 'stop-request', fileId: offer.fileId, begin: 0 }, Uint8Array.of(1, 2, 3, 4).buffer));
    host.send({ type: 'range.request', requestId: 'stopped-retry', fileId: offer.fileId, begin: 0, end: 4 });
    assert.equal((await host.wait('range.error')).requestId, 'stopped-retry');
    await delay(50);
    assert.equal(host.events.some(e => e.binary), false, 'A late stopped response cannot reach the receiver');
  } finally { for (const peer of peers) peer.close(); child.kill('SIGTERM'); }
});

test('retry before the first join acknowledgement preserves one pending student and approval', { timeout: 20000 }, async () => {
  const { port, child } = await startServer();
  const peers: TestPeer[] = [];
  try {
    const room = await (await fetch('http://127.0.0.1:' + port + '/api/rooms', { method: 'POST' })).json() as {
      roomId: string; hostToken: string; joinToken: string;
    };
    const host = await connect(port, { role: 'host', roomId: room.roomId, token: room.hostToken });
    peers.push(host);
    await host.wait('room.state');
    const resumeToken = 'ab'.repeat(32);
    const phone = await connect(port, { role: 'student', joinToken: room.joinToken, resumeToken });
    peers.push(phone);
    // Intentionally don't use any capability from the first acknowledgement.
    const pending = await host.wait('student.pending');
    const replacement = await connect(port, { role: 'student', joinToken: room.joinToken, resumeToken });
    peers.push(replacement);
    assert.equal((await replacement.wait('join.pending')).resumeToken, resumeToken);
    host.send({ type: 'room.sync' });
    const state = await host.wait('room.state');
    const students = state.students as Array<{ id: string; approved: boolean }>;
    assert.equal(students.length, 1);
    assert.equal(students[0].approved, false);
    assert.equal(students[0].id, (pending.student as { id: string }).id);
    host.send({ type: 'student.accept', studentId: students[0].id });
    await replacement.wait('join.accepted');
  } finally {
    for (const peer of peers) peer.close();
    child.kill('SIGTERM');
  }
});

test('phone takeover replays only its outstanding uncancelled byte requests after restoring its manifest', { timeout: 20000 }, async () => {
  const { port, child } = await startServer();
  const peers: TestPeer[] = [];
  try {
    const room = await (await fetch('http://127.0.0.1:' + port + '/api/rooms?autoApprove=1', { method: 'POST' })).json() as {
      roomId: string; hostToken: string; joinToken: string;
    };
    const host = await connect(port, { role: 'host', roomId: room.roomId, token: room.hostToken });
    peers.push(host);
    await host.wait('room.state');
    const phone = await connect(port, { role: 'student', joinToken: room.joinToken });
    peers.push(phone);
    const joined = await phone.wait('join.accepted');
    phone.send({ type: 'file.offer', fileId: 'takeover-file', name: 'original.bin', size: 4 });
    await phone.wait('file.approved');
    await host.wait('file.announced');
    for (const requestId of ['keep-request', 'cancel-request']) {
      host.send({ type: 'range.request', requestId, fileId: 'takeover-file', begin: 0, end: 4 });
      assert.equal((await phone.wait('range.request')).requestId, requestId);
    }
    host.send({ type: 'range.cancel', requestId: 'cancel-request' });
    host.send({ type: 'room.sync' });
    await host.wait('room.state'); // Cancellation is processed before takeover.
    const other = await connect(port, { role: 'student', joinToken: room.joinToken, name: 'Other sender' });
    peers.push(other);
    await other.wait('join.accepted');
    other.send({ type: 'file.offer', fileId: 'other-sender-file', name: 'other.bin', size: 4 });
    await other.wait('file.approved');
    await host.wait('file.announced');
    host.send({ type: 'range.request', requestId: 'other-request', fileId: 'other-sender-file', begin: 0, end: 4 });
    await other.wait('range.request');
    const replacement = await connect(port, {
      role: 'student', joinToken: room.joinToken, resumeToken: joined.resumeToken,
    });
    peers.push(replacement);
    const manifest = await replacement.wait('join.resumed');
    assert.equal((manifest.files as Array<{ status: string }>)[0].status, 'approved');
    const replayed = await replacement.wait('range.request');
    assert.equal(replayed.requestId, 'keep-request');
    const bytes = Uint8Array.of(41, 3, 87, 255);
    replacement.ws.send(encodeRangePacket({ type: 'range.data', requestId: 'keep-request', fileId: 'takeover-file', begin: 0 }, bytes.buffer));
    const received = await host.waitBinary();
    const packet = decodeRangePacket(received.buffer.slice(received.byteOffset, received.byteOffset + received.byteLength) as ArrayBuffer);
    assert.deepEqual(packet.bytes, bytes);
    await delay(100);
    assert.equal(replacement.events.some(e => !e.binary && e.msg.type === 'range.request'), false,
      'Cancelled requests and other senders\' requests must not be replayed');
  } finally {
    for (const peer of peers) peer.close();
    child.kill('SIGTERM');
  }
});

test('different devices exchange metadata, approvals and byte-range PDF data via relay', { timeout: 20000 }, async () => {
  const { port, child } = await startServer();
  const peers: TestPeer[] = [];
  try {
    const creation = await fetch('http://127.0.0.1:' + port + '/api/rooms', { method: 'POST' });
    assert.equal(creation.status, 201);
    const room = await creation.json() as {
      roomId: string; hostToken: string; joinToken: string; code: string;
    };
    assert.match(room.code, /^\d{6}$/);

    const host = await connect(port, { role: 'host', roomId: room.roomId, token: room.hostToken });
    peers.push(host);
    const state = await host.wait('room.state');
    assert.equal(state.code, room.code);

    const student = await connect(port, { role: 'student', joinToken: room.joinToken, name: 'Tester' });
    peers.push(student);
    await student.wait('join.pending');
    const pending = await host.wait('student.pending');
    const studentInfo = pending.student as { id: string };
    host.send({ type: 'student.accept', studentId: studentInfo.id });
    await student.wait('join.accepted');

    const pdf = Buffer.from('%PDF-1.7\nsample-pdf-binary');
    const fileId = 'pdfabcdef12345';
    student.send({ type: 'file.offer', fileId, name: 'class.pdf', size: pdf.length });
    await student.wait('file.approved');
    const announcement = await host.wait('file.announced');
    assert.equal((announcement.file as { name: string }).name, 'class.pdf');

    assert.equal((announcement.file as { status: string }).status, 'approved');
    // Student authorization is the only approval step; no file.allow action.

    const requestId = 'requestabc12345';
    host.send({ type: 'range.request', requestId, fileId, begin: 0, end: pdf.length });
    const request = await student.wait('range.request');
    assert.equal(request.requestId, requestId);
    assert.equal(request.end, pdf.length);
    student.ws.send(encodeRangePacket({
      type: 'range.data', requestId, fileId, begin: 0,
    }, pdf), { binary: true });
    const result = await host.waitBinary();
    const packet = new ArrayBuffer(result.byteLength);
    new Uint8Array(packet).set(result);
    const data = decodeRangePacket(packet);
    assert.equal(data.header.requestId, requestId);
    assert.deepEqual(Buffer.from(data.bytes), pdf);

    // Older clients may still send per-chunk updates. Those must never
    // reach the phone or trigger durable metadata updates.
    host.send({ type: 'cache.progress', fileId, bytes: Math.floor(pdf.length / 2) });
    student.send({ type: 'file.sync' });
    const interim = await student.wait('file.manifest');
    const interimFiles = interim.files as Array<{ fileId: string; cachedBytes?: number }>;
    assert.equal(interimFiles.find(f => f.fileId === fileId)?.cachedBytes, undefined);

    // Only final completion gets one host acknowledgement.
    host.send({ type: 'cache.progress', fileId, bytes: pdf.length });
    const ack = await student.wait('cache.progress');
    assert.equal(ack.fileId, fileId);
    assert.equal(ack.bytes, pdf.length);
    assert.equal(ack.complete, true);
    student.send({ type: 'file.sync' });
    const manifest = await student.wait('file.manifest');
    const saved = manifest.files as Array<{ fileId: string; cachedBytes?: number }>;
    assert.equal(saved.find(f => f.fileId === fileId)?.cachedBytes, pdf.length,
      'The relay must keep the last host-acknowledged bytes for phone resync');
    // File manifests now carry completed-cache metadata directly; the
    // student sync must NOT cause another host IndexedDB scan or a progress
    // broadcast while the fast transfer lane is active.

    // Students cannot request ranges: this belongs exclusively to the teacher.
    student.send({ type: 'range.request', requestId: 'badstudent123', fileId, begin: 0, end: 4 });
    await assert.rejects(student.wait('range.request'));

    host.send({ type: 'room.end' });
    await student.wait('room.closed');
  } finally {
    for (const peer of peers) peer.close();
    child.kill('SIGTERM');
  }
});


test('open admission is an explicit room creation choice and preserves sender-only manifests', { timeout: 20000 }, async () => {
  const { port, child } = await startServer();
  const peers: TestPeer[] = [];
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/api/rooms?autoApprove=1', { method: 'POST' });
    assert.equal(response.status, 201);
    const room = await response.json() as {
      code: string; roomId: string; hostToken: string; joinToken: string; autoApprove: boolean;
    };
    assert.equal(room.autoApprove, true);
    const host = await connect(port, { role: 'host', roomId: room.roomId, token: room.hostToken });
    peers.push(host);
    const snapshot = await host.wait('room.state');
    assert.equal(snapshot.autoApprove, true);
    const alice = await connect(port, { role: 'student', joinToken: room.joinToken, name: 'Alice' });
    peers.push(alice);
    const bob = await connect(port, { role: 'student', joinToken: room.joinToken, name: 'Bob' });
    peers.push(bob);
    const joinedAlice = await alice.wait('join.accepted');
    const joinedBob = await bob.wait('join.accepted');
    assert.ok(joinedAlice.resumeToken);
    assert.ok(joinedBob.resumeToken);
    alice.send({ type: 'file.offer', fileId: 'aliceprivatepdf', name: 'Alice-private.pdf', size: 180 });
    await alice.wait('file.approved');
    await host.wait('file.announced');
    alice.send({ type: 'file.sync' });
    bob.send({ type: 'file.sync' });
    const own = await alice.wait('file.manifest');
    const other = await bob.wait('file.manifest');
    assert.equal((own.files as unknown[]).length, 1);
    assert.equal((other.files as unknown[]).length, 0,
      'Only the owner should see private file metadata; the host sees all');
  } finally {
    for (const peer of peers) peer.close();
    child.kill('SIGTERM');
  }
});

test('scoped HTTP lease and acknowledged generation-safe room end work without a host socket', { timeout: 20000 }, async () => {
  const { port, child } = await startServer();
  const peers: TestPeer[] = [];
  try {
    const origin = 'http://127.0.0.1:' + port;
    const room = await (await fetch(origin + '/api/rooms?autoApprove=1', { method: 'POST' })).json() as {
      roomId: string; code: string; roomGeneration: string; hostToken: string; leaseToken: string; joinToken: string;
    };
    assert.match(room.roomGeneration, /^[a-f0-9-]{36}$/);
    assert.notEqual(room.leaseToken, room.hostToken);
    const endpoint = origin + '/api/rooms/' + room.roomId + '/lease';
    const headers = { Authorization: 'Bearer ' + room.leaseToken, 'Content-Type': 'application/json' };
    assert.equal((await fetch(endpoint, { method: 'GET' })).status, 405);
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body: '{' })).status, 400);
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body: 'x'.repeat(257) })).status, 413,
      'The HTTP adapter must return the bounded-body error, not lose the response');
    const control = (action: string, token: string, generation = room.roomGeneration, originHeader?: string) =>
      fetch(origin + '/api/rooms/' + room.roomId + '/' + action, { method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
          ...(originHeader ? { Origin: originHeader } : {}) }, body: JSON.stringify({ roomGeneration: generation }) });
    assert.ok([401, 403].includes((await control('lease', room.joinToken)).status));
    assert.equal((await control('end', room.leaseToken)).status, 403, 'Presenter lease cannot end a room');
    assert.equal((await control('lease', room.leaseToken, room.roomGeneration, 'https://other.example')).status, 403);
    const renewed = await control('lease', room.leaseToken);
    assert.equal(renewed.status, 200);
    assert.equal((await renewed.json() as { state: string }).state, 'active', 'Renewal needs no host WebSocket');
    const stale = await control('end', room.hostToken, crypto.randomUUID());
    assert.equal((await stale.json() as { state: string }).state, 'absent');
    assert.equal((await (await control('lease', room.leaseToken)).json() as { state: string }).state, 'active',
      'A close for another generation never terminates this classroom');
    const forbiddenHost = await connect(port, { role: 'host', roomId: room.roomId, token: room.leaseToken });
    peers.push(forbiddenHost);
    await forbiddenHost.wait('error');
    forbiddenHost.close();
    const host = await connect(port, { role: 'host', roomId: room.roomId, token: room.hostToken });
    peers.push(host);
    const hostState = await host.wait('room.state');
    assert.equal(hostState.roomGeneration, room.roomGeneration);
    const student = await connect(port, { role: 'student', code: room.code, joinToken: room.joinToken, name: 'Control tester' });
    peers.push(student);
    const joined = await student.wait('join.accepted');
    assert.equal(joined.leaseToken, undefined, 'Student does not receive presenter authority');
    host.close();
    const ended = await control('end', room.hostToken);
    assert.equal(ended.status, 200);
    assert.equal((await ended.json() as { state: string }).state, 'closed');
    await student.wait('room.closed');
    const repeated = await control('end', room.hostToken);
    assert.equal((await repeated.json() as { state: string }).state, 'absent', 'Lost response can be retried without a socket');
    const leaseAfterEnd = await control('lease', room.leaseToken);
    assert.equal((await leaseAfterEnd.json() as { state: string }).state, 'absent', 'Lease cannot recreate an ended room');
  } finally {
    for (const peer of peers) peer.close();
    child.kill();
  }
});
