import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomTransferClient } from '../src/client/transferClient';

class FakeWorker {
  static instances: FakeWorker[] = [];
  static failConstruction = false;
  sent: any[] = []; terminated = false;
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onmessageerror: ((event: any) => void) | null = null;
  constructor() { if (FakeWorker.failConstruction) throw Error('Workers blocked'); FakeWorker.instances.push(this); }
  postMessage(value: unknown) { this.sent.push(value); }
  terminate() { this.terminated = true; }
  reply(reply: object, session = this.sent.at(-1).session) { this.onmessage?.({ data: { session, ...reply } }); }
  events(events: object[], session?: number) { this.reply({ type: 'events', events }, session); }
}
function setup(t: import('node:test').TestContext) {
  const previous = ['Worker', 'location'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '' } });
  FakeWorker.instances = []; FakeWorker.failConstruction = false;
  const client = new RoomTransferClient();
  t.after(() => {
    client.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  return client;
}
test('worker bridge resolves results once, cancels passive reads and rejects old-room operations', async t => {
  const client = setup(t); client.setRoom('generation:a'); client.connect({ role: 'host', roomId: '123456' });
  const worker = FakeWorker.instances[0];
  worker.events([{ type: 'status', status: 'connected' }]);
  const request = client.request('preview', { roomId: 'generation:a', fileId: 'fileabcdef' });
  const rpc = worker.sent.at(-1).command;
  worker.reply({ type: 'result', id: rpc.id, value: 'saved-preview' });
  assert.equal(await request, 'saved-preview');
  const abort = new AbortController();
  const reading = client.request('read', { roomId: 'generation:a', begin: 0, end: 4 }, abort.signal);
  abort.abort(); await assert.rejects(reading, /cancelled/);
  assert.equal(worker.sent.at(-1).command.type, 'cancel');
  const pending = client.request('preview', { roomId: 'generation:a' });
  const owner = worker.sent.at(-1).session;
  client.connect({ role: 'host', roomId: '654321' });
  await assert.rejects(pending, /Room changed/);
  worker.events([{ type: 'status', status: 'connected' }], owner);
  assert.equal(client.connected, false, 'An old worker batch cannot authenticate another room');
});
test('idle worker warm-up opens no connection and reuses the owner when a room is created', t => {
  const client = setup(t); client.warm(); client.warm();
  assert.equal(FakeWorker.instances.length, 1);
  assert.ok(FakeWorker.instances[0].sent.every(message => message.command.type === 'room'));
  assert.equal(client.connected, false);
  client.connect({ role: 'host', roomId: '123456' });
  assert.equal(FakeWorker.instances.length, 1);
  assert.equal(FakeWorker.instances[0].sent.at(-1).command.type, 'connect');
});
test('worker crash preserves the initial private capability, learned generation and selected File handles', async t => {
  const client = setup(t); client.connect({ role: 'student', code: '123456' });
  const first = FakeWorker.instances[0], initial = first.sent.find(message => message.command.type === 'connect').command.identity;
  assert.match(initial.resumeToken, /^[a-f0-9]{64}$/);
  first.events([{ type: 'message', message: { type: 'join.accepted', roomGeneration: 'generation-a', resumeToken: initial.resumeToken } }]);
  const file = new File([Uint8Array.of(1, 2, 3)], 'original.bin');
  client.addSources([{ fileId: 'original123', file }]);
  const pending = client.request('preview', { roomId: 'generation:a' });
  first.onerror?.({ preventDefault() {} });
  await assert.rejects(pending, /restarted/);
  assert.equal(first.terminated, true);
  const replacement = FakeWorker.instances[1];
  const identity = replacement.sent.find(message => message.command.type === 'connect').command.identity;
  assert.equal(identity.resumeToken, initial.resumeToken); assert.equal(identity.roomGeneration, 'generation-a');
  assert.equal(replacement.sent.find(message => message.command.type === 'sources').command.files[0].file, file);
});
test('Stop while disconnected retires its File and survives a worker replacement without registering it again', t => {
  const client = setup(t); client.connect({ role: 'student', code: '123456' });
  const first = FakeWorker.instances[0];
  const original = { fileId: 'stopped123', file: new File([Uint8Array.of(9)], 'stopped.bin') };
  client.addSources([original]);
  assert.equal(client.connected, false);
  assert.equal(client.send({ type: 'file.revoke', fileId: original.fileId }), true);
  assert.equal(first.sent.at(-1).command.message.type, 'file.revoke');
  client.addSources([original]);
  assert.deepEqual(first.sent.at(-1).command.files, []);
  first.onerror?.({ preventDefault() {} });
  const replacement = FakeWorker.instances[1];
  assert.ok(replacement.sent.some(message => message.command.message?.type === 'file.revoke'));
  assert.deepEqual(replacement.sent.find(message => message.command.type === 'sources').command.files, []);
});
test('unsupported worker startup and exhausted restart budget stop cleanly without an implicit UI transfer', t => {
  const client = setup(t); let warning = '';
  client.onWarning = value => { warning = value; };
  FakeWorker.failConstruction = true; client.connect({ role: 'student', code: '123456' });
  assert.equal(client.connected, false); assert.equal(client.unavailable, true); assert.match(warning, /Web Worker/);
  assert.doesNotThrow(() => { client.wake(); client.pauseHeartbeat(); });
  FakeWorker.failConstruction = false; client.connect({ role: 'student', code: '123456' });
  for (let count = 0; count < 3; count++) FakeWorker.instances.at(-1)!.onerror?.({ preventDefault() {} });
  assert.equal(FakeWorker.instances.length, 3); assert.equal(client.unavailable, true);
  client.wake(); assert.equal(FakeWorker.instances.length, 3, 'Focus cannot bypass the failed-worker retry budget');
});
