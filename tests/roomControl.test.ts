import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOM_TTL_MS } from '../src/shared/protocol';
import { authorizeRoomControl, readRoomControlGeneration, RoomControlInputError } from '../src/shared/roomControl';
import { RoomLease, endRoomAndClear } from '../src/client/roomControl';

const generation = '12345678-1234-4234-8234-123456789abc';
const identity = { roomId: '123456', roomGeneration: generation, leaseToken: 'L'.repeat(43) };
const session = { ...identity, hostToken: 'H'.repeat(43) };
const config = { ...session, created: 1000, lastActivityAt: 1000 };
const result = (state: string) => Response.json({ state, roomGeneration: generation });
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await delay(5);
  assert.ok(predicate(), 'Expected async state was reached');
}

test('room controls separate lease/end authority and never revive expired or reused generations', () => {
  assert.equal(authorizeRoomControl(config, generation, session.leaseToken, 'lease', 2000), 'allowed');
  assert.equal(authorizeRoomControl(config, generation, session.leaseToken, 'end', 2000), 'denied');
  assert.equal(authorizeRoomControl(config, generation, session.hostToken, 'end', 2000), 'allowed');
  assert.equal(authorizeRoomControl(config, generation, 'wrong', 'lease', 2000), 'denied');
  assert.equal(authorizeRoomControl(config, generation, session.leaseToken, 'lease', 1000 + ROOM_TTL_MS), 'expired');
  assert.equal(authorizeRoomControl(config, crypto.randomUUID(), session.hostToken, 'end', 2000), 'absent');
  assert.equal(authorizeRoomControl(null, generation, session.hostToken, 'end', 2000), 'absent');
});

test('control metadata is bounded by actual bytes and validates its generation', async () => {
  const valid = new Response(JSON.stringify({ roomGeneration: generation })).body!.getReader();
  assert.equal(await readRoomControlGeneration(valid), generation);
  await assert.rejects(readRoomControlGeneration(new Response('x'.repeat(257)).body!.getReader()),
    (error: unknown) => error instanceof RoomControlInputError && error.status === 413);
  await assert.rejects(readRoomControlGeneration(new Response('{"roomGeneration":"123456"}').body!.getReader()),
    (error: unknown) => error instanceof RoomControlInputError && error.status === 400);
});

test('lost close response preserves intent and local bytes; retry accepts generation absence', async () => {
  let saved: typeof session & { closeRequested?: boolean; serverClosed?: boolean } = session;
  let clears = 0;
  const persist = (pending: typeof saved) => { saved = pending; };
  await assert.rejects(endRoomAndClear(saved, persist, async () => { clears++; }, async () => { throw Error('response lost'); }),
    /retained/);
  assert.equal(saved.closeRequested, true);
  assert.equal(saved.serverClosed, undefined);
  assert.equal(clears, 0, 'No local bytes removed while closure is uncertain');
  await endRoomAndClear(saved, persist, async () => { clears++; }, async () => result('absent'));
  assert.equal(saved.serverClosed, true);
  assert.equal(clears, 1);
});

test('cache cleanup failure keeps confirmed closure and retries cleanup without the network', async () => {
  let saved: typeof session & { closeRequested?: boolean; serverClosed?: boolean } = session;
  let clears = 0;
  const persist = (pending: typeof saved) => { saved = pending; };
  await assert.rejects(endRoomAndClear(saved, persist, async () => { clears++; throw Error('disk failure'); },
    async () => result('closed')), /closed.*cache could not be cleared/);
  assert.equal(saved.serverClosed, true);
  await endRoomAndClear(saved, persist, async () => { clears++; }, async () => { throw Error('must not fetch'); });
  assert.equal(clears, 2);
});

test('unresponsive close is aborted at its deadline without clearing original bytes', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let cleared = false;
  let aborted = false;
  const closing = endRoomAndClear(session, () => {}, async () => { cleared = true; },
    async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); }, { once: true });
    }));
  context.mock.timers.tick(12_000);
  await assert.rejects(closing, /retained/);
  assert.equal(aborted, true);
  assert.equal(cleared, false);
});

test('intent persistence failure and wrong-generation replies never clear cache', async () => {
  let requested = false;
  let cleared = false;
  await assert.rejects(endRoomAndClear(session, () => { throw Error('storage denied'); }, async () => { cleared = true; },
    async () => { requested = true; return result('closed'); }), /storage denied/);
  assert.equal(requested, false);
  await assert.rejects(endRoomAndClear(session, () => {}, async () => { cleared = true; },
    async () => Response.json({ state: 'closed', roomGeneration: crypto.randomUUID() })), /retained/);
  assert.equal(cleared, false);
});

test('lease renewals continue without visibility input, serialize requests and stop after disposal', async () => {
  let requests = 0;
  let release!: (response: Response) => void;
  const lease = new RoomLease(async (_url, options) => {
    requests++;
    assert.equal(options?.headers && (options.headers as Record<string, string>).Authorization, 'Bearer ' + identity.leaseToken);
    assert.equal(options?.body, JSON.stringify({ roomGeneration: generation }));
    return new Promise<Response>(resolve => { release = resolve; });
  }, 15);
  try {
    lease.start(identity);
    await lease.renew();
    await delay(25);
    assert.equal(requests, 1, 'Only one in-flight request, including foreground wakes');
    release(result('active'));
    await waitFor(() => requests === 2);
    lease.stop();
    release(result('active'));
    await delay(40);
    assert.equal(requests, 2, 'Late completion cannot restart a stopped lease');
  } finally { lease.stop(); }
});

test('expired capability stops lease retries and does not perform any file operation', async () => {
  let requests = 0;
  const lease = new RoomLease(async () => { requests++; return new Response(null, { status: 403 }); }, 10);
  try {
    lease.start(identity);
    await delay(50);
    await lease.renew();
    assert.equal(requests, 1);
  } finally { lease.stop(); }
});
