import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';

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
    ? ['node_modules/wrangler/bin/wrangler.js', 'dev', '--port', String(port), '--ip', '127.0.0.1']
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

test('real Chromium: QR-equivalent room flow renders PDF.js page through WebSocket relay', { timeout: 90000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await chromium.launch({ headless: true });
  const host = await browser.newPage();
  const student = await browser.newPage();
  // Record the current WebSocket in the student's browser without adding a production debug API.
  await student.addInitScript({ content: `
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
    await student.getByText('Choose a PDF to share.').waitFor();

    await student.locator('input[type=file]').setInputFiles({
      name: 'smoke.pdf',
      mimeType: 'application/pdf',
      buffer: makePdf(),
    });
    await host.locator('.document-row').filter({ hasText: 'smoke.pdf' }).waitFor();
    // Visual regression: every PDF carries a palette-based file identity.
    const swatch = await host.locator('.document-row').first().evaluate(element => {
      const icon = element.querySelector('.file-icon');
      return icon ? {
        accent: getComputedStyle(element).getPropertyValue('--file-accent').trim(),
        background: getComputedStyle(icon).backgroundColor,
      } : null;
    });
    assert.match(swatch?.accent ?? '', /^#[0-9A-Fa-f]{6}$/);
    assert.notEqual(swatch?.background, 'rgba(0, 0, 0, 0)');
    if (!process.env.FLASHVIEW_BACKEND) {
      // Locator waits can scroll the test viewport. Reset before full-page
      // captures so sticky navigation isn't composited halfway down the page.
      await host.evaluate(() => window.scrollTo(0, 0));
      await student.evaluate(() => window.scrollTo(0, 0));
      await host.screenshot({ path: 'test-artifacts/ui/classroom.png', fullPage: true });
      await student.screenshot({ path: 'test-artifacts/ui/student.png', fullPage: true });
    }
    // Student approval also approves each new PDF automatically.
    await student.locator('.sent-row').filter({ hasText: 'smoke.pdf' })
      .getByText('Shared — caching on classroom computer').waitFor();
    // Cache starts before any teacher presentation tab is opened.
    await host.locator('.document-row').filter({ hasText: 'smoke.pdf' })
      .getByText(/saved|cached on this computer/).waitFor({ timeout: 15000 });
    const [presentation] = await Promise.all([
      host.waitForEvent('popup'),
      host.locator('.document-row').getByRole('button', { name: /Present/ }).click(),
    ]);
    // Teacher's queue remains available while the PDF is projected.
    assert.equal(await host.locator('.document-row').count(), 1);
    // Projector view must be truly black around the actual PDF.
    const stageColor = await presentation.locator('.page-stage')
      .evaluate(element => getComputedStyle(element).backgroundColor);
    assert.equal(stageColor, 'rgb(0, 0, 0)');
    await presentation.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.page-shell canvas');
      return Boolean(canvas && canvas.width >= 500 && canvas.height >= 700 &&
        canvas.dataset.renderedPage === '1' && !document.querySelector('.viewer-alert'));
    }, null, { timeout: 20000 });
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
    if (!process.env.FLASHVIEW_BACKEND) {
      await presentation.screenshot({ path: 'test-artifacts/ui/presentation.png' });
    }
    assert.match(await presentation.locator('.viewer-filename').innerText(), /direct local rendering/);
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
    await host.getByText('Fully cached on this computer').waitFor({ timeout: 15000 });
    assert.equal(await host.locator('.document-row .file-progress-track').first().getAttribute('aria-valuenow'), '100');
    await delay(process.env.FLASHVIEW_BACKEND === 'cloudflare' ? 350 : 31_200);
    assert.equal(await presentation.locator('.viewer-alert').count(), 0);
    await presentation.getByRole('spinbutton', { name: 'Page number' }).fill('1');
    await presentation.getByRole('spinbutton', { name: 'Page number' }).press('Enter');
    await presentation.waitForFunction(() =>
      !document.querySelector('.page-overlay') && !document.querySelector('.viewer-alert'),
      null, { timeout: 20000 });
    await presentation.close();
    assert.equal(await host.locator('.document-row').count(), 1);

    // Simulate exactly what happens when a mobile browser drops the connection.
    // No teacher reapproval or file reselection should be needed on recovery.
    await student.evaluate(() => {
      const record = window as typeof window & { __flashviewSockets?: WebSocket[] };
      const ws = record.__flashviewSockets?.at(-1);
      if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Expected an open WebSocket');
      ws.close(4100, 'Simulated mobile tab background');
    });
    await student.waitForFunction(() => {
      const record = window as typeof window & { __flashviewSockets?: WebSocket[] };
      const sockets = record.__flashviewSockets ?? [];
      return sockets.length >= 2 && sockets.at(-1)?.readyState === WebSocket.OPEN &&
        document.querySelector('.connection.connected') !== null &&
        (document.querySelector('.sent-row')?.textContent ?? '').includes('Shared — caching on classroom computer');
    }, null, { timeout: 20000 });
    assert.match(await student.locator('.sent-row').innerText(), /smoke\.pdf/);

    // Drop exactly ONE student announcement while the WebSocket still reports OPEN.
    // The sender must not claim server acceptance; sync repairs the lost offer.
    await student.evaluate(() => {
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
    await student.locator('.sent-row').filter({ hasText: 'lost-announcement.pdf' })
      .getByText('Sending announcement…').waitFor();
    assert.equal(await host.locator('.document-row').count(), 1);
    // A tab returning online asks the server for its authoritative manifest.
    await student.evaluate(() => window.dispatchEvent(new Event('online')));
    await host.locator('.document-row').filter({ hasText: 'lost-announcement.pdf' }).waitFor({ timeout: 15000 });
    await student.locator('.sent-row').filter({ hasText: 'lost-announcement.pdf' })
      .getByText('Shared — caching on classroom computer').waitFor();
    // The host refreshes all server-persisted submissions after missed broadcasts.
    await host.getByRole('button', { name: /Refresh submissions/ }).click();
    assert.equal(await host.locator('.document-row').count(), 2);
    await host.locator('.document-row').filter({ hasText: 'lost-announcement.pdf' })
      .getByText('Fully cached on this computer').waitFor({ timeout: 15000 });

    const [secondPresentation] = await Promise.all([
      host.waitForEvent('popup'),
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
      .getByText('Fully cached on this computer').waitFor();
    await host.reload();
    await host.locator('.connection.connected').waitFor();
    await host.locator('.document-row').filter({ hasText: 'smoke.pdf' })
      .getByText('Fully cached on this computer').waitFor({ timeout: 12000 });
    const [offlinePresentation] = await Promise.all([
      host.waitForEvent('popup'),
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

    const countRoomChunks = async () => host.evaluate(room => new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('flashview-room-cache');
      request.onsuccess = () => {
        const tx = request.result.transaction('chunks', 'readonly');
        const count = tx.objectStore('chunks').index('room').count(IDBKeyRange.only(room));
        count.onsuccess = () => resolve(count.result);
        count.onerror = () => reject(count.error);
      };
      request.onerror = () => reject(request.error);
    }), roomCode!);
    assert.ok(await countRoomChunks() >= 3, 'Expected cached PDF chunks');
    await host.getByRole('button', { name: /End session/ }).click();
    await host.getByRole('button', { name: /End & clear cache/ }).isDisabled().then(x => assert.equal(x, true));
    await host.getByRole('checkbox', { name: /I understand/ }).check();
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
  const browser = await chromium.launch({ headless: true });
  const host = await browser.newPage();
  const student = await browser.newPage();
  // Simulate an overloaded phone/campus relay. PDF.js may need bytes from
  // anywhere in a non-linearized PDF; delay those reads, never block them.
  // Full caching then takes many seconds, leaving time for early page render.
  await student.addInitScript(() => {
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
    await host.goto(root);
    await host.getByRole('button', { name: /Create a room/ }).click();
    const code = await host.locator('.room-code').innerText();
    await host.locator('.connection.connected').waitFor();
    await student.goto(root);
    await student.locator('#code').fill(code);
    await student.getByRole('button', { name: /Join room/ }).click();
    await host.locator('.approval').waitFor();
    await host.locator('.approval').getByRole('button', { name: 'Allow' }).click();
    await student.getByText('Choose a PDF to share.').waitFor();

    const pdfBytes = makePdf(35000);
    await student.locator('input[type=file]').setInputFiles({
      name: 'progressive.pdf',
      mimeType: 'application/pdf',
      buffer: pdfBytes,
    });
    const row = host.locator('.document-row').filter({ hasText: 'progressive.pdf' });
    await row.waitFor();
    [presentation] = await Promise.all([
      host.waitForEvent('popup'),
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
    }), code);
    // Allow the initial batch already in-flight before the foreground request
    // to drain. The background pump must still fetch MORE chunks after that.
    await delay(1300);
    const before = await cachedChunks();
    await delay(2400);
    const after = await cachedChunks();
    assert.ok(after > before, 
      'Background cache must keep advancing while a foreground range remains pending: ' + before + ' -> ' + after);

    // Either real ranged PDF.js rendering or the phone-produced first-slide
    // preview can win the race. Both must visibly show the correct first page
    // while a large background transfer is still incomplete.
    await presentation.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-rendered-page="1"]');
      const jpeg = document.querySelector<HTMLImageElement>('img[data-first-page-preview]');
      return Boolean((canvas || (jpeg && jpeg.complete && jpeg.naturalWidth > 0)) &&
        !document.querySelector('.viewer-alert'));
    }, null, { timeout: 22000 });
    assert.doesNotMatch(await row.innerText(), /Fully cached on this computer/,
      'The first slide MUST be visible before background downloading finishes');
    assert.match(await presentation.locator('.viewer-filename').innerText(), /streaming preview/);
    const image = presentation.locator('img[data-first-page-preview]');
    const earlySlideVisible = await image.count() > 0 ||
      await presentation.locator('canvas[data-rendered-page="1"]').count() > 0;
    assert.equal(earlySlideVisible, true, 'The first slide should appear before 100%');

    // For the preview route, ensure the image actually decoded.
    if (await image.count()) {
      assert.equal(await image.evaluate(el => (el as HTMLImageElement).naturalWidth > 200), true);
    }

    // A second student's small PDF must complete even while the first
    // student has an intentionally blocked range request. This used to be
    // impossible when the scheduler awaited a whole per-file batch.
    const fastStudent = await browser.newPage();
    await fastStudent.goto(root);
    await fastStudent.locator('#code').fill(code);
    await fastStudent.getByRole('button', { name: /Join room/ }).click();
    const fastApproval = host.locator('.approval').filter({ hasText: 'Student' });
    await fastApproval.last().getByRole('button', { name: 'Allow' }).click();
    await fastStudent.getByText('Choose a PDF to share.').waitFor();
    await fastStudent.locator('input[type=file]').setInputFiles({
      name: 'fast-peer.pdf', mimeType: 'application/pdf', buffer: makePdf(),
    });
    await host.locator('.document-row').filter({ hasText: 'fast-peer.pdf' })
      .getByText('Fully cached on this computer').waitFor({ timeout: 15000 });
    assert.doesNotMatch(await row.innerText(), /Fully cached on this computer/,
      'The deliberately blocked first sender must still be downloading');
    await fastStudent.close();

    // Release the delayed foreground request and the document's cross-ref
    // tail. The original bytes should finish caching without closing the viewer.
    await student.evaluate(() => {
      (window as typeof window & { __releaseHeldTail?: () => void }).__releaseHeldTail?.();
    });
    await row.getByText('Fully cached on this computer').waitFor({ timeout: 45000 });
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
  const browser = await chromium.launch({ headless: true });
  const host = await browser.newPage();
  const student = await browser.newPage();
  try {
    const root = 'http://127.0.0.1:' + port;
    await host.goto(root);
    await host.getByRole('button', { name: /Create a room/ }).click();
    const code = await host.locator('.room-code').innerText();
    await host.locator('.connection.connected').waitFor();
    await student.goto(root);
    await student.locator('#code').fill(code);
    await student.getByRole('button', { name: /Join room/ }).click();
    await host.locator('.approval').getByRole('button', { name: 'Allow' }).click();
    await student.getByText('Choose a PDF to share.').waitFor();
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
  const browser = await chromium.launch({ headless: true });
  const host = await browser.newPage();
  const student = await browser.newPage();
  await student.addInitScript(() => {
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
    await host.getByRole('button', { name: /Create a room/ }).click();
    const code = await host.locator('.room-code').innerText();
    await host.locator('.connection.connected').waitFor();
    await student.goto(url + '/?perf=1');
    await student.locator('#code').fill(code);
    await student.getByRole('button', { name: /Join room/ }).click();
    await host.locator('.approval').getByRole('button', { name: 'Allow' }).click();
    await student.getByText('Choose a PDF to share.').waitFor();
    const pressureApplied = await student.evaluate(() => {
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
      .getByText('Fully cached on this computer').waitFor({ timeout: 25000 });
    const samples = await student.evaluate(() =>
      (window as typeof window & {
        __flashviewPerf?: { snapshot: () => { summary: Array<{ metric: string; count: number }> } };
      }).__flashviewPerf?.snapshot().summary ?? []);
    const forcedReads = await student.evaluate(() =>
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
