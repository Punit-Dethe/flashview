import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile, mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const mib = Number(process.env.BENCH_MIB ?? 2);
const count = Number(process.env.BENCH_STUDENTS ?? 1);
const repeats = Number(process.env.BENCH_RUNS ?? 1);
const partBytes = Number(process.env.BENCH_PART_MIB ?? 8) * 1024 * 1024;
const concurrency = Number(process.env.BENCH_UPLOAD_CONCURRENCY ?? 2);
const layout = process.env.BENCH_R2_LAYOUT ?? 'object';
const timeoutMs = Number(process.env.BENCH_TIMEOUT_MS ?? 120_000);
const remoteOrigin = process.env.BENCH_R2_ORIGIN;
const token = remoteOrigin ? process.env.BENCH_R2_TOKEN : randomBytes(32).toString('hex');
if (!(mib >= 1 && mib <= 200) || !Number.isInteger(count) || !(count >= 1 && count <= 30) ||
    !Number.isInteger(repeats) || !(repeats >= 1 && repeats <= 10) ||
    ![5, 8, 16].includes(partBytes / 1024 / 1024) ||
    !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4 ||
    !['object', 'segments'].includes(layout) || !(timeoutMs >= 1000 && timeoutMs <= 900_000))
  throw Error('Invalid benchmark configuration');
if (!token || token.length < 32) throw Error('Live benchmark requires BENCH_R2_TOKEN (at least 32 characters)');
if (remoteOrigin && new URL(remoteOrigin).protocol !== 'https:') throw Error('Live benchmark requires HTTPS');

let child: ChildProcess | undefined;
let origin = remoteOrigin;
if (!origin) {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  origin = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev',
    '--config', 'benchmarks/r2/wrangler.jsonc', '--port', String(port), '--ip', '127.0.0.1',
    '--var', 'BENCH_TOKEN:' + token], { env: { ...process.env, BROWSER: 'none', WRANGLER_SEND_METRICS: 'false' } });
  let errors = '';
  child.stderr?.on('data', data => { errors = (errors + String(data)).slice(-2000); });
  child.stdout?.on('data', () => {});
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(origin + '/health')).ok) { ready = true; break; } } catch { /* booting */ }
    await delay(100);
  }
  if (!ready) { child.kill(); throw Error('Isolated R2 startup failed: ' + errors); }
}

const fixture = randomBytes(Math.floor(mib * 1024 * 1024));
const hashBlockBytes = 8 * 1024 * 1024;
const hashes: string[] = [];
const partHashes: string[] = [];
for (let offset = 0; offset < fixture.length; offset += hashBlockBytes)
  hashes.push(createHash('sha256').update(fixture.subarray(offset, offset + hashBlockBytes)).digest('hex'));
if (layout === 'segments') for (let offset = 0; offset < fixture.length; offset += partBytes)
  partHashes.push(createHash('sha256').update(fixture.subarray(offset, offset + partBytes)).digest('hex'));
const fixtureDirectory = await mkdtemp(join(tmpdir(), 'flashview-r2-bench-'));
const fixturePath = join(fixtureDirectory, 'original.bin');
await writeFile(fixturePath, fixture);
const headers = { Authorization: 'Bearer ' + token };
const results: unknown[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch();
  for (let iteration = 1; iteration <= repeats; iteration++) {
    const senderContext = await browser.newContext({ extraHTTPHeaders: headers });
    const hostContext = await browser.newContext();
    const ids: string[] = [];
    try {
      const files = await Promise.all(Array.from({ length: count }, async () => {
        const sender = await senderContext.newPage();
        const receiver = await hostContext.newPage();
        await sender.goto(origin!);
        await receiver.goto(origin!);
        // Match the existing app baseline: transfer code is ready before the
        // user selects a file. Don't charge a cold worker script to R2 alone.
        await receiver.evaluate(() => new Promise<void>((resolve, reject) => {
          const worker = new Worker('/cache-worker.js');
          const timer = setTimeout(() => { worker.terminate(); reject(Error('Cache worker startup timed out')); }, 30_000);
          (window as typeof window & { __r2CacheWorker?: Worker }).__r2CacheWorker = worker;
          worker.onerror = () => { clearTimeout(timer); reject(Error('Cache worker startup failed')); };
          worker.onmessage = ({ data }) => { if (data.type === 'ready') { clearTimeout(timer); resolve(); } };
        }));
        return { sender, receiver };
      }));
      const batchStart = performance.now();
      const perFile = await Promise.all(files.map(async ({ sender, receiver }) => {
        const started = performance.now();
        // Match the relay clock: include file selection and admission rather
        // than measuring only bytes after Playwright has loaded the source.
        await sender.locator('input[type=file]').setInputFiles(fixturePath);
        const admissionStarted = performance.now();
        // Admission uses the phone's existing browser connection, rather than
        // an unrelated Node HTTP connection with different handshake costs.
        const { id } = await sender.evaluate(async config => {
          const response = await fetch('/api/runs', {
            method: 'POST', headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
            body: JSON.stringify(config.input),
          });
          if (!response.ok) throw Error('R2 benchmark admission failed: ' + response.status);
          return await response.json() as { id: string };
        }, { token, input: { size: fixture.length, partBytes, layout, partHashes } });
        const admissionMs = performance.now() - admissionStarted;
        ids.push(id);
        const receive = () => receiver.evaluate(config => new Promise<{
          ok: boolean; bytes: number; committedAtMs: number; verifiedAtMs: number; error?: string;
        }>((resolve, reject) => {
          const worker = (window as typeof window & { __r2CacheWorker: Worker }).__r2CacheWorker;
          const timer = setTimeout(() => { worker.terminate(); reject(Error('Cache verification timed out')); }, config.timeoutMs);
          worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(Error('Cache worker failed')); };
          worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate();
            if (data.ok) resolve(data); else reject(Error(data.error)); };
          worker.postMessage(config);
        }), { id, token, size: fixture.length, hashBlockBytes, hashes, timeoutMs, layout, partBytes });
        const pipelined = layout === 'segments' ? receive() : undefined;
        // Keep a rejection observed if upload fails before the receiver is awaited.
        void pipelined?.catch(() => {});
        const upload = await sender.evaluate(async config => {
          const file = document.querySelector<HTMLInputElement>('input[type=file]')!.files![0];
          const start = performance.now();
          let next = 1;
          const parts = Math.ceil(file.size / config.partBytes);
          const partTimings: Array<{ part: number; ms: number; server?: Record<string, number> }> = [];
          const uploads = Array.from({ length: config.concurrency }, async () => {
            while (next <= parts) {
              const index = next++;
              const partStart = performance.now();
              const response = await fetch('/api/runs/' + config.id + '/parts/' + index, {
                method: 'PUT', headers: { Authorization: 'Bearer ' + config.token },
                body: file.slice((index - 1) * config.partBytes, index * config.partBytes),
                signal: AbortSignal.timeout(config.timeoutMs),
              });
              if (!response.ok) throw Error('Part upload failed: ' + response.status);
              const receipt = await response.json() as { timing?: Record<string, number> };
              partTimings.push({ part: index, ms: performance.now() - partStart, server: receipt.timing });
            }
          });
          await Promise.all(uploads);
          const completionStarted = performance.now();
          const complete = await fetch('/api/runs/' + config.id + '/complete', {
            method: 'POST', headers: { Authorization: 'Bearer ' + config.token },
            signal: AbortSignal.timeout(config.timeoutMs),
          });
          if (!complete.ok) throw Error('Object completion failed: ' + complete.status);
          return { uploadedAtMs: performance.now() - start,
            finalizationMs: performance.now() - completionStarted, partTimings };
        }, { id, partBytes, token, timeoutMs, concurrency });
        // Simulate the phone leaving immediately after confirmed cloud receipt.
        await sender.close();
        const cache = await (pipelined ?? receive());
        return { fileId: id, admissionMs, ...upload, cache, timeToVerifiedCacheMs: performance.now() - started };
      }));
      const result = { iteration, timeToVerifiedCacheAllMs: performance.now() - batchStart, perFile };
      results.push(result);
      console.log(JSON.stringify(result));
    } finally {
      await senderContext.close();
      await hostContext.close();
      const cleanup = await Promise.allSettled(ids.map(async id => {
        const removed = await fetch(origin + '/api/runs/' + id, { method: 'DELETE', headers });
        if (!removed.ok) throw Error('Benchmark cleanup failed; retain run ' + id + ' for reconciliation');
      }));
      const failures = cleanup.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => (result as PromiseRejectedResult).reason), 'R2 cleanup failed');
    }
  }
} finally {
  await browser?.close().catch(() => {});
  child?.kill();
  await unlink(fixturePath);
  await rmdir(fixtureDirectory);
}
await mkdir('test-artifacts', { recursive: true });
await writeFile('test-artifacts/r2-' + (remoteOrigin ? 'live' : 'local') + '-' + mib + 'mib-' + count +
  'students-' + layout + '-' + partBytes / 1024 / 1024 + 'partmib-' + concurrency + 'concurrent.json',
  JSON.stringify({ schema: 'flashview-r2-benchmark-v1',
    measurementRevision: 2,
    environment: remoteOrigin ? 'live-r2-browser-on-this-machine-not-campus-proof' : 'local-r2-emulation-not-provider-performance',
    configuration: { mib, actualBytes: fixture.length, count, repeats, partBytes, concurrency, hashBlockBytes, layout },
    phoneClosedAfterUpload: true, viewingEnabled: false, results }, null, 2) + '\n');
