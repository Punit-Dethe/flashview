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
async function startServer(): Promise<{ port: number; child: ChildProcessWithoutNullStreams }> {
  const port = await unusedPort();
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
