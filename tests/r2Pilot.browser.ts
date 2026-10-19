import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

test('real-device pilot: sender closes, original is verified in OPFS, preview stays local', { timeout: 90_000 }, async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const origin = process.env.BENCH_R2_ORIGIN ?? 'http://127.0.0.1:' + port;
  const token = process.env.BENCH_R2_TOKEN ?? randomBytes(32).toString('hex');
  const child = process.env.BENCH_R2_ORIGIN ? undefined : spawn(process.execPath,
    ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'benchmarks/r2/wrangler.jsonc',
      '--port', String(port), '--ip', '127.0.0.1', '--var', 'BENCH_TOKEN:' + token],
    { env: { ...process.env, BROWSER: 'none', WRANGLER_SEND_METRICS: 'false' }, stdio: 'ignore' });
  const ids: string[] = [];
  const headers = { Authorization: 'Bearer ' + token };
  const browser = await chromium.launch();
  try {
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { if ((await fetch(origin + '/health')).ok) { ready = true; break; } } catch { /* booting */ }
      await delay(100);
    }
    assert.ok(ready, 'Isolated Worker starts');
    const created = await fetch(origin + '/api/pilots', { method: 'POST', headers });
    assert.equal(created.status, 201);
    const pilot = await created.json() as { id: string; hostUrl: string };
    const hostKey = new URLSearchParams(new URL(pilot.hostUrl).hash.slice(1)).get('key')!;
    const pilotHeaders = { Authorization: 'Bearer ' + hostKey };
    const initial = await (await fetch(origin + '/api/pilots/' + pilot.id, { headers: pilotHeaders })).json() as { senderUrl: string };
    const senderContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const sender = await senderContext.newPage();
    await sender.goto(initial.senderUrl);
    await sender.getByText('Connected', { exact: true }).waitFor();
    assert.equal(new URL(sender.url()).hash, '', 'Invitation is removed from address bar');
    const fixture = randomBytes(2 * 1024 * 1024 + 101);
    await sender.getByLabel('Benchmark source').setInputFiles({ name: 'original.bin', mimeType: 'application/octet-stream', buffer: fixture });
    await sender.getByText('✓ Upload complete', { exact: true }).waitFor({ timeout: 60_000 });
    await mkdir('test-artifacts/ui', { recursive: true });
    await sender.screenshot({ path: 'test-artifacts/ui/r2-pilot-phone.png', fullPage: true });
    await senderContext.close();

    const state = await (await fetch(origin + '/api/pilots/' + pilot.id, { headers: pilotHeaders })).json() as { files: { id: string }[] };
    const id = state.files[0].id;
    ids.push(id);
    const hostContext = await browser.newContext({ viewport: { width: 1365, height: 900 }, acceptDownloads: false });
    const host = await hostContext.newPage();
    let downloads = 0;
    host.on('download', () => { downloads++; });
    await host.goto(pilot.hostUrl);
    await host.locator('[data-file-id="' + id + '"]').getByText('✓ Cached and verified', { exact: true }).waitFor({ timeout: 60_000 });
    const savedHash = await host.evaluate(async fileId => {
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('flashview-benchmark');
      const file = await (await directory.getFileHandle(fileId)).getFile();
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
        value => value.toString(16).padStart(2, '0')).join('');
    }, id);
    assert.equal(savedHash, createHash('sha256').update(fixture).digest('hex'));
    assert.equal(downloads, 0, 'Automatic receipt never generates a download');
    await host.screenshot({ path: 'test-artifacts/ui/r2-pilot-desktop.png', fullPage: true });

    // Opening and closing a verified image preview must cause no original-byte
    // network requests. Only the independent receiver fetches originals.
    const secondContext = await browser.newContext();
    const secondSender = await secondContext.newPage();
    await secondSender.goto(initial.senderUrl);
    await secondSender.getByText('Connected', { exact: true }).waitFor();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    await secondSender.getByLabel('Benchmark source').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: png });
    await secondSender.getByText('✓ Upload complete', { exact: true }).waitFor({ timeout: 60_000 });
    await host.getByRole('button', { name: 'Preview cached image' }).waitFor();
    let originalRequests = 0;
    hostContext.on('request', request => { if (/\/api\/runs\/[^/]+\/file/.test(request.url())) originalRequests++; });
    await host.getByRole('button', { name: 'Preview cached image' }).click();
    await host.getByRole('img', { name: 'pixel.png', exact: true }).waitFor();
    await host.getByRole('button', { name: 'Close preview' }).click();
    assert.equal(originalRequests, 0, 'Viewing only reads verified local cache');
    assert.equal(downloads, 0);

    // A plausible-sized but corrupt original must never become a usable cache.
    const senderKey = new URLSearchParams(new URL(initial.senderUrl).hash.slice(1)).get('key')!;
    const badOffer = await fetch(origin + '/api/pilots/' + pilot.id + '/runs', { method: 'POST',
      headers: { Authorization: 'Bearer ' + senderKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'corrupt.bin', size: 3, hashBlockBytes: 8 * 1024 * 1024, hashes: ['0'.repeat(64)] }),
    });
    assert.equal(badOffer.status, 201);
    const bad = await badOffer.json() as { id: string; token: string };
    ids.push(bad.id);
    const badHeaders = { Authorization: 'Bearer ' + bad.token };
    assert.equal((await fetch(origin + '/api/runs/' + bad.id + '/parts/1',
      { method: 'PUT', headers: badHeaders, body: Uint8Array.of(1, 2, 3) })).status, 200);
    assert.equal((await fetch(origin + '/api/runs/' + bad.id + '/complete', { method: 'POST', headers: badHeaders })).status, 200);
    const failed = host.locator('[data-file-id="' + bad.id + '"]');
    await failed.getByText('Receipt failed', { exact: true }).waitFor();
    assert.equal(await failed.getByRole('button', { name: 'Preview cached image' }).count(), 0);
    const partialExists = await host.evaluate(async fileId => {
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('flashview-benchmark');
      try { await directory.getFileHandle(fileId); return true; } catch { return false; }
    }, bad.id);
    assert.equal(partialExists, false, 'Corrupt/partial OPFS cache is removed');
    await failed.getByRole('button', { name: 'Retry receipt' }).waitFor();
    const finalState = await (await fetch(origin + '/api/pilots/' + pilot.id, { headers: pilotHeaders })).json() as { files: { id: string }[] };
    ids.push(...finalState.files.map(file => file.id).filter(fileId => fileId !== id));
    await secondContext.close();
    await hostContext.close();
  } finally {
    await browser.close();
    await Promise.allSettled(ids.map(id => fetch(origin + '/api/runs/' + id, { method: 'DELETE', headers })));
    child?.kill();
  }
});
