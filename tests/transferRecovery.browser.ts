import { transferInit, transferEval, transferWait, transferWorker } from './transferHarness';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, firefox, type Page } from 'playwright';

async function backend() {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const child = spawn(process.execPath, process.env.FLASHVIEW_BACKEND === 'cloudflare'
    ? ['node_modules/wrangler/bin/wrangler.js', 'dev', '--name', 'warpview-test-' + port, '--persist-to', '.wrangler/test-state/' + port, '--inspector-port', '0', '--port', String(port), '--ip', '127.0.0.1']
    : ['--import', 'tsx', 'src/server/index.ts'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', BROWSER: 'none' },
  });
  let output = '';
  child.stderr.on('data', data => { output += String(data); });
  for (let i = 0; i < 180; i++) {
    if (child.exitCode !== null) throw Error('Backend exited: ' + output.slice(-2000));
    try {
      if ((await fetch('http://127.0.0.1:' + port + '/health')).ok)
        return { origin: 'http://127.0.0.1:' + port, child };
    } catch { /* Starting. */ }
    await delay(100);
  }
  child.kill();
  throw Error('Backend startup timed out: ' + output.slice(-2000));
}

async function digest(page: Page, room: string, name: string): Promise<string> {
  const session = await page.evaluate(() => {
    const saved = JSON.parse(sessionStorage.getItem('flashview-host')!);
    return { code: saved.code, cacheId: saved.cacheId ?? saved.code };
  });
  assert.equal(session.code, room, 'Hash the expected room generation');
  return page.evaluate(async ({ room, name }) => {
    const req = indexedDB.open('flashview-room-cache');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    const rows = await new Promise<Array<{ room: string; document: string; index: number; data: ArrayBuffer }>>((resolve, reject) => {
      const tx = db.transaction('chunks', 'readonly');
      const req = tx.objectStore('chunks').getAll();
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    db.close();
    // One matching file per room in this test.
    const chunks = rows.filter(row => row.room === room).sort((a, b) => a.index - b.index);
    if (!chunks.length) throw Error('No cached bytes for ' + name);
    const bytes = new Uint8Array(chunks.reduce((size, row) => size + row.data.byteLength, 0));
    let offset = 0;
    for (const row of chunks) { bytes.set(new Uint8Array(row.data), offset); offset += row.data.byteLength; }
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  }, { room: session.cacheId, name });
}

test('suspended file picker and repeated mid-file disconnects recover promptly with exact cached bytes', { timeout: 90000 }, async t => {
  const remote = process.env.RECOVERY_ORIGIN;
  const policyQuery = process.env.RECOVERY_POLICY ? 'resumePolicy=' + encodeURIComponent(process.env.RECOVERY_POLICY) + '&' : '';
  const { origin, child } = remote ? { origin: new URL(remote).origin, child: null } : await backend();
  const engine = process.env.FLASHVIEW_BROWSER === 'firefox' ? firefox : chromium;
  const browser = await engine.launch({ headless: true });
  const host = await browser.newPage();
  const student = await browser.newPage();
  const trace: string[] = [];
  const began = Date.now();
  for (const [side, page] of [['host', host], ['phone', student]] as const) {
    page.on('websocket', ws => {
      trace.push(`${Date.now() - began} ${side}: socket created`);
      ws.on('close', () => trace.push(`${Date.now() - began} ${side}: socket closed`));
      ws.on('framereceived', ({ payload }) => {
        if (typeof payload !== 'string') return;
        const message = JSON.parse(payload);
        if (/^(join\.|heartbeat\.|error|file\.announced|file\.updated|range\.error)/.test(message.type))
          trace.push(`${Date.now() - began} ${side}: ${message.type} ${message.file?.status ?? message.message ?? ''}`);
      });
    });
  }
  try {
    await transferInit(host, `{
      const Native = WebSocket;
      globalThis.__hostConnections = 0;
      globalThis.WebSocket = class extends Native { constructor(...args) { super(...args); globalThis.__hostConnections++; } };
    }`);
    // Blackhole both directions while the browser still reports OPEN. The
    // relay retains the old socket until the replacement authenticates.
    await transferInit(student, `{
      const Native = window.WebSocket;
      window.__rangeFailures = [];
      window.__sockets = [];
      window.WebSocket = class extends Native {
        constructor(...args) {
          super(...args);
          window.__sockets.push(this);
          this.addEventListener('message', event => {
            if (typeof event.data === 'string' && JSON.parse(event.data).type === 'join.resumed')
              window.__resumeCount = (window.__resumeCount || 0) + 1;
            if (window.__sockets[0] === this && location.search.includes('loseJoinAck=1') &&
                typeof event.data === 'string' && JSON.parse(event.data).type === 'join.accepted') {
              window.__lostJoinAck = true;
              event.stopImmediatePropagation();
              return;
            }
            if (this.__dead) event.stopImmediatePropagation();
          });
        }
        send(data) {
          if (typeof data === 'string' && JSON.parse(data).type === 'range.error') window.__rangeFailures.push(JSON.parse(data).message);
          if (!this.__dead) return super.send(data);
        }
        close(...args) { if (!this.__dead) return super.close(...args); }
      };
      const slice = File.prototype.slice;
      File.prototype.slice = function(...args) {
        const blob = slice.apply(this, args);
        const read = blob.arrayBuffer.bind(blob);
        blob.arrayBuffer = async function() {
          if (window.__holdReads) {
            window.__heldReads ||= [];
            await new Promise((resolve, reject) => window.__heldReads.push(reject));
          }
          await new Promise(resolve => setTimeout(resolve, 100));
          return read();
        };
        return blob;
      };
    }`);
    await host.goto(origin + '/?' + policyQuery);
    await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const code = (await host.locator('.room-code').innerText()).trim();
    await student.goto(origin + '/?' + policyQuery + 'loseJoinAck=1');
    await student.locator('#code').fill(code);
    await student.getByRole('button', { name: /Join room/ }).click();
    await student.locator('.student-drive').waitFor();
    await transferWait(student, 'window.__lostJoinAck === true');
    // The picker is disabled until admission. First recover a backgrounded
    // initial join whose acknowledgement was lost, retaining its identity.
    await student.evaluate(`{
      document.dispatchEvent(new Event('freeze'));
      document.dispatchEvent(new Event('resume'));
    }`);
    // Simulate suspension inside the native picker before choosing a file.
    const chooserReady = student.waitForEvent('filechooser');
    await student.locator('.student-add-fab').click();
    const chooser = await chooserReady;
    await transferEval(student, `window.__sockets.at(-1).__dead = true`);
    await chooser.setFiles({
      name: 'picker.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(768 * 1024, 73),
    });
    const first = host.locator('.document-row').filter({ hasText: 'picker.bin' });
    await first.locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 6500 });
    assert.equal(await digest(host, code, 'picker.bin'), createHash('sha256').update(Buffer.alloc(768 * 1024, 73)).digest('hex'));
    assert.equal(await host.locator('.participant-row').count(), 1,
      'Losing the first join acknowledgement must not create a ghost participant');
    t.diagnostic('Initial picker recovery events: ' + JSON.stringify(trace.slice(0, 18)));
    await host.getByRole('button', { name: /End (room|session)/ }).click();
    await host.getByRole('checkbox', { name: /I understand/ }).check();
    await host.getByRole('button', { name: 'End & clear cache' }).click();
    // A separate room keeps hash verification independent of earlier files.
    await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const nextCode = (await host.locator('.room-code').innerText()).trim();
    await student.goto(origin + '/?' + policyQuery);
    await student.locator('#code').fill(nextCode);
    await student.getByRole('button', { name: /Join room/ }).click();
    await student.locator('.student-drive').waitFor();
    const bytes = Buffer.allocUnsafe(20 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + (i >>> 16)) & 255;
    await student.locator('input[type=file]').setInputFiles({
      name: 'large.bin', mimeType: 'application/octet-stream', buffer: bytes,
    });
    const row = host.locator('.document-row').filter({ hasText: 'large.bin' });
    await host.waitForFunction(() => Number(document.querySelector('.cache-ring')?.getAttribute('aria-valuenow')) >= 5);
    for (let round = 0; round < 2; round++) {
      const before = Number(await row.locator('.cache-ring').getAttribute('aria-valuenow'));
      assert.ok(before < 100, 'Interrupt an active transfer');
      const started = Date.now();
      await transferEval(student, `window.__sockets.at(-1).__dead = true`);
      await student.evaluate(`document.dispatchEvent(new Event('freeze'))`);
      // Let all phone reads finish against the dead socket. The receiver's
      // next window of requests is now stranded at the relay, not in JS reads.
      await delay(600);
      const returned = Date.now();
      const connectionsBefore = Number(await transferEval(student, 'window.__sockets.length'));
      const resume = await student.evaluate(`(() => {
        const began = performance.now();
        document.dispatchEvent(new Event('resume'));
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('pageshow'));
        return { handlerMs: performance.now() - began };
      })()`);
      await transferWait(student, n => (window as typeof window & { __sockets: WebSocket[] }).__sockets.length > n, connectionsBefore);
      await host.waitForFunction(previous => Number(document.querySelector('.cache-ring')?.getAttribute('aria-valuenow')) > previous,
        before, { timeout: 6500 });
      t.diagnostic('Mid-file recovery ' + (round + 1) + ': ' + (Date.now() - started) + ' ms');
      t.diagnostic('Return to persisted progress ' + (round + 1) + ': ' + (Date.now() - returned) + ' ms');
      t.diagnostic('Return handler: ' + JSON.stringify(resume));
    }
    // A read begun on the old socket may reject after a replacement has
    // authenticated and replayed the same request. Its stale failure must not
    // cancel the replacement's response or start a file retry cooldown.
    await transferEval(student, 'window.__holdReads = true');
    await transferWait(student, 'window.__heldReads?.length > 0');
    const resumedBefore = Number(await transferEval(student, 'window.__resumeCount || 0'));
    await transferEval(student, `{
      window.__sockets.at(-1).__dead = true;
      window.__holdReads = false;
    }`);
    await student.evaluate(`{
      document.dispatchEvent(new Event('freeze'));
      document.dispatchEvent(new Event('resume'));
    }`);
    await transferWait(student, previous =>
      Number((window as typeof window & { __resumeCount?: number }).__resumeCount) > previous, resumedBefore);
    await transferEval(student, `{
      for (const reject of window.__heldReads.splice(0)) reject(new Error('Old connection read failed'));
    }`);
    await delay(200);
    assert.equal(await transferEval(student, "window.__rangeFailures.includes('Cannot read file from sender device')"), false,
      'Old asynchronous reads must not fail replayed requests on the replacement connection');
    // Also return from a healthy picker without adding another file. Recovery
    // must preserve the active transfer and not create a duplicate file card.
    const healthyChooserReady = student.waitForEvent('filechooser');
    await student.locator('.student-add-fab').click();
    await (await healthyChooserReady).setFiles([]);
    if (process.env.RECOVERY_POLICY !== 'probe') {
      const hostOwner = await transferWorker(host);
      // Inspect the worker-owned host socket via a test-only native wrapper.
      const before = await hostOwner.evaluate('globalThis.__hostConnections || 0');
      await host.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        window.dispatchEvent(new Event('online'));
        Reflect.deleteProperty(document, 'visibilityState');
        window.dispatchEvent(new Event('focus'));
      });
      await transferWait(host, n => Number((globalThis as typeof globalThis & { __hostConnections?: number }).__hostConnections) > Number(n), before);
    }
    await row.locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 30000 });
    assert.equal(await digest(host, nextCode, 'large.bin'), createHash('sha256').update(bytes).digest('hex'));
    assert.equal(await row.count(), 1, 'Reconnection must not duplicate files');
  } catch (error) {
    t.diagnostic(JSON.stringify(trace.slice(-60)));
    throw error;
  } finally {
    if (remote && await host.getByRole('button', { name: 'End room', exact: true }).isVisible().catch(() => false)) {
      await host.getByRole('button', { name: 'End room', exact: true }).click().then(async () => {
        await host.getByRole('checkbox', { name: /I understand/ }).check();
        await host.getByRole('button', { name: 'End & clear cache' }).click();
        await host.getByRole('button', { name: /Create a room/ }).waitFor({ timeout: 5000 });
      }).catch(() => {});
    }
    await browser.close(); child?.kill('SIGTERM');
  }
});
