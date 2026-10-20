import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomFileEngine, persistRoomFiles, type FileTransition } from '../src/shared/roomFileEngine';
import type { FileManifest } from '../src/shared/protocol';
const owner = { id: 'owner-a', name: 'Alice', approved: true };
const offer = { fileId: 'original-file', name: 'original.bin', size: 4 };
function offered(engine: RoomFileEngine): FileTransition {
  const result = engine.offer(owner, offer);
  assert.notEqual(result.kind, 'rejected');
  if (result.kind === 'rejected') assert.fail(result.message);
  return result;
}

test('file engine reserves once and reconciles a delayed announcement after terminal Stop', () => {
  const engine = new RoomFileEngine();
  const announced = offered(engine);
  const initialSnapshot = structuredClone(announced.file);
  const stopped = engine.revoke(owner.id, offer.fileId)!;
  assert.equal(stopped.file.revision, 2);
  assert.deepEqual(announced.file, initialSnapshot, 'Later commands must not mutate a pending persistence snapshot');
  const stale = engine.effects(announced);
  assert.deepEqual(stale.map(effect => effect.message.type), ['file.state']);
  assert.equal((stale[0].message.file as FileManifest).revoked, true);
  assert.equal(stale.some(effect => effect.message.type === 'file.approved'), false);
  const replay = offered(engine);
  assert.equal(replay.changed, false); assert.equal(replay.file.revoked, true); assert.equal(replay.file.revision, 2);
  assert.equal(engine.files.size, 1);
  const duplicate = engine.revoke(owner.id, offer.fileId)!;
  assert.equal(duplicate.changed, false); assert.equal(duplicate.file.revision, 2);
  assert.equal(engine.revoke('another-owner', offer.fileId), null);
});

test('completion is idempotent, invalid progress is inert, and delayed completion cannot undo a cache-loss reset', () => {
  const engine = new RoomFileEngine(); offered(engine);
  for (const [bytes, snapshot] of [[2, true], [5, true], [-1, true], [0, false], ['4', true]])
    assert.equal(engine.cacheProgress(offer.fileId, bytes, snapshot), null);
  const done = engine.cacheProgress(offer.fileId, 4, false)!;
  assert.deepEqual(engine.effects(done).map(effect => effect.to), ['owner', 'actor']);
  const duplicate = engine.cacheProgress(offer.fileId, 4, false)!;
  assert.equal(duplicate.changed, false);
  assert.deepEqual(engine.effects(duplicate).map(effect => effect.message.type), ['cache.progress.receipt']);
  const reset = engine.cacheProgress(offer.fileId, 0, true)!;
  assert.equal(reset.file.revision, 3); assert.equal(done.file.cachedBytes, 4);
  assert.deepEqual(engine.effects(done), [], 'An old awaited completion cannot send false Done/receipt after reset');
  assert.deepEqual(engine.effects(duplicate), []);
  const notices = engine.effects(reset);
  assert.equal(notices.length, 1); assert.equal(notices[0].message.bytes, 0); assert.equal(notices[0].message.complete, false);
});

test('late disconnect effects cannot mark a resumed file offline, including after metadata restoration', () => {
  const engine = new RoomFileEngine(); offered(engine);
  const disconnected = engine.ownerStatus(owner.id, 'disconnect');
  const persisted = structuredClone([...engine.files.values()]);
  const resumed = engine.ownerStatus(owner.id, 'resume', true);
  assert.equal(resumed[0].file.revision, 3);
  assert.deepEqual(engine.effects(disconnected[0]), []);
  assert.equal((engine.effects(resumed[0])[0].message.file as FileManifest).status, 'approved');
  const restored = new RoomFileEngine(persisted);
  persisted[0].status = 'rejected';
  assert.equal(restored.files.get(offer.fileId)?.status, 'offline', 'Restoration owns its metadata');
  assert.equal(restored.ownerStatus(owner.id, 'resume')[0].file.revision, 3);
  const replay = offered(restored); assert.equal(replay.changed, false); assert.equal(replay.file.revision, 3);
});

test('legacy approval/resume cannot resurrect revoked records or mutate another owner', () => {
  const legacy: FileManifest[] = [
    { ...offer, ownerId: owner.id, ownerName: owner.name, status: 'pending', revoked: true },
    { ...offer, fileId: 'pending-legacy', ownerId: owner.id, ownerName: owner.name, status: 'pending' },
    { ...offer, fileId: 'another-file', ownerId: 'other-owner', ownerName: 'Bob', status: 'offline', revision: 7 },
  ];
  const engine = new RoomFileEngine(legacy);
  assert.deepEqual(engine.ownerStatus(owner.id, 'approve').map(change => change.file.fileId), ['pending-legacy']);
  assert.equal(engine.files.get('pending-legacy')?.revision, 1);
  engine.ownerStatus(owner.id, 'disconnect'); engine.ownerStatus(owner.id, 'resume', false);
  assert.equal(engine.files.get('pending-legacy')?.status, 'pending');
  assert.equal(engine.files.get(offer.fileId)?.revoked, true);
  assert.equal(engine.files.get(offer.fileId)?.status, 'pending');
  assert.equal(engine.files.get('another-file')?.revision, 7);
  assert.equal(engine.offer({ ...owner, approved: false }, offer).kind, 'rejected');
});

test('ending a room discards delayed file effects rather than resurrecting cleared metadata', () => {
  const engine = new RoomFileEngine(); const transition = offered(engine);
  const progress = engine.cacheProgress(offer.fileId, 4, true)!;
  engine.clear();
  assert.deepEqual(engine.effects(transition), []); assert.deepEqual(engine.effects(progress), []);
  assert.equal(engine.files.size, 0);
});

test('a failed metadata write cannot turn duplicate offers or completion into a persistence shortcut', async () => {
  const engine = new RoomFileEngine(); offered(engine);
  let attempts = 0;
  const saved: FileManifest[][] = [];
  const store = async (files: FileManifest[]) => {
    attempts++;
    if (attempts === 1 || attempts === 3) throw Error('Temporary metadata failure');
    saved.push(structuredClone(files));
  };
  await assert.rejects(persistRoomFiles(engine, store), /Temporary metadata failure/);
  assert.equal(engine.needsPersistence, true);
  const replay = offered(engine); assert.equal(replay.changed, false);
  await persistRoomFiles(engine, store);
  assert.equal(attempts, 2); assert.equal(engine.needsPersistence, false);
  const done = engine.cacheProgress(offer.fileId, 4, true)!;
  await assert.rejects(persistRoomFiles(engine, store), /Temporary metadata failure/);
  const duplicate = engine.cacheProgress(offer.fileId, 4, true)!;
  assert.equal(duplicate.changed, false);
  await persistRoomFiles(engine, store);
  assert.equal(attempts, 4); assert.equal(saved[1][0].cachedBytes, 4);
  await persistRoomFiles(engine, store);
  assert.equal(attempts, 4, 'Already committed exact retries do no extra storage work');
  assert.equal(engine.effects(done).some(effect => effect.message.type === 'cache.progress.receipt'), true);
});

test('an older successful save does not confirm mutations that happened while it was pending', async () => {
  const engine = new RoomFileEngine(); offered(engine);
  let finish!: () => void;
  let saved!: FileManifest[];
  const pending = persistRoomFiles(engine, async files => {
    saved = files; await new Promise<void>(resolve => { finish = resolve; });
  });
  engine.revoke(owner.id, offer.fileId);
  assert.equal(saved[0].revoked, undefined);
  finish(); await pending;
  assert.equal(engine.needsPersistence, true);
  await persistRoomFiles(engine, async files => { assert.equal(files[0].revoked, true); });
  assert.equal(engine.needsPersistence, false);
});
