import { transferInit, transferEval, transferWait, transferWorker } from './transferHarness';
import { chromium } from 'playwright';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
if (!process.env.RESUME_BENCH_ORIGIN) throw Error('Set RESUME_BENCH_ORIGIN to an isolated deployment with both resume policies');
const origin = new URL(process.env.RESUME_BENCH_ORIGIN).origin;
const repetitions = Number(process.env.RESUME_BENCH_RUNS ?? 5);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw Error('RESUME_BENCH_RUNS must be 1–10');
await mkdir('test-artifacts', { recursive: true });
const browser = await chromium.launch({ headless: true });
const bytes = randomBytes(20 * 1024 * 1024);
const expected = createHash('sha256').update(bytes).digest('hex');
const results: object[] = [];
try {
  for (let iteration = 1; iteration <= repetitions; iteration++) {
    for (const name of (iteration % 2 ? ['probe', 'immediate'] : ['immediate', 'probe'])) {
      const query = '/?resumePolicy=' + name;
      const context = await browser.newContext();
      const host = await context.newPage();
      const phone = await context.newPage();
      try {
        await transferInit(phone, `{
          const Native = window.WebSocket;
          window.WebSocket = class extends Native {
            constructor(...args) {
              super(...args);
              this.addEventListener('message', event => {
                if (typeof event.data === 'string' && JSON.parse(event.data).type === 'join.accepted') window.__joined = true;
              });
            }
          };
        }`);
        await host.goto(origin + query);
        await host.getByRole('button', { name: /Create a room/ }).click();
        await host.locator('.connection.connected').waitFor();
        const code = (await host.locator('.room-code').innerText()).trim();
        await phone.goto(origin + query);
        await phone.locator('#code').fill(code);
        await phone.getByRole('button', { name: /Join room/ }).click();
        await phone.waitForFunction('window.__joined === true');
        const chooserReady = phone.waitForEvent('filechooser');
        await phone.locator('.student-add-fab').click();
        const chooser = await chooserReady;
        const start = Date.now();
        await chooser.setFiles({ name: 'speed.bin', mimeType: 'application/octet-stream', buffer: bytes });
        await host.locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 45000 });
        const cachedMs = Date.now() - start;
        const cacheId = await host.evaluate(() => { const session = JSON.parse(sessionStorage.getItem('flashview-host')!); return session.cacheId ?? session.code; });
        const actual = await host.evaluate(async room => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open('flashview-room-cache'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
          });
          const rows = await new Promise<Array<{ index: number; data: ArrayBuffer }>>((resolve, reject) => {
            const req = db.transaction('chunks', 'readonly').objectStore('chunks').index('room').getAll(IDBKeyRange.only(room));
            req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
          });
          db.close(); rows.sort((a,b) => a.index-b.index);
          const output = new Uint8Array(rows.reduce((size, row) => size + row.data.byteLength, 0));
          let at = 0; for (const row of rows) { output.set(new Uint8Array(row.data), at); at += row.data.byteLength; }
          const hash = await crypto.subtle.digest('SHA-256', output);
          return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2,'0')).join('');
        }, cacheId);
        if (actual !== expected) throw Error('Cache hash mismatch');
        const result = { name, iteration, bytes: bytes.length, cachedMs, verifiedMs: Date.now() - start };
        results.push(result); console.log(JSON.stringify(result));
      } finally {
        if (await host.getByRole('button', { name: 'End room', exact: true }).isVisible().catch(() => false)) {
          await host.getByRole('button', { name: 'End room', exact: true }).click();
          await host.getByRole('button', { name: 'End & clear cache' }).click();
          await host.getByRole('button', { name: /Create a room/ }).waitFor();
        }
        await context.close();
      }
    }
  }
} finally {
  await writeFile('test-artifacts/immediate-same-worker-throughput.json', JSON.stringify(results, null, 2));
  await browser.close();
}
