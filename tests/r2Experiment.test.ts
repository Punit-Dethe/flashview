import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Opt-in: keep the ordinary unit suite fast; run with npm run test:r2.
test('isolated R2 experiment: authentication, multipart receipts, exact bytes and terminal cleanup', {
  skip: process.env.FLASHVIEW_TEST_R2 !== '1', timeout: 60_000,
}, async () => {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const token = randomBytes(32).toString('hex');
  const origin = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev',
    '--config', 'benchmarks/r2/wrangler.jsonc', '--port', String(port), '--ip', '127.0.0.1',
    '--var', 'BENCH_TOKEN:' + token], { env: { ...process.env, BROWSER: 'none', WRANGLER_SEND_METRICS: 'false' } });
  let log = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', data => { log = (log + data).slice(-2000); });
  const headers = { Authorization: 'Bearer ' + token };
  const ids: string[] = [];
  try {
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) break;
      try { if ((await fetch(origin + '/health')).ok) { ready = true; break; } } catch { /* starting */ }
      await delay(100);
    }
    assert.ok(ready, 'R2 emulator startup: ' + log);
    const denied = await fetch(origin + '/api/runs', { method: 'POST', body: '{}' });
    assert.equal(denied.status, 401);
    const partBytes = 8 * 1024 * 1024;
    const original = randomBytes(partBytes + 137);
    const created = await fetch(origin + '/api/runs', {
      method: 'POST', headers, body: JSON.stringify({ size: original.length, partBytes }),
    });
    assert.equal(created.status, 201);
    const { id } = await created.json() as { id: string };
    ids.push(id);
    const base = origin + '/api/runs/' + id;
    assert.equal((await fetch(base + '/file', { headers })).status, 409);
    assert.equal((await fetch(base + '/complete', { method: 'POST', headers })).status, 409);
    const parts = await Promise.all([1, 2].map(part => fetch(base + '/parts/' + part, {
      method: 'PUT', headers, body: original.subarray((part - 1) * partBytes, part * partBytes),
    })));
    assert.deepEqual(parts.map(part => part.status), [200, 200]);
    assert.match(parts[0].headers.get('Server-Timing') ?? '', /authorize;dur=.*storage_and_body;dur=.*receipt;dur=/,
      'Live diagnostics separate control, streaming/storage, and receipt');
    const complete = await fetch(base + '/complete', { method: 'POST', headers });
    assert.equal(complete.status, 200);
    assert.equal((await complete.json() as { size: number }).size, original.length);
    assert.equal((await fetch(base + '/complete', { method: 'POST', headers })).status, 200,
      'A lost completion response must be safe to retry');
    const read = await fetch(base + '/file', { headers });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('Content-Disposition'), null, 'Automatic receipt is fetch-to-cache');
    const received = Buffer.from(await read.arrayBuffer());
    assert.equal(createHash('sha256').update(received).digest('hex'),
      createHash('sha256').update(original).digest('hex'));
    assert.equal((await fetch(base + '/parts/1', { method: 'PUT', headers, body: original.subarray(0, partBytes) })).status, 409,
      'A completed file cannot be overwritten');
    assert.equal((await fetch(base, { method: 'DELETE', headers })).status, 204);
    assert.equal((await fetch(base + '/file', { headers })).status, 409);
    assert.equal((await fetch(base + '/complete', { method: 'POST', headers })).status, 409);
    assert.equal((await fetch(base, { method: 'DELETE', headers })).status, 204, 'Cleanup is repeatable');

    const small = await fetch(origin + '/api/runs', {
      method: 'POST', headers, body: JSON.stringify({ size: 20, partBytes }),
    });
    const smallId = (await small.json() as { id: string }).id;
    ids.push(smallId);
    const smallBase = origin + '/api/runs/' + smallId;
    assert.equal((await fetch(smallBase + '/parts/1', { method: 'PUT', headers, body: randomBytes(21) })).status, 409,
      'The actual stream cannot exceed its reserved length');
    assert.equal((await fetch(smallBase + '/complete', { method: 'POST', headers })).status, 409);

    const segmented = await fetch(origin + '/api/runs', {
      method: 'POST', headers, body: JSON.stringify({ size: original.length, partBytes, layout: 'segments',
        partHashes: [original.subarray(0, partBytes), original.subarray(partBytes)]
          .map(bytes => createHash('sha256').update(bytes).digest('hex')) }),
    });
    assert.equal(segmented.status, 201);
    const segmentId = (await segmented.json() as { id: string }).id;
    ids.push(segmentId);
    const segmentBase = origin + '/api/runs/' + segmentId;
    assert.equal((await fetch(segmentBase + '/parts/1', {
      method: 'PUT', headers, body: original.subarray(0, partBytes),
    })).status, 200);
    assert.equal((await fetch(segmentBase + '/file?part=1', { headers })).status, 200,
      'Transfer-only pipeline can receive committed bytes before the file finishes uploading');
    assert.equal((await fetch(segmentBase + '/file?part=2', { headers })).status, 409);
    assert.equal((await fetch(segmentBase + '/complete', { method: 'POST', headers })).status, 409);
    const badTail = Buffer.from(original.subarray(partBytes));
    badTail[0] ^= 1;
    assert.equal((await fetch(segmentBase + '/parts/2', { method: 'PUT', headers, body: badTail })).status, 409,
      'Storage must reject same-length corrupt segment bytes');
    assert.equal((await fetch(segmentBase + '/parts/2', {
      method: 'PUT', headers, body: original.subarray(partBytes),
    })).status, 200);
    assert.equal((await fetch(segmentBase + '/complete', { method: 'POST', headers })).status, 200);

    const invitation = await fetch(origin + '/api/pilots', { method: 'POST', headers });
    assert.equal(invitation.status, 201);
    const invited = await invitation.json() as { id: string; hostUrl: string };
    const hostKey = new URLSearchParams(new URL(invited.hostUrl).hash.slice(1)).get('key')!;
    const hostHeaders = { Authorization: 'Bearer ' + hostKey };
    const pilotBase = origin + '/api/pilots/' + invited.id;
    const hostState = await (await fetch(pilotBase, { headers: hostHeaders })).json() as { senderUrl: string; files: unknown[] };
    assert.equal(hostState.files.length, 0);
    const senderKey = new URLSearchParams(new URL(hostState.senderUrl).hash.slice(1)).get('key')!;
    const senderHeaders = { Authorization: 'Bearer ' + senderKey, 'Content-Type': 'application/json' };
    const offeredBytes = Buffer.from('real-device pilot bytes');
    const metadata = { name: 'example.txt', size: offeredBytes.length, hashBlockBytes: 8 * 1024 * 1024,
      hashes: [createHash('sha256').update(offeredBytes).digest('hex')] };
    assert.equal((await fetch(pilotBase + '/runs', { method: 'POST', headers: hostHeaders, body: '{}' })).status, 403,
      'Host invitation cannot upload or create files');
    assert.equal((await fetch(origin + '/api/runs', { method: 'POST', headers: senderHeaders, body: '{}' })).status, 401,
      'Invitation cannot use unbounded owner admission');
    const offer = await fetch(pilotBase + '/runs', { method: 'POST', headers: senderHeaders, body: JSON.stringify(metadata) });
    assert.equal(offer.status, 201);
    const offered = await offer.json() as { id: string; token: string };
    ids.push(offered.id);
    const offeredBase = origin + '/api/runs/' + offered.id;
    const writerHeaders = { Authorization: 'Bearer ' + offered.token };
    const snapshot = await (await fetch(pilotBase, { headers: hostHeaders })).json() as { files: { token: string }[] };
    const readerHeaders = { Authorization: 'Bearer ' + snapshot.files[0].token };
    assert.equal((await fetch(offeredBase + '/parts/1', { method: 'PUT', headers: readerHeaders, body: offeredBytes })).status, 401,
      'Read invitation cannot change original bytes');
    assert.equal((await fetch(base + '/file', { headers: readerHeaders })).status, 401, 'Capability is scoped to one original');
    assert.equal((await fetch(offeredBase, { method: 'DELETE', headers: writerHeaders })).status, 401,
      'Sender cannot delete a test original behind the host');
    assert.equal((await fetch(offeredBase + '/parts/1', { method: 'PUT', headers: writerHeaders, body: offeredBytes })).status, 200);
    assert.equal((await fetch(offeredBase + '/complete', { method: 'POST', headers: writerHeaders })).status, 200);
    assert.equal((await fetch(offeredBase + '/file', { headers: writerHeaders })).status, 401, 'Writer is not a reader');
    const originalRead = await fetch(offeredBase + '/file', { headers: readerHeaders });
    assert.equal(originalRead.status, 200);
    assert.deepEqual(Buffer.from(await originalRead.arrayBuffer()), offeredBytes);
    for (let index = 1; index < 10; index++) {
      const next = await fetch(pilotBase + '/runs', { method: 'POST', headers: senderHeaders, body: JSON.stringify(metadata) });
      assert.equal(next.status, 201);
      ids.push((await next.json() as { id: string }).id);
    }
    assert.equal((await fetch(pilotBase + '/runs', { method: 'POST', headers: senderHeaders, body: JSON.stringify(metadata) })).status, 409,
      'Manual invitation cannot exceed ten admissions');
  } finally {
    await Promise.allSettled(ids.map(id => fetch(origin + '/api/runs/' + id, { method: 'DELETE', headers })));
    child.kill();
  }
});
