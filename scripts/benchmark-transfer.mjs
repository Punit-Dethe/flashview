import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
// Synthetic original bytes only; public mode creates and ends temporary rooms.
// Includes automated file selection + transfer + cache/UI completion. Hashing is
// measured separately from that interval and must succeed on every repetition.
const target = process.env.BENCH_TARGET ?? 'node';
const mib = Number(process.env.BENCH_MIB ?? 20);
const repeats = Number(process.env.BENCH_RUNS ?? 3);
const diagnostic = process.env.BENCH_DIAGNOSTICS === '1';
assert.ok(['node', 'cloudflare', 'public'].includes(target), 'BENCH_TARGET must be node, cloudflare or public');
assert.ok(Number.isInteger(mib) && mib >= 1 && mib <= 45, 'BENCH_MIB must be 1–45 (in-memory automation fixture limit)');
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10, 'BENCH_RUNS must be 1–10');
let child;
let origin = 'https://flashview.outlanderwatr.workers.dev';
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
    let began;
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
      await host.goto(origin + (diagnostic ? '/?perf=1' : ''));
      const start = performance.now();
      await host.getByRole('button', { name: /Create a room/ }).click();
      await host.locator('.connection.connected').waitFor();
      room = await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')));
      const roomReadyMs = Math.round(performance.now() - start);
      await phone.goto(origin + '/?join=' + encodeURIComponent(room.joinToken) + (diagnostic ? '&perf=1' : ''));
      await phone.locator('.student-add-fab:not([disabled])').waitFor();
      began = performance.now();
      await phone.locator('input[type=file]').setInputFiles({ name: 'speed-original.bin', mimeType: 'application/octet-stream', buffer: bytes });
      const selectionMs = Math.round(performance.now() - began);
      await host.locator('.document-row .cache-ring[aria-valuenow="100"]').waitFor({ timeout: 60000 });
      const cachedMs = Math.round(performance.now() - began);
      const digest = await host.evaluate(async room => {
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
      runs.push({ roomReadyMs, selectionMs, cachedMs, mibPerSecond: +(mib / (cachedMs / 1000)).toFixed(2), sha256Matched: true, ...(diagnostics ? { diagnostics } : {}) });
    } finally {
      if (room) { const ended = await fetch(origin + '/api/rooms/' + room.roomId + '/end', { method: 'POST', headers: { Authorization: 'Bearer ' + room.hostToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ roomGeneration: room.roomGeneration }) }); assert.ok(ended.ok); }
      await context.close();
    }
  }
  const sorted = runs.map(run => run.cachedMs).sort((a, b) => a - b);
  const medianMs = sorted[Math.floor((sorted.length - 1) / 2)];
  const result = { target, bytes: bytes.length, runs, medianMs, browserVersion: browser.version(), nodeVersion: process.version,
    note: 'Synthetic desktop Chromium, original browser cache verified; selection/transfer/cache/UI timing, hash excluded. Not a physical-phone, campus or pure network throughput benchmark.' };
  const resultPath = process.env.BENCH_RESULT ?? 'test-artifacts/transfer-speed-' + target + '.json';
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally {
  await browser.close();
  if (child) { if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else child.kill(); }
}
