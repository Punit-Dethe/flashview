import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomEngine, type Joined, type RoomMetadata } from '../src/shared/roomEngine';
const makeJoin = (engine: RoomEngine, index = 1, resumeToken: unknown = undefined, hostOnline = true): Joined => {
  const result = engine.join({ connection: {}, id: 'owner-' + index, name: 'Alice', resumeToken,
    newToken: String(index).padStart(64, '0'), autoApprove: false, hostOnline, now: 100 });
  if (result.kind !== 'joined') assert.fail(result.message);
  return result;
};
const offer = { fileId: 'engine-original', name: 'original.bin', size: 4 };

test('shared participant approval, private takeover and rejection own one immutable session state', () => {
  const engine = new RoomEngine();
  const pending = makeJoin(engine);
  assert.equal(pending.participant.approved, false);
  const approved = engine.approve(pending.participant.id)!;
  assert.equal(engine.sessions.get(pending.participant.token)?.approved, true);
  assert.equal(pending.participant.approved, false, 'Old pending result is immutable');
  assert.equal(engine.isCurrent(pending.participant), false);
  const revision = engine.revision;
  engine.approve(pending.participant.id); assert.equal(engine.revision, revision, 'Approval retries are idempotent');
  const replacement = makeJoin(engine, 2, pending.participant.token, false);
  assert.equal(replacement.displaced, approved.participant.connection);
  assert.equal(replacement.participant.id, approved.participant.id);
  assert.equal(replacement.participant.approved, true);
  assert.equal(engine.disconnect(approved.participant.id, approved.participant.connection), null);
  assert.equal(engine.students().length, 1);
  assert.equal('token' in engine.students()[0], false, 'Private capabilities never appear in host lists');
  engine.fileState.offer(replacement.participant, offer);
  const rejected = engine.reject(replacement.participant.id)!;
  assert.equal(rejected.participant?.connection, replacement.participant.connection);
  assert.equal(engine.sessions.has(replacement.participant.token), false);
  assert.equal(engine.students().length, 0);
  assert.equal(engine.fileState.files.get(offer.fileId)?.status, 'offline');
  assert.equal(engine.isCurrent(replacement.participant), false);
});

test('participant quota survives rejection and known private resumes bypass new-identity rate and host absence', () => {
  const engine = new RoomEngine(); const original = makeJoin(engine);
  engine.disconnect(original.participant.id, original.participant.connection);
  for (let i = 2; i <= 120; i++) { const joined = makeJoin(engine, i); engine.reject(joined.participant.id); }
  const fresh = engine.join({ connection: {}, id: 'new-owner', name: '', newToken: 'new-token', resumeToken: undefined,
    autoApprove: true, hostOnline: true, now: 200 });
  assert.equal(fresh.kind, 'rejected'); if (fresh.kind === 'rejected') assert.equal(fresh.code, 'JOIN_RATE_LIMIT');
  const resumed = makeJoin(engine, 999, original.participant.token, false);
  assert.equal(resumed.resumed, true); assert.equal(resumed.participant.id, original.participant.id);
});

test('shared host takeover ignores old disconnects and ending clears all metadata authority', () => {
  const engine = new RoomEngine(); const a = {}, b = {};
  engine.connectHost(a); const joined = makeJoin(engine);
  engine.connectHost(b); const revision = engine.revision;
  assert.equal(engine.disconnectHost(a), false); assert.equal(engine.revision, revision);
  assert.equal(engine.isHost(b), true);
  engine.clear(); assert.equal(engine.isHost(b), false);
  assert.equal(engine.sessions.size, 0); assert.equal(engine.students().length, 0);
  assert.equal(engine.disconnect(joined.participant.id, joined.participant.connection), null);
});

test('room checkpoint serializes overlapping writes and restores revisions, capabilities and terminal file state', async () => {
  const engine = new RoomEngine(); const pending = makeJoin(engine);
  const owner = engine.approve(pending.participant.id)!.participant;
  engine.fileState.offer(owner, offer);
  let finish!: () => void;
  const saved: RoomMetadata[] = [];
  const first = engine.persist(async snapshot => { saved.push(structuredClone(snapshot)); await new Promise<void>(resolve => { finish = resolve; }); });
  await Promise.resolve(); await Promise.resolve();
  engine.fileState.revoke(owner.id, offer.fileId);
  const finalVersion = engine.revision;
  const second = engine.persist(async snapshot => { saved.push(structuredClone(snapshot)); });
  assert.equal(saved.length, 1, 'Only one physical metadata write is active');
  finish(); await Promise.all([first, second]);
  assert.equal(saved.length, 2); assert.equal(saved[0].files[0].revoked, undefined);
  assert.equal(saved[1].roomRevision, finalVersion); assert.equal(saved[1].files[0].revoked, true);
  assert.equal('connection' in saved[1].sessions[0], false);
  const restored = new RoomEngine(saved[1]);
  assert.equal(restored.revision, finalVersion); assert.equal(restored.needsPersistence, false);
  restored.restoreParticipant({}, owner.id); assert.equal(restored.students()[0].approved, true);
  assert.equal(restored.fileState.files.get(offer.fileId)?.revoked, true);
});

test('failed room checkpoints remain retryable and a subsequent save coalesces pending metadata', async () => {
  const engine = new RoomEngine(); const joined = makeJoin(engine);
  await assert.rejects(engine.persist(async () => { throw Error('Storage failed'); }), /Storage failed/);
  assert.equal(engine.needsPersistence, true);
  engine.approve(joined.participant.id);
  let writes = 0;
  const write = async (snapshot: RoomMetadata) => { writes++; assert.equal(snapshot.sessions[0].approved, true); };
  await Promise.all([engine.persist(write), engine.persist(write), engine.persist(write)]);
  assert.equal(writes, 1); assert.equal(engine.needsPersistence, false);
  await engine.persist(write); assert.equal(writes, 1);
});

test('a host can retire an offline private capability without deleting its cached manifest', () => {
  const engine = new RoomEngine(); const joined = makeJoin(engine);
  const owner = engine.approve(joined.participant.id)!.participant;
  engine.fileState.offer(owner, offer); engine.fileState.cacheProgress(offer.fileId, 4, true);
  engine.disconnect(owner.id, owner.connection);
  assert.ok(engine.reject(owner.id)); assert.equal(engine.sessions.has(owner.token), false);
  assert.equal(engine.fileState.files.get(offer.fileId)?.cachedBytes, 4);
  assert.equal(engine.approve(owner.id), null);
});

test('queued metadata cannot recreate an ended room after an older save finishes', async () => {
  const engine = new RoomEngine(); const joined = makeJoin(engine);
  let finish!: () => void; let writes = 0;
  const first = engine.persist(async () => { writes++; await new Promise<void>(resolve => { finish = resolve; }); });
  await Promise.resolve(); await Promise.resolve();
  engine.approve(joined.participant.id);
  const queued = engine.persist(async () => { writes++; });
  engine.clear(); finish(); await Promise.all([first, queued]);
  assert.equal(writes, 1);
  const result = engine.join({ connection: {}, id: 'late', name: 'late', resumeToken: undefined, newToken: 'late-token',
    autoApprove: true, hostOnline: true, now: 500 });
  assert.equal(result.kind, 'rejected');
});
