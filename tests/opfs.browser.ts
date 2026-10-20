import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'vite';
import { chromium, firefox } from 'playwright';
import { transferInit, transferEval, transferWait, transferWorker } from './transferHarness';
import type * as Store from '../src/client/storage/opfsStore';
import { makePdf } from './pdfFixture';
import { makePowerPointFixture } from './pptxFixture';
declare global { var __store: typeof Store; }

async function backend() {
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const child = spawn(process.execPath, process.env.FLASHVIEW_BACKEND === 'cloudflare'
    ? ['node_modules/wrangler/bin/wrangler.js', 'dev', '--name', 'warpview-opfs-' + port, '--persist-to', '.wrangler/opfs-tests/' + port, '--inspector-port', '0', '--port', String(port), '--ip', '127.0.0.1']
    : ['--import', 'tsx', 'src/server/index.ts'], { env: { ...process.env, PORT: String(port), NODE_ENV: 'test' }, stdio: 'ignore' });
  const root = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 180; i++) { try { if ((await fetch(root + '/health')).ok) return { root, child }; } catch {} await delay(100); }
  child.kill(); throw Error('OPFS test backend unavailable');
}
const engine = process.env.FLASHVIEW_BROWSER === 'firefox' ? firefox : chromium;

test('OPFS completed PDF and PowerPoint present locally after the source leaves', { timeout: 90000 }, async () => {
  const { root, child } = await backend(), browser = await engine.launch();
  const host = await browser.newPage(), phone = await browser.newPage();
  try {
    await host.goto(root + '/?storage=opfs'); await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const room = await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!));
    await phone.goto(root + '/?join=' + encodeURIComponent(room.joinToken)); await phone.locator('.student-add-fab:not([disabled])').waitFor();
    await phone.locator('input[type=file]').setInputFiles([
      { name: 'local.pdf', mimeType: 'application/pdf', buffer: makePdf(1) },
      { name: 'local.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: await makePowerPointFixture() },
    ]);
    for (const name of ['local.pdf', 'local.pptx'])
      await host.locator('.document-row').filter({ hasText: name }).locator('.cache-ring[aria-valuenow="100"]').waitFor();
    await phone.close();
    for (const name of ['local.pdf', 'local.pptx']) {
      const opening = host.waitForEvent('popup'); await host.getByRole('button', { name: 'Present ' + name, exact: true }).click();
      const viewer = await opening;
      if (name.endsWith('.pdf')) await viewer.locator('canvas[data-rendered-page="1"]').waitFor({ timeout: 45000 });
      else { await viewer.locator('.flashview-pptx-controls').waitFor({ timeout: 45000 }); assert.equal(await viewer.getByText('Slide 1 / 1').count(), 1); }
      assert.equal(await viewer.locator('.viewer-alert').count(), 0);
      await viewer.close();
    }
    await host.getByRole('button', { name: 'End room', exact: true }).click(); await host.locator('.end-check input').check();
    await host.getByRole('button', { name: 'End & clear cache', exact: true }).click(); await host.locator('.welcome').waitFor();
  } finally { await browser.close(); child.kill(); }
});

test('OPFS capability failure creates no room and does not change normal-room behavior', { timeout: 40000 }, async () => {
  const { root, child } = await backend(), browser = await engine.launch(), host = await browser.newPage();
  let creations = 0;
  host.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/rooms') creations++; });
  try {
    await transferInit(host, `Object.defineProperty(FileSystemFileHandle.prototype, 'createSyncAccessHandle', {configurable:true,value:undefined})`);
    await host.goto(root + '/?storage=opfs'); await host.getByRole('button', { name: /Create a room/ }).click();
    await host.getByRole('alert').getByText(/Private file storage is unavailable/).waitFor();
    assert.equal(creations, 0); assert.equal(await host.locator('.welcome').count(), 1);
    await host.goto(root); await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    assert.equal(creations, 1);
    assert.match(await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!).cacheId), /^generation:/);
    await host.getByRole('button', { name: 'End room', exact: true }).click(); await host.locator('.end-check input').check();
    await host.getByRole('button', { name: 'End & clear cache', exact: true }).click(); await host.locator('.welcome').waitFor();
  } finally { await browser.close(); child.kill(); }
});

test('OPFS quota recovery persists retained bytes without re-requesting or blocking a healthy file', { timeout: 60000 }, async () => {
  const { root, child } = await backend(), browser = await engine.launch();
  const host = await browser.newPage(), phone = await browser.newPage();
  try {
    await transferInit(host, `{
      const native=FileSystemFileHandle.prototype.createSyncAccessHandle;
      window.__quotaRecovered=false;window.__quotaFile='';
      FileSystemFileHandle.prototype.createSyncAccessHandle=async function(...args){
        if(this.name.endsWith('.bin')&&!window.__quotaFile)window.__quotaFile=this.name;
        const fail=this.name===window.__quotaFile, handle=await native.apply(this,args);
        return new Proxy(handle,{get(target,key){if(key==='write')return(...args)=>{if(fail&&!window.__quotaRecovered)throw new DOMException('Synthetic quota','QuotaExceededError');return target.write(...args)};
          const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}});
      };
    }`);
    await transferInit(phone, `{
      window.__quotaRequests=0;window.__quotaId='';const Native=WebSocket;
      window.WebSocket=class extends Native{constructor(...args){super(...args);this.addEventListener('message',event=>{
        if(typeof event.data!=='string')return;const m=JSON.parse(event.data);if(m.type==='range.request'){window.__quotaId ||= m.fileId;if(m.fileId===window.__quotaId)window.__quotaRequests++}
      })}};
    }`);
    await host.goto(root + '/?storage=opfs'); await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const room = await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!));
    await phone.goto(root + '/?join=' + encodeURIComponent(room.joinToken)); await phone.locator('.student-add-fab:not([disabled])').waitFor();
    await phone.locator('input[type=file]').setInputFiles({ name: 'quota-original.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(65536 + 7, 73) });
    await host.getByTestId('storage-blocked').waitFor();
    assert.equal(await host.locator('.document-row .cache-ring[aria-valuenow="100"]').count(), 0);
    await phone.locator('input[type=file]').setInputFiles({ name: 'healthy-original.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(2048, 91) });
    await host.locator('.document-row').filter({ hasText: 'healthy-original.bin' }).locator('.cache-ring[aria-valuenow="100"]').waitFor();
    const requested = Number(await transferEval(phone, 'window.__quotaRequests'));
    await transferEval(host, 'window.__quotaRecovered=true');
    await host.getByRole('button', { name: 'Retry saving', exact: true }).click();
    await host.locator('.document-row').filter({ hasText: 'quota-original.bin' }).locator('.cache-ring[aria-valuenow="100"]').waitFor();
    assert.equal(Number(await transferEval(phone, 'window.__quotaRequests')), requested);
    await host.getByRole('button', { name: 'End room', exact: true }).click(); await host.locator('.end-check input').check();
    await host.getByRole('button', { name: 'End & clear cache', exact: true }).click(); await host.locator('.welcome').waitFor();
  } finally { await browser.close(); child.kill(); }
});

test('OPFS verification finishes locally after Stop when all original bytes are already persisted', { timeout: 45000 }, async () => {
  const { root, child } = await backend(), browser = await engine.launch();
  const host = await browser.newPage({ acceptDownloads: true }), phone = await browser.newPage();
  let revoked = false;
  host.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    if (typeof payload === 'string') { const m = JSON.parse(payload); if (m.type === 'file.updated' && m.file.revoked) revoked = true; }
  }));
  try {
    await transferInit(host, `{
      const slice=File.prototype.slice;window.__holdSeal=true;window.__sealReads=[];
      File.prototype.slice=function(...args){const piece=slice.apply(this,args);if(typeof document==='undefined'&&this.name.endsWith('.bin')&&window.__holdSeal){
        const read=piece.arrayBuffer.bind(piece);piece.arrayBuffer=()=>new Promise(resolve=>window.__sealReads.push(()=>{window.__holdSeal=false;read().then(resolve)}));
      }return piece};
    }`);
    await host.goto(root + '/?storage=opfs'); await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const room = await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!));
    await phone.goto(root + '/?join=' + encodeURIComponent(room.joinToken)); await phone.locator('.student-add-fab:not([disabled])').waitFor();
    const bytes = Buffer.alloc(262144 + 7, 17);
    await phone.locator('input[type=file]').setInputFiles({ name: 'verify-after-stop.bin', mimeType: 'application/octet-stream', buffer: bytes });
    await transferWait(host, 'window.__sealReads.length>0');
    assert.equal(await host.locator('.document-row .cache-ring[aria-valuenow="100"]').count(), 0, 'Full byte count alone is not verified completion');
    await phone.getByRole('button', { name: 'Stop sharing', exact: true }).click();
    for (let i = 0; i < 100 && !revoked; i++) await delay(50);
    assert.equal(revoked, true);
    await transferEval(host, 'window.__sealReads.splice(0).forEach(release=>release())');
    await host.locator('.document-row .cache-ring[aria-valuenow="100"]').waitFor();
    const downloading = host.waitForEvent('download'); await host.getByRole('button', { name: 'Download verify-after-stop.bin' }).click();
    const { readFile } = await import('node:fs/promises');
    assert.deepEqual(await readFile((await (await downloading).path())!), bytes);
    await host.getByRole('button', { name: 'End room', exact: true }).click(); await host.locator('.end-check input').check();
    await host.getByRole('button', { name: 'End & clear cache', exact: true }).click(); await host.locator('.welcome').waitFor();
  } finally { await browser.close(); child.kill(); }
});

test('OPFS store: short writes, crash checkpoints, corruption repair, leases and cleanup fencing', { timeout: 90000 }, async t => {
  const { root, child } = await backend(), browser = await engine.launch();
  const page = await browser.newPage();
  try {
    // Bundle only for this test; no debug entrypoint or API ships in production.
    const built = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false,
      lib: { entry: 'src/client/storage/opfsStore.ts', formats: ['es'], fileName: 'opfs-test' } } });
    const output = Array.isArray(built) ? built[0] : built;
    if (!('output' in output)) throw Error('Expected test module');
    const code = output.output.find(item => item.type === 'chunk')!;
    if (!('code' in code)) throw Error('Missing test module');
    await page.goto(root);
    const waiting = page.waitForEvent('worker', { predicate: worker => worker.url().startsWith('blob:') });
    await page.evaluate(code => {
      const module = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      new Worker(URL.createObjectURL(new Blob(['import * as store from ' + JSON.stringify(module) + ';globalThis.__store=store;'], { type: 'text/javascript' })), { type: 'module' });
    }, code.code);
    const worker = await waiting;
    for (let i = 0; i < 100 && !await worker.evaluate('!!globalThis.__store'); i++) await delay(50);
    assert.equal(await worker.evaluate('!!globalThis.__store'), true, 'Test-only store module must initialize');
    await worker.evaluate('globalThis.__name = value => value');
    const result = await worker.evaluate(async () => {
      const store = globalThis.__store, room = 'opfs:' + crypto.randomUUID();
      const bytes = new Uint8Array(4 * 65536 + 7); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 29) % 251;
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
      const file = { fileId: 'original-123', name: 'synthetic.bin', ownerId: 'sender', ownerName: 'Sender', status: 'approved' as const, size: bytes.length, sha256: hash };
      const handlePrototype = FileSystemFileHandle.prototype as unknown as { createSyncAccessHandle: (...args: unknown[]) => Promise<any> };
      const native = handlePrototype.createSyncAccessHandle;
      // Every write is deliberately short, even though it succeeds.
      handlePrototype.createSyncAccessHandle = async function(...args) {
        const handle = await native.apply(this, args);
        return new Proxy(handle, { get(target, property) {
          if (property === 'write') return (data: Uint8Array, options: { at: number }) => target.write(data.subarray(0, 4093), options);
          const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
        } });
      };
      await store.prepareOriginal(room, file);
      const save = (index: number) => store.saveOriginalBlock(room, file.fileId, index, bytes.slice(index * 65536, Math.min(bytes.length, (index + 1) * 65536)));
      await Promise.all(Array.from({ length: 5 }, (_, i) => save(i)));
      const committed = [...await store.originalIndices(room, file.fileId)];
      const sealed = await store.sealOriginal(room, file, () => true);
      let lease = await new store.CompletedFileStore().acquire(room, file);
      if (!lease) throw Error('Completed original missing');
      const exact = new Uint8Array(await lease.file.arrayBuffer()).every((value, i) => value === bytes[i]);
      lease.release();
      const directory = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('warpview-originals-v1')).getDirectoryHandle(room.slice(5));
      const disk = await (await directory.getFileHandle(file.fileId + '.bin') as any).createSyncAccessHandle();
      disk.write(new Uint8Array([99]), { at: 65536 + 17 }); disk.flush(); disk.close();
      const repaired = [...await store.originalIndices(room, file.fileId)];
      const refused = await new store.CompletedFileStore().acquire(room, file) === null;
      await save(1); const resealed = await store.sealOriginal(room, file, () => true);
      // Simulate bytes flushed just before a crash/failed metadata transaction.
      const partialRoom = 'opfs:' + crypto.randomUUID(); await store.prepareOriginal(partialRoom, file);
      const abort = new AbortController();
      handlePrototype.createSyncAccessHandle = async function(...args) {
        const handle = await native.apply(this, args);
        return new Proxy(handle, { get(target, property) {
          if (property === 'flush') return () => { target.flush(); abort.abort(); };
          const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
        } });
      };
      let cancelled = false;
      try { await store.saveOriginalBlock(partialRoom, file.fileId, 0, bytes.slice(0, 65536), abort.signal); } catch { cancelled = true; }
      handlePrototype.createSyncAccessHandle = native;
      const afterCrash = [...await store.originalIndices(partialRoom, file.fileId)];
      // Valid per-block checkpoints cannot substitute for the pinned whole-file root.
      const wrongRootRoom = 'opfs:' + crypto.randomUUID(), wrongRoot = { ...file, sha256: '0'.repeat(64) };
      await store.prepareOriginal(wrongRootRoom, wrongRoot);
      await Promise.all(Array.from({ length: 5 }, (_, index) => store.saveOriginalBlock(wrongRootRoom, file.fileId, index,
        bytes.slice(index * 65536, Math.min(bytes.length, (index + 1) * 65536)))));
      const rootRefused = !await store.sealOriginal(wrongRootRoom, wrongRoot, () => true) &&
        (await store.originalIndices(wrongRootRoom, file.fileId)).size === 0 &&
        await new store.CompletedFileStore().acquire(wrongRootRoom, wrongRoot) === null;
      await store.deleteOriginalRoom(wrongRootRoom);
      lease = await new store.CompletedFileStore().acquire(room, file); if (!lease) throw Error('Repaired original missing');
      let deleted = false; const deleting = store.deleteOriginalRoom(room).then(() => { deleted = true; });
      await new Promise(resolve => setTimeout(resolve, 100)); const waitedForReader = !deleted;
      lease.release(); await deleting;
      let fenced = false;
      try { await store.prepareOriginal(room, file); } catch { fenced = true; }
      await store.deleteOriginalRoom(partialRoom);
      return { committed, sealed, exact, repaired, refused, resealed, cancelled, afterCrash, rootRefused, waitedForReader, fenced };
    });
    assert.equal(result.committed.length, 5); assert.ok(result.sealed && result.exact);
    assert.equal(result.repaired.length, 4); assert.ok(!result.repaired.includes(1));
    assert.ok(result.refused && result.resealed); assert.ok(result.cancelled); assert.equal(result.afterCrash.length, 0);
    assert.ok(result.rootRefused);
    assert.ok(result.waitedForReader && result.fenced);
    t.diagnostic(JSON.stringify({ browser: browser.version(), ...result }));
  } finally { await browser.close(); child.kill(); }
});

test('OPFS relay: source integrity, worker restart, exact completed export and generation-scoped cleanup', { timeout: 90000 }, async t => {
  const { root, child } = await backend(), browser = await engine.launch();
  const host = await browser.newPage({ acceptDownloads: true }), phone = await browser.newPage();
  const mib = Number(process.env.OPFS_TEST_MIB ?? 20);
  assert.ok(Number.isInteger(mib) && mib >= 1 && mib <= 200);
  const size = mib * 1024 * 1024 - 7, expectedHash = createHash('sha256');
  const fixture = resolve('test-artifacts/opfs-original-' + crypto.randomUUID() + '.bin');
  await mkdir(resolve('test-artifacts'), { recursive: true });
  const writer = await open(fixture, 'wx'), block = Buffer.alloc(1024 * 1024, 113);
  try {
    for (let offset = 0; offset < size; offset += block.length) {
      const part = block.subarray(0, Math.min(block.length, size - offset));
      await writer.write(part); expectedHash.update(part);
    }
  } finally { await writer.close(); }
  const expected = expectedHash.digest('hex');
  try {
    await transferInit(phone, `{
      const Native = WebSocket;window.__requested = 0;window.__corruptOnce = true;window.__largestRead = 0;
      const nativeRead=Blob.prototype.arrayBuffer;Blob.prototype.arrayBuffer=function(){window.__largestRead=Math.max(window.__largestRead,this.size);return nativeRead.call(this)};
      window.WebSocket = class extends Native {
        send(data) { if(window.__corruptOnce && data instanceof ArrayBuffer) { window.__corruptOnce=false;data=data.slice(0);const bytes=new Uint8Array(data);bytes[bytes.length-1]^=1; } return super.send(data); }
        constructor(...args) { super(...args);this.addEventListener('message',event=>{if(typeof event.data==='string'&&JSON.parse(event.data).type==='range.request')window.__requested++})}
      };
    }`);
    await host.goto(root + '/?storage=opfs'); await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const room = await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!));
    assert.match(room.cacheId, /^opfs:/);
    await phone.goto(root + '/?join=' + encodeURIComponent(room.joinToken));
    await phone.locator('.student-add-fab:not([disabled])').waitFor();
    const started = performance.now();
    await phone.locator('input[type=file]').setInputFiles(fixture);
    await host.locator('.document-row .cache-ring[aria-valuenow="100"]').waitFor({ timeout: 45000 });
    const cachedMs = Math.round(performance.now() - started);
    const requests = Number(await transferEval(phone, 'window.__requested'));
    assert.ok(requests > Math.ceil(size / 262144), 'A corrupted range must be rejected and requested again');
    assert.ok(Number(await transferEval(phone, 'window.__largestRead')) <= 1024 * 1024, 'Source hashing and transfer reads must remain bounded');
    // Rebuild from committed OPFS checkpoints after losing the original worker.
    await (await transferWorker(host)).evaluate(() => { setTimeout(() => { throw Error('Synthetic OPFS worker failure'); }, 0); });
    await host.locator('.connection.connected').waitFor({ timeout: 15000 });
    await host.reload(); await host.locator('.connection.connected').waitFor();
    await host.locator('.document-row .cache-ring[aria-valuenow="100"]').waitFor();
    assert.equal(Number(await transferEval(phone, 'window.__requested')), requests, 'Committed originals must not be re-requested after restart');
    const downloading = host.waitForEvent('download'); await host.getByRole('button', { name: 'Download ' + fixture.split(/[\\/]/).at(-1) }).click();
    const exportedHash = createHash('sha256');
    for await (const part of createReadStream((await (await downloading).path())!)) exportedHash.update(part);
    assert.equal(exportedHash.digest('hex'), expected);
    await host.getByRole('button', { name: 'End room', exact: true }).click(); await host.locator('.end-check input').check();
    await host.getByRole('button', { name: 'End & clear cache', exact: true }).click(); await host.locator('.welcome').waitFor();
    const removed = await host.evaluate(async room => {
      try { await (await (await navigator.storage.getDirectory()).getDirectoryHandle('warpview-originals-v1')).getDirectoryHandle(room.slice(5)); return false; }
      catch (error) { return (error as DOMException).name === 'NotFoundError'; }
    }, room.cacheId);
    assert.equal(removed, true); t.diagnostic(JSON.stringify({ browser: browser.version(), mib, cachedMs, requests, injectedCorruption: true, sha256Matched: true }));
  } finally { await browser.close(); child.kill(); await unlink(fixture); }
});
