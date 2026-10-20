import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, unlink, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { build } from 'vite';
import { chromium, firefox, webkit } from 'playwright';

// Real browser APIs, persistent desktop profile, no app/backend/network transfers.
const browserName = process.env.STORAGE_BROWSER ?? 'chromium';
const engine = { chromium, firefox, webkit }[browserName]; assert.ok(engine, 'Unsupported STORAGE_BROWSER');
const sizes = (process.env.STORAGE_MIB ?? '20,200').split(',').map(Number);
assert.ok(sizes.every(size => Number.isInteger(size) && size >= 1 && size <= 200));
const repeats = Number(process.env.STORAGE_RUNS ?? 3); assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 5);
const modes = (process.env.STORAGE_MODES ?? 'idb-current,idb-batched,opfs').split(','), results = [], fixtures = [];
assert.ok(modes.length && new Set(modes).size === modes.length && modes.every(mode => ['idb-current', 'idb-batched', 'opfs'].includes(mode)));
const nativeTrace = process.env.STORAGE_NATIVE_TRACE === '1';
const unsupported = new Set();
const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><input type="file">'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let context, profile;
const profileRoot = resolve('.wrangler/storage-profiles');
try {
  const built = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: true,
    lib: { entry: resolve('benchmarks/storage/worker.ts'), formats: ['es'] }, target: 'es2022' } });
  const output = Array.isArray(built) ? built[0] : built;
  const code = output.output.find(item => item.type === 'chunk').code;
  profile = resolve(profileRoot, browserName + '-' + randomUUID());
  await mkdir(profile, { recursive: true });
  context = await engine.launchPersistentContext(profile, { headless: true });
  const page = await context.newPage(); await page.goto('http://127.0.0.1:' + server.address().port);
  for (const mib of sizes) {
    const path = resolve('.wrangler/storage-fixture-' + randomUUID() + '.bin'), bytes = mib * 1024 * 1024 - 7;
    fixtures.push(path); const fixture = await open(path, 'wx'), part = Buffer.alloc(1024 * 1024, 113), digest = createHash('sha256');
    try { for (let offset = 0; offset < bytes; offset += part.length) { const chunk = part.subarray(0, Math.min(part.length, bytes - offset)); await fixture.write(chunk); digest.update(chunk); } }
    finally { await fixture.close(); }
    const expected = digest.digest('hex'); await page.locator('input').setInputFiles(path);
    for (let round = 0; round < repeats; round++) {
      const order = [...modes.slice(round % modes.length), ...modes.slice(0, round % modes.length)];
      for (const mode of order) {
        if (unsupported.has(mode)) continue;
        const startedAt = new Date().toISOString();
        const value = await page.evaluate(async ({ code, mode, expected, nativeTrace }) => {
          const module = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
          const entry = URL.createObjectURL(new Blob(['import {runStorageCase} from ' + JSON.stringify(module) + ';onmessage=({data})=>runStorageCase(data).then(value=>postMessage({value}),error=>postMessage({error:String(error)}));'], { type: 'text/javascript' }));
          const worker = new Worker(entry, { type: 'module' });
          try {
            return await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => reject(Error('Storage comparison timed out')), 180000);
              worker.onmessage = ({ data }) => { clearTimeout(timeout); data.error ? reject(Error(data.error)) : resolve(data.value); };
              worker.onerror = error => { clearTimeout(timeout); reject(Error(error.message)); };
              worker.postMessage({ mode, expected, nativeTrace, source: document.querySelector('input').files[0] });
            });
          } finally { worker.terminate(); URL.revokeObjectURL(entry); URL.revokeObjectURL(module); }
        }, { code, mode, expected, nativeTrace }).catch(error => {
          if (mode !== 'opfs' || !String(error).includes('NotSupportedError')) throw error;
          unsupported.add(mode);
          return { mode, unsupported: true, reason: 'NotSupportedError from this browser backend; not a Safari/iOS conclusion' };
        });
        results.push({ mib, round, startedAt, completedAt: new Date().toISOString(), ...value });
        console.log(JSON.stringify(results.at(-1)));
      }
    }
  }
  const report = { browser: browserName, version: context.browser()?.version(), profile: 'persistent', sizes, modes, nativeTrace, repeats, results,
    note: 'Saturated local storage comparison, <=1 MiB windows, bounded source reads and identical source/range/block/root integrity checks. No network/viewers. IDB reference drivers are not production fallback implementations; idb-current adds integrity absent from current production. idb-batched uses strict durability. Not physical mobile evidence or total-memory measurement.' };
  const path = resolve(process.env.STORAGE_RESULT ?? 'test-artifacts/storage-' + browserName + '.json');
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(report, null, 2));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  for (const fixture of fixtures) await unlink(fixture).catch(() => {});
  if (profile) {
    // Delete only this generated profile, after checking its resolved location.
    const within = relative(profileRoot, profile);
    assert.ok(within && !within.startsWith('..') && !isAbsolute(within), 'Profile cleanup must stay under the generated profile root');
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
