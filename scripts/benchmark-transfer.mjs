import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
// Synthetic original bytes only; public mode creates and ends temporary rooms.
// Includes automated selection + transfer + cache/UI completion and selected
// production integrity work. Independent post-completion hashing is excluded.
const target = process.env.BENCH_TARGET ?? 'node';
const mib = Number(process.env.BENCH_MIB ?? 20);
const repeats = Number(process.env.BENCH_RUNS ?? 3);
const diagnostic = process.env.BENCH_DIAGNOSTICS === '1';
// Run with node --import tsx when enabling the test-only worker trace.
const workerTrace = process.env.BENCH_WORKER_TRACE === '1' ? await import('../tests/transferTrace.ts') : null;
const storage = process.env.BENCH_STORAGE ?? 'idb';
assert.ok(['idb', 'opfs'].includes(storage), 'BENCH_STORAGE must be idb or opfs');
assert.ok(['node', 'cloudflare', 'public'].includes(target), 'BENCH_TARGET must be node, cloudflare or public');
assert.ok(Number.isInteger(mib) && mib >= 1 && mib <= 45, 'BENCH_MIB must be 1–45 (in-memory automation fixture limit)');
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10, 'BENCH_RUNS must be 1–10');
let child;
let origin = process.env.BENCH_ORIGIN ?? 'https://flashview.outlanderwatr.workers.dev';
if (target === 'public') {
  const address = new URL(origin);
  assert.equal(address.protocol, 'https:', 'Public benchmark requires HTTPS');
  assert.ok(!address.username && !address.password && address.pathname === '/' && !address.search && !address.hash,
    'BENCH_ORIGIN must be an origin without credentials, path or query');
  origin = address.origin;
}
const browser = await chromium.launch({ headless: true });
const bytes = randomBytes(mib * 1024 * 1024);
const expected = createHash('sha256').update(bytes).digest('hex');
const runs = [];
try {
  if (target !== 'public') {
    const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port; await new Promise(resolve => server.close(resolve));
    origin = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, target === 'cloudflare' ? ['node_modules/wrangler/bin/wrangler.js', 'dev', '--name', 'warpview-speed-' + port, '--persist-to', '.wrangler/speed-state/' + port, '--inspector-port', '0', '--port', String(port), '--ip', '127.0.0.1'] : ['--import', 'tsx', 'src/server/index.ts'], { env: { ...process.env, PORT: String(port), NODE_ENV: 'test', BROWSER: 'none' }, stdio: 'ignore' });
    let ready = false;
    for (let i = 0; i < 180; i++) { try { if ((await fetch(origin + '/health')).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.ok(ready, 'Backend ready');
  }
  for (let i = 0; i < repeats; i++) {
    const context = await browser.newContext();
    const host = await context.newPage(); const phone = await context.newPage();
    let began, beganEpoch;
    if (workerTrace) { await workerTrace.installTrace(host); await workerTrace.installTrace(phone); }
    const ranges = new Map(), events = [];
    if (diagnostic) for (const [side, page] of [['host', host], ['phone', phone]]) page.on('websocket', socket => {
      for (const direction of ['framesent', 'framereceived']) socket.on(direction, ({ payload }) => {
        if (began === undefined) return;
        try {
          const ms = Math.round(performance.now() - began);
          if (typeof payload === 'string') {
            const message = JSON.parse(payload);
            if (message.type === 'range.request') {
              const range = ranges.get(message.requestId) ?? {};
              range[side === 'host' ? 'requestedAt' : 'sourceReceivedAt'] = ms; ranges.set(message.requestId, range);
            } else if (/^(error|range.error|file\.|join\.)/.test(message.type) && events.length < 100)
              events.push({ side, direction, type: message.type, ms, code: message.code, reason: message.type === 'range.error' ? message.message : undefined });
          } else {
            const size = payload.readUInt16BE(0), header = JSON.parse(payload.subarray(2, 2 + size).toString());
            const range = ranges.get(header.requestId) ?? {};
            range[side === 'phone' ? 'sourceSentAt' : 'receivedAt'] = ms; ranges.set(header.requestId, range);
          }
        } catch { /* Diagnostics never affect transfer success. */ }
      });
    });
    let room;
    try {
      const hostUrl = new URL(origin);
      if (diagnostic) hostUrl.searchParams.set('perf', '1');
      if (storage === 'opfs') hostUrl.searchParams.set('storage', 'opfs');
      await host.goto(hostUrl.href);
      const start = performance.now();
      await host.getByRole('button', { name: /Create a room/ }).click();
      await host.locator('.connection.connected').waitFor();
      room = await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')));
      const roomReadyMs = Math.round(performance.now() - start);
      await phone.goto(origin + '/?join=' + encodeURIComponent(room.joinToken) + (diagnostic ? '&perf=1' : ''));
      await phone.locator('.student-add-fab:not([disabled])').waitFor();
      began = performance.now(); beganEpoch = Date.now();
      await phone.locator('input[type=file]').setInputFiles({ name: 'speed-original.bin', mimeType: 'application/octet-stream', buffer: bytes });
      const selectionMs = Math.round(performance.now() - began);
      await host.locator('.document-row .cache-ring[aria-valuenow="100"]').waitFor({ timeout: 60000 });
      const cachedMs = Math.round(performance.now() - began);
      const digest = await host.evaluate(async room => {
        if (room.startsWith('opfs:')) {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('warpview-originals-v1');
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
          });
          const records = await new Promise((resolve, reject) => {
            const request = db.transaction('files').objectStore('files').index('room').getAll(room);
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
          });
          db.close();
          if (records.length !== 1 || !records[0].sealed) throw Error('Original is not sealed');
          const directory = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('warpview-originals-v1')).getDirectoryHandle(room.slice(5));
          const file = await (await directory.getFileHandle(records[0].fileId + '.bin')).getFile();
          return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), value => value.toString(16).padStart(2, '0')).join('');
        }
        const request = indexedDB.open('flashview-room-cache');
        const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        const records = await new Promise((resolve, reject) => { const request = db.transaction('chunks', 'readonly').objectStore('chunks').index('room').getAll(room); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        db.close(); records.sort((a, b) => a.index - b.index);
        const all = new Uint8Array(records.reduce((sum, row) => sum + row.data.byteLength, 0));
        let offset = 0; for (const row of records) { all.set(new Uint8Array(row.data), offset); offset += row.data.byteLength; }
        return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', all)), value => value.toString(16).padStart(2, '0')).join('');
      }, room.cacheId ?? room.code);
      assert.equal(digest, expected);
      let diagnostics;
      if (diagnostic) {
        const timing = [...ranges.values()].map(range => ({ ...range, totalMs: range.receivedAt - range.requestedAt,
          sourceMs: range.sourceSentAt - range.sourceReceivedAt, downlinkMs: range.receivedAt - range.sourceSentAt }));
        const metrics = await Promise.all([host, phone].map(page => page.evaluate(() => window.__flashviewPerf?.snapshot().summary)));
        diagnostics = { events, requestCount: ranges.size, unfinishedRequests: timing.filter(range => range.receivedAt === undefined).length,
          slowestRanges: timing.filter(range => Number.isFinite(range.totalMs)).sort((a,b) => b.totalMs-a.totalMs).slice(0, 3), hostMetrics: metrics[0], sourceMetrics: metrics[1] };
      }
      const trace = workerTrace ? await workerTrace.readTrace(host, phone, beganEpoch) : undefined;
      if (trace) assert.ok(trace.requestCount > 0, 'Worker trace must observe the actual transfer owner');
      runs.push({ roomReadyMs, selectionMs, cachedMs, mibPerSecond: +(mib / (cachedMs / 1000)).toFixed(2), sha256Matched: true,
        ...(diagnostics ? { diagnostics } : {}), ...(trace ? { workerTrace: trace } : {}) });
    } finally {
      if (room) { const ended = await fetch(origin + '/api/rooms/' + room.roomId + '/end', { method: 'POST', headers: { Authorization: 'Bearer ' + room.hostToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ roomGeneration: room.roomGeneration }) }); assert.ok(ended.ok); }
      await context.close();
    }
  }
  const sorted = runs.map(run => run.cachedMs).sort((a, b) => a - b);
  const medianMs = sorted[Math.floor((sorted.length - 1) / 2)];
  const result = { target, storage, bytes: bytes.length, runs, medianMs, browserVersion: browser.version(), nodeVersion: process.version,
    note: 'Synthetic desktop Chromium; selection/transfer/cache/UI timing includes production OPFS integrity work when selected. Independent post-transfer hash excluded. Not a physical-phone, campus or pure network throughput benchmark.' };
  const resultPath = process.env.BENCH_RESULT ?? 'test-artifacts/transfer-speed-' + target + '.json';
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally {
  await browser.close();
  if (child) { if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else child.kill(); }
}
