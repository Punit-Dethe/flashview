import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { decodeRangePacket, encodeRangePacket } from '../src/shared/protocol';

type Message = { type: string; [key: string]: unknown };
type Event = { binary: false; msg: Message } | { binary: true; data: Buffer };

class TestPeer {
  events: Event[] = [];
  waiters: Array<{ predicate: (event: Event) => boolean; done: (event: Event) => void }> = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (data, binary) => {
      const event: Event = binary
        ? { binary: true, data: Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer) }
        : { binary: false, msg: JSON.parse(data.toString()) as Message };
      const index = this.waiters.findIndex(waiter => waiter.predicate(event));
      if (index >= 0) this.waiters.splice(index, 1)[0].done(event);
      else this.events.push(event);
    });
  }
  send(msg: Record<string, unknown>): void { this.ws.send(JSON.stringify({ v: 1, ...msg })); }
  async wait(type: string): Promise<Message> {
    const event = await this.waitFor(e => !e.binary && e.msg.type === type);
    assert.equal(event.binary, false);
    return event.msg;
  }
  async waitBinary(): Promise<Buffer> {
    const event = await this.waitFor(e => e.binary);
    assert.equal(event.binary, true);
    return event.data;
  }
  waitFor(predicate: (event: Event) => boolean): Promise<Event> {
    const existing = this.events.findIndex(predicate);
    if (existing !== -1) return Promise.resolve(this.events.splice(existing, 1)[0]);
    return new Promise<Event>((resolve, reject) => {
      const waiter = { predicate, done: (event: Event) => { clearTimeout(timer); resolve(event); } };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(item => item !== waiter);
        reject(new Error('Timeout waiting for server message'));
      }, 5000);
    });
  }
  close(): void { this.ws.close(); }
}

async function connect(port: number, auth: Record<string, unknown>): Promise<TestPeer> {
  const room = typeof auth.code === 'string' ? auth.code
    : typeof auth.joinToken === 'string' ? auth.joinToken.split('.')[0] : String(auth.roomId ?? '');
  const suffix = process.env.FLASHVIEW_BACKEND === 'cloudflare' ? '?room=' + room : '';
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws' + suffix, {
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
async function startServer(): Promise<{ port: number; child: ChildProcessWithoutNullStreams }> {
  const port = await unusedPort();
  const useCloudflare = process.env.FLASHVIEW_BACKEND === 'cloudflare';
  const child = spawn(process.execPath, useCloudflare
    ? ['node_modules/wrangler/bin/wrangler.js', 'dev', '--port', String(port), '--ip', '127.0.0.1']
    : ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
  });
  let output = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', data => { output += String(data); });
  for (let i = 0; i < 200; i++) {
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

test('owner stop cancels pending bytes and remains terminal after reconnect and offer replay', { timeout: 20000 }, async () => {
  const { port, child } = await startServer();
  const peers: TestPeer[] = [];
  try {
    const creation = await fetch('http://127.0.0.1:' + port + '/api/rooms?autoApprove=1', { method: 'POST' });
    const room = await creation.json() as { roomId: string; code: string; hostToken: string; joinToken: string };
    const host = await connect(port, { role: 'host', roomId: room.roomId, token: room.hostToken });
    peers.push(host);
    await host.wait('room.state');
    const student = await connect(port, { role: 'student', joinToken: room.joinToken, name: 'Stop tester' });
    peers.push(student);
    const joined = await student.wait('join.accepted');
    const fileId = 'revoked-original';
    student.send({ type: 'file.offer', fileId, name: 'original.bin', size: 4 });
    await student.wait('file.approved');
    await host.wait('file.announced');
    const requestId = 'pending-revoked-range';
    host.send({ type: 'range.request', requestId, fileId, begin: 0, end: 4 });
    await student.wait('range.request');
    student.send({ type: 'file.revoke', fileId });
    assert.equal((await host.wait('range.error')).requestId, requestId);
    const update = await host.wait('file.updated');
    assert.equal((update.file as { revoked: boolean }).revoked, true);
    // A late response must never slip through after the cancellation receipt.
    student.ws.send(encodeRangePacket({ type: 'range.data', requestId, fileId, begin: 0 }, Uint8Array.of(1, 2, 3, 4)));
    student.send({ type: 'heartbeat.ping' });
    await student.wait('heartbeat.pong');
    host.send({ type: 'room.sync' });
    await host.wait('room.state');
    assert.ok(host.events.every(event => !event.binary));

    // A different file disconnected by presence alone must still recover.
    student.send({ type: 'file.offer', fileId: 'resumable-original', name: 'live.bin', size: 4 });
    await student.wait('file.approved');
    await host.wait('file.announced');
    student.close();
    await host.wait('student.left');
    const resumed = await connect(port, { role: 'student', joinToken: room.joinToken,
      name: 'Stop tester', resumeToken: joined.resumeToken });
    peers.push(resumed);
    const snapshot = await resumed.wait('join.resumed');
    const files = snapshot.files as Array<{ fileId: string; status: string; revoked?: boolean }>;
    assert.equal(files.find(file => file.fileId === fileId)?.status, 'offline');
    assert.equal(files.find(file => file.fileId === fileId)?.revoked, true);
    assert.equal(files.find(file => file.fileId === 'resumable-original')?.status, 'approved');
    resumed.send({ type: 'file.offer', fileId, name: 'original.bin', size: 4 });
    const replay = await resumed.wait('file.state');
    assert.equal((replay.file as { status: string }).status, 'offline');
    assert.equal((replay.file as { revoked: boolean }).revoked, true);
    host.send({ type: 'range.request', requestId: 'retry-revoked-range', fileId, begin: 0, end: 4 });
    assert.equal((await host.wait('range.error')).requestId, 'retry-revoked-range');
  } finally {
    for (const peer of peers) peer.close();
    child.kill();
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
