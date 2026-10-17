import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, firefox, type Page } from 'playwright';
const browserEngine = process.env.FLASHVIEW_BROWSER === 'firefox' ? firefox : chromium;
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

    await first.getByRole('button', { name: /Create a room/ }).click();
    await first.locator('.connection.connected').waitFor();
    assert.equal(await first.locator('.site-header').count(), 0, 'Room workspace must have no header');
    assert.equal(await first.locator('.workspace-topline').count(), 0, 'Room breadcrumbs and room-active strip are removed');
    assert.equal(await first.locator('.workspace-invite-heading').count(), 0, 'Sidebar must not have an introductory hero');
    assert.equal(await first.getByRole('heading', { name: 'Participants' }).count(), 1);
    const firstCode = (await first.locator('.room-code').textContent())?.trim();
    assert.match(firstCode ?? '', /^\d{6}$/);
    assert.equal(await first.locator('.qr-plate svg').count(), 1);
    const sidebarWordmark = first.locator('.sidebar-brand');
    assert.equal((await sidebarWordmark.innerText()).trim(), 'flashview.');
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
    assert.ok(leftBefore && Math.abs(leftBefore.y) < 2,
      'Sidebar must begin at the top edge of the viewport without header chrome');
    const docHeading = await right.getByRole('heading', { name: /Documents/ }).boundingBox();
    assert.ok(docHeading && leftBefore && docHeading.x >= leftBefore.x + leftBefore.width,
      'Documents should occupy the area to the right of the full-height sidebar');
    const copy = await first.getByRole('button', { name: /Copy link/ }).boundingBox();
    const end = await first.getByRole('button', { name: /End session/ }).boundingBox();
    const join = await first.getByRole('button', { name: /Join another room/ }).boundingBox();
    assert.ok(copy && end && join && Math.abs(copy.y - end.y) < 4 && join.y > copy.y + 30,
      'Copy link and End session share a row; Join another room sits underneath');

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

    await first.getByRole('button', { name: /Join another room/ }).click();
    await first.locator('#switch-code').fill(secondCode!);
    await first.getByRole('button', { name: /Join room/ }).click();
    await second.locator('.sidebar-participants .approval').waitFor();
    assert.equal(await second.locator('.workspace-right .approval').count(), 0,
      'Student approval rows belong in the sidebar, not in the document panel');
    assert.ok(await first.getByText('Waiting for the teacher.').isVisible());
    assert.equal(await first.evaluate(() => sessionStorage.getItem('flashview-host')), null,
      'Switching rooms must remove the previous host credentials');
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
    // Every document keeps a square footprint during the spinner-to-JPEG fade.
    const card = host.locator('.document-row').filter({ hasText: 'smoke.pdf' });
    const tile = await card.boundingBox();
    assert.ok(tile && Math.abs(tile.width - tile.height) < 3, 'Each document tile is square');
    const swatch = await card.evaluate(element => ({
      accent: getComputedStyle(element).getPropertyValue('--file-accent').trim(),
      background: getComputedStyle(element.querySelector('.document-thumb')!).backgroundColor,
    }));
    assert.match(swatch.accent, /^#[0-9A-Fa-f]{6}$/);
    assert.notEqual(swatch.background, 'rgba(0, 0, 0, 0)');
    // The existing phone-generated first-page JPEG should appear in the card.
    await card.locator('img.document-thumb-image.is-visible').waitFor({ timeout: 20000 });
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
      host.waitForEvent('popup'),
      host.locator('.document-row').getByRole('button', { name: /Present/ }).click(),
    ]);
    // Teacher's queue remains available while the PDF is projected.
    assert.equal(await host.locator('.document-row').count(), 1);
    // Projector view must be truly black around the actual PDF.
    const toolbarBlur = await presentation.locator('.viewer-toolbar')
      .evaluate(element => getComputedStyle(element).backdropFilter);
    assert.equal(toolbarBlur, 'none',
      'Full-screen overlay header must not blur PDF pixels on the left side');
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
    // Immersive UI: no permanent header, a true full-viewport slide stage and
    // one pill in the lower-right corner. The PDF keeps its correct proportions.
    const projectorLayout = await presentation.evaluate(() => {
      const root = document.querySelector('.viewer')!.getBoundingClientRect();
      const slide = document.querySelector('.page-shell canvas')!.getBoundingClientRect();
      const dock = document.querySelector('.viewer-controls')!.getBoundingClientRect();
      return {
        windowHeight: innerHeight, windowWidth: innerWidth,
        rootHeight: root.height, slideHeight: slide.height,
        dockRight: dock.right, dockBottom: dock.bottom,
        roundedDock: getComputedStyle(document.querySelector('.viewer-controls')!).borderRadius,
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
    // Top-left identity uses the document's curated accent, matching its
    // teacher-side file card instead of a generic gray back arrow.
    assert.equal(await presentation.locator('.viewer-file-mark').count(), 1);
    const identity = await presentation.locator('.viewer-filename').evaluate(el => {
      const marker = el.querySelector('.viewer-file-mark');
      return {
        radius: getComputedStyle(el).borderRadius,
        accent: marker ? getComputedStyle(marker).color : '',
      };
    });
    assert.equal(identity.radius, '15px');
    assert.notEqual(identity.accent, '');

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
        toolbarHidden: getComputedStyle(document.querySelector('.viewer-toolbar')!).display === 'none',
        footerHidden: getComputedStyle(document.querySelector('.viewer-footer')!).display === 'none',
        pillVisible: getComputedStyle(document.querySelector('.viewer-control-pill')!).display !== 'none',
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
        (document.querySelector('.student-file-card')?.textContent ?? '').includes('smoke.pdf');
    }, null, { timeout: 20000 });
    assert.match(await student.locator('.student-file-card').first().innerText(), /smoke\.pdf/);

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
    await student.locator('.student-file-card').filter({ hasText: 'lost-announcement.pdf' })
      .getByText('Preparing to share…').waitFor();
    assert.equal(await host.locator('.document-row').count(), 1);
    // A tab returning online asks the server for its authoritative manifest.
    await student.evaluate(() => window.dispatchEvent(new Event('online')));
    await host.locator('.document-row').filter({ hasText: 'lost-announcement.pdf' }).waitFor({ timeout: 15000 });
    await student.locator('.student-file-card').filter({ hasText: 'lost-announcement.pdf' })
      .locator('.transfer-ring[aria-valuenow="100"]').waitFor({ timeout: 15000 });
    // The host refreshes all server-persisted submissions after missed broadcasts.
    await host.getByRole('button', { name: /Refresh submissions/ }).click();
    assert.equal(await host.locator('.document-row').count(), 2);
    await host.locator('.document-row').filter({ hasText: 'lost-announcement.pdf' })
      .locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 15000 });

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
      .locator('.cache-ring[aria-valuenow="100"]').waitFor();
    await host.reload();
    await host.locator('.connection.connected').waitFor();
    await host.locator('.document-row').filter({ hasText: 'smoke.pdf' })
      .locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 12000 });
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
  const browser = await browserEngine.launch({ headless: true });
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
      .locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 15000 });
    assert.notEqual(await row.locator('.cache-ring').getAttribute('aria-valuenow'), '100',
      'The deliberately blocked first sender must still be downloading');
    await fastStudent.close();

    // Release the delayed foreground request and the document's cross-ref
    // tail. The original bytes should finish caching without closing the viewer.
    await student.evaluate(() => {
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
  const browser = await browserEngine.launch({ headless: true });
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
      .locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 25000 });
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


test('mobile progress recovers missed events from the relay manifest and pill is connection-only', { timeout: 95000 }, async () => {
  const { port, child } = await runningServer();
  const browser = await browserEngine.launch({ headless: true });
  const host = await browser.newPage();
  const student = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const origin = 'http://127.0.0.1:' + port;
  try {
    await student.addInitScript(() => {
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
    await host.getByRole('button', { name: /Create a room/ }).click();
    await host.locator('.connection.connected').waitFor();
    const code = await host.locator('.room-code').textContent();
    await student.goto(origin);
    await student.locator('#code').fill(code!);
    await student.locator('#student-name').fill('Missing Updates');
    await student.getByRole('button', { name: /Join room/ }).click();
    await host.locator('.approval').filter({ hasText: 'Missing Updates' })
      .getByRole('button', { name: 'Allow' }).click();
    await student.getByText('Choose a PDF to share.').waitFor();
    await student.locator('.transfer-pill').waitFor({ state: 'detached' });

    // Deliberately lose BOTH forms of progress delivery. The teacher must
    // still finish caching the exact original PDFs, and a subsequent sync
    // must recover the real counts without depending on host tab timers.
    await student.evaluate(() => {
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
    await student.locator('.transfer-pill').waitFor({ state: 'detached' });
    await host.locator('.document-row').filter({ hasText: 'small.pdf' })
      .locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 25000 });
    await host.locator('.document-row').filter({ hasText: 'larger.pdf' })
      .locator('.cache-ring[aria-valuenow="100"]').waitFor({ timeout: 25000 });
    assert.equal(await cards.locator('.transfer-ring[aria-valuenow="100"]').count(), 0,
      'Lost notifications should be reproducible in this test');

    await student.evaluate(() => {
      const scoped = window as typeof window & {
        __flashviewSockets?: WebSocket[]; __dropManifest?: boolean;
      };
      scoped.__dropManifest = false;
      scoped.__flashviewSockets?.at(-1)?.send(JSON.stringify({ v: 1, type: 'file.sync' }));
    });
    await student.waitForFunction(() =>
      document.querySelectorAll('.student-file-card .transfer-ring[aria-valuenow="100"]').length === 2,
      null, { timeout: 20000 });
    await student.locator('.student-transfer-heading').getByText('2 of 2 ready').waitFor();
    await student.getByText('All files are saved on the classroom computer. You can leave this page.').waitFor();
    assert.equal(await student.locator('.transfer-pill').count(), 0,
      'Done and Uploading should never produce a status pill');

    // Hold the phone offline so ultra-fast Cloudflare reconnects do not hide
    // the transient dock before Playwright can observe it.
    await student.context().setOffline(true);
    await student.evaluate(() => {
      const sockets = (window as typeof window & { __flashviewSockets?: WebSocket[] }).__flashviewSockets;
      sockets?.at(-1)?.close(4100, 'Simulated phone connection interruption');
    });
    await student.locator('.transfer-pill').waitFor({ timeout: 7000 });
    assert.match(await student.locator('.transfer-pill').innerText(), /Connecting/);
    await student.context().setOffline(false);
    await student.evaluate(() => window.dispatchEvent(new Event('online')));
    await student.locator('.transfer-pill').waitFor({ state: 'detached', timeout: 18000 });

    // Adding one more file changes only the per-file cards, not the dock.
    await student.locator('input[type=file]').setInputFiles({
      name: 'late.pdf', mimeType: 'application/pdf', buffer: makePdf(400),
    });
    await student.locator('.student-file-card').filter({ hasText: 'late.pdf' }).waitFor();
    await student.locator('.student-transfer-heading').getByText('3 of 3 ready').waitFor({ timeout: 25000 });
    assert.equal(await student.locator('.transfer-pill').count(), 0);
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
});
