import { transferInit, transferEval, transferWait, transferWorker } from './transferHarness';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, firefox, type Page } from 'playwright';
import { makePowerPointFixture } from './pptxFixture';
import { invitationUrl } from '../src/client/joinInvitation';
const browserEngine = process.env.FLASHVIEW_BROWSER === 'firefox' ? firefox : chromium;
import { mkdir, readFile } from 'node:fs/promises';

async function unusedPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const addr = listener.address();
  assert.ok(addr && typeof addr !== 'string');
  const port = addr.port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return port;
}
async function runningServer() {
  const port = await unusedPort();
  const useCloudflare = process.env.FLASHVIEW_BACKEND === 'cloudflare';
  const child = spawn(process.execPath, useCloudflare
    ? ['node_modules/wrangler/bin/wrangler.js', 'dev', '--name', 'warpview-test-' + port, '--persist-to', '.wrangler/test-state/' + port, '--inspector-port', '0', '--port', String(port), '--ip', '127.0.0.1']
    : ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', BROWSER: 'none' },
  });
  let output = '';
  child.stderr.on('data', data => { output += String(data); });
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error('Server exited: ' + output);
    try {
      if ((await fetch('http://127.0.0.1:' + port + '/health')).ok) return { port, child };
    } catch { /* Waiting for process. */ }
    await delay(100);
  }
  child.kill();
  throw new Error('Server startup timed out: ' + output);
}

async function waitForPresenterPopup(host: Page): Promise<Page> {
  const page = await host.waitForEvent('popup');
  // Host credentials are stripped from an initial blank tab before navigation.
  await page.waitForURL(url => url.pathname === '/present');
  return page;
}

async function swipePreview(page: Page, selector: string, dx: number, dy = 0) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box);
  const x = box.x + box.width / 2 - dx / 2, y = box.y + box.height / 2 - dy / 2;
  if (process.env.FLASHVIEW_BROWSER === 'firefox') {
    await page.evaluate(({ selector, x, y, dx, dy }) => {
      const surface = document.querySelector(selector)!;
      for (const [type, touches, changed] of [
        ['touchstart', [{clientX:x,clientY:y}], []],
        ['touchend', [], [{clientX:x+dx,clientY:y+dy}]],
      ] as const) {
        const event = new Event(type, { bubbles:true });
        Object.defineProperties(event, { touches:{value:touches}, changedTouches:{value:changed} });
        surface.dispatchEvent(event);
      }
    }, { selector, x, y, dx, dy });
    return;
  }
  const client = await page.context().newCDPSession(page);
  try {
    await client.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{x,y}] });
    for (let step = 1; step <= 5; step++)
      await client.send('Input.dispatchTouchEvent', { type:'touchMove', touchPoints:[{x:x+dx*step/5,y:y+dy*step/5}] });
    await client.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] });
  } finally { await client.detach(); }
}

async function assertPowerPointFits(page: Page) {
  await page.waitForFunction(() => {
    const slide = document.querySelector('.pptxv-stage')?.getBoundingClientRect();
    return slide && (Math.abs(slide.width - innerWidth) < 3 || Math.abs(slide.height - innerHeight) < 3) &&
      slide.width <= innerWidth + 3 && slide.height <= innerHeight + 3;
  });
}

async function assertPresentationDock(page: Page) {
  const bounds = await page.locator('.presentation-controls').evaluate(el => {
    const dock = el.getBoundingClientRect();
    const children = [...el.querySelectorAll('button, input')].map(child => child.getBoundingClientRect());
    return { right: dock.right, bottom: dock.bottom, left: dock.left,
      width: innerWidth, height: innerHeight,
      fits: children.every(child => child.left >= dock.left && child.right <= dock.right &&
        child.top >= dock.top && child.bottom <= dock.bottom) };
  });
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height && bounds.fits,
    'All preview controls must fit the dock and viewport');
  assert.ok(bounds.right > bounds.width - 38 && bounds.bottom > bounds.height - 38,
    'Preview controls stay in the bottom-right corner');
  assert.equal(await page.getByRole('button', { name: 'Close', exact: true }).isVisible(), true);
}

/** Construct a valid single-page PDF with a realistic (200 KB) byte-range surface. */
function makePdf(fillerLines = 1400): Buffer {
  const pageCount = 10;
  const fontId = pageCount * 2 + 3;
  const kids = Array.from({ length: pageCount }, (_, i) => (3 + i * 2) + ' 0 R');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + pageCount + ' >>',
  ];
  for (let i = 0; i < pageCount; i++) {
    const contentId = 4 + i * 2;
    const stream = 'BT /F1 26 Tf 72 690 Td (FlashView page ' + (i + 1) + ') Tj ET';
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 ' + fontId + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>');
    objects.push('<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream');
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += (i + 1) + ' 0 obj\n' + objects[i] + '\nendobj\n';
  }
  // Force noncontiguous PDF.js range requests for structure near the file tail.
  pdf += ('% ' + 'PDF DATA '.repeat(15) + '\n').repeat(fillerLines);
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (const offset of offsets) pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\n';
  pdf += 'startxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(pdf);
}

async function seedLifecycleCache(page: import('playwright').Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const session = JSON.parse(sessionStorage.getItem('flashview-host')!);
    const opened = indexedDB.open('flashview-room-cache');
    opened.onerror = () => reject(opened.error);
    opened.onsuccess = () => {
      const db = opened.result;
      const tx = db.transaction(['chunks', 'rooms'], 'readwrite');
      const room = session.cacheId ?? session.code;
      const document = room + '/lifecycle-fixture';
      tx.objectStore('chunks').put({ key: document + '/0', room, document,
        index: 0, data: Uint8Array.of(1, 2, 3).buffer });
      tx.objectStore('rooms').put({ id: room, expires: Date.now() + 7_200_000 });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }));
}
async function cacheIdentity(page: Page): Promise<string> {
  return page.evaluate(() => {
    const session = JSON.parse(sessionStorage.getItem('flashview-host')!);
    return session.cacheId ?? session.code;
  });
}
async function lifecycleCacheCount(page: import('playwright').Page, room: string): Promise<number> {
  return page.evaluate(code => new Promise<number>((resolve, reject) => {
    const opened = indexedDB.open('flashview-room-cache');
    opened.onerror = () => reject(opened.error);
    opened.onsuccess = () => {
      const db = opened.result;
      const tx = db.transaction('chunks', 'readonly');
      const count = tx.objectStore('chunks').index('room').count(IDBKeyRange.only(code));
      count.onsuccess = () => resolve(count.result);
      count.onerror = () => reject(count.error);
      tx.oncomplete = () => db.close();
    };
  }), room);
}

test('QR welcome: optional name, explicit skip, clean URLs and private refresh resume', { timeout: 60000 }, async () => {
  const { port, child } = await runningServer(), browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage(), named = await browser.newPage(), skipped = await browser.newPage(), legacy = await browser.newPage();
  const root = 'http://127.0.0.1:' + port;
  const hellos: Record<string, unknown>[] = [], skippedHellos: Record<string, unknown>[] = [];
  for (const [page, messages] of [[named, hellos], [skipped, skippedHellos]] as const)
    page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
      if (typeof payload === 'string') { const message = JSON.parse(payload); if (message.type === 'hello') messages.push(message); }
    }));
  try {
    await host.goto(root); await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const session = await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!));
    const url = invitationUrl(root, session.joinToken, session.code);
    await named.addInitScript(() => sessionStorage.setItem('flashview-host', JSON.stringify({ roomId: 'unrelated', code: '111111', hostToken: 'unrelated', joinToken: 'unrelated' })));
    await named.goto(url); await named.locator('.invite-card').waitFor();
    await named.waitForURL(value => value.pathname === '/join/' + session.code && !value.search && !value.hash);
    await mkdir('test-artifacts/ui', { recursive: true });
    const screenPrefix = 'test-artifacts/ui/qr-welcome-' + browserEngine.name() + '-' + (process.env.FLASHVIEW_BACKEND ?? 'node');
    await named.screenshot({ path: screenPrefix + '-desktop.png' });
    assert.equal(hellos.length, 0, 'Scanning must not join before the name/skip choice');
    assert.equal(await named.getByLabel('Your name (optional)').getAttribute('required'), null);
    assert.equal(await named.getByRole('button', { name: 'Add files', exact: true }).count(), 0);
    await named.getByLabel('Your name (optional)').fill('  Asha  ');
    await named.getByLabel('Your name (optional)').press('Enter');
    await named.locator('.student-add-fab:not([disabled])').waitFor();
    assert.equal(hellos[0].name, 'Asha');
    await named.locator('input[type=file]').setInputFiles({ name: 'named.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('named original') });
    await host.locator('.document-row').filter({ hasText: 'named.bin' }).locator('.cache-ring.is-complete').waitFor();
    assert.equal(await host.locator('.participant-row').filter({ hasText: 'Asha' }).count(), 1);
    const resume = hellos[0].resumeToken;
    await named.reload(); await named.locator('.student-add-fab:not([disabled])').waitFor();
    assert.equal(await named.locator('.invite-card').count(), 0, 'Refresh must not repeat the choice');
    assert.equal(hellos.at(-1)?.resumeToken, resume); assert.equal(hellos.at(-1)?.name, 'Asha');
    await named.getByRole('button', { name: 'Leave room', exact: true }).click();
    await named.locator('.welcome').waitFor();
    assert.equal(await named.evaluate(() => history.state?.warpviewJoin), undefined, 'Leave clears the remembered invitation');
    await skipped.setViewportSize({ width: 390, height: 844 });
    await skipped.goto(url); await skipped.locator('.invite-card').waitFor();
    await skipped.reload(); await skipped.locator('.invite-card').waitFor();
    await skipped.screenshot({ path: screenPrefix + '-mobile.png' });
    assert.equal(skippedHellos.length, 0, 'Refreshing an unchosen invitation must remain pending');
    await skipped.getByLabel('Your name (optional)').fill('Do not use this name');
    await skipped.getByRole('button', { name: 'Skip for now', exact: true }).click();
    await skipped.locator('.student-add-fab:not([disabled])').waitFor();
    assert.equal(skippedHellos[0].name, 'Student', 'Skip discards a partially entered name');
    await skipped.locator('input[type=file]').setInputFiles({ name: 'skipped.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('anonymous original') });
    await host.locator('.document-row').filter({ hasText: 'skipped.bin' }).locator('.cache-ring.is-complete').waitFor();
    assert.equal(await host.locator('.participant-row').filter({ hasText: 'Student' }).count(), 1);
    await legacy.goto(root + '/?join=' + encodeURIComponent(session.joinToken));
    await legacy.locator('.invite-card').waitFor(); await legacy.getByRole('button', { name: 'Skip for now', exact: true }).click();
    await legacy.locator('.student-add-fab:not([disabled])').waitFor();
    await legacy.waitForURL(value => value.pathname === '/join/' + session.code && !value.search && !value.hash);
    await host.getByRole('button', { name: 'End room', exact: true }).click();
    await host.getByRole('button', { name: 'End & clear cache', exact: true }).click(); await host.locator('.welcome').waitFor();
  } finally { await browser.close(); child.kill(); }
});

test('room cache identity: reused code cannot inherit bytes or previews and cleanup stays scoped', { timeout: 70000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage({ acceptDownloads: true });
  const student = await browser.newPage();
  const fileId = '12345678123442348234123456789abc';
  const original = Buffer.alloc(512 * 1024 + 7);
  for (let i = 0; i < original.length; i++) original[i] = (i * 37 + Math.floor(i / 65536)) % 256;
  try {
    const root = 'http://127.0.0.1:' + port;
    await transferInit(host, () => {
      const reads: string[] = [];
      (window as typeof window & { __previewKeys?: string[] }).__previewKeys = reads;
      const get = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function (key) {
        if (this.name === 'previews') reads.push(String(key));
        return get.call(this, key);
      };
    });
    await host.goto(root);
    await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const session = await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!));
    assert.equal(session.cacheId, 'generation:' + session.roomGeneration);
    const foreignCache = 'generation:87654321-4321-4321-8321-cba987654321';
    // A previous room used exactly this code and file ID. Every old chunk has
    // the expected length: key/length checks alone would falsely say complete.
    await host.evaluate(async ({ rooms, fileId, size }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('flashview-room-cache');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['chunks', 'rooms', 'previews'], 'readwrite');
        for (const room of rooms) {
          const document = room + '/' + fileId;
          for (let index = 0; index < Math.ceil(size / 65536); index++) {
            const data = new Uint8Array(Math.min(65536, size - index * 65536)).fill(238).buffer;
            tx.objectStore('chunks').put({ key: document + '/' + index, room, document, index, data });
          }
          tx.objectStore('previews').put({ key: document, room, dataUrl: 'old-room-preview' });
          tx.objectStore('rooms').put({ id: room, expires: Date.now() + 7_200_000 });
        }
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
      });
      db.close();
    }, { rooms: [session.code, foreignCache], fileId, size: original.length });
    await student.addInitScript(() => {
      crypto.randomUUID = () => '12345678-1234-4234-8234-123456789abc';
    });
    await student.goto(root + '/?join=' + encodeURIComponent(session.joinToken));
    await student.getByRole('button', { name: 'Skip for now', exact: true }).click();
    await student.locator('.student-add-fab:not([disabled])').waitFor();
    await student.locator('input[type=file]').setInputFiles({ name: 'isolated.bin', mimeType: 'application/octet-stream', buffer: original });
    await host.locator('.document-row .cache-ring[aria-valuenow="100"]').waitFor();
    assert.equal(await lifecycleCacheCount(host, session.cacheId), Math.ceil(original.length / 65536));
    await student.close();
    // Restore without a source. Both export and the presenter broker must use
    // the namespace advertised by the server, rather than the visible code.
    await host.evaluate(() => {
      const saved = JSON.parse(sessionStorage.getItem('flashview-host')!);
      delete saved.cacheId;
      sessionStorage.setItem('flashview-host', JSON.stringify(saved));
    });
    await host.reload();
    await host.locator('.connection.connected').waitFor();
    await host.locator('.document-row .cache-ring[aria-valuenow="100"]').waitFor();
    assert.equal(await cacheIdentity(host), session.cacheId);
    const previewKey = session.cacheId + '/' + fileId;
    await transferWait(host, key => (window as typeof window & { __previewKeys?: string[] })
      .__previewKeys?.includes(key), previewKey);
    const previewReads = await transferEval(host, () =>
      (window as typeof window & { __previewKeys?: string[] }).__previewKeys ?? []);
    assert.ok(previewReads.every(key => key === previewKey), 'Preview lookup cannot fall back to a reused code');
    const downloading = host.waitForEvent('download');
    await host.getByRole('button', { name: 'Download isolated.bin' }).click();
    const saved = await downloading;
    assert.equal(createHash('sha256').update(await readFile((await saved.path())!)).digest('hex'),
      createHash('sha256').update(original).digest('hex'));
    assert.equal(await host.locator('.document-thumb-image[src="old-room-preview"]').count(), 0);
    await host.getByRole('button', { name: 'End room', exact: true }).click();
    await host.getByRole('button', { name: 'End & clear cache', exact: true }).click();
    await host.locator('.welcome').waitFor();
    assert.equal(await lifecycleCacheCount(host, session.cacheId), 0);
    for (const room of [session.code, foreignCache]) {
      assert.equal(await lifecycleCacheCount(host, room), Math.ceil(original.length / 65536),
        'Cleanup preserves other generations and legacy bytes');
      const preview = await host.evaluate(room => new Promise<unknown>((resolve, reject) => {
        const request = indexedDB.open('flashview-room-cache');
        request.onsuccess = () => {
          const db = request.result;
          const get = db.transaction('previews', 'readonly').objectStore('previews').index('room').get(room);
          get.onsuccess = () => { resolve(get.result?.dataUrl); db.close(); }; get.onerror = () => reject(get.error);
        };
        request.onerror = () => reject(request.error);
      }), room);
      assert.equal(preview, 'old-room-preview');
    }
  } finally { await browser.close(); child.kill(); }
});

test('room cache identity: legacy rooms keep original bytes when lease metadata is upgraded', { timeout: 50000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage({ acceptDownloads: true });
  const student = await browser.newPage();
  try {
    const root = 'http://127.0.0.1:' + port;
    // Simulate creation by the previous client. The real backend must pin this
    // room's old cache format even after a new client adopts lease credentials.
    await host.route('**/api/rooms?*', async route => {
      const url = new URL(route.request().url()); url.searchParams.delete('cache');
      await route.fulfill({ response: await route.fetch({ url: url.href }) });
    });
    await host.goto(root);
    await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const saved = await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!));
    assert.equal(saved.cacheId, saved.code);
    const original = Buffer.from('Legacy original bytes must stay readable after upgrading room leases.');
    await student.goto(root + '/?join=' + encodeURIComponent(saved.joinToken));
    await student.getByRole('button', { name: 'Skip for now', exact: true }).click();
    await student.locator('.student-add-fab:not([disabled])').waitFor();
    await student.locator('input[type=file]').setInputFiles({ name: 'legacy.bin', mimeType: 'application/octet-stream', buffer: original });
    await host.locator('.document-row .cache-ring[aria-valuenow="100"]').waitFor();
    await student.close();
    await host.evaluate(() => {
      const session = JSON.parse(sessionStorage.getItem('flashview-host')!);
      delete session.cacheId; delete session.roomGeneration; delete session.leaseToken;
      sessionStorage.setItem('flashview-host', JSON.stringify(session));
    });
    await host.reload();
    await host.locator('.connection.connected').waitFor();
    await host.locator('.document-row .cache-ring[aria-valuenow="100"]').waitFor();
    const restored = await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!));
    assert.equal(restored.cacheId, saved.code);
    assert.equal(restored.roomGeneration, saved.roomGeneration);
    const downloading = host.waitForEvent('download');
    await host.getByRole('button', { name: 'Download legacy.bin' }).click();
    const download = await downloading;
    assert.deepEqual(await readFile((await download.path())!), original);
    assert.equal(await lifecycleCacheCount(host, saved.code), 1);
    await host.getByRole('button', { name: 'End room', exact: true }).click();
    await host.getByRole('button', { name: 'End & clear cache', exact: true }).click();
    await host.locator('.welcome').waitFor();
    assert.equal(await lifecycleCacheCount(host, saved.code), 0);
  } finally { await browser.close(); child.kill(); }
});

test('room lifecycle: failed/lost end responses preserve cache and resume intent across refresh', { timeout: 50000 }, async t => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage();
  const root = 'http://127.0.0.1:' + port;
  let stage = 'create';
  try {
    await host.goto(root);
    await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    await seedLifecycleCache(host);
    const room = await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!) as {
      code: string; cacheId: string; roomId: string; roomGeneration: string; leaseToken: string;
    });
    stage = 'failed initial close';
    await host.route('**/api/rooms/**/end', route => route.abort());
    await host.getByRole('button', { name: 'End room', exact: true }).click();
    await host.getByRole('button', { name: 'End & clear cache', exact: true }).click();
    await host.getByRole('button', { name: 'Retry end & cleanup', exact: true }).waitFor();
    await host.getByText(/Could not confirm classroom closure/).waitFor();
    assert.equal(await lifecycleCacheCount(host, room.cacheId), 1);
    const intent = await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!));
    assert.equal(intent.closeRequested, true);
    assert.notEqual(intent.serverClosed, true);
    stage = 'restore failed close after refresh';
    await host.reload();
    await host.getByText(/Could not confirm classroom closure/).waitFor();
    assert.equal(await lifecycleCacheCount(host, room.cacheId), 1, 'Refresh retains the uncertain-close cache');
    await host.unroute('**/api/rooms/**/end');
    stage = 'commit close but drop response';
    await host.route('**/api/rooms/**/end', async route => {
      await route.fetch(); // Server commits; its response is lost before the browser receives it.
      await route.abort();
    });
    await host.getByRole('button', { name: 'Retry end & cleanup', exact: true }).click();
    await host.getByText(/Could not confirm classroom closure/).waitFor();
    assert.equal(await lifecycleCacheCount(host, room.cacheId), 1, 'Even a lost successful receipt cannot erase cache early');
    const state = await (await fetch(root + '/api/rooms/' + room.roomId + '/lease', { method: 'POST',
      headers: { Authorization: 'Bearer ' + room.leaseToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomGeneration: room.roomGeneration }) })).json() as { state: string };
    assert.equal(state.state, 'absent', 'The dropped response really followed server closure');
    stage = 'retry confirmed-absent generation';
    await host.unroute('**/api/rooms/**/end');
    await host.getByRole('button', { name: 'Retry end & cleanup', exact: true }).click();
    await host.locator('.welcome').waitFor();
    assert.equal(await lifecycleCacheCount(host, room.cacheId), 0);
    assert.equal(await host.evaluate(() => sessionStorage.getItem('flashview-host')), null);
  } catch (error) {
    t.diagnostic('Lifecycle stage: ' + stage);
    t.diagnostic(await host.evaluate(() => {
      const saved = JSON.parse(sessionStorage.getItem('flashview-host') || '{}');
      return JSON.stringify({ closeRequested: saved.closeRequested, serverClosed: saved.serverClosed,
        welcome: Boolean(document.querySelector('.welcome')),
        alert: document.querySelector('[role="alert"]')?.textContent });
    }).catch(() => 'Page unavailable'));
    throw error;
  } finally { await browser.close(); child.kill(); }
});

test('room lifecycle: failed cache deletion retains its handle and confirmed closure for retry', { timeout: 40000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage();
  try {
    await host.goto('http://127.0.0.1:' + port);
    await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    await seedLifecycleCache(host);
    const code = (await host.locator('.room-code').innerText()).trim();
    const cacheId = await cacheIdentity(host);
    await transferEval(host, () => {
      const original = IDBObjectStore.prototype.delete;
      let fail = true;
      IDBObjectStore.prototype.delete = function (key) {
        if (this.name === 'rooms' && fail) {
          fail = false;
          this.transaction.abort();
          throw Error('Injected room cleanup failure');
        }
        return original.call(this, key);
      };
    });
    await host.getByRole('button', { name: 'End room', exact: true }).click();
    await host.getByRole('button', { name: 'End & clear cache', exact: true }).click();
    await host.getByText(/classroom is closed.*cache could not be cleared/).waitFor();
    assert.equal(await lifecycleCacheCount(host, cacheId), 1);
    assert.equal(await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!).serverClosed), true);
    assert.equal(await host.getByRole('button', { name: 'Keep room open', exact: true }).isDisabled(), true);
    await host.getByRole('button', { name: 'Retry end & cleanup', exact: true }).click();
    await host.locator('.welcome').waitFor();
    assert.equal(await lifecycleCacheCount(host, cacheId), 0, 'Retry really deletes the original room cache');
    assert.equal(await host.evaluate(() => sessionStorage.getItem('flashview-host')), null);
  } finally { await browser.close(); child.kill(); }
});

test('room lifecycle: legacy host sessions upgrade in place and confirmed cleanup resumes offline after refresh', { timeout: 40000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage();
  try {
    await host.goto('http://127.0.0.1:' + port);
    await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    await seedLifecycleCache(host);
    const code = (await host.locator('.room-code').innerText()).trim();
    const cacheId = await cacheIdentity(host);
    await host.evaluate(() => {
      const saved = JSON.parse(sessionStorage.getItem('flashview-host')!);
      delete saved.roomGeneration; delete saved.leaseToken;
      sessionStorage.setItem('flashview-host', JSON.stringify(saved));
    });
    await host.reload();
    await host.locator('.connection.connected').waitFor();
    await host.waitForFunction(() => Boolean(JSON.parse(sessionStorage.getItem('flashview-host')!).leaseToken));
    assert.equal((await host.locator('.room-code').innerText()).trim(), code);
    assert.equal(await lifecycleCacheCount(host, cacheId), 1, 'Upgrading credentials preserves existing cached bytes');
    await transferEval(host, () => {
      const original = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function (key) {
        if (this.name === 'rooms') { this.transaction.abort(); throw Error('Injected cleanup failure'); }
        return original.call(this, key);
      };
    });
    await host.getByRole('button', { name: 'End room', exact: true }).click();
    await host.getByRole('button', { name: 'End & clear cache', exact: true }).click();
    await host.getByText(/classroom is closed.*cache could not be cleared/).waitFor();
    assert.equal(await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!).serverClosed), true);
    await host.route('**/api/rooms/**', route => route.abort());
    await host.reload();
    await host.locator('.welcome').waitFor();
    assert.equal(await lifecycleCacheCount(host, cacheId), 0, 'Confirmed closure permits local cleanup without any control connection');
  } finally { await browser.close(); child.kill(); }
});

test('room lifecycle: hidden host and visible presenter renew separately; bridge survives two-hour clock advance', { timeout: 60000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage();
  const student = await browser.newPage();
  const root = 'http://127.0.0.1:' + port;
  let hostLeases = 0;
  let presenterLeases = 0;
  host.on('request', request => { if (request.url().endsWith('/lease')) hostLeases++; });
  host.context().on('request', request => {
    if (request.url().endsWith('/lease') && request.frame().page() !== host) presenterLeases++;
  });
  try {
    await host.clock.install();
    await host.goto(root);
    await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const invite = await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!).joinToken as string);
    await student.goto(root + '/?join=' + encodeURIComponent(invite));
    await student.getByRole('button', { name: 'Skip for now', exact: true }).click();
    await student.locator('.student-add-fab:not([disabled])').waitFor();
    await student.locator('input[type=file]').setInputFiles({ name: 'lease.pdf', mimeType: 'application/pdf', buffer: makePdf(1) });
    const card = host.locator('.document-row').filter({ hasText: 'lease.pdf' });
    await card.locator('.cache-ring.is-complete').waitFor();
    const guestLeaseReady = host.context().waitForEvent('response', { predicate: response =>
      response.url().endsWith('/lease') && response.request().frame().page() !== host && response.status() === 200 });
    const [presenter] = await Promise.all([waitForPresenterPopup(host), card.getByRole('button', { name: 'Present lease.pdf' }).click()]);
    await presenter.waitForFunction(() => Boolean(document.querySelector('canvas[data-rendered-page="1"]')));
    await (await guestLeaseReady).finished();
    assert.equal(await presenter.evaluate(() => sessionStorage.getItem('flashview-host')), null,
      'Presenter receives no copy of dashboard host credentials');
    await student.close();
    await host.evaluate("Object.defineProperty(document, 'visibilityState', { configurable: true, get() { return 'hidden'; } }); document.dispatchEvent(new Event('visibilitychange'));");
    const before = hostLeases;
    await host.clock.fastForward('02:01:00');
    for (let attempt = 0; attempt < 50 && hostLeases <= before; attempt++) await delay(20);
    assert.ok(hostLeases > before, 'Hidden dashboard still issues its independent renewal');
    // A fresh metadata handshake proves the host bridge is still listening;
    // an already-buffered PDF alone could conceal a silently closed channel.
    const bridge = await presenter.evaluate(`new Promise((resolve, reject) => {
      const channel = new BroadcastChannel('flashview-present-' + location.hash.slice(1));
      const timeout = setTimeout(() => { channel.close(); reject(Error('Presenter bridge stopped')); }, 3000);
      channel.onmessage = ({ data }) => {
        if (data.type !== 'metadata') return;
        clearTimeout(timeout); channel.close();
        resolve({ leaseKeys: Object.keys(data.lease || {}).sort(), hostToken: data.hostToken });
      };
      channel.postMessage({ type: 'ready' });
    })`) as { leaseKeys: string[]; hostToken?: string };
    assert.deepEqual(bridge.leaseKeys, ['leaseToken', 'roomGeneration', 'roomId']);
    assert.equal(bridge.hostToken, undefined);
    await presenter.evaluate(() => window.dispatchEvent(new Event('focus')));
    for (let attempt = 0; attempt < 50 && presenterLeases < 2; attempt++) await delay(20);
    assert.ok(presenterLeases >= 2, 'Presenter renews independently of hidden socket heartbeats');
    await presenter.getByRole('spinbutton', { name: 'Page number' }).fill('10');
    await presenter.getByRole('spinbutton', { name: 'Page number' }).press('Enter');
    await presenter.waitForFunction(() => Boolean(document.querySelector('canvas[data-rendered-page="10"]')));
  } finally { await browser.close(); child.kill(); }
});

test('home branding and end-room dialog: no header, responsive warning and direct cache cleanup', { timeout: 30000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, reducedMotion: 'reduce' });
  try {
    await page.goto('http://127.0.0.1:' + port);
    await page.locator('.home-wordmark').waitFor();
    assert.equal(await page.locator('.site-header, nav, .nav-start').count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'WarpView', exact: true, level: 1 }).count(), 1);
    assert.equal(await page.getByText('From your phone, onto the big screen.', { exact: true }).count(), 0);
    assert.equal(await page.locator('.home-wordmark').innerText(), 'warpview');
    assert.equal(await page.locator('.home-wordmark').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    for (const width of [1440, 1280, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const geometry = await page.evaluate(() => {
        const brand = document.querySelector('.home-wordmark')!.getBoundingClientRect();
        const card = document.querySelector('.reference-actions')!.getBoundingClientRect();
        const sky = document.querySelector('.reference-welcome>.reference-sky')!.getBoundingClientRect();
        const accents = [...document.querySelectorAll('.hero-accent')].map(el => el.getBoundingClientRect());
        return { center: brand.x + brand.width / 2, cardCenter: card.x + card.width / 2, gap: card.top - brand.bottom,
          verticalCenterError: Math.abs(brand.y + brand.height / 2 - (sky.top + card.top) / 2),
          accentsVisible: accents.some(icon => icon.width > 0 && icon.height > 0),
          font: parseFloat(getComputedStyle(document.querySelector('.home-wordmark')!).fontSize),
          overlapping: accents.some(icon => icon.left < card.right && icon.right > card.left && icon.top < card.bottom && icon.bottom > card.top),
          overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.ok(Math.abs(geometry.center - width / 2) < 2, 'Brand stays centered');
      assert.ok(Math.abs(geometry.cardCenter - width / 2) < 2, 'Room controls stay centered');
      assert.ok(geometry.gap >= 32 && geometry.font >= 64, 'Large brand sits clearly above the room card');
      assert.ok(geometry.verticalCenterError < 2, 'Brand is vertically centered between the sky top and room card at width ' + width);
      assert.equal(geometry.accentsVisible, width > 760, 'Phone layouts hide illustrations');
      assert.equal(geometry.overlapping, false, 'Illustrations never cover the room controls at width ' + width);
      assert.equal(geometry.overflow, false);
    }
    assert.equal(await page.locator('.home-wordmark').evaluate(el => getComputedStyle(el).color), 'rgb(255, 255, 255)');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    assert.equal(await page.locator('.home-wordmark').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.getByRole('button', { name: /Create a room/ }).click();
    await page.locator('.connection.connected').waitFor();
    await seedLifecycleCache(page);
    const room = await page.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!).cacheId as string);
    await page.getByRole('button', { name: 'End room', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Room files will be deleted.' });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('checkbox').count(), 0);
    assert.equal(await dialog.getByRole('button', { name: 'End & clear cache', exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Keep room open', exact: true }).evaluate(el => el === document.activeElement), true);
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      const box = await dialog.boundingBox();
      assert.ok(box && box.x >= 16 && box.x + box.width <= width - 16 && box.y >= 16 && box.y + box.height <= 828);
    }
    await dialog.getByRole('button', { name: 'Keep room open', exact: true }).click();
    assert.equal(await dialog.count(), 0);
    assert.equal(await lifecycleCacheCount(page, room), 1, 'Cancel keeps cached files');
    await page.getByRole('button', { name: 'End room', exact: true }).click();
    await dialog.getByRole('button', { name: 'End & clear cache', exact: true }).click();
    await page.locator('.welcome').waitFor();
    assert.equal(await lifecycleCacheCount(page, room), 0, 'Direct confirmation clears cached files');
  } finally { await browser.close(); child.kill(); }
});

test('real browser: explicit room start, pinned invite, scrolling documents and room switch', { timeout: 70000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const first = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  const second = await browser.newPage();
  const root = 'http://127.0.0.1:' + port;
  try {
    await first.goto(root);
    await first.getByRole('button', { name: /Create a room/ }).waitFor();
    assert.equal(await first.locator('.room-code').count(), 0,
      'Visiting the homepage must not create a classroom automatically');
    await first.reload();
    assert.equal(await first.locator('.room-code').count(), 0,
      'Reloading the welcome page must not create a classroom either');

    assert.equal(await first.locator('.site-header').count(), 0, 'Homepage has no header');
    const background = await first.locator('.reference-sky').evaluate(el => getComputedStyle(el).backgroundImage);
    assert.match(background, /31, 79, 232|#1f4fe8/i,
      'The supplied cobalt-to-pastel sky gradient should remain intact');

    await first.getByRole('button', { name: /Create a room/ }).click();
    await first.locator('.connection.connected').waitFor();
    assert.equal(await first.locator('.site-header').count(), 0, 'Room workspace must have no header');
    assert.equal(await first.locator('.workspace-topline').count(), 0, 'Room breadcrumbs and room-active strip are removed');
    assert.equal(await first.locator('.workspace-invite-heading').count(), 0, 'Sidebar must not have an introductory hero');
    assert.equal(await first.getByRole('heading', { name: 'Shared by', exact: true }).count(), 1);
    const firstCode = (await first.locator('.room-code').textContent())?.trim();
    assert.match(firstCode ?? '', /^\d{6}$/);
    assert.equal(await first.locator('.qr-plate svg').count(), 1);
    const sidebarWordmark = first.locator('.sidebar-brand');
    assert.equal((await sidebarWordmark.innerText()).trim(), 'warpview');
    const wordmarkBox = await sidebarWordmark.boundingBox();
    const qrBox = await first.locator('.qr-plate').boundingBox();
    const brandFontSize = await sidebarWordmark.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    assert.ok(brandFontSize >= 30, 'FlashView wordmark must be visibly prominent');
    assert.ok(wordmarkBox && qrBox && qrBox.y > wordmarkBox.y + wordmarkBox.height,
      'FlashView branding should sit above the QR code');
    assert.ok(wordmarkBox && qrBox &&
      Math.abs((wordmarkBox.x + wordmarkBox.width / 2) - (qrBox.x + qrBox.width / 2)) < 3,
      'FlashView wordmark should be horizontally centered on the QR code');
    assert.ok(wordmarkBox && qrBox && qrBox.y - (wordmarkBox.y + wordmarkBox.height) >= 14 &&
      qrBox.y - (wordmarkBox.y + wordmarkBox.height) <= 54,
      'Wordmark and QR should have calm but compact visual separation');
    const left = first.locator('.workspace-left');
    const right = first.getByTestId('documents-scroll-region');
    const leftBefore = await left.boundingBox();
    assert.ok(leftBefore && leftBefore.width > 250);
    assert.ok(leftBefore && Math.abs(leftBefore.y - 22) < 3,
      'The reference v8 classroom has a 22px outside gutter');
    const docHeading = await right.getByRole('heading', { name: /^Files/ }).boundingBox();
    assert.ok(docHeading && leftBefore && docHeading.x >= leftBefore.x + leftBefore.width,
      'Documents should occupy the area to the right of the full-height sidebar');
    await first.getByRole('button', { name: 'List view' }).click();
    assert.equal(await first.locator('.document-grid.is-list').count(), 1,
      'Reference v8 list toggle should switch the real file queue');
    await first.getByRole('button', { name: 'Grid view' }).click();
    assert.equal(await first.locator('.document-grid.is-list').count(), 0);
    const copy = await first.getByRole('button', { name: /Copy link/ }).boundingBox();
    const end = await first.getByRole('button', { name: /End room/ }).boundingBox();
    assert.ok(copy && end && Math.abs(copy.y - end.y) < 4,
      'Copy link and End room should share a row');
    assert.equal(await first.getByRole('button', { name: /Join another room/ }).count(), 0,
      'Room-switch controls were deliberately removed from the host sidebar');

    await right.evaluate(el => {
      const list = el.querySelector('.document-list')!;
      for (let index = 0; index < 32; index++) {
        const row = document.createElement('div');
        row.className = 'test-placeholder-file';
        row.style.height = '84px';
        row.textContent = 'Visual overflow fixture ' + index;
        list.appendChild(row);
      }
      el.scrollTop = el.scrollHeight;
    });
    const scrollInfo = await right.evaluate(el => ({ top: el.scrollTop, client: el.clientHeight, scroll: el.scrollHeight }));
    const leftAfter = await left.boundingBox();
    assert.ok(scrollInfo.top > 0 && scrollInfo.scroll > scrollInfo.client, 'Only documents pane should scroll');
    assert.ok(leftAfter && Math.abs(leftAfter.y - leftBefore.y) < 2,
      'QR invitation panel must remain fixed while document list scrolls');
    assert.equal(await first.evaluate(() => window.scrollY), 0,
      'The host document list must not move the whole viewport');

    await first.reload();
    await first.locator('.connection.connected').waitFor();
    assert.equal((await first.locator('.room-code').textContent())?.trim(), firstCode,
      'Refreshing the active classroom must reuse its room');

    await second.goto(root);
    await second.getByRole('button', { name: /Create a room/ }).click();
    await second.locator('.connection.connected').waitFor();
    const secondCode = (await second.locator('.room-code').textContent())?.trim();
    assert.match(secondCode ?? '', /^\d{6}$/);
    assert.notEqual(firstCode, secondCode);

    assert.equal(await first.locator('.room-code').innerText(), firstCode,
      'Creating another room must not switch or abandon the active host room');
    assert.equal(await first.locator('#switch-code').count(), 0,
      'Removed room switch dialog must not be mounted');
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
});

test('open rooms auto-admit guests, show only their own PDFs, and expose a light two-column grid', { timeout: 85000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage({ viewport: { width: 1360, height: 850 } });
  const first = await browser.newPage({ viewport: { width: 390, height: 820 } });
  const second = await browser.newPage({ viewport: { width: 390, height: 820 } });
  const root = 'http://127.0.0.1:' + port;
  try {
    await host.goto(root);
    assert.equal(await host.getByLabel('Require approval').isChecked(), false,
      'Rooms must be open to link holders by default');
    await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    assert.equal(await host.locator('.room-admission-status').count(), 0,
      'Admission settings are shown only before room creation');
    const code = (await host.locator('.room-code').innerText()).trim();
    for (const [page, username] of [[first,'Alice'],[second,'Bob']] as const) {
      await page.goto(root);
      await page.locator('#code').fill(code);
      await page.locator('#student-name').fill(username);
      await page.getByRole('button', { name: /Join room/ }).click();
      await page.locator('.student-drive').waitFor();
      assert.equal(await page.locator('.student-drive').count(), 1);
      assert.equal(await page.locator('.upload-target').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Add files' }).count(), 1);
    }
    assert.equal(await host.locator('.sidebar-participants .approval').count(), 0,
      'Open room guests should not require host approval');
    await first.locator('input[type=file]').setInputFiles([
      { name: 'private-alice.pdf', mimeType: 'application/pdf', buffer: makePdf(250) },
      { name: 'another-alice.pdf', mimeType: 'application/pdf', buffer: makePdf(150) },
    ]);
    await first.locator('.student-file-card').nth(1).waitFor();
    assert.equal(await first.locator('.student-file-card').count(), 2);
    const widthInfo = await first.locator('.student-files-grid').evaluate(element => ({
      columns: getComputedStyle(element).gridTemplateColumns.split(' ').length,
      background: getComputedStyle(document.querySelector('.student-drive')!).backgroundColor,
    }));
    assert.equal(widthInfo.columns, 2, 'Mobile view should fit exactly two cards per row');
    assert.equal(widthInfo.background, 'rgb(243, 247, 254)', 'Student room adopts the reference light-blue page');
    await host.locator('.document-row').filter({ hasText: 'private-alice.pdf' }).waitFor();
    assert.equal(await second.locator('.student-file-card').count(), 0,
      'A different student must not see Alice’s files');
    await first.locator('.student-file-card .transfer-ring[aria-valuenow="100"]').first()
      .waitFor({ timeout: 25000 });
    await first.waitForFunction(() =>
      document.querySelectorAll('.student-file-card .transfer-ring[aria-valuenow="100"]').length === 2,
      null, { timeout: 25000 });
    const hostBg = await host.locator('.workspace-right').evaluate(e => getComputedStyle(e).backgroundColor);
    assert.notEqual(hostBg, 'rgb(16, 17, 21)', 'Host document pane should have a light background');
    const longName = 'this-is-a-particularly-long-file-name-that-should-not-overflow-the-card.pdf';
    await first.locator('input[type=file]').setInputFiles({
      name: longName, mimeType: 'application/pdf', buffer: makePdf(120),
    });
    await first.locator('.student-file-card').filter({ hasText: longName }).waitFor();
    const typography = await first.locator('.student-file-card').filter({ hasText: longName })
      .locator('.student-file-info strong').evaluate(e => ({
        whiteSpace: getComputedStyle(e).whiteSpace,
        overflow: getComputedStyle(e).overflow,
        textOverflow: getComputedStyle(e).textOverflow,
        paddingRight: getComputedStyle(e).paddingRight,
      }));
    assert.equal(typography.textOverflow, 'ellipsis');
    assert.equal(typography.overflow, 'hidden');
    assert.ok(parseFloat(typography.paddingRight) >= 9);
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
});

test('real browser: QR-equivalent room flow renders PDF.js page through WebSocket relay', { timeout: 90000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage();
  const student = await browser.newPage();
  // Record the current WebSocket in the student's browser without adding a production debug API.
  await transferInit(student, { content: `
    (() => {
      const Original = window.WebSocket;
      window.__flashviewSockets = [];
      window.WebSocket = new Proxy(Original, {
        construct(target, args) {
          const ws = Reflect.construct(target, args);
          window.__flashviewSockets.push(ws);
          return ws;
        }
      });
    })();
  ` });
  const root = 'http://127.0.0.1:' + port;
  const browserLogs: string[] = [];
  const presenters: Page[] = [];
  host.on('popup', page => {
    presenters.push(page);
    page.on('pageerror', err => browserLogs.push('presenter JS ERROR: ' + err.message));
    page.on('console', m => { if (m.type() === 'error') browserLogs.push('presenter console: ' + m.text()); });
  });
  host.on('pageerror', error => browserLogs.push('host JS ERROR: ' + error.message));
  student.on('pageerror', error => browserLogs.push('student JS ERROR: ' + error.message));
  host.on('console', message => { if (message.type() === 'error') browserLogs.push('host CONSOLE: ' + message.text()); });
  student.on('console', message => { if (message.type() === 'error') browserLogs.push('student CONSOLE: ' + message.text()); });
  try {
    await host.goto(root);
    if (!process.env.FLASHVIEW_BACKEND) {
      await mkdir('test-artifacts/ui', { recursive: true });
      await host.screenshot({ path: 'test-artifacts/ui/welcome.png', fullPage: true });
    }
    await host.getByLabel('Require approval').check();
    await host.getByRole('button', { name: /Create a room/ }).click();
    const roomCode = await host.locator('.room-code').textContent();
    assert.match(roomCode ?? '', /^\d{6}$/);
    await host.locator('.connection.connected').waitFor();
    await student.goto(root);
    await student.locator('#code').fill(roomCode!);
    await student.locator('#student-name').fill('Chromium Tester');
    await student.getByRole('button', { name: /Join room/ }).click();

    await host.locator('.approval').filter({ hasText: 'Chromium Tester' }).waitFor();
    await host.locator('.approval').filter({ hasText: 'Chromium Tester' }).getByRole('button', { name: 'Allow' }).click();
    await student.locator('.student-drive').waitFor();

    await student.locator('input[type=file]').setInputFiles({
      name: 'smoke.pdf',
      mimeType: 'application/pdf',
      buffer: makePdf(),
    });
    await host.locator('.document-row').filter({ hasText: 'smoke.pdf' }).waitFor();
    // Previews have a stable ratio and a card-colored bezel. Loading a JPEG
    // must not change the reserved preview space.
    const card = host.locator('.document-row').filter({ hasText: 'smoke.pdf' });
    const tile = await card.boundingBox();
    const swatch = await card.evaluate(element => {
      const visual=element.querySelector('.document-card-visual')!;
      return {
        height: visual.getBoundingClientRect().height,
        ratio: getComputedStyle(visual).aspectRatio,
        bezel: getComputedStyle(visual).marginLeft,
        background: getComputedStyle(element.querySelector('.document-thumb')!).backgroundColor,
      };
    });
    assert.ok(tile && tile.width > 170 && tile.height > 170, 'Reference gallery cards need readable dimensions');
    assert.ok(swatch.height >= 128, 'Preview remains large enough to read');
    assert.equal(swatch.ratio, '16 / 10');
    assert.equal(swatch.bezel, '6px');
    assert.notEqual(swatch.background, 'rgba(0, 0, 0, 0)');
    // Rendering on the sender is independent: diagnose phone rendering
    // before checking delivery to the host, especially on Firefox.
    const localPreview = student.locator('.student-file-card').filter({ hasText: 'smoke.pdf' })
      .locator('img.student-file-preview');
    await localPreview.waitFor({ timeout: 20000 });
    assert.ok(await localPreview.evaluate(node => (node as HTMLImageElement).naturalWidth > 100));
    // The smaller local JPEG should also reach the host without delaying PDF bytes.
    try {
      await card.locator('img.document-thumb-image.is-visible').waitFor({ timeout: 20000 });
    } catch (error) {
      // Separate a missing relay message from an image decode failure,
      // particularly on Firefox's headless mobile-sender simulation.
      const hostPreview = await card.evaluate(el => ({
        image: Boolean(el.querySelector('img.document-thumb-image')),
        fallback: Boolean(el.querySelector('.document-pdf-symbol')),
        spinner: Boolean(el.querySelector('.document-thumb-spinner')),
      }));
      const phonePreview = await localPreview.evaluate(el => ({
        bytes: (el as HTMLImageElement).src.length,
        width: (el as HTMLImageElement).naturalWidth,
      }));
      console.log('PREVIEW_DIAGNOSTICS', { hostPreview, phonePreview });
      throw error;
    }
    assert.equal(await card.locator('img.document-thumb-image').evaluate(
      image => (image as HTMLImageElement).naturalWidth > 100), true);
    assert.equal(await card.locator('.document-thumb-spinner').count(), 0,
      'The loader disappears as the first slide fades in');
    assert.doesNotMatch(await card.innerText(), /Fully cached|ready offline|Downloading PDF/,
      'Cache status must not clutter the card body');
    if (!process.env.FLASHVIEW_BACKEND) {
      // Locator waits can scroll the test viewport. Reset before full-page
      // captures so sticky navigation isn't composited halfway down the page.
      await host.evaluate(() => window.scrollTo(0, 0));
      await student.evaluate(() => window.scrollTo(0, 0));
      await host.screenshot({ path: 'test-artifacts/ui/classroom.png', fullPage: true });
      await student.screenshot({ path: 'test-artifacts/ui/student.png', fullPage: true });
    }
    // Student approval also approves each new PDF automatically.
    await student.locator('.student-file-card').filter({ hasText: 'smoke.pdf' })
      .locator('.transfer-ring').waitFor();
    // Cache starts before presenting and its ring is readable to assistive technology.
    await host.locator('.document-row').filter({ hasText: 'smoke.pdf' })
      .locator('.cache-ring[role="progressbar"]').waitFor({ timeout: 15000 });
    const [presentation] = await Promise.all([
      waitForPresenterPopup(host),
      host.locator('.document-row').getByRole('button', { name: /Present/ }).click(),
    ]);
    // Teacher's queue remains available while the PDF is projected.
    assert.equal(await host.locator('.document-row').count(), 1);
    // Projector view must be truly black around the actual PDF.
    assert.equal(await presentation.locator('.viewer-toolbar, .viewer-footer, .viewer-filename').count(), 0,
      'Only the bottom-right controls remain; document identity and cache details are removed');
    const stageColor = await presentation.locator('.page-stage')
      .evaluate(element => getComputedStyle(element).backgroundColor);
    assert.equal(stageColor, 'rgb(0, 0, 0)');
    await presentation.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.page-shell canvas');
      return Boolean(canvas && canvas.width >= 500 && canvas.height >= 700 &&
        canvas.dataset.renderedPage === '1' && !document.querySelector('.viewer-alert'));
    }, null, { timeout: 20000 });
    await presentation.locator('.presentation-transition').waitFor({state:'hidden'});
    const initialFit = await presentation.locator('.page-shell canvas').evaluate(element => {
      const canvas = element.getBoundingClientRect(), stage = document.querySelector('.page-stage')!;
      return Math.abs(canvas.width - (stage.clientWidth - 24)) < 3 ||
        Math.abs(canvas.height - (stage.clientHeight - 12)) < 3;
    });
    assert.equal(initialFit, true, 'The first visible PDF page is already fitted');
    await swipePreview(presentation, '.page-stage', -160);
    await presentation.waitForFunction(() => document.querySelector('canvas[data-rendered-page="2"]'));
    await swipePreview(presentation, '.page-stage', 160);
    await presentation.waitForFunction(() => document.querySelector('canvas[data-rendered-page="1"]'));
    const renderedDarkPixels = await presentation.locator('.page-shell canvas').evaluate(canvas => {
      const context = (canvas as HTMLCanvasElement).getContext('2d');
      if (!context) return 0;
      const { width, height } = canvas as HTMLCanvasElement;
      const image = context.getImageData(0, 0, width, height);
      let ink = 0;
      // A valid PDF page has visible black text, not merely an empty canvas.
      for (let y = 0; y < height; y += 4) {
        for (let x = 0; x < width; x += 4) {
          const at = (y * width + x) * 4;
          if (image.data[at] < 120 && image.data[at+1] < 120 && image.data[at+2] < 120) ink++;
        }
      }
      return ink;
    });
    assert.ok(renderedDarkPixels > 3, 'Page 1 should contain actually rendered pixels');
    // Immersive UI: no permanent header, a true full-viewport slide stage and
    // one pill in the lower-right corner. The PDF keeps its correct proportions.
    const projectorLayout = await presentation.evaluate(() => {
      const root = document.querySelector('.viewer')!.getBoundingClientRect();
      const slide = document.querySelector('.page-shell canvas')!.getBoundingClientRect();
      const dock = document.querySelector('.presentation-controls')!.getBoundingClientRect();
      return {
        windowHeight: innerHeight, windowWidth: innerWidth,
        rootHeight: root.height, slideHeight: slide.height,
        dockRight: dock.right, dockBottom: dock.bottom,
        roundedDock: getComputedStyle(document.querySelector('.presentation-controls')!).borderRadius,
        captionCount: document.querySelectorAll('.presentation-caption').length,
      };
    });
    assert.equal(projectorLayout.captionCount, 0);
    assert.ok(Math.abs(projectorLayout.rootHeight - projectorLayout.windowHeight) <= 2,
      'Slide stage should occupy the whole display without top/bottom chrome');
    assert.ok(projectorLayout.slideHeight > projectorLayout.windowHeight * .94,
      'PDF should fit the full available height rather than the old toolbar-constrained area');
    assert.ok(projectorLayout.dockRight > projectorLayout.windowWidth - 38 &&
      projectorLayout.dockBottom > projectorLayout.windowHeight - 38,
      'Presentation control pill must float in the lower-right corner');
    assert.equal(projectorLayout.roundedDock, '999px');

    // Zoom should enlarge the actual rendered PDF, then Reset must fit it again.
    const normalHeight = await presentation.locator('.page-shell canvas')
      .evaluate(el => el.getBoundingClientRect().height);
    await presentation.getByRole('button', { name: 'Zoom in' }).click();
    await presentation.waitForFunction(expected => {
      const canvas = document.querySelector<HTMLCanvasElement>('.page-shell canvas');
      return canvas?.dataset.renderedPage === '1' &&
        canvas.getBoundingClientRect().height > expected * 1.18 &&
        !document.querySelector('.page-overlay');
    }, normalHeight, { timeout: 15000 });
    await presentation.getByRole('button', { name: 'Reset zoom to fit' }).click();
    await presentation.waitForFunction(expected => {
      const canvas = document.querySelector<HTMLCanvasElement>('.page-shell canvas');
      return canvas?.dataset.renderedPage === '1' &&
        Math.abs(canvas.getBoundingClientRect().height - expected) < 2 &&
        !document.querySelector('.page-overlay');
    }, normalHeight, { timeout: 15000 });
    const pagePaint = await presentation.getByRole('spinbutton', { name: 'Page number' }).evaluate(el => {
      const input = getComputedStyle(el), pill = getComputedStyle(el.closest('.presentation-controls')!);
      return { background: input.backgroundColor, border: input.borderTopColor, pill: pill.backgroundColor };
    });
    assert.equal(pagePaint.background, pagePaint.pill);
    assert.equal(pagePaint.border, pagePaint.pill, 'Editable page number blends into the pill');
    assert.equal(await presentation.getByRole('button', { name: 'Close', exact: true }).count(), 1);

    // Native Fullscreen API should engage from the floating pill AND keep a
    // fully painted PDF on-screen. Merely asserting fullscreenElement existed
    // previously missed the real-world "fullscreen goes black" regression.
    if (await presentation.evaluate(() => document.fullscreenEnabled)) {
      await presentation.getByRole('button', { name: 'Fullscreen', exact: true }).click();
      await presentation.waitForFunction(() => document.fullscreenElement !== null, null, { timeout: 10000 });
      await presentation.waitForFunction(() => {
        const wrapper = document.querySelector<HTMLElement>('.viewer');
        const canvas = document.querySelector<HTMLCanvasElement>('.page-shell canvas');
        if (!wrapper || document.fullscreenElement !== wrapper || !canvas ||
            canvas.dataset.renderedPage !== '1') return false;
        const stage = document.querySelector<HTMLElement>('.page-stage');
        if (!stage || stage.clientHeight < innerHeight - 15 ||
            Math.abs(wrapper.getBoundingClientRect().height - innerHeight) > 2) return false;
        const bounds = canvas.getBoundingClientRect();
        if (bounds.width < 200 || bounds.height < 300 ||
            bounds.bottom <= 0 || bounds.top >= innerHeight) return false;
        const context = canvas.getContext('2d');
        if (!context) return false;
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        let ink = 0, paper = 0;
        for (let i = 0; i < data.length; i += 4 * 12) {
          if (data[i] < 130 && data[i+1] < 130 && data[i+2] < 130) ink++;
          if (data[i] > 230 && data[i+1] > 230 && data[i+2] > 230) paper++;
        }
        return ink >= 3 && paper > 200;
      }, null, { timeout: 25000 });
      const immersiveChrome = await presentation.evaluate(() => ({
        toolbarHidden: !document.querySelector('.viewer-toolbar'),
        footerHidden: !document.querySelector('.viewer-footer'),
        pillVisible: getComputedStyle(document.querySelector('.presentation-controls')!).display !== 'none',
      }));
      assert.deepEqual(immersiveChrome, { toolbarHidden: true, footerHidden: true, pillVisible: true },
        'Fullscreen must hide the top-left info and footer, leaving only the control pill');
      if (!process.env.FLASHVIEW_BACKEND) {
        await presentation.screenshot({ path: 'test-artifacts/ui/presentation-fullscreen.png' });
      }
      await presentation.getByRole('button', { name: 'Exit fullscreen' }).click();
      await presentation.waitForFunction(() => document.fullscreenElement === null, null, { timeout: 10000 });
      await presentation.waitForFunction(() =>
        document.querySelector<HTMLCanvasElement>('canvas[data-rendered-page="1"]') !== null,
        null, { timeout: 12000 });
    }
    if (!process.env.FLASHVIEW_BACKEND) {
      await presentation.screenshot({ path: 'test-artifacts/ui/presentation.png' });
    }
    assert.equal(await presentation.locator('.viewer-filename').count(), 0);
    assert.equal(await presentation.locator('.viewer-alert').count(), 0);
    // Regression: moving around the PDF and waiting past the old 30s watchdog
    // must not destroy the successfully opened PDF document.
    await presentation.getByRole('spinbutton', { name: 'Page number' }).fill('10');
    await presentation.getByRole('spinbutton', { name: 'Page number' }).press('Enter');
    await presentation.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.page-shell canvas');
      return Boolean(canvas?.dataset.renderedPage === '10' &&
        !document.querySelector('.page-overlay') && !document.querySelector('.viewer-alert'));
    }, null, { timeout: 20000 });
    await host.locator('.document-row .cache-ring[aria-valuenow="100"]').first().waitFor({ timeout: 15000 });
    assert.equal(await host.locator('.document-row .cache-ring.is-complete path').count(), 1,
      'Cached files show a complete circular ring with a tick');
    await delay(process.env.FLASHVIEW_BACKEND === 'cloudflare' ? 350 : 31_200);
    assert.equal(await presentation.locator('.viewer-alert').count(), 0);
    await presentation.getByRole('spinbutton', { name: 'Page number' }).fill('1');
    await presentation.getByRole('spinbutton', { name: 'Page number' }).press('Enter');
    await presentation.waitForFunction(() =>
      !document.querySelector('.page-overlay') && !document.querySelector('.viewer-alert'),
      null, { timeout: 20000 });
    await presentation.setViewportSize({ width: 375, height: 812 });
    await assertPresentationDock(presentation);
    if (!process.env.FLASHVIEW_BACKEND)
      await presentation.screenshot({ path: 'test-artifacts/ui/presentation-mobile.png' });
    await Promise.all([presentation.waitForEvent('close'),
      presentation.getByRole('button', { name: 'Close', exact: true }).click()]);
    assert.equal(await host.locator('.document-row').count(), 1);

    // Simulate exactly what happens when a mobile browser drops the connection.
    // No teacher reapproval or file reselection should be needed on recovery.
    await transferEval(student, () => {
      const record = window as typeof window & { __flashviewSockets?: WebSocket[] };
      const ws = record.__flashviewSockets?.at(-1);
      if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Expected an open WebSocket');
      ws.close(4100, 'Simulated mobile tab background');
    });
    await transferWait(student, () => {
      const record = window as typeof window & { __flashviewSockets?: WebSocket[] };
      const sockets = record.__flashviewSockets ?? [];
      return sockets.length >= 2 && sockets.at(-1)?.readyState === WebSocket.OPEN;
    }, undefined, 20000);
    await student.locator('.student-drive').waitFor();
    assert.match(await student.locator('.student-file-card').first().innerText(), /smoke\.pdf/);

    // Drop exactly ONE student announcement while the WebSocket still reports OPEN.
    // The sender must not claim server acceptance; sync repairs the lost offer.
    await transferEval(student, () => {
      const record = window as typeof window & { __flashviewSockets?: WebSocket[] };
      const ws = record.__flashviewSockets?.at(-1);
      if (!ws) throw Error('Missing student WebSocket');
      const original = ws.send.bind(ws);
      let dropOnce = true;
      ws.send = ((data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
        if (dropOnce && typeof data === 'string') {
          const message = JSON.parse(data) as { type?: string };
          if (message.type === 'file.offer') {
            dropOnce = false;
            return;
          }
        }
        original(data);
      }) as WebSocket['send'];
    });
    await student.locator('input[type=file]').setInputFiles({
      name: 'lost-announcement.pdf', mimeType: 'application/pdf', buffer: makePdf(),
    });
    await student.locator('.student-file-card').filter({ hasText: 'lost-announcement.pdf' })
      .getByText('Preparing…').waitFor();
    assert.equal(await host.locator('.document-row').count(), 1);
    // A tab returning online asks the server for its authoritative manifest.
    await student.evaluate(() => window.dispatchEvent(new Event('online')));
    await host.locator('.document-row').filter({ hasText: 'lost-announcement.pdf' }).waitFor({ timeout: 15000 });
    await student.locator('.student-file-card').filter({ hasText: 'lost-announcement.pdf' })
      .locator('.transfer-ring[aria-valuenow="100"]').waitFor({ timeout: 15000 });
    // Reference v8 removes the extra Refresh button; the existing
    // foreground wake/sync path still repairs missed host broadcasts.
    await host.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert.equal(await host.locator('.document-row').count(), 2);
    await host.locator('.document-row').filter({ hasText: 'lost-announcement.pdf' })
      .locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 15000 });

    const [secondPresentation] = await Promise.all([
      waitForPresenterPopup(host),
      host.locator('.document-row').filter({ hasText: 'smoke.pdf' }).getByRole('button', { name: /Present/ }).click(),
    ]);
    await secondPresentation.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.page-shell canvas');
      return Boolean(canvas && canvas.dataset.renderedPage === '1' && !document.querySelector('.viewer-alert'));
    }, null, { timeout: 20000 });
    await secondPresentation.close();
    // Closing the presentation must not close the classroom or remove the queue.
    assert.equal(await host.locator('.document-row').count(), 2);
    assert.equal(await host.locator('.connection.connected').count(), 1);

    // Prove that a completed cache works after the student is entirely offline
    // and the original host page has been reloaded.
    await student.close();
    await host.locator('.document-row').filter({ hasText: 'smoke.pdf' })
      .locator('.cache-ring[aria-valuenow="100"]').waitFor();
    await host.reload();
    await host.locator('.connection.connected').waitFor();
    await host.locator('.document-row').filter({ hasText: 'smoke.pdf' })
      .locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 12000 });
    const [offlinePresentation] = await Promise.all([
      waitForPresenterPopup(host),
      host.locator('.document-row').filter({ hasText: 'smoke.pdf' })
        .getByRole('button', { name: /Present/ }).click(),
    ]);
    await offlinePresentation.waitForFunction(() =>
      Boolean(document.querySelector('canvas[data-rendered-page="1"]')) && !document.querySelector('.viewer-alert'),
      null, { timeout: 20000 });
    await offlinePresentation.getByRole('spinbutton', { name: 'Page number' }).fill('10');
    await offlinePresentation.getByRole('spinbutton', { name: 'Page number' }).press('Enter');
    await offlinePresentation.waitForFunction(() =>
      Boolean(document.querySelector('canvas[data-rendered-page="10"]')) && !document.querySelector('.viewer-alert'),
      null, { timeout: 20000 });
    await offlinePresentation.close();

    const cachedRoom = await cacheIdentity(host);
    const countRoomChunks = async () => host.evaluate(room => new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('flashview-room-cache');
      request.onsuccess = () => {
        const tx = request.result.transaction('chunks', 'readonly');
        const count = tx.objectStore('chunks').index('room').count(IDBKeyRange.only(room));
        count.onsuccess = () => resolve(count.result);
        count.onerror = () => reject(count.error);
      };
      request.onerror = () => reject(request.error);
    }), cachedRoom);
    assert.ok(await countRoomChunks() >= 3, 'Expected cached PDF chunks');
    await host.getByRole('button', { name: /End room/ }).click();
    await host.getByRole('button', { name: /End & clear cache/ }).isEnabled().then(x => assert.equal(x, true));
    await host.getByRole('button', { name: /End & clear cache/ }).click();
    await host.getByRole('button', { name: /Create a room/ }).waitFor();
    assert.equal(await countRoomChunks(), 0, 'Ending the room must purge its IndexedDB bytes');
  } catch (e) {
    const hostState = await host.evaluate(() => ({
      alert: document.querySelector('.viewer-alert')?.textContent,
      loading: document.querySelector('.page-loading')?.textContent,
      overlay: document.querySelector('.page-overlay')?.textContent,
      filename: document.querySelector('.viewer-filename')?.textContent,
      canvasWidth: document.querySelector<HTMLCanvasElement>('canvas')?.width,
      documentRow: document.querySelector('.document-row')?.textContent,
      text: document.body.innerText.slice(0, 1600),
    })).catch(reason => ({ error: String(reason) }));
    const studentState = await student.evaluate(() => ({
      text: document.body.innerText.slice(0, 1400),
    })).catch(reason => ({ error: String(reason) }));
    const presenterStates = await Promise.all(presenters.map(page => page.evaluate(() => ({
      href: location.href,
      viewer: document.querySelector('.viewer')?.textContent?.slice(0, 600),
      error: document.querySelector('.viewer-alert')?.textContent,
      stage: document.querySelector('.page-loading')?.textContent,
      overlay: document.querySelector('.page-overlay')?.textContent,
      canvas: document.querySelector('canvas')?.width,
      text: document.body.innerText.slice(0, 1300),
    })).catch(err => ({ failure: String(err) }))));
    console.error('BROWSER_DIAGNOSTICS', JSON.stringify({ hostState, studentState, presenterStates, browserLogs }));
    await mkdir('test-artifacts', { recursive: true });
    await host.screenshot({ path: 'test-artifacts/host-failure.png', fullPage: true }).catch(() => {});
    await student.screenshot({ path: 'test-artifacts/student-failure.png', fullPage: true }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
});


test('PDF renders first page while a multi-megabyte PDF is still transferring', { timeout: 85000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage();
  const student = await browser.newPage();
  // Simulate an overloaded phone/campus relay. PDF.js may need bytes from
  // anywhere in a non-linearized PDF; delay those reads, never block them.
  // Full caching then takes many seconds, leaving time for early page render.
  await transferInit(student, () => {
    const realSlice = File.prototype.slice;
    const realArrayBuffer = Blob.prototype.arrayBuffer;
    const slowed = new WeakSet<Blob>();
    const withheld = new WeakSet<Blob>();
    const waiters: Array<() => void> = [];
    let released = false;
    File.prototype.slice = function (start?: number, end?: number, contentType?: string) {
      const blob = realSlice.call(this, start, end, contentType);
      if (this.name === 'progressive.pdf' && typeof start === 'number') {
        if (start >= 65536) slowed.add(blob);
        // Hold only the final PDF chunk. We explicitly request it as a
        // foreground range; background must keep caching the other chunks.
        const tail = Math.floor((this.size - 1) / 65536) * 65536;
        if (start === tail) withheld.add(blob);
      }
      return blob;
    };
    Blob.prototype.arrayBuffer = async function () {
      if (withheld.has(this) && !released) {
        await new Promise<void>(resolve => waiters.push(resolve));
      }
      if (slowed.has(this)) {
        await new Promise<void>(resolve => setTimeout(resolve, 450));
      }
      return realArrayBuffer.call(this);
    };
    (window as typeof window & { __releaseHeldTail?: () => void }).__releaseHeldTail = () => {
      released = true;
      for (const resolve of waiters.splice(0)) resolve();
    };
  });
  const root = 'http://127.0.0.1:' + port;
  let presentation: Page | null = null;
  try {
    await host.goto(root + '?packet=64');
    await host.getByLabel('Require approval').check();
    await host.getByRole('button', { name: /Create a room/ }).click();
    const code = await host.locator('.room-code').innerText();
    await host.locator('.connection.connected').waitFor();
    await student.goto(root);
    await student.locator('#code').fill(code);
    await student.getByRole('button', { name: /Join room/ }).click();
    await host.locator('.approval').waitFor();
    await host.locator('.approval').getByRole('button', { name: 'Allow' }).click();
    await student.locator('.student-drive').waitFor();

    const pdfBytes = makePdf(35000);
    await student.locator('input[type=file]').setInputFiles({
      name: 'progressive.pdf',
      mimeType: 'application/pdf',
      buffer: pdfBytes,
    });
    const row = host.locator('.document-row').filter({ hasText: 'progressive.pdf' });
    await row.waitFor();
    [presentation] = await Promise.all([
      waitForPresenterPopup(host),
      row.getByRole('button', { name: /Present/ }).click(),
    ]);
    // Exercise a long foreground PDF range request without moving pages.
    // On the original scheduler, an active foreground request HALTED the
    // classroom's background queue until it completed.
    const lastBegin = Math.floor((pdfBytes.length - 1) / 65536) * 65536;
    await presentation.evaluate(({ begin, end }) => {
      const channel = new BroadcastChannel('flashview-present-' + location.hash.slice(1));
      channel.postMessage({ type: 'range', id: 'held-foreground-123', begin, end });
      // Remains open until the presentation tab is closed.
      (window as typeof window & { __testRangeChannel?: BroadcastChannel }).__testRangeChannel = channel;
    }, { begin: lastBegin, end: pdfBytes.length });
    const cachedChunks = async () => host.evaluate(room => new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('flashview-room-cache');
      request.onsuccess = () => {
        const count = request.result.transaction('chunks', 'readonly')
          .objectStore('chunks').index('room').count(IDBKeyRange.only(room));
        count.onsuccess = () => resolve(count.result);
        count.onerror = () => reject(count.error);
      };
      request.onerror = () => reject(request.error);
    }), await cacheIdentity(host));
    // Allow the initial batch already in-flight before the foreground request
    // to drain. The background pump must still fetch MORE chunks after that.
    await delay(1300);
    const before = await cachedChunks();
    await delay(2400);
    const after = await cachedChunks();
    assert.ok(after > before,
      'Background cache must keep advancing while a foreground range remains pending: ' + before + ' -> ' + after);
    // The ring must animate partial completion without exposing noisy numeric text.
    await host.waitForFunction(() => {
      const row = Array.from(document.querySelectorAll('.document-row'))
        .find(el => el.textContent?.includes('progressive.pdf'));
      const value = Number(row?.querySelector('.cache-ring')?.getAttribute('aria-valuenow') ?? 0);
      return value > 0 && value < 100;
    }, null, { timeout: 15000 });
    const partialPercent = Number(await row.locator('.cache-ring').getAttribute('aria-valuenow'));
    assert.ok(partialPercent > 0 && partialPercent < 100);

    // Either real ranged PDF.js rendering or the phone-produced first-slide
    // preview can win the race. Both must visibly show the correct first page
    // while a large background transfer is still incomplete.
    await presentation.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-rendered-page="1"]');
      const jpeg = document.querySelector<HTMLImageElement>('img[data-first-page-preview]');
      return Boolean((canvas || (jpeg && jpeg.complete && jpeg.naturalWidth > 0)) &&
        !document.querySelector('.viewer-alert'));
    }, null, { timeout: 22000 });
    assert.notEqual(await row.locator('.cache-ring').getAttribute('aria-valuenow'), '100',
      'The first slide MUST be visible before background downloading finishes');
    assert.equal(await presentation.locator('.viewer-filename').count(), 0);
    const image = presentation.locator('img[data-first-page-preview]');
    const earlySlideVisible = await image.count() > 0 ||
      await presentation.locator('canvas[data-rendered-page="1"]').count() > 0;
    assert.equal(earlySlideVisible, true, 'The first slide should appear before 100%');

    // For the preview route, ensure the image actually decoded.
    if (await image.count()) {
      assert.equal(await image.evaluate(el => (el as HTMLImageElement).naturalWidth > 200), true);
    }

    // The original sender has only a single deliberately held tail range left.
    // Make the stuck-worker race deterministic: no successful old request may
    // wake the scheduler coincidentally after the second file is announced.
    await row.locator('.cache-ring[aria-valuenow="99"]').waitFor({ timeout: 30000 });
    await delay(750);

    // A second student's small PDF must complete despite that permanently
    // pending range. A new offer MUST itself wake the scheduler; waiting on
    // Promise.race(activeBackground) alone left this second file at 0%.
    const fastStudent = await browser.newPage();
    await fastStudent.goto(root);
    await fastStudent.locator('#code').fill(code);
    await fastStudent.getByRole('button', { name: /Join room/ }).click();
    const fastApproval = host.locator('.approval').filter({ hasText: 'Student' });
    await fastApproval.last().getByRole('button', { name: 'Allow' }).click();
    await fastStudent.locator('.student-drive').waitFor();
    await fastStudent.locator('input[type=file]').setInputFiles({
      name: 'fast-peer.pdf', mimeType: 'application/pdf', buffer: makePdf(),
    });
    await host.locator('.document-row').filter({ hasText: 'fast-peer.pdf' })
      .locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 15000 });
    assert.notEqual(await row.locator('.cache-ring').getAttribute('aria-valuenow'), '100',
      'The deliberately blocked first sender must still be downloading');
    await fastStudent.close();

    // Release the delayed foreground request and the document's cross-ref
    // tail. The original bytes should finish caching without closing the viewer.
    await transferEval(student, () => {
      (window as typeof window & { __releaseHeldTail?: () => void }).__releaseHeldTail?.();
    });
    await row.locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 45000 });
    assert.equal(await row.locator('.cache-ring.is-complete path').count(), 1);
    await presentation.locator('canvas[data-rendered-page="1"]').waitFor({ timeout: 20000 });
    assert.equal(await presentation.locator('.viewer-alert').count(), 0);
  } catch (error) {
    const doc = presentation ? await presentation.evaluate(() => document.body.innerText.slice(0, 1300))
      .catch(reason => String(reason)) : 'No popup';
    const hostText = await host.evaluate(() => document.body.innerText.slice(0, 1300))
      .catch(reason => String(reason));
    console.error('PROGRESSIVE_PDF_DIAGNOSTICS', JSON.stringify({ doc, hostText }));
    throw error;
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
});


test('large PDFs still produce a first-slide preview', { timeout: 75000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage();
  const student = await browser.newPage();
  try {
    const root = 'http://127.0.0.1:' + port;
    await host.goto(root);
    await host.getByLabel('Require approval').check();
    await host.getByRole('button', { name: /Create a room/ }).click();
    const code = await host.locator('.room-code').innerText();
    await host.locator('.connection.connected').waitFor();
    await student.goto(root);
    await student.locator('#code').fill(code);
    await student.getByRole('button', { name: /Join room/ }).click();
    await host.locator('.approval').getByRole('button', { name: 'Allow' }).click();
    await student.locator('.student-drive').waitFor();
    const large = makePdf(110000);
    assert.ok(large.length > 12 * 1024 * 1024);
    await student.locator('input[type=file]').setInputFiles({
      name: 'large-preview.pdf', mimeType: 'application/pdf', buffer: large,
    });
    await host.waitForFunction(async () => {
      const request = indexedDB.open('flashview-room-cache');
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const result = await new Promise<number>((resolve, reject) => {
        const count = db.transaction('previews', 'readonly').objectStore('previews').count();
        count.onsuccess = () => resolve(count.result);
        count.onerror = () => reject(count.error);
      });
      db.close();
      return result > 0;
    }, null, { timeout: 25000 });
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
});


test('Stage 1: a temporarily full student send buffer waits and drains without rejecting PDFs', { timeout: 70000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage();
  const student = await browser.newPage();
  await transferInit(student, () => {
    // Record real native student sockets, but do not alter their behavior
    // during connection, authentication or approval.
    const Native = window.WebSocket;
    const sockets: WebSocket[] = [];
    window.WebSocket = new Proxy(Native, {
      construct(Target, args) {
        const ws = Reflect.construct(Target, args) as WebSocket;
        sockets.push(ws);
        return ws;
      },
    });
    (window as typeof window & { __testSocket?: () => WebSocket | undefined })
      .__testSocket = () => sockets.at(-1);
  });
  try {
    const url = 'http://127.0.0.1:' + port;
    await host.goto(url + '/?perf=1');
    await host.getByLabel('Require approval').check();
    await host.getByRole('button', { name: /Create a room/ }).click();
    const code = await host.locator('.room-code').innerText();
    await host.locator('.connection.connected').waitFor();
    await student.goto(url + '/?perf=1');
    await student.locator('#code').fill(code);
    await student.getByRole('button', { name: /Join room/ }).click();
    await host.locator('.approval').getByRole('button', { name: 'Allow' }).click();
    await student.locator('.student-drive').waitFor();
    const pressureApplied = await transferEval(student, () => {
      const w = window as typeof window & {
        __testSocket?: () => WebSocket | undefined;
        __testSocketReads?: () => number;
      };
      const ws = w.__testSocket?.();
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      let reads = 0;
      const original = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')?.get;
      if (!original) return false;
      const deadline = Date.now() + 3200;
      Object.defineProperty(ws, 'bufferedAmount', {
        configurable: true,
        get() {
          if (Date.now() < deadline) {
            reads++;
            return 5 * 1024 * 1024;
          }
          return original.call(ws);
        },
      });
      w.__testSocketReads = () => reads;
      return ws.bufferedAmount >= 5 * 1024 * 1024;
    });
    assert.equal(pressureApplied, true, 'Simulated backlog must affect the REAL student WebSocket');
    await student.locator('input[type=file]').setInputFiles({
      name: 'temporary-backpressure.pdf', mimeType: 'application/pdf',
      buffer: makePdf(16000),
    });
    await host.locator('.document-row').filter({ hasText: 'temporary-backpressure.pdf' })
      .locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 25000 });
    const samples = await student.evaluate(() =>
      (window as typeof window & {
        __flashviewPerf?: { snapshot: () => { summary: Array<{ metric: string; count: number }> } };
      }).__flashviewPerf?.snapshot().summary ?? []);
    const forcedReads = await transferEval(student, () =>
      (window as typeof window & { __testSocketReads?: () => number }).__testSocketReads?.() ?? 0);
    assert.ok(forcedReads > 1, 'The real sender socket must read the simulated backlog');
    assert.ok(samples.some(s => s.metric === 'sender_backpressure_ms' && s.count > 0),
      'The sender should record that it waited for the simulated busy socket');
    assert.equal(await student.getByText(/Network sender is busy/).count(), 0);
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
});


test('mobile progress recovers missed events from the relay manifest and pill is connection-only', { timeout: 95000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage();
  const student = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const origin = 'http://127.0.0.1:' + port;
  try {
    await transferInit(student, () => {
      const Original = window.WebSocket;
      const scoped = window as typeof window & { __flashviewSockets?: WebSocket[] };
      scoped.__flashviewSockets = [];
      window.WebSocket = new Proxy(Original, {
        construct(target, args) {
          const ws = new target(...(args as [string]));
          scoped.__flashviewSockets!.push(ws);
          return ws;
        },
      });
    });
    await host.goto(origin);
    await host.getByLabel('Require approval').check();
    await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const code = await host.locator('.room-code').textContent();
    await student.goto(origin);
    await student.locator('#code').fill(code!);
    await student.locator('#student-name').fill('Missing Updates');
    await student.getByRole('button', { name: /Join room/ }).click();
    await host.locator('.approval').filter({ hasText: 'Missing Updates' })
      .getByRole('button', { name: 'Allow' }).click();
    await student.locator('.student-drive').waitFor();
    await student.locator('.transfer-pill').waitFor({ state: 'detached' });

    // Deliberately lose BOTH forms of progress delivery. The teacher must
    // still finish caching the exact original PDFs, and a subsequent sync
    // must recover the real counts without depending on host tab timers.
    await transferEval(student, () => {
      const scoped = window as typeof window & {
        __flashviewSockets?: WebSocket[]; __dropManifest?: boolean;
      };
      const ws = scoped.__flashviewSockets?.at(-1);
      if (!ws?.onmessage) throw Error('Student connection not ready');
      scoped.__dropManifest = true;
      const original = ws.onmessage;
      ws.onmessage = event => {
        if (typeof event.data === 'string') {
          const type = (JSON.parse(event.data) as { type?: string }).type;
          if (type === 'cache.progress' || (scoped.__dropManifest && type === 'file.manifest')) return;
        }
        original.call(ws, event);
      };
    });
    await student.locator('input[type=file]').setInputFiles([
      { name: 'small.pdf', mimeType: 'application/pdf', buffer: makePdf(120) },
      { name: 'larger.pdf', mimeType: 'application/pdf', buffer: makePdf(1400) },
    ]);
    const cards = student.locator('.student-file-card');
    await cards.first().waitFor();
    assert.equal(await cards.count(), 2, 'Both selected files must appear immediately on the phone');
    await student.locator('.student-status-pill.is-uploading').waitFor();
    assert.match(await student.locator('.student-status-pill').getAttribute('aria-label') ?? '',
      /Uploading.*Keep this window open/);
    assert.equal(await cards.locator('.transfer-ring').count(), 0,
      'Pending phone cards must not show inaccurate intermediate percentages');
    const dockLayout = await student.locator('.student-transfer-actions').evaluate(root => {
      const pill = root.querySelector('.student-status-pill')!.getBoundingClientRect();
      const add = root.querySelector('.student-add-fab')!.getBoundingClientRect();
      return { sameRow: Math.abs((pill.top + pill.bottom) / 2 -
        (add.top + add.bottom) / 2) < 6, separated: pill.right <= add.left };
    });
    assert.equal(dockLayout.sameRow, true, 'Status dock sits in the same row as + New');
    assert.equal(dockLayout.separated, true, 'Status dock must not cover + New');
    await host.locator('.document-row').filter({ hasText: 'small.pdf' })
      .locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 25000 });
    await host.locator('.document-row').filter({ hasText: 'larger.pdf' })
      .locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 25000 });
    assert.equal(await cards.locator('.transfer-ring[aria-valuenow="100"]').count(), 0,
      'A dropped final acknowledgement must not display false completion');
    await student.locator('.student-status-pill.is-uploading').waitFor();

    await transferEval(student, () => {
      const scoped = window as typeof window & {
        __flashviewSockets?: WebSocket[]; __dropManifest?: boolean;
      };
      scoped.__dropManifest = false;
      scoped.__flashviewSockets?.at(-1)?.send(JSON.stringify({ v: 1, type: 'file.sync' }));
    });
    await student.locator('.student-status-pill.is-done').waitFor({ timeout: 20000 });
    await student.waitForFunction(() =>
      document.querySelectorAll('.student-file-card .transfer-ring[aria-valuenow="100"]').length === 2,
      null, { timeout: 20000 });
    await student.locator('.student-status-pill').waitFor({ state: 'detached', timeout: 7000 });

    // Verify the dock from explicit connection-state notifications. Real
    // reconnect is exercised by the other browser tests; WebSocket close
    // handshakes in the local Cloudflare emulator are not deterministic.
    await transferEval(student, () => {
      const sockets = (window as typeof window & { __flashviewSockets?: WebSocket[] }).__flashviewSockets;
      const ws = sockets?.at(-1);
      if (!ws?.onmessage) throw Error('Expected active student socket');
      ws.onmessage.call(ws, new MessageEvent('message', {
        data: JSON.stringify({ v: 1, type: 'host.offline' }),
      }));
    });
    await student.locator('.transfer-pill').waitFor({ timeout: 7000 });
    assert.match(await student.locator('.transfer-pill').innerText(), /Connecting/);
    // The actual student socket remains authenticated. An out-of-order
    // host.offline notification must not defer a new file.offer for 20s.
    await student.locator('input[type=file]').setInputFiles({
      name: 'stale-host-status.bin', mimeType: 'application/octet-stream',
      buffer: Buffer.from('FlashView stale host notification regression'),
    });
    await host.locator('.document-row').filter({ hasText: 'stale-host-status.bin' })
      .waitFor({ timeout: 6000 });
    await host.locator('.document-row').filter({ hasText: 'stale-host-status.bin' })
      .locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 10000 });
    await transferEval(student, () => {
      const sockets = (window as typeof window & { __flashviewSockets?: WebSocket[] }).__flashviewSockets;
      const ws = sockets?.at(-1);
      if (!ws?.onmessage) throw Error('Expected active student socket');
      ws.onmessage.call(ws, new MessageEvent('message', {
        data: JSON.stringify({ v: 1, type: 'host.online' }),
      }));
    });
    await student.locator('.transfer-pill').waitFor({ state: 'detached', timeout: 7000 });

    // A newly added file must reopen Uploading, never retain the old Done.
    await student.locator('input[type=file]').setInputFiles({
      name: 'late.pdf', mimeType: 'application/pdf', buffer: makePdf(400),
    });
    await student.locator('.student-file-card').filter({ hasText: 'late.pdf' }).waitFor();
    await student.locator('.student-status-pill.is-uploading').waitFor();
    await student.locator('.student-file-card').filter({ hasText: 'late.pdf' })
      .locator('.transfer-ring[aria-valuenow="100"]').waitFor({ timeout: 25000 });
    await student.locator('.student-status-pill.is-done').waitFor({ timeout: 5000 });
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
});

test('room engine: stale snapshots, pending approvals and foreign closure cannot erase a cached original', { timeout: 60000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage({ acceptDownloads: true });
  const phone = await browser.newPage();
  const original = Buffer.alloc(768 * 1024 + 7);
  for (let i = 0; i < original.length; i++) original[i] = (i * 37 + Math.floor(i / 65536)) % 256;
  const instrument = `{
    const Native = window.WebSocket;
    window.__engineSockets = [];
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args); window.__engineSockets.push(this);
        this.addEventListener('message', event => {
          if (typeof event.data !== 'string') return;
          const message = JSON.parse(event.data);
          if (message.type === 'room.state' && !window.__oldRoom) window.__oldRoom = event.data;
          if (message.type === 'join.pending' && !window.__oldPending) window.__oldPending = event.data;
        });
      }
    };
  }`;
  try {
    await transferInit(host, instrument); await transferInit(phone, instrument);
    const root = 'http://127.0.0.1:' + port;
    await host.goto(root); await host.getByLabel('Require approval').check();
    await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const session = await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!));
    await phone.goto(root + '/?join=' + encodeURIComponent(session.joinToken));
    await phone.getByRole('button', { name: 'Skip for now', exact: true }).click();
    await phone.getByText('Waiting to join', { exact: true }).waitFor();
    await host.locator('.approval').getByRole('button', { name: 'Allow' }).click();
    await phone.locator('.student-add-fab:not([disabled])').waitFor();
    await phone.locator('input[type=file]').setInputFiles({ name: 'engine-protected.bin', mimeType: 'application/octet-stream', buffer: original });
    await host.locator('.document-row .cache-ring[aria-valuenow="100"]').waitFor();
    await phone.locator('.student-status-pill.is-done').waitFor();
    await transferEval(phone, `{
      if (!window.__oldPending) throw Error('Pending snapshot not captured');
      window.__engineSockets.at(-1).dispatchEvent(new MessageEvent('message', { data: window.__oldPending }));
    }`);
    await host.evaluate(`{
      window.__rowVanished = false;
      new MutationObserver(() => { if (!document.querySelector('.document-row')) window.__rowVanished = true; })
        .observe(document.querySelector('.premium-app'), { childList: true, subtree: true });
    }`);
    await transferEval(host, `{
      if (!window.__oldRoom) throw Error('Room snapshot not captured');
      const socket = window.__engineSockets.at(-1);
      socket.dispatchEvent(new MessageEvent('message', { data: window.__oldRoom }));
      const foreign = { ...JSON.parse(window.__oldRoom), roomGeneration: 'foreign-generation', roomRevision: 999999 };
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(foreign) }));
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ ...foreign, type: 'room.closed' }) }));
    }`);
    await delay(150);
    assert.equal(await phone.getByText('Waiting to join', { exact: true }).count(), 0);
    assert.equal(await host.evaluate('window.__rowVanished'), false, 'An old full list must never remove the current cached row');
    assert.equal(await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!).cacheId), session.cacheId);
    const exporting = host.waitForEvent('download');
    await host.getByRole('button', { name: 'Download engine-protected.bin' }).click();
    const exported = await exporting;
    assert.deepEqual(await readFile((await exported.path())!), original);
    await host.getByRole('button', { name: 'End room', exact: true }).click();
    await host.getByRole('button', { name: 'End & clear cache', exact: true }).click();
    await host.locator('.welcome').waitFor();
  } finally { await browser.close(); child.kill(); }
});

test('transfer worker: UI stalls preserve exact originals; Chromium receipt remains independent', { timeout: 45000 }, async t => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const host = await context.newPage();
  const phone = await browser.newPage();
  const observer = await context.newPage();
  const original = Buffer.alloc(12 * 1024 * 1024 + 7, 109);
  try {
    await transferInit(host, `{
      const Native=WebSocket;
      window.__completionCommands=[];
      window.__firstBinaryAt=0;
      window.WebSocket=class extends Native { send(data) {
        if(typeof data==='string' && JSON.parse(data).type==='cache.progress') window.__completionCommands.push({bytes:JSON.parse(data).bytes,at:Date.now()});
        return super.send(data);
      } constructor(...args) {super(...args);this.addEventListener('message',event=>{if(typeof event.data!=='string'&&!window.__firstBinaryAt)window.__firstBinaryAt=Date.now()})}};
    }`);
    await transferInit(phone, `{
      const read = Blob.prototype.arrayBuffer;
      window.__allowTransfer = false; window.__waitingReads = [];
      window.__firstReadAt=0;window.__firstSendAt=0;
      Blob.prototype.arrayBuffer = async function() {
        if(typeof document === 'undefined' && !window.__allowTransfer) await new Promise(r => window.__waitingReads.push(r));
        await new Promise(r => setTimeout(r, 60)); const bytes=await read.call(this);if(!window.__firstReadAt)window.__firstReadAt=Date.now();return bytes;
      };
      const Native = WebSocket;
      window.__completedFromRelay = 0;
      window.WebSocket = class extends Native { send(data){if(typeof data!=='string'&&!window.__firstSendAt)window.__firstSendAt=Date.now();return super.send(data)} constructor(...args) { super(...args); this.addEventListener('message', event => {
        if (typeof event.data === 'string') { const m = JSON.parse(event.data); if (m.type === 'cache.progress' && m.complete) window.__completedFromRelay = Date.now(); }
      }); } };
    }`);
    const root = 'http://127.0.0.1:' + port;
    await host.goto(root); await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const saved = await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!));
    await phone.goto(root + '/?join=' + encodeURIComponent(saved.joinToken));
    await phone.getByRole('button', { name: 'Skip for now', exact: true }).click();
    await phone.locator('.student-add-fab:not([disabled])').waitFor();
    await observer.goto(root);
    assert.equal(await observer.evaluate(() => sessionStorage.getItem('flashview-host')), null);
    await phone.locator('input[type=file]').setInputFiles({ name: 'independent.bin', mimeType: 'application/octet-stream', buffer: original });
    await transferWait(phone, 'window.__waitingReads.length > 0');
    // Observe in another worker: Firefox may defer DevTools evaluations and
    // same-context observer-page JS while a page thread is deliberately busy.
    // Record timestamps inside each agent and inspect them after the block.
    const observing = observer.waitForEvent('worker', { predicate: worker => worker.url().startsWith('blob:') });
    await observer.evaluate(({ room, size }) => {
      const code = `globalThis.__observedAt=0;
        async function scan(){
          const request=indexedDB.open('flashview-room-cache');
          const db=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
          const bytes=await new Promise((resolve,reject)=>{
            let total=0;const request=db.transaction('chunks','readonly').objectStore('chunks').index('room').openCursor(IDBKeyRange.only(${JSON.stringify(room)}));
            request.onsuccess=()=>{const cursor=request.result;if(cursor){total+=cursor.value.data.byteLength;cursor.continue()}else resolve(total)};request.onerror=()=>reject(request.error);
          });db.close();if(bytes===${size})globalThis.__observedAt=Date.now();else setTimeout(scan,50);
        }scan();`;
      new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    }, { room: saved.cacheId, size: original.length });
    const observerWorker = await observing;
    await transferEval(phone, 'setTimeout(()=>{window.__releasedAt=Date.now();window.__allowTransfer=true;window.__waitingReads.splice(0).forEach(resolve=>resolve())},1000)');
    await Promise.all([host, phone].map(page => page.evaluate(() => {
      setTimeout(() => {
        const start = Date.now(), until = performance.now() + 10000;
        while (performance.now() < until) { /* Deliberately block only the page. */ }
        (window as typeof window & { __blockInterval?: { start: number; end: number } }).__blockInterval = { start, end: Date.now() };
      }, 100);
    })));
    await delay(11000);
    const blocks = await Promise.all([host, phone].map(page => page.evaluate(() =>
      (window as typeof window & { __blockInterval: { start: number; end: number } }).__blockInterval)));
    let observedAt = Number(await observerWorker.evaluate('globalThis.__observedAt'));
    let receiptAt = Number(await transferEval(phone, 'window.__completedFromRelay'));
    const first = Math.max(...blocks.map(block => block.start)), last = Math.min(...blocks.map(block => block.end));
    const recoveredBy = Math.max(...blocks.map(block => block.end)) + 5000;
    if (process.env.FLASHVIEW_BROWSER === 'firefox') {
      // The first snapshot is only about one second after the busy interval.
      // Wait through the existing recovery deadline before judging timestamps;
      // the independent observer may still be scanning after receipt completes.
      while ((!observedAt || !receiptAt) && Date.now() < recoveredBy) {
        await delay(50);
        observedAt = Number(await observerWorker.evaluate('globalThis.__observedAt'));
        receiptAt = Number(await transferEval(phone, 'window.__completedFromRelay'));
      }
    }
    t.diagnostic(JSON.stringify({ browser:browser.version(), blocks, observedAt, receiptAt, source: await transferEval(phone, '({releasedAt:window.__releasedAt,firstReadAt:window.__firstReadAt,firstSendAt:window.__firstSendAt})'), host:await transferEval(host,'({firstBinaryAt:window.__firstBinaryAt,completionCommands:window.__completionCommands})') }));
    if (process.env.FLASHVIEW_BROWSER === 'firefox') {
      // N37: this Firefox build's native File/WS delivery still waits for the
      // parent main thread. Keep an explicit bounded-recovery/integrity check;
      // do not silently count it as passing Chromium's independence criterion.
      assert.ok(observedAt > first && observedAt < recoveredBy, 'Firefox must preserve and finish receipt promptly after its native delivery resumes');
      assert.ok(receiptAt > first && receiptAt < recoveredBy, 'Firefox completion must recover without reselection/reapproval');
      t.diagnostic('N37: Firefox native delivery coupling is a known limitation; this case checks bounded recovery, not complete UI independence.');
    } else {
      assert.ok(observedAt > first && observedAt < last, 'All original bytes must persist while both UI threads are blocked');
      assert.ok(receiptAt > first && receiptAt < last, 'Completion must reach the sender worker while both UI threads are blocked');
    }
    await host.locator('.document-row .cache-ring[aria-valuenow="100"]').waitFor();
    const exporting = host.waitForEvent('download');
    await host.getByRole('button', { name: 'Download independent.bin' }).click();
    assert.deepEqual(await readFile((await (await exporting).path())!), original);
    assert.equal((await transferWorker(host)).url().includes('relayWorker-'), true);
  } finally { await browser.close(); child.kill(); }
});

test('transfer worker: sender and receiver crashes resume the same private original from committed cache', { timeout: 60000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage({ acceptDownloads: true }); const phone = await browser.newPage();
  const original = Buffer.alloc(24 * 1024 * 1024 + 7, 83);
  try {
    await transferInit(phone, `{
      const read = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = async function() { await new Promise(r => setTimeout(r, 100)); return read.call(this); };
    }`);
    const root = 'http://127.0.0.1:' + port;
    await host.goto(root); await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const saved = await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!));
    await phone.goto(root + '/?join=' + encodeURIComponent(saved.joinToken));
    await phone.getByRole('button', { name: 'Skip for now', exact: true }).click();
    await phone.locator('.student-add-fab:not([disabled])').waitFor();
    await phone.locator('input[type=file]').setInputFiles({ name: 'restartable.bin', mimeType: 'application/octet-stream', buffer: original });
    await host.waitForFunction(() => Number(document.querySelector('.cache-ring')?.getAttribute('aria-valuenow')) >= 5);
    for (const owner of [phone, host]) {
      const before = Number(await host.locator('.document-row .cache-ring').getAttribute('aria-valuenow'));
      assert.ok(before < 100, 'Crash during active transfer');
      const replacement = owner.waitForEvent('worker', { predicate: w => /relayWorker-/.test(w.url()) });
      await (await transferWorker(owner)).evaluate(() => { setTimeout(() => { throw Error('Synthetic transfer worker crash'); }, 0); });
      await replacement;
      await host.waitForFunction(previous => Number(document.querySelector('.cache-ring')?.getAttribute('aria-valuenow')) > previous, before, { timeout: 15000 });
    }
    await host.locator('.document-row .cache-ring[aria-valuenow="100"]').waitFor({ timeout: 30000 });
    await phone.locator('.student-file-card .transfer-ring[aria-valuenow="100"]').waitFor();
    assert.equal(await host.locator('.participant-row').count(), 1);
    assert.equal(await host.locator('.document-row').count(), 1);
    const exporting = host.waitForEvent('download'); await host.getByRole('button', { name: 'Download restartable.bin' }).click();
    assert.deepEqual(await readFile((await (await exporting).path())!), original);
    for (const page of [host, phone]) assert.equal(page.workers().filter(w => /relayWorker-/.test(w.url())).length, 1);
  } finally { await browser.close(); child.kill(); }
});

test('transfer worker: Stop cancels held ranges and ignores late original reads while another file completes', { timeout: 40000 }, async () => {
  const { port, child } = await runningServer(); const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage({ acceptDownloads: true }); const phone = await browser.newPage();
  let cancels = 0, latePackets = 0, stopped = false;
  host.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    if (typeof payload === 'string' && JSON.parse(payload).type === 'range.cancel') cancels++;
  }));
  phone.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    if (stopped && typeof payload !== 'string') latePackets++;
  }));
  try {
    await transferInit(host, `{
      const Native = WebSocket;
      window.WebSocket = class extends Native { constructor(...args) { super(...args); this.addEventListener('message', event => {
        if (typeof event.data === 'string' && JSON.parse(event.data).type === 'range.error') event.stopImmediatePropagation();
      }); } };
    }`);
    await transferInit(phone, `{
      const slice = File.prototype.slice;
      window.__heldOriginals = [];
      File.prototype.slice = function(...args) {
        const blob = slice.apply(this,args), read = blob.arrayBuffer.bind(blob);
        if (this.name === 'held-original.bin') blob.arrayBuffer = () => new Promise(resolve => window.__heldOriginals.push(() => read().then(resolve)));
        return blob;
      };
    }`);
    const root = 'http://127.0.0.1:' + port;
    await host.goto(root); await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const token = await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!).joinToken);
    await phone.goto(root + '/?join=' + encodeURIComponent(token));
    await phone.getByRole('button', { name: 'Skip for now', exact: true }).click(); await phone.locator('.student-add-fab:not([disabled])').waitFor();
    const healthy = Buffer.alloc(768 * 1024 + 7, 31);
    await phone.locator('input[type=file]').setInputFiles([
      { name: 'held-original.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(2 * 1024 * 1024, 17) },
      { name: 'healthy-original.bin', mimeType: 'application/octet-stream', buffer: healthy },
    ]);
    await transferWait(phone, 'window.__heldOriginals.length > 0');
    await host.locator('.document-row').filter({ hasText: 'healthy-original.bin' }).locator('.cache-ring[aria-valuenow="100"]').waitFor();
    await phone.locator('.student-file-card').filter({ hasText: 'held-original.bin' }).getByRole('button', { name: 'Stop sharing' }).click();
    await phone.getByText('Sharing stopped', { exact: true }).waitFor();
    for (let attempt = 0; attempt < 40 && !cancels; attempt++) await delay(50);
    assert.ok(cancels > 0, 'Stop must cancel receiver ranges immediately rather than occupying slots until timeout');
    stopped = true;
    await transferEval(phone, 'window.__heldOriginals.splice(0).forEach(release => release())');
    await delay(250); assert.equal(latePackets, 0, 'Retired source reads cannot send binary responses');
    assert.equal(await host.locator('.document-row').filter({ hasText: 'held-original.bin' }).locator('.cache-ring[aria-valuenow="100"]').count(), 0);
    const exporting = host.waitForEvent('download'); await host.getByRole('button', { name: 'Download healthy-original.bin' }).click();
    assert.deepEqual(await readFile((await (await exporting).path())!), healthy);
  } finally { await browser.close(); child.kill(); }
});

test('transfer worker: offline Stop retires source bytes and is replayed after private reconnect', { timeout: 45000 }, async () => {
  const remote = process.env.WORKER_RECOVERY_ORIGIN;
  const { port, child } = remote ? { port: 0, child: null } : await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage({ acceptDownloads: true }); const phone = await browser.newPage();
  let revoked = false, stopped = false, binaryAfterStop = 0, senderLeft = false;
  host.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    if (typeof payload === 'string') {
      const message = JSON.parse(payload);
      if (message.type === 'student.left') senderLeft = true;
      if (message.type === 'file.updated' && message.file.name === 'offline-stop.bin' && message.file.revoked) revoked = true;
    }
  }));
  phone.on('websocket', socket => socket.on('framesent', ({ payload }) => { if (stopped && typeof payload !== 'string') binaryAfterStop++; }));
  try {
    await transferInit(phone, `{
      const Native=WebSocket;window.__offlineSockets=[];
      window.WebSocket=class extends Native {constructor(...args){super(...args);window.__offlineSockets.push(this)}};
      const slice=File.prototype.slice;window.__offlineReads=[];
      File.prototype.slice=function(...args){const blob=slice.apply(this,args),read=blob.arrayBuffer.bind(blob);
        if(this.name==='offline-stop.bin')blob.arrayBuffer=()=>new Promise(resolve=>window.__offlineReads.push(()=>read().then(resolve)));return blob;};
    }`);
    const root = remote ? new URL(remote).origin : 'http://127.0.0.1:' + port;
    await host.goto(root); await host.getByRole('button', { name: /Create a room/ }).click(); await host.locator('.connection.connected').waitFor();
    const token = await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!).joinToken);
    await phone.goto(root + '/?join=' + encodeURIComponent(token));
    await phone.getByRole('button', { name: 'Skip for now', exact: true }).click(); await phone.locator('.student-add-fab:not([disabled])').waitFor();
    await phone.locator('input[type=file]').setInputFiles({ name: 'offline-stop.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(2 * 1024 * 1024, 47) });
    await transferWait(phone, 'window.__offlineReads.length > 0');
    await phone.context().setOffline(true);
    await transferEval(phone, 'window.__offlineSockets.at(-1).close(4100,"Synthetic offline Stop")');
    for (let attempt = 0; attempt < 150 && !senderLeft; attempt++) await delay(50);
    assert.equal(senderLeft, true, 'Relay must observe departure before the offline Stop');
    assert.equal(await host.locator('.participant-row').count(), 1,
      'A disconnected sender remains listed through their shared file');
    await phone.getByRole('button', { name: 'Stop sharing' }).click(); await phone.getByText('Sharing stopped', { exact: true }).waitFor();
    stopped = true;
    await transferEval(phone, 'window.__offlineReads.splice(0).forEach(release=>release())');
    await phone.context().setOffline(false); await phone.evaluate(() => window.dispatchEvent(new Event('online')));
    for (let attempt = 0; attempt < 150 && !revoked; attempt++) await delay(50);
    assert.equal(revoked, true, 'Reconnect must replay the terminal command, not just drop the source bytes');
    assert.equal(binaryAfterStop, 0); stopped = false;
    await host.waitForFunction(() => document.querySelectorAll('.participant-row').length === 1);
    const healthy = Buffer.alloc(512 * 1024 + 7, 93);
    await phone.locator('input[type=file]').setInputFiles({ name: 'after-offline-stop.bin', mimeType: 'application/octet-stream', buffer: healthy });
    await host.locator('.document-row').filter({ hasText: 'after-offline-stop.bin' }).locator('.cache-ring[aria-valuenow="100"]').waitFor();
    const exporting = host.waitForEvent('download'); await host.getByRole('button', { name: 'Download after-offline-stop.bin' }).click();
    assert.deepEqual(await readFile((await (await exporting).path())!), healthy);
  } finally {
    await phone.context().setOffline(false).catch(() => {});
    try {
      if (remote && await host.getByRole('button', { name: 'End room', exact: true }).isVisible().catch(() => false)) {
        await host.getByRole('button', { name: 'End room', exact: true }).click();
        await host.getByRole('button', { name: 'End & clear cache', exact: true }).click();
        await host.locator('.welcome').waitFor();
      }
    } finally { await browser.close(); child?.kill(); }
  }
});

test('network packet sizes 128/256 KiB preserve exact original PDF bytes in 64 KiB browser cache', { timeout: 110000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const root = 'http://127.0.0.1:' + port;
  const fixture = makePdf(3900);
  const expectedDigest = createHash('sha256').update(fixture).digest('hex');
  try {
    for (const packetKiB of [128, 256]) {
      const host = await browser.newPage();
      const student = await browser.newPage();
      try {
        await host.goto(root + '/?packet=' + packetKiB);
        await host.getByRole('button', {name: /Create a room/}).click();
        const code = (await host.locator('.room-code').innerText()).trim();
        await host.locator('.connection.connected').waitFor();
        await student.goto(root);
        await student.locator('#code').fill(code);
        await student.getByRole('button', {name: /Join room/}).click();
        await student.locator('.student-drive').waitFor();
        await student.locator('input[type=file]').setInputFiles({
          name: 'packet-check.pdf', mimeType: 'application/pdf', buffer: fixture,
        });
        await host.locator('.document-row .cache-ring[aria-valuenow="100"]')
          .waitFor({timeout:30000});
        const stored = await host.evaluate(async room => {
          const request = indexedDB.open('flashview-room-cache');
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const chunks = await new Promise<Array<{index:number;room:string;data:ArrayBuffer}>>((resolve, reject) => {
            const tx = db.transaction('chunks', 'readonly');
            const get = tx.objectStore('chunks').getAll();
            get.onsuccess = () => resolve(get.result);
            get.onerror = () => reject(get.error);
          });
          db.close();
          const parts = chunks.filter(x => x.room === room).sort((a,b) => a.index-b.index);
          const length = parts.reduce((sum,x) => sum+x.data.byteLength, 0);
          const all = new Uint8Array(length);
          let position = 0;
          for (const piece of parts) {
            all.set(new Uint8Array(piece.data), position);
            position += piece.data.byteLength;
          }
          const digest = await crypto.subtle.digest('SHA-256', all);
          return { length, count: parts.length, indices: parts.map(x => x.index),
            sha256: Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2,'0')).join('') };
        }, await cacheIdentity(host));
        assert.equal(stored.length, fixture.length, 'Full file must survive packet splitting');
        assert.ok(stored.count > 6, 'Multi-packet test fixture must exercise multiple groups');
        assert.deepEqual(stored.indices, Array.from({length:stored.count}, (_,i)=>i));
        assert.equal(stored.sha256, expectedDigest, 'All cached PDF bytes must match exactly');
      } finally {
        await host.close();
        await student.close();
      }
    }
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
});



test('QR joins open the upload workspace after the name choice; leaving or ending returns to a clean homepage', {timeout: 100000}, async () => {
  const {port,child}=await runningServer();
  const browser=await browserEngine.launch({headless:true});
  const host=await browser.newPage();
  const student=await browser.newPage({viewport:{width:390,height:820}});
  const root='http://127.0.0.1:'+port;
  try {
    // The QR name choice must never flash the manual room-code form.
    await student.addInitScript(() => {
      const scoped=window as typeof window & {__sawQrJoinForm?:boolean};
      scoped.__sawQrJoinForm=false;
      new MutationObserver(()=>{
        if (document.querySelector('.student-screen .room-entry')) scoped.__sawQrJoinForm=true;
      }).observe(document,{subtree:true,childList:true});
    });

    await host.goto(root);
    await host.getByRole('button',{name:/Create a room/}).click();
    await host.locator('.connection.connected').waitFor();
    const invite=await host.evaluate(()=>{
      const saved=sessionStorage.getItem('flashview-host');
      return saved ? (JSON.parse(saved) as {joinToken:string}).joinToken : '';
    });
    assert.ok(invite.length >= 20,'QR link must include an authorized invite token');

    await student.goto(root+'/?join='+encodeURIComponent(invite));
    await student.getByRole('button', { name: 'Skip for now', exact: true }).click();
    await student.locator('.student-drive').waitFor();
    assert.equal(await student.locator('.student-screen .room-entry').count(),0,
      'QR links must never render the manual room-code form');
    await student.waitForFunction(()=>
      Boolean(document.querySelector('.student-add-fab:not([disabled])')),null,{timeout:20000});
    assert.equal(await student.evaluate(()=>
      (window as typeof window & {__sawQrJoinForm?:boolean}).__sawQrJoinForm),false,
      'Joining through a QR link must not flash the manual join screen');
    assert.equal(await student.getByRole('button',{name:'Add files'}).count(),1);

    // A room ended by the teacher should instantly leave the student's
    // workspace, clear its QR URL and restore an EMPTY join-code input.
    await host.getByRole('button',{name:/End room/}).click();
    await host.getByRole('button',{name:/End & clear cache/}).click();
    await student.locator('.welcome').waitFor({timeout:20000});
    assert.equal(new URL(student.url()).search,'','Expired invite must be removed from URL');
    assert.equal(await student.locator('#code').inputValue(),'',
      'Ended room must not leave the QR token or six-digit code in the input');
    await host.locator('.welcome').waitFor({timeout:15000});

    // Manually entering a code has the same clean exit behavior.
    await host.getByRole('button',{name:/Create a room/}).click();
    await host.locator('.connection.connected').waitFor();
    const code=(await host.locator('.room-code').innerText()).trim();
    await student.locator('#code').fill(code);
    await student.getByRole('button',{name:/Join room/}).click();
    await student.locator('.student-add-fab:not([disabled])').waitFor();
    await student.getByRole('button',{name:'Leave room'}).click();
    await student.locator('.welcome').waitFor();
    assert.equal(await student.locator('#code').inputValue(),'',
      'Leaving should clear the manually entered code');
    assert.equal(new URL(student.url()).search,'');
    await student.reload();
    await student.locator('.welcome').waitFor();
    assert.equal(await student.locator('#code').inputValue(),'',
      'The prior QR link must not rejoin the room after a refresh');
  } finally {
    await host.close();await student.close();await browser.close();child.kill('SIGTERM');
  }
});


test('universal binary transfer preserves APK, EXE, PPTX, XLSX, GIF, ZIP, DEB, SH and BIN bytes', {timeout: 130000}, async () => {
  const {port,child}=await runningServer();
  const browser=await browserEngine.launch({headless:true});
  const host=await browser.newPage({acceptDownloads:true});
  const student=await browser.newPage();
  const root='http://127.0.0.1:'+port;
  try {
    await host.goto(root);
    await host.getByRole('button',{name:/Create a room/}).click();
    await host.locator('.connection.connected').waitFor();
    const code=(await host.locator('.room-code').innerText()).trim();
    await student.goto(root);
    await student.locator('#code').fill(code);
    await student.getByRole('button',{name:/Join room/}).click();
    await student.locator('.student-drive').waitFor();
    const names=[
      'example.apk','program.exe','slides.pptx','financials.xlsx','animation.gif',
      'archive.zip','package.deb','install.sh','unknown-file.bin',
    ];
    const fixtures=names.map((name,i)=>{
      const bytes=Buffer.alloc(70_000 + (i*23_719));
      for(let j=0;j<bytes.length;j++) bytes[j]=(i*23+j*17+j>>4)&255;
      return {name,mimeType:'application/octet-stream',buffer:bytes};
    });
    await student.locator('input[type=file]').setInputFiles(fixtures);
    for(const f of fixtures) {
      const card=host.locator('.document-row').filter({hasText:f.name});
      await card.waitFor({timeout:45000});
      const present=card.getByRole('button',{name:'Present '+f.name});
      assert.equal(await present.count(),f.name.endsWith('.pptx')?1:0,
        'Only PDF and supported PowerPoint files receive Present controls: '+f.name);
      const downloadButton=card.getByRole('button',{name:'Download '+f.name});
      await downloadButton.waitFor();
      await card.locator('.cache-ring[aria-valuenow="100"]').waitFor({timeout:50000});
      assert.equal(await downloadButton.isEnabled(),true);
      const [download]=await Promise.all([
        host.waitForEvent('download',{timeout:15000}),
        downloadButton.click(),
      ]);
      assert.equal(download.suggestedFilename(),f.name);
      const actual=await readFile(await download.path());
      assert.equal(createHash('sha256').update(actual).digest('hex'),
        createHash('sha256').update(f.buffer).digest('hex'),
        'File must be byte-perfect through relay, cache, and browser download: '+f.name);
      assert.equal(actual.byteLength,f.buffer.byteLength);
    }
    const pptxButton=host.locator('.document-row').filter({hasText:'slides.pptx'})
      .getByRole('button',{name:'Present slides.pptx'});
    assert.equal(await pptxButton.isEnabled(),true,
      'A fully received PPTX enables Present, independent of the original sender');
    // The synthetic binary file above is intentionally NOT a real PPTX.
    // The separate genuine-OOXML test below must exercise renderer loading.
    // A room still has the original 256 KiB packet default.
    assert.equal(await host.evaluate(()=>new URLSearchParams(location.search).get('packet')),null);
    await host.getByRole('button',{name:/End room/}).click();
    await host.getByRole('button',{name:/End & clear cache/}).click();
    await student.locator('.welcome').waitFor({timeout:20000});
  } finally {
    await host.close();await student.close();await browser.close();
    child.kill('SIGTERM');
  }
});


test('reference UI assigns one color per real participant, including two students with the same name', {timeout:85000}, async()=>{
  const {port,child}=await runningServer();
  const browser=await browserEngine.launch({headless:true});
  const host=await browser.newPage();
  const first=await browser.newPage();
  const second=await browser.newPage();
  const root='http://127.0.0.1:'+port;
  try {
    await host.goto(root);
    await host.getByRole('button',{name:/Create a room/}).click();
    await host.locator('.connection.connected').waitFor();
    const code=(await host.locator('.room-code').innerText()).trim();
    for(const page of [first,second]) {
      await page.goto(root);
      await page.locator('#code').fill(code);
      // Both people intentionally share the default display name "Student".
      await page.getByRole('button',{name:/Join room/}).click();
      await page.locator('.student-add-fab:not([disabled])').waitFor();
    }
    assert.equal(await host.locator('.participant-row').count(), 0,
      'Joining alone must not add a name to Shared by');
    assert.equal(await host.locator('.room-admission-status').count(), 0);
    assert.equal(await host.getByLabel('Require approval').count(), 0);
    await first.locator('input[type=file]').setInputFiles([
      {name:'slides-one.pptx',mimeType:'application/octet-stream',buffer:Buffer.alloc(12_288,1)},
      {name:'archive-one.zip',mimeType:'application/octet-stream',buffer:Buffer.alloc(13_000,2)},
    ]);
    await second.locator('input[type=file]').setInputFiles({
      name:'installer-two.apk',mimeType:'application/octet-stream',buffer:Buffer.alloc(15_000,3),
    });
    await host.locator('.document-row').nth(2).waitFor({timeout:30000});
    await host.waitForFunction(()=>{
      const avatars=[...document.querySelectorAll<HTMLElement>('.participant-row .participant-avatar')];
      const cards=[...document.querySelectorAll<HTMLElement>('.document-row')];
      return avatars.length===2 && avatars.every(a=>a.style.getPropertyValue('--participant-color')) &&
        cards.length===3 && cards.every(c=>Boolean(c.querySelector('.document-pdf-symbol svg linearGradient stop')));
    });
    const ui=await host.evaluate(()=>{
      const avatars=[...document.querySelectorAll<HTMLElement>('.participant-row')].map(row=>({
        id:row.dataset.participantId,
        name:row.querySelector('.participant-info strong')?.textContent,
        color:row.querySelector<HTMLElement>('.participant-avatar')?.style.getPropertyValue('--participant-color'),
      }));
      const cards=[...document.querySelectorAll<HTMLElement>('.document-row')].map(card=>({
        name:card.querySelector('h3')?.textContent,
        ownerId:card.dataset.ownerId,
        metadataVisible:Boolean(card.querySelector('.document-file-meta')),
        gradient:card.querySelector('linearGradient stop')?.getAttribute('stop-color'),
      }));
      return {avatars,cards};
    });
    assert.equal(ui.avatars.length,2);
    assert.ok(ui.avatars.every(a=>a.name==='Student'),'Both people have the same display name');
    assert.notEqual(ui.avatars[0].id,ui.avatars[1].id);
    assert.notEqual(ui.avatars[0].color,ui.avatars[1].color,'Different people must get different hues');
    const colorFor=(id:string|undefined)=>ui.avatars.find(a=>a.id===id)?.color;
    for(const card of ui.cards){
      const color=colorFor(card.ownerId);
      assert.ok(color,'Every file must refer to a real participant');
      assert.equal(card.metadataVisible,false,'Cards omit the uploader and size row');
      assert.ok(card.gradient && card.gradient!=='#4a5062','The pixel icon must not be gray');
    }
    const [a,b,c]=['slides-one.pptx','archive-one.zip','installer-two.apk'].map(
      name=>ui.cards.find(card=>card.name===name)!);
    assert.equal(a.ownerId,b.ownerId,'Two files from the same student share one participant ID');
    assert.equal(a.gradient,b.gradient,'Every icon from one student has an identical gradient');
    assert.notEqual(a.ownerId,c.ownerId);
    assert.notEqual(a.gradient,c.gradient,'Different students get different icon gradients');
    await host.locator('.document-row .cache-ring[aria-valuenow="100"]').nth(2).waitFor();
    await first.close();
    // Ask for an authoritative snapshot after the sender has left. Its name
    // belongs to retained originals, rather than the current socket roster.
    await host.reload();
    await host.locator('.connection.connected').waitFor();
    await host.locator('.participant-row').nth(1).waitFor();
    assert.equal(await host.locator('.participant-info small').count(), 0,
      'Contributors must not be labelled Connected');
    assert.equal(await host.locator('.participant-row').count(), 2);
    await host.waitForFunction(() => [...document.querySelectorAll('.participant-row,.document-row')]
      .every(element => Number(getComputedStyle(element).opacity) > 0.99));
    await mkdir('test-artifacts/ui', { recursive: true });
    await host.screenshot({ path: 'test-artifacts/ui/shared-by-desktop.png', fullPage: true });
    await host.getByRole('button',{name:/End room/}).click();
    await host.getByRole('button',{name:/End & clear cache/}).click();
  } finally {
    await host.close();await first.close();await second.close();await browser.close();
    child.kill('SIGTERM');
  }
});


test('refined file cards hide metadata, truncate long names and keep phone controls readable', {timeout:80000}, async()=>{
  const {port,child}=await runningServer();
  const browser=await browserEngine.launch({headless:true});
  const host=await browser.newPage({viewport:{width:1280,height:760}});
  const student=await browser.newPage({viewport:{width:390,height:844}});
  const root='http://127.0.0.1:'+port;
  const longName='Extremely_long_university_assignment_final_presentation_document_revision_123456789.xlsx';
  try{
    await host.goto(root);
    await host.getByRole('button',{name:/Create a room/}).click();
    await host.locator('.connection.connected').waitFor();
    assert.equal(await host.getByRole('heading',{name:/^Files/}).count(),1);
    assert.equal(await host.locator('.reference-room-tools button').count(),2,
      'Top-right toolbar must contain only Grid/List controls');
    assert.equal(await host.locator('.reference-live').count(),0,
      'The relay status pill must no longer occupy the top-right toolbar');
    assert.equal(await host.locator('.sidebar-participants-heading .connection.connected').count(),1,
      'A tiny sidebar dot keeps connection feedback without a toolbar pill');
    const code=(await host.locator('.room-code').innerText()).trim();
    await student.goto(root);
    await student.locator('#code').fill(code);
    await student.locator('#student-name').fill('Alexandra Long Student Name Test');
    await student.getByRole('button',{name:/Join room/}).click();
    await student.locator('.student-add-fab:not([disabled])').waitFor();
    assert.equal(await student.locator('.student-empty-pixel-icon').count(),1,
      'Phone empty state should reuse the same pixel-art folder as the website');
    const actionBox=await student.locator('.student-add-fab').boundingBox();
    assert.ok(actionBox&&actionBox.width>=108&&actionBox.height>=58,
      'The New button should be larger but still fit on a phone');
    await student.locator('input[type=file]').setInputFiles({
      name:longName,mimeType:'application/octet-stream',buffer:Buffer.alloc(19_000,31),
    });
    const card=host.locator('.document-row').filter({hasText:longName});
    await card.waitFor({timeout:25000});
    const check=await card.evaluate(element=>{
      const title=element.querySelector<HTMLElement>('.document-card-info h3')!;
      const titleRect=title.getBoundingClientRect();
      const cardRect=element.getBoundingClientRect();
      const visual=element.querySelector<HTMLElement>('.document-card-visual')!;
      return {
        filename: title.textContent,
        titleEllipsis:getComputedStyle(title).textOverflow,
        titleHasOverflow:title.scrollWidth>title.clientWidth,
        titleRightPadding:parseFloat(getComputedStyle(title).paddingRight),
        titleRightEdge:titleRect.right,
        cardRightEdge:cardRect.right,
        metadataVisible:Boolean(element.querySelector('.document-file-meta,.document-file-owner,.document-file-size')),
        bezel:parseFloat(getComputedStyle(visual).marginLeft),
        previewBorder:parseFloat(getComputedStyle(visual).borderTopWidth),
        cardBackground:getComputedStyle(element).backgroundColor,
        panelBackground:getComputedStyle(element.closest('.workspace-right')!).backgroundColor,
        panelBlur:getComputedStyle(element.closest('.workspace-right')!).backdropFilter,
        titleAbovePreview:titleRect.bottom<=visual.getBoundingClientRect().top,
        actionsBelowPreview:visual.getBoundingClientRect().bottom<=element.querySelector('.document-card-actions')!.getBoundingClientRect().top,
      };
    });
    assert.equal(check.filename,longName,'Long original filename remains intact');
    assert.equal(check.titleEllipsis,'ellipsis');
    assert.equal(check.titleHasOverflow,true,'Long file name visually ends in ellipsis');
    assert.ok(check.titleRightPadding>=12,'File name gets breathing room on the right');
    assert.ok(check.cardRightEdge-check.titleRightEdge>=12,'Text should not touch the card edge');
    assert.equal(check.metadataVisible,false,'Cards omit uploader, color dot and file size');
    assert.equal(check.bezel,6,'The existing preview bezel stays the same width');
    assert.equal(check.previewBorder,1,'The preview has a thin visible outline');
    assert.equal(check.cardBackground,'rgb(240, 244, 249)');
    assert.equal(check.panelBackground,'rgb(255, 255, 255)');
    assert.equal(check.panelBlur,'none','The Files section has a solid background');
    assert.ok(check.titleAbovePreview&&check.actionsBelowPreview,'Cards show title, preview, then actions');
    await mkdir('test-artifacts/ui',{recursive:true});
    await host.waitForFunction(()=>[...document.querySelectorAll('.document-row')]
      .every(element=>Number(getComputedStyle(element).opacity)>.99));
    await host.screenshot({path:'test-artifacts/ui/file-cards-desktop.png',fullPage:true});
    await host.setViewportSize({width:390,height:844});
    const contentsFit=await card.evaluate(element=>{
      const outer=element.getBoundingClientRect();
      const title=element.querySelector('.document-card-info')!.getBoundingClientRect();
      const preview=element.querySelector('.document-card-visual')!.getBoundingClientRect();
      const actions=element.querySelector('.document-card-actions')!.getBoundingClientRect();
      if(title.bottom>preview.top||preview.bottom>actions.top)return false;
      return [...element.querySelectorAll('.document-card-visual, .document-card-info, .document-card-actions button')]
        .every(child=>{
          const box=child.getBoundingClientRect();
          return box.left>=outer.left&&box.right<=outer.right;
        });
    });
    assert.equal(contentsFit,true,'Phone previews, text and both actions fit inside the card bezel');
    await host.screenshot({path:'test-artifacts/ui/file-cards-mobile.png',fullPage:true});
    await host.setViewportSize({width:1280,height:760});
    await host.getByRole('button',{name:'List view'}).click();
    const list=host.locator('.document-grid.is-list');
    await list.waitFor();
    assert.equal(await list.locator('.document-file-meta,.document-file-owner,.document-file-size').count(),0,
      'List mode also omits uploader and file size');
    assert.equal(await card.evaluate(element=>element.querySelector('.document-card-visual')!.getBoundingClientRect().right<=
      element.querySelector('.document-card-info')!.getBoundingClientRect().left),true,'List view keeps the thumbnail before the title');
    await host.getByRole('button',{name:'End room'}).click();
    await host.getByRole('button',{name:/End & clear cache/}).click();
  }finally{
    await host.close();await student.close();await browser.close();child.kill('SIGTERM');
  }
});


test('phone hosting: join-first homepage, collapsed room setup, approvals and shared files', {timeout:80000}, async()=>{
  const {port,child}=await runningServer();
  const browser=await browserEngine.launch({headless:true});
  const host=await browser.newPage({viewport:{width:390,height:844}});
  const student=await browser.newPage({viewport:{width:390,height:844}});
  const root='http://127.0.0.1:'+port;
  try{
    await host.goto(root);
    const order=await host.evaluate(()=>{
      const join=document.querySelector('.reference-actions .join-card')!.getBoundingClientRect();
      const create=document.querySelector('.reference-actions .host-card')!.getBoundingClientRect();
      return {joinTop:join.top,createTop:create.top};
    });
    assert.ok(order.joinTop<order.createTop,'On phones, Send from your device comes first');
    await host.getByRole('checkbox',{name:'Require approval'}).check();
    await host.getByRole('button',{name:/Create a room/}).click();
    await host.locator('.connection.connected').waitFor({state:'attached'});
    const compact=host.locator('.mobile-host-toolbar');
    assert.ok(await compact.isVisible(),'A phone host sees the compact room header');
    const code=(await compact.locator('.mobile-host-code').innerText()).trim();
    assert.match(code,/^\d{6}$/);
    assert.equal((await compact.locator('.mobile-host-byline').innerText()).trim(),'by warpview');
    const configure=host.getByRole('button',{name:'Configure'});
    assert.equal(await configure.getAttribute('aria-expanded'),'false');
    assert.equal(await host.locator('.qr-plate').isVisible(),false,
      'QR and sharing controls must be collapsed initially');
    assert.equal(await host.locator('.list-heading').isVisible(),false,
      'Phones should not show the Files title or grid/list toolbar');
    assert.equal(await host.getByText('Waiting for the first file').isVisible(),true);

    await configure.click();
    assert.equal(await configure.getAttribute('aria-expanded'),'true');
    assert.equal(await host.locator('.qr-plate').isVisible(),true);
    assert.equal(await host.getByRole('button',{name:'Copy link'}).isVisible(),true);
    assert.equal(await host.getByRole('button',{name:'End room'}).isVisible(),true);
    assert.equal(await host.getByText('Approve each person').count(),0);
    assert.equal(await host.getByLabel('Require approval').count(),0);
    assert.equal(await host.getByRole('heading',{name:'Shared by',exact:true}).isVisible(),true);

    await student.goto(root);
    await student.locator('#code').fill(code);
    await student.getByRole('button',{name:/Join room/}).click();
    const request=host.locator('.sidebar-approval');
    await request.waitFor({timeout:20000});
    assert.equal(await host.locator('.participant-row').count(),0,
      'Pending requests are actionable without becoming contributors');
    await request.getByRole('button',{name:'Allow'}).click();
    await student.locator('.student-add-fab:not([disabled])').waitFor();
    assert.equal(await host.locator('.participant-row').count(),0,
      'Approval alone does not add a contributor');

    await student.locator('input[type=file]').setInputFiles({
      name:'mobile-host-demo.txt',mimeType:'text/plain',buffer:Buffer.from('Hello from the student'),
    });
    const card=host.locator('.document-row').filter({hasText:'mobile-host-demo.txt'});
    await card.waitFor({timeout:25000});
    assert.equal(await card.isVisible(),true,'Received files remain available on mobile');
    await host.locator('.participant-row').waitFor();
    assert.equal(await host.locator('.participant-row').isVisible(),true,
      'People who share files are visible in the expanded mobile sidebar');
    await host.waitForFunction(() => [...document.querySelectorAll('.participant-row,.document-row')]
      .every(element => Number(getComputedStyle(element).opacity) > 0.99));
    await mkdir('test-artifacts/ui', { recursive: true });
    await host.screenshot({ path: 'test-artifacts/ui/shared-by-mobile.png', fullPage: true });
    await configure.click();
    assert.equal(await host.locator('.qr-plate').isVisible(),false);
    assert.equal(await card.isVisible(),true,'Collapsing Configure must not hide files');
  }finally{
    await host.close();await student.close();await browser.close();child.kill('SIGTERM');
  }
});

test('complete PowerPoint uses lazy browser-only presenter with independent Download and Present actions',
  {timeout:130000}, async()=>{
  const {port,child}=await runningServer();
  const browser=await browserEngine.launch({headless:true});
  const host=await browser.newPage({viewport:{width:1280,height:760},acceptDownloads:true});
  const student=await browser.newPage();
  const root='http://127.0.0.1:'+port;
  let popup:Page|null=null;
  try{
    const pptx=await makePowerPointFixture(3);
    await host.goto(root);
    await host.getByRole('button',{name:/Create a room/}).click();
    await host.locator('.connection.connected').waitFor();
    const code=(await host.locator('.room-code').innerText()).trim();
    await student.goto(root);
    await student.locator('#code').fill(code);
    await student.getByRole('button',{name:/Join room/}).click();
    await student.locator('.student-add-fab:not([disabled])').waitFor();
    await student.locator('input[type=file]').setInputFiles({
      name:'lecture.pptx',mimeType:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      buffer:pptx,
    });
    const card=host.locator('.document-row').filter({hasText:'lecture.pptx'});
    await card.waitFor({timeout:30000});
    const downloadButton=card.getByRole('button',{name:'Download lecture.pptx'});
    const presentButton=card.getByRole('button',{name:'Present lecture.pptx'});
    assert.equal(await presentButton.count(),1,'PPTX gets the small circular Present button');
    assert.equal(await downloadButton.count(),1,'PPTX also gets Download');
    assert.equal(await presentButton.evaluate(x=>getComputedStyle(x).borderRadius),'50%',
      'PPTX Present is circular');
    const actionStyle=await card.evaluate(el=>{
      const row=el.querySelector('.document-card-actions')!.getBoundingClientRect();
      const left=el.querySelector('.document-card-download')!.getBoundingClientRect();
      const right=el.querySelector('.document-card-present')!.getBoundingClientRect();
      const paint=getComputedStyle(el.querySelector('.document-card-present')!);
      return {withinRow:right.top>=row.top-2&&right.bottom<=row.bottom+2,
        aligned:Math.abs((left.top+left.bottom)/2-(right.top+right.bottom)/2)<2,
        follows:left.right+5<=right.left,
        border:paint.borderTopWidth,icon:el.querySelector('.document-card-present svg path')?.getAttribute('d')};
    });
    assert.ok(actionStyle.withinRow&&actionStyle.aligned&&actionStyle.follows,
      'Outlined Present must be to the right of Download in the same horizontal row');
    // Completion can switch the button during this check. Its background has
    // a 200 ms CSS transition, so a one-frame midpoint is not an invalid color.
    await host.waitForFunction(() => {
      const button = document.querySelector('[aria-label="Present lecture.pptx"]');
      return button && ['rgb(255, 255, 255)', 'rgb(248, 249, 251)'].includes(getComputedStyle(button).backgroundColor);
    }, null, { timeout: 3000 });
    assert.ok(actionStyle.border!=='0px'&&actionStyle.icon?.includes('17.5'),
      'Present uses a bordered projection-screen glyph');
    await card.locator('.cache-ring[aria-valuenow="100"]').waitFor({timeout:30000});
    await host.waitForFunction(() => {
      const el=[...document.querySelectorAll<HTMLButtonElement>('.document-card-present')]
        .find(button=>button.getAttribute('aria-label')==='Present lecture.pptx');
      if (!el || el.disabled) return false;
      const paint=getComputedStyle(el);
      const rgb=paint.backgroundColor.match(/[0-9]+/g)?.map(Number)??[];
      return rgb.length>=3 && rgb.slice(0,3).every(value=>value>=245);
    },null,{timeout:3000});
    await card.locator('img.document-thumb-image.is-visible').waitFor({timeout:45000});
    const thumb=await card.locator('img.document-thumb-image').evaluate(el=>({
      width:(el as HTMLImageElement).naturalWidth,
      height:(el as HTMLImageElement).naturalHeight,
      url:(el as HTMLImageElement).src,
    }));
    assert.ok(thumb.width>=300&&thumb.height>0&&thumb.url.startsWith('data:image/jpeg;base64,'),
      'Host generates a genuine first-slide JPEG locally after the PPTX download completes');
    assert.equal(await presentButton.isEnabled(),true);
    assert.equal(await downloadButton.isEnabled(),true);
    let releaseImport!: () => void, imported!: () => void;
    const importGate = new Promise<void>(resolve => { releaseImport = resolve; });
    const importRequested = new Promise<void>(resolve => { imported = resolve; });
    await host.context().route('**/assets/PowerPointPresenter-*.js', async route => {
      imported(); await importGate; await route.continue();
    });
    [popup]=await Promise.all([waitForPresenterPopup(host),presentButton.click()]);
    await importRequested;
    const brand = await popup.locator('.presentation-transition').elementHandle();
    assert.ok(brand);
    assert.equal(await popup.locator('.presentation-transition').isVisible(), true);
    assert.equal(await popup.locator('.presentation-transition-brand').innerText(), 'warpview');
    assert.equal(await popup.locator('.presentation-transition-spinner').isVisible(),true);
    assert.equal(await popup.locator('.presentation-transition-brand').evaluate(element=>{
      const title=element.querySelector('span')!.getBoundingClientRect();
      const spinner=element.querySelector('.presentation-transition-spinner')!.getBoundingClientRect();
      return spinner.top>title.bottom&&getComputedStyle(element.querySelector('.presentation-transition-spinner')!).animationName!=='none';
    }),true,'An animated loading indicator sits below WarpView');
    assert.doesNotMatch(await popup.locator('body').innerText(), /Loading PowerPoint|Opening PowerPoint|Opening presentation/);
    if (!process.env.FLASHVIEW_BACKEND)
      await popup.screenshot({ path:'test-artifacts/ui/preview-transition.png' });
    releaseImport();
    await popup.getByRole('spinbutton', { name: 'Slide number' }).waitFor({timeout:45000});
    await popup.waitForFunction(() => !(document.querySelector('[aria-label="Slide number"]') as HTMLInputElement)?.disabled);
    await popup.locator('.presentation-transition').waitFor({state:'hidden'});
    assert.equal(await brand.evaluate(element => element.isConnected), true, 'One branded layer survives both loading stages');
    assert.equal(await popup.getByRole('spinbutton', { name: 'Slide number' }).inputValue(), '1');
    await swipePreview(popup, '.flashview-pptx-canvas', -160);
    await popup.waitForFunction(() => (document.querySelector('[aria-label="Slide number"]') as HTMLInputElement)?.value === '2');
    await swipePreview(popup, '.flashview-pptx-canvas', 160);
    await popup.waitForFunction(() => (document.querySelector('[aria-label="Slide number"]') as HTMLInputElement)?.value === '1');
    await swipePreview(popup, '.flashview-pptx-canvas', 10, 150);
    assert.equal(await popup.getByRole('spinbutton', { name: 'Slide number' }).inputValue(), '1');
    await popup.getByRole('button', { name: 'Zoom in', exact:true }).click();
    await swipePreview(popup, '.flashview-pptx-canvas', -160);
    assert.equal(await popup.getByRole('spinbutton', { name: 'Slide number' }).inputValue(), '1', 'Zoomed dragging must not change slides');
    await popup.getByRole('button', { name: 'Reset zoom to fit' }).click();
    assert.equal(await popup.getByRole('button',{name:'Fullscreen',exact:true}).count(),1);
    await popup.getByRole('spinbutton', { name: 'Slide number' }).fill('2');
    await popup.getByRole('spinbutton', { name: 'Slide number' }).press('Enter');
    await popup.getByText('FlashView PowerPoint Test 2', { exact: true }).waitFor();
    await popup.getByRole('button', { name: 'Previous slide' }).click();
    await popup.waitForFunction(() => (document.querySelector('[aria-label="Slide number"]') as HTMLInputElement)?.value === '1');
    await popup.locator('.flashview-pptx-canvas').click();
    await popup.keyboard.press('ArrowRight');
    await popup.waitForFunction(() => (document.querySelector('[aria-label="Slide number"]') as HTMLInputElement)?.value === '2');
    await popup.setViewportSize({ width: 1660, height: 1016 });
    await assertPowerPointFits(popup);
    const fitted = await popup.locator('.pptxv-stage').boundingBox();
    await popup.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await popup.getByRole('button', { name: 'Zoom in', exact: true }).click();
    assert.equal(await popup.getByRole('button', { name: 'Reset zoom to fit' }).innerText(), '150%');
    await popup.waitForFunction(width => document.querySelector('.pptxv-stage')!.getBoundingClientRect().width > width * 1.48, fitted!.width);
    await popup.getByRole('button', { name: 'Reset zoom to fit' }).click();
    await assertPowerPointFits(popup);
    await popup.getByRole('button', { name: 'Zoom out', exact: true }).click();
    assert.equal(await popup.getByRole('button', { name: 'Reset zoom to fit' }).innerText(), '75%');
    await popup.getByRole('button', { name: 'Reset zoom to fit' }).click();
    await assertPowerPointFits(popup);
    await assertPresentationDock(popup);
    assert.equal(await popup.getByText('Notes', { exact: true }).isVisible(), false, 'No second renderer toolbar');
    if (!process.env.FLASHVIEW_BACKEND)
      await popup.screenshot({ path: 'test-artifacts/ui/powerpoint.png' });
    await popup.setViewportSize({ width: 375, height: 812 });
    await assertPowerPointFits(popup);
    await assertPresentationDock(popup);
    if (!process.env.FLASHVIEW_BACKEND)
      await popup.screenshot({ path: 'test-artifacts/ui/powerpoint-mobile.png' });
    await popup.setViewportSize({ width: 1280, height: 760 });
    if (await popup.evaluate(() => document.fullscreenEnabled)) {
      await popup.getByRole('button', { name: 'Fullscreen', exact: true }).click();
      await popup.waitForFunction(() => document.fullscreenElement?.classList.contains('flashview-pptx-presenter'));
      await assertPowerPointFits(popup);
      await assertPresentationDock(popup);
      assert.equal(await popup.getByRole('button', { name: 'Exit fullscreen' }).count(), 1);
    }
    assert.equal(await popup.locator('.flashview-pptx-state').count(),0);
    const [dl]=await Promise.all([host.waitForEvent('download'),downloadButton.click()]);
    const got=await readFile(await dl.path());
    assert.equal(createHash('sha256').update(got).digest('hex'),
      createHash('sha256').update(pptx).digest('hex'),
      'PowerPoint Download must preserve original bytes');
    await Promise.all([popup.waitForEvent('close'),
      popup.getByRole('button', { name: 'Close', exact: true }).click()]);
    assert.equal(await host.locator('.document-row').count(), 1, 'Close returns to the room without ending it');
  }finally{
    await popup?.close().catch(()=>{});
    await host.close();await student.close();await browser.close();child.kill('SIGTERM');
  }
});

test('host handover never sends a stale offline event; new host still receives the original file bytes',
  { timeout: 45000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const page = await browser.newPage();
  const root = 'http://127.0.0.1:' + port;
  try {
    await page.goto(root);
    // A string expression avoids tsx's __name wrapper leaking into the
    // isolated Playwright browser context when helper functions are nested.
    const result = await page.evaluate(`(async () => {
      const sockets = [];
      const open = async (auth, roomCode) => {
        const ws = new WebSocket(location.origin.replace(/^http/, 'ws') +
          '/ws?room=' + encodeURIComponent(roomCode));
        ws.binaryType = 'arraybuffer';
        sockets.push(ws);
        const events = [];
        const seen = [];
        ws.addEventListener('message', message => {
          if (typeof message.data === 'string') {
            const event = JSON.parse(message.data);
            events.push(event);
            seen.push(event.type);
          } else if (message.data instanceof ArrayBuffer) {
            events.push({ type: 'binary', data: Array.from(new Uint8Array(message.data)) });
            seen.push('binary');
          }
        });
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', () => resolve(), { once: true });
          ws.addEventListener('error', () => reject(Error('WebSocket error')), { once: true });
        });
        ws.send(JSON.stringify({ v: 1, type: 'hello', ...auth }));
        return { ws, events, seen };
      };
      const wait = async (peer, type) => {
        for (let i = 0; i < 120; i++) {
          const at = peer.events.findIndex(event => event.type === type);
          if (at >= 0) return peer.events.splice(at, 1)[0];
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw Error('Timeout waiting for ' + type);
      };
      try {
        const response = await fetch('/api/rooms?autoApprove=1', { method: 'POST' });
        if (!response.ok) throw Error('Room creation failed');
        const room = await response.json();
        const first = await open({ role: 'host', roomId: room.roomId, token: room.hostToken }, room.code);
        await wait(first, 'room.state');
        const phone = await open({ role: 'student', joinToken: room.joinToken, name: 'Handover' }, room.code);
        await wait(phone, 'join.accepted');
        const replacement = await open({ role: 'host', roomId: room.roomId, token: room.hostToken }, room.code);
        await wait(replacement, 'room.state');
        await wait(phone, 'host.online');
        await new Promise(resolve => setTimeout(resolve, 400));
        const lastOnlineAt = phone.seen.lastIndexOf('host.online');
        const staleOffline = phone.seen.slice(lastOnlineAt + 1)
          .filter(type => type === 'host.offline').length;
        const fileId = 'handovertransfer123';
        const bytes = Array.from({ length: 520 }, (_, i) => (i * 29 + 13) % 256);
        phone.ws.send(JSON.stringify({
          v: 1, type: 'file.offer', fileId, name: 'handover.bin', size: bytes.length,
        }));
        await wait(phone, 'file.approved');
        await wait(replacement, 'file.announced');
        const requestId = 'handoverrange123';
        replacement.ws.send(JSON.stringify({
          v: 1, type: 'range.request', requestId, fileId, begin: 0, end: bytes.length,
        }));
        await wait(phone, 'range.request');
        const json = new TextEncoder().encode(JSON.stringify({
          type: 'range.data', requestId, fileId, begin: 0,
        }));
        const packet = new Uint8Array(2 + json.length + bytes.length);
        new DataView(packet.buffer).setUint16(0, json.length);
        packet.set(json, 2);
        packet.set(bytes, 2 + json.length);
        phone.ws.send(packet.buffer);
        const delivered = await wait(replacement, 'binary');
        const raw = delivered.data;
        const headerLength = new DataView(new Uint8Array(raw).buffer).getUint16(0);
        const resultBytes = raw.slice(2 + headerLength);
        const completion = JSON.stringify({
          v: 1, type: 'cache.progress', fileId, bytes: bytes.length,
        });
        replacement.ws.send(completion);
        const firstReceipt = await wait(replacement, 'cache.progress.receipt');
        await wait(phone, 'cache.progress');
        // Model a lost confirmation: sender never saw the receipt and
        // resends the same whole-file message. The relay must re-receipt it.
        replacement.ws.send(completion);
        const retriedReceipt = await wait(replacement, 'cache.progress.receipt');
        const acknowledged = firstReceipt.bytes === bytes.length &&
          retriedReceipt.bytes === bytes.length &&
          firstReceipt.fileId === fileId && retriedReceipt.fileId === fileId;
        return { staleOffline, acknowledged,
          matches: JSON.stringify(resultBytes) === JSON.stringify(bytes) };
      } finally {
        for (const ws of sockets) ws.close();
      }
    })()`) as { staleOffline: number; matches: boolean; acknowledged: boolean };
    assert.equal(result.acknowledged, true,
      'Duplicate completion acknowledgments must receive idempotent relay receipts');
    assert.equal(result.staleOffline, 0,
      'An obsolete host socket cannot announce host.offline after the replacement comes online');
    assert.equal(result.matches, true, 'An uninterrupted relay handover must preserve original bytes');
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
});

test('connection guard: admission retry delay retains selected bytes and clears its notice after recovery', { timeout: 45000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage({ acceptDownloads: true });
  const phone = await browser.newPage();
  const identities: string[] = [];
  phone.on('websocket', ws => ws.on('framesent', ({ payload }) => {
    if (typeof payload === 'string') { const m = JSON.parse(payload); if (m.type === 'hello') identities.push(m.resumeToken); }
  }));
  try {
    const root = 'http://127.0.0.1:' + port;
    await host.goto(root); await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const token = await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!).joinToken as string);
    // Inject one server-requested wait without spending a real minute or
    // weakening server quotas. The real relay still authenticates the retry.
    await transferInit(phone, `{
      const Native = window.WebSocket;
      window.__guardSockets = [];
      window.WebSocket = class extends Native {
        constructor(...args) {
          super(...args); window.__guardSockets.push(this);
          this.addEventListener('message', event => {
            if (typeof event.data !== 'string') return;
            const m = JSON.parse(event.data);
            if (m.type === 'join.accepted' && !window.__guardDelayed) {
              window.__guardDelayed = true; window.__guardDeadline = Date.now() + 4000;
              event.stopImmediatePropagation();
              this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
                type: 'error', code: 'JOIN_RATE_LIMIT', retryable: true, retryAfterMs: 4000,
                message: 'This room is temporarily busy accepting new connections. Your files are kept; retrying shortly.'
              }) }));
              this.close();
            }
          });
        }
      };
    }`);
    await phone.goto(root + '/?join=' + encodeURIComponent(token));
    await phone.getByRole('button', { name: 'Skip for now', exact: true }).click();
    await phone.getByRole('alert').getByText(/Your files are kept/).waitFor();
    const original = Buffer.alloc(768 * 1024 + 7, 61);
    await phone.locator('input[type=file]').setInputFiles({ name: 'retained-during-wait.bin', mimeType: 'application/octet-stream', buffer: original });
    const before = await phone.evaluate(() => {
      for (let i = 0; i < 20; i++) { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); }
    });
    const guard = await transferEval(phone, () => {
      const w = window as typeof window & { __guardSockets: WebSocket[]; __guardDeadline: number };
      return { sockets: w.__guardSockets.length, remaining: w.__guardDeadline - Date.now() };
    });
    assert.equal(guard.sockets, 1); assert.ok(guard.remaining > 0);
    await phone.locator('.student-file-card .transfer-ring[aria-valuenow="100"]').waitFor({ timeout: 20000 });
    assert.equal(await phone.getByRole('alert').count(), 0, 'Successful admission clears only its own waiting notice');
    assert.equal(await host.locator('.participant-row').count(), 1);
    assert.equal(identities.length, 2); assert.equal(identities[0], identities[1]);
    const event = host.waitForEvent('download');
    await host.getByRole('button', { name: 'Download retained-during-wait.bin' }).click();
    assert.deepEqual(await readFile((await (await event).path())!), original);
    await host.getByRole('button', { name: 'End room', exact: true }).click();
    await host.getByRole('button', { name: 'End & clear cache', exact: true }).click();
    await host.locator('.welcome').waitFor();
  } finally { await browser.close(); child.kill(); }
});

test('room admission: capacity denial stops replay, releases local slots and preserves cached originals', { timeout: 70000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage({ acceptDownloads: true });
  const phone = await browser.newPage();
  const offered: string[] = [];
  let manifests = 0;
  phone.on('websocket', ws => {
    ws.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') return;
      const m = JSON.parse(payload); if (m.type === 'file.offer') offered.push(m.name);
    });
    ws.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string' && JSON.parse(payload).type === 'file.manifest') manifests++;
    });
  });
  try {
    const root = 'http://127.0.0.1:' + port;
    await host.goto(root);
    await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const session = await host.evaluate(() => JSON.parse(sessionStorage.getItem('flashview-host')!));
    await phone.goto(root + '/?join=' + encodeURIComponent(session.joinToken));
    await phone.getByRole('button', { name: 'Skip for now', exact: true }).click();
    await phone.locator('.student-add-fab:not([disabled])').waitFor();
    const original = Buffer.alloc(4096, 73);
    await phone.locator('input[type=file]').setInputFiles({ name: 'already-received.bin', mimeType: 'application/octet-stream', buffer: original });
    await phone.locator('.student-file-card .transfer-ring[aria-valuenow="100"]').waitFor();
    // Reserve metadata only, not 4 GiB of generated/network/disk data. These
    // short-lived senders then go offline; their retained manifests still count.
    await host.evaluate(async token => {
      for (let sender = 0; sender < 3; sender++) {
        const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws?room=' + token.split('.')[0]);
        let waiting: { type: string; resolve: () => void; reject: (error: Error) => void } | undefined;
        let last = 'opening', file = -1;
        const watchdog = setInterval(() => waiting?.reject(Error('Admission fixture stalled: sender ' + sender +
          ', file ' + file + ', waiting ' + waiting.type + ', last ' + last)), 8000);
        ws.addEventListener('message', event => {
          if (typeof event.data !== 'string') return;
          const m = JSON.parse(event.data);
          last = m.type + ':' + (m.code ?? '');
          if (m.type === 'error' || m.type === 'file.rejected' || m.type === 'join.rejected')
            waiting?.reject(Error('Admission fixture refused: ' + last));
          if (waiting && m.type === waiting.type) { const next = waiting; waiting = undefined; next.resolve(); }
        });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Admission fixture handshake timed out')), 8000);
          ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
          ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('Admission fixture connection failed')); }, { once: true });
        });
        const joined = new Promise<void>((resolve, reject) => { waiting = { type: 'join.accepted', resolve, reject }; });
        ws.send(JSON.stringify({ type: 'hello', role: 'student', joinToken: token, name: 'Budget fixture' })); await joined;
        for (let i = sender * 10; i < Math.min(21, (sender + 1) * 10); i++) {
          file = i;
          const acknowledged = new Promise<void>((resolve, reject) => { waiting = { type: 'file.state', resolve, reject }; });
          ws.send(JSON.stringify({ type: 'file.offer', fileId: 'browser-budget-' + i, name: 'reserved-' + i + '.bin',
            size: i < 20 ? 200 * 1024 * 1024 : 96 * 1024 * 1024 - 4096 }));
          await acknowledged;
        }
        clearInterval(watchdog);
        const closed = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Fixture close handshake timed out for sender ' + sender)), 8000);
          ws.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        ws.close(); await closed;
      }
    }, session.joinToken);
    await phone.locator('input[type=file]').setInputFiles({ name: 'denied.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(64) });
    await phone.getByRole('alert').getByText(/4 GiB file budget/).waitFor();
    assert.equal(await phone.locator('.student-file-card').count(), 1, 'Denied file cannot leave a phantom uploading card');
    for (let i = 0; i < 3; i++) {
      const before = manifests;
      await phone.evaluate(() => window.dispatchEvent(new Event('focus')));
      for (let tries = 0; tries < 100 && manifests === before; tries++) await delay(20);
      assert.ok(manifests > before, 'Force authoritative reconciliation after rejection');
    }
    assert.equal(offered.filter(name => name === 'denied.bin').length, 1, 'Capacity failures are not endlessly re-offered');
    // Nine remaining local slots are still usable after a rejected selection.
    await phone.locator('input[type=file]').setInputFiles(Array.from({ length: 9 }, (_, i) => ({
      name: 'denied-batch-' + i + '.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(64),
    })));
    for (let tries = 0; tries < 100 && offered.filter(name => name.startsWith('denied-batch-')).length < 9; tries++) await delay(20);
    assert.equal(offered.filter(name => name.startsWith('denied-batch-')).length, 9, 'Rejected offers release local admission slots');
    await phone.waitForFunction(() => document.querySelectorAll('.student-file-card').length === 1);
    const ready = host.locator('.document-row').filter({ hasText: 'already-received.bin' });
    const downloading = host.waitForEvent('download');
    await ready.getByRole('button', { name: 'Download already-received.bin' }).click();
    assert.deepEqual(await readFile((await (await downloading).path())!), original);
    await host.getByRole('button', { name: 'End room', exact: true }).click();
    await host.getByRole('button', { name: 'End & clear cache', exact: true }).click();
    await host.locator('.welcome').waitFor();
  } finally { await browser.close(); child.kill(); }
});

test('phone and relay enforce the same ten-file room limit without phantom uploads',
  { timeout: 85000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage();
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const root = 'http://127.0.0.1:' + port;
  try {
    await host.goto(root);
    await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const code = (await host.locator('.room-code').innerText()).trim();
    await phone.goto(root);
    await phone.locator('#code').fill(code);
    await phone.getByRole('button', { name: /Join room/ }).click();
    await phone.locator('.student-drive').waitFor();
    const files = Array.from({ length: 11 }, (_, index) => ({
      name: 'limit-' + index + '.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(40 + index, index),
    }));
    await phone.locator('input[type=file]').setInputFiles(files);
    await phone.locator('.student-file-card').nth(9).waitFor({ timeout: 15000 });
    assert.equal(await phone.locator('.student-file-card').count(), 10);
    assert.equal(await phone.getByText('limit-10.bin').count(), 0);
    await phone.getByRole('alert').getByText(/up to 10 files per person/i)
      .waitFor({ timeout: 7000 });
    await host.locator('.document-row').filter({ hasText: 'limit-9.bin' })
      .locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 25000 });
    assert.equal(await host.locator('.document-row').count(), 10,
      'No rejected eleventh file should enter the host queue');
    await phone.waitForFunction(() =>
      document.querySelectorAll('.student-file-card .transfer-ring[aria-valuenow="100"]').length === 10,
      null, { timeout: 25000 });
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
});

test('a transient host IndexedDB write failure recovers without reuploading the entire file', { timeout: 70000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage();
  const student = await browser.newPage();
  const root = 'http://127.0.0.1:' + port;
  const original = makePdf(2100);
  try {
    await transferInit(host, () => {
      const put = IDBObjectStore.prototype.put;
      let rejected = false;
      IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
        if (!rejected && this.name === 'chunks') {
          rejected = true;
          (window as typeof window & { __testFailedWrite?: boolean }).__testFailedWrite = true;
          throw new DOMException('Synthetic transient storage failure', 'QuotaExceededError');
        }
        return key === undefined ? put.call(this, value) : put.call(this, value, key);
      };
    });
    await host.goto(root);
    await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const code = (await host.locator('.room-code').innerText()).trim();
    await student.goto(root);
    await student.locator('#code').fill(code);
    await student.getByRole('button', { name: /Join room/ }).click();
    await student.locator('.student-drive').waitFor();
    await student.locator('input[type=file]').setInputFiles({
      name: 'recover-storage.pdf', mimeType: 'application/pdf', buffer: original,
    });
    const row = host.locator('.document-row').filter({ hasText: 'recover-storage.pdf' });
    await row.waitFor();
    await transferWait(host, () => (window as typeof window & { __testFailedWrite?: boolean }).__testFailedWrite === true);
    await row.locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 40000 });
    const actualDigest = await host.evaluate(async room => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('flashview-room-cache');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const records = await new Promise<Array<{ index: number; data: ArrayBuffer }>>((resolve, reject) => {
        const request = database.transaction('chunks', 'readonly').objectStore('chunks')
          .index('room').getAll(IDBKeyRange.only(room));
        request.onsuccess = () => resolve(request.result as Array<{ index: number; data: ArrayBuffer }>);
        request.onerror = () => reject(request.error);
      });
      records.sort((a, b) => a.index - b.index);
      const length = records.reduce((sum, item) => sum + item.data.byteLength, 0);
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const item of records) {
        bytes.set(new Uint8Array(item.data), offset);
        offset += item.data.byteLength;
      }
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return Array.from(hash, b => b.toString(16).padStart(2, '0')).join('');
    }, await cacheIdentity(host));
    assert.equal(actualDigest, createHash('sha256').update(original).digest('hex'),
      'Recovery must preserve original bytes exactly');
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
});

test('a deleted cached chunk retracts false completion and is downloaded again', { timeout: 70000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage();
  const student = await browser.newPage();
  const root = 'http://127.0.0.1:' + port;
  const original = makePdf(1600);
  try {
    // Test-only socket capture installed before the app constructs its socket.
    await transferInit(host, () => {
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          const record = window as typeof window & { __staleSockets?: WebSocket[] };
          (record.__staleSockets ??= []).push(this);
        }
      };
    });
    await host.goto(root);
    await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const code = (await host.locator('.room-code').innerText()).trim();
    await student.goto(root);
    await student.locator('#code').fill(code);
    await student.getByRole('button', { name: /Join room/ }).click();
    await student.locator('.student-drive').waitFor();
    await student.locator('input[type=file]').setInputFiles({
      name: 'stale-cache.pdf', mimeType: 'application/pdf', buffer: original,
    });
    const row = host.locator('.document-row').filter({ hasText: 'stale-cache.pdf' });
    await row.locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 25000 });
    // First the relay and student agree that the ORIGINAL cache is complete.
    await student.locator('.student-file-card').filter({ hasText: 'stale-cache.pdf' })
      .locator('.transfer-ring[aria-valuenow="100"]').waitFor({ timeout: 15000 });
    // Freeze ALL new phone reads after initial completion. This makes the
    // downward correction observable before the missing range can be repaired.
    await transferEval(student, () => {
      const read = Blob.prototype.arrayBuffer;
      const waiting: Array<() => void> = [];
      let released = false;
      Blob.prototype.arrayBuffer = async function (...args) {
        if (!released) await new Promise<void>(resolve => waiting.push(resolve));
        return read.apply(this, args);
      };
      (window as typeof window & { __releaseCacheRepair?: () => void }).__releaseCacheRepair =
        () => { released = true; for (const resolve of waiting.splice(0)) resolve(); };
    });
    const removed = await host.evaluate(room => new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('flashview-room-cache');
      request.onsuccess = () => {
        const store = request.result.transaction('chunks', 'readwrite').objectStore('chunks');
        const cursor = store.index('room').openKeyCursor(IDBKeyRange.only(room));
        cursor.onsuccess = () => {
          const result = cursor.result;
          if (!result) { reject(Error('No cache chunk to remove')); return; }
          const key = String(result.primaryKey);
          const tx = store.transaction;
          store.delete(key);
          tx.oncomplete = () => resolve(1);
          tx.onerror = () => reject(tx.error);
        };
        cursor.onerror = () => reject(cursor.error);
      };
      request.onerror = () => reject(request.error);
    }), await cacheIdentity(host));
    assert.equal(removed, 1);

    // The app only synchronizes in a visible teacher tab, by design.
    // Make this the foreground tab before synthesizing focus; a hidden-tab
    // focus event is correctly ignored and would test a different behavior.
    await host.bringToFront();
    assert.equal(await host.evaluate(() => document.visibilityState), 'visible');
    await transferEval(host, () => {
      const record = window as typeof window & {
        __staleSockets?: WebSocket[];
        __staleCacheEvents?: string[];
      };
      record.__staleCacheEvents = [];
      const ws = record.__staleSockets?.at(-1);
      if (!ws) throw Error('No host WebSocket for cache repair test');
      const send = ws.send.bind(ws);
      ws.send = ((data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
        if (typeof data === 'string') {
          const msg = JSON.parse(data) as { type?: string };
          if (msg.type) record.__staleCacheEvents!.push('out:' + msg.type);
        }
        return send(data);
      }) as WebSocket['send'];
      ws.addEventListener('message', event => {
        if (typeof event.data !== 'string') return;
        const msg = JSON.parse(event.data) as { type?: string };
        if (msg.type) record.__staleCacheEvents!.push('in:' + msg.type);
      });
    });
    // Ask for the server manifest without recreating the teacher's cache.
    // The scheduler must revalidate the local 100% index, discover the
    // missing chunk and independently request it from the original sender.
    await host.evaluate(() => window.dispatchEvent(new Event('focus')));
    try {
      await row.locator('.cache-ring[aria-valuenow="100"]').waitFor({ state: 'hidden', timeout: 12000 });
    } catch (error) {
      const diagnostics = await host.evaluate(async room => {
        const record = window as typeof window & {
          __staleSockets?: WebSocket[];
          __staleCacheEvents?: string[];
        };
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('flashview-room-cache');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
          const req = db.transaction('chunks', 'readonly').objectStore('chunks')
            .index('room').getAllKeys(IDBKeyRange.only(room));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        return {
          visibility: document.visibilityState,
          socketState: record.__staleSockets?.at(-1)?.readyState,
          events: record.__staleCacheEvents,
          cachedKeys: keys.map(String),
          ringValues: [...document.querySelectorAll('.document-row .cache-ring')]
            .map(el => el.getAttribute('aria-valuenow')),
          documentText: document.body.innerText.slice(-900),
        };
      }, await cacheIdentity(host));
      console.error('STALE_CACHE_DIAGNOSTICS', JSON.stringify(diagnostics));
      throw error;
    }
    await transferEval(student, () => {
      (window as typeof window & { __releaseCacheRepair?: () => void }).__releaseCacheRepair?.();
    });
    await row.locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 25000 });
    const digest = await host.evaluate(async room => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('flashview-room-cache');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const chunks = await new Promise<Array<{ index: number; data: ArrayBuffer }>>((resolve, reject) => {
        const request = db.transaction('chunks', 'readonly').objectStore('chunks')
          .index('room').getAll(IDBKeyRange.only(room));
        request.onsuccess = () => resolve(request.result as Array<{ index: number; data: ArrayBuffer }>);
        request.onerror = () => reject(request.error);
      });
      chunks.sort((a, b) => a.index - b.index);
      const bytes = new Uint8Array(chunks.reduce((n, item) => n + item.data.byteLength, 0));
      let cursor = 0;
      for (const chunk of chunks) {
        bytes.set(new Uint8Array(chunk.data), cursor);
        cursor += chunk.data.byteLength;
      }
      const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return Array.from(hashed, b => b.toString(16).padStart(2, '0')).join('');
    }, await cacheIdentity(host));
    assert.equal(digest, createHash('sha256').update(original).digest('hex'));
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
});

test('a stalled IndexedDB index query times out and retries without losing a phone file', { timeout: 70000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage();
  const student = await browser.newPage();
  const root = 'http://127.0.0.1:' + port;
  const pdf = makePdf(750);
  try {
    await transferInit(host, () => {
      const getAllKeys = IDBIndex.prototype.getAllKeys;
      let blocked = false;
      IDBIndex.prototype.getAllKeys = function (...args) {
        if (!blocked && this.name === 'document') {
          blocked = true;
          (window as typeof window & { __blockedIndexOnce?: boolean }).__blockedIndexOnce = true;
          // Deliberately never notify onsuccess/onerror. The transaction
          // itself is allowed to finish to reproduce the browser edge case.
          return { onsuccess: null, onerror: null } as unknown as IDBRequest<IDBValidKey[]>;
        }
        return getAllKeys.apply(this, args);
      };
    });
    await host.goto(root);
    await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const code = (await host.locator('.room-code').innerText()).trim();
    await student.goto(root);
    await student.locator('#code').fill(code);
    await student.getByRole('button', { name: /Join room/ }).click();
    await student.locator('.student-drive').waitFor();
    await student.locator('input[type=file]').setInputFiles({
      name: 'index-timeout.pdf', mimeType: 'application/pdf', buffer: pdf,
    });
    await transferWait(host, () =>
      (window as typeof window & { __blockedIndexOnce?: boolean }).__blockedIndexOnce === true);
    const row = host.locator('.document-row').filter({ hasText: 'index-timeout.pdf' });
    await row.locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 35000 });
    const digest = await host.evaluate(async room => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('flashview-room-cache');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const chunks = await new Promise<Array<{index: number; data: ArrayBuffer}>>((resolve, reject) => {
        const req = db.transaction('chunks', 'readonly').objectStore('chunks').index('room')
          .getAll(IDBKeyRange.only(room));
        req.onsuccess = () => resolve(req.result as Array<{index: number; data: ArrayBuffer}>);
        req.onerror = () => reject(req.error);
      });
      chunks.sort((a, b) => a.index - b.index);
      const bytes = new Uint8Array(chunks.reduce((count, chunk) => count + chunk.data.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(new Uint8Array(chunk.data), offset);
        offset += chunk.data.byteLength;
      }
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return Array.from(hash, n => n.toString(16).padStart(2, '0')).join('');
    }, await cacheIdentity(host));
    assert.equal(digest, createHash('sha256').update(pdf).digest('hex'),
      'The resumed transfer must persist every original byte');
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
});

test('large binary download streams IndexedDB records without a getAll whole-file copy', {timeout: 130000}, async () => {
  const {port,child}=await runningServer();
  const browser=await browserEngine.launch({headless:true});
  const host=await browser.newPage({acceptDownloads:true});
  const student=await browser.newPage();
  const root='http://127.0.0.1:'+port;
  // Bigger than the 48 MiB LRU's individual transfer windows, and much
  // bigger than normal PDF range packets, without a huge CI fixture.
  const bytes=Buffer.alloc(12*1024*1024+137);
  for (let i=0; i<bytes.length; i++) bytes[i]=(i*31+(i>>13))&255;
  try {
    await transferInit(host, () => {
      const getAll=IDBIndex.prototype.getAll;
      const record=window as typeof window & {__bulkCacheReads?: number};
      record.__bulkCacheReads=0;
      IDBIndex.prototype.getAll=function(...args) {
        if (this.name==='document') {
          record.__bulkCacheReads!++;
          throw Error('Whole-file IndexedDB getAll is forbidden in large-file downloads');
        }
        return getAll.apply(this,args);
      };
    });
    await host.goto(root);
    await host.getByRole('button',{name:/Create a room/}).click();
    await host.locator('.connection.connected').waitFor();
    const code=(await host.locator('.room-code').innerText()).trim();
    await student.goto(root);
    await student.locator('#code').fill(code);
    await student.getByRole('button',{name:/Join room/}).click();
    await student.locator('.student-drive').waitFor();
    await student.locator('input[type=file]').setInputFiles({
      name:'large-payload.bin',mimeType:'application/octet-stream',buffer:bytes,
    });
    const card=host.locator('.document-row').filter({hasText:'large-payload.bin'});
    await card.locator('.cache-ring[aria-valuenow="100"]').waitFor({timeout:90000});
    // Trap a second full-size JavaScript allocation only during the download.
    // The network path remains free to allocate its small range packets.
    await host.evaluate(() => {
      const Original = Uint8Array;
      const state = window as typeof window & { __largeDownloadAllocations?: number };
      state.__largeDownloadAllocations = 0;
      (window as typeof window & { Uint8Array: typeof Uint8Array }).Uint8Array =
        new Proxy(Original, {
          construct(target, args, newTarget) {
            if (typeof args[0] === 'number' && args[0] > 2 * 1024 * 1024) {
              state.__largeDownloadAllocations!++;
              throw Error('Download allocated a second whole-file JS buffer');
            }
            return Reflect.construct(target, args, newTarget);
          },
        });
    });
    const [download]=await Promise.all([
      host.waitForEvent('download',{timeout:30000}),
      card.getByRole('button',{name:'Download large-payload.bin'}).click(),
    ]);
    const saved=await readFile(await download.path());
    assert.equal(createHash('sha256').update(saved).digest('hex'),
      createHash('sha256').update(bytes).digest('hex'),
      'Assembling IndexedDB chunks one-by-one must preserve all original bytes');
    assert.equal(await host.evaluate(()=>
      (window as typeof window & {__bulkCacheReads?: number}).__bulkCacheReads ?? -1),0,
      'A completed-file read must never bulk-clone every chunk into JS memory');
    assert.equal(await host.evaluate(() =>
      (window as typeof window & {__largeDownloadAllocations?: number})
        .__largeDownloadAllocations ?? -1), 0,
      'Saving should not allocate a second file-sized Uint8Array');
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
});

test('persistent quota triggers visible pause and explicit byte-exact recovery', {timeout: 105000}, async () => {
  const {port,child}=await runningServer();
  const browser=await browserEngine.launch({headless:true});
  const host=await browser.newPage({acceptDownloads:true});
  const student=await browser.newPage();
  const root='http://127.0.0.1:'+port;
  const original=Buffer.alloc(410_123);
  for(let i=0;i<original.length;i++)original[i]=(i*13+(i>>8))&255;
  try {
    await transferInit(host, () => {
      const put=IDBObjectStore.prototype.put;
      let full=true;
      let failures=0;
      const scope=window as typeof window & {
        __quotaFailures?: () => number; __restoreStorage?: () => void;
      };
      scope.__quotaFailures=()=>failures;
      scope.__restoreStorage=()=>{full=false;};
      IDBObjectStore.prototype.put=function(value: unknown, key?: IDBValidKey) {
        if(this.name==='chunks' && full) {
          failures++;
          throw new DOMException('Synthetic persistent quota failure','QuotaExceededError');
        }
        return key===undefined ? put.call(this,value) : put.call(this,value,key);
      };
    });
    await host.goto(root);
    await host.getByRole('button',{name:/Create a room/}).click();
    await host.locator('.connection.connected').waitFor();
    const code=(await host.locator('.room-code').innerText()).trim();
    await student.goto(root);
    await student.locator('#code').fill(code);
    await student.getByRole('button',{name:/Join room/}).click();
    await student.locator('.student-drive').waitFor();
    await student.locator('input[type=file]').setInputFiles({
      name:'quota-blocked.bin',mimeType:'application/octet-stream',buffer:original,
    });
    const row=host.locator('.document-row').filter({hasText:'quota-blocked.bin'});
    await row.waitFor();
    const banner=host.getByTestId('storage-blocked');
    await banner.waitFor({timeout:55000});
    assert.match(await banner.innerText(),/Browser storage is full/i);
    assert.equal(await row.locator('.cache-ring[aria-valuenow="100"]').count(),0);
    assert.equal(await host.locator('.connection.connected').count(),1,
      'Full browser quota should never restart the shared room socket');
    const before=await transferEval(host, ()=>
      (window as typeof window & {__quotaFailures?:()=>number}).__quotaFailures?.() ?? -1);
    await delay(1800);
    const after=await transferEval(host, ()=>
      (window as typeof window & {__quotaFailures?:()=>number}).__quotaFailures?.() ?? -1);
    assert.equal(after,before,'Storage retries must stop after the persistent quota threshold');
    await transferEval(host, ()=>
      (window as typeof window & {__restoreStorage?:()=>void}).__restoreStorage?.());
    await banner.getByRole('button',{name:'Retry saving'}).click();
    await row.locator('.cache-ring[aria-valuenow="100"]').waitFor({timeout:45000});
    await banner.waitFor({state:'hidden',timeout:12000});
    const [download]=await Promise.all([
      host.waitForEvent('download',{timeout:15000}),
      row.getByRole('button',{name:'Download quota-blocked.bin'}).click(),
    ]);
    const saved=await readFile(await download.path());
    assert.equal(createHash('sha256').update(saved).digest('hex'),
      createHash('sha256').update(original).digest('hex'));
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
});
