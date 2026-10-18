import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, firefox, type Page } from 'playwright';
import { makePowerPointFixture } from './pptxFixture';
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

    // The supplied v8 HTML places its 60px nav in normal flow before 76px
    // headline padding. The React nav floats, so its headline must compensate.
    const heroGeometry = await first.evaluate(() => {
      const nav = document.querySelector('.reference-nav')!.getBoundingClientRect();
      const title = document.querySelector('.reference-hero h1')!.getBoundingClientRect();
      const sky = document.querySelector('.reference-sky')!;
      return {
        gap: title.top - nav.bottom,
        background: getComputedStyle(sky).backgroundImage,
      };
    });
    assert.ok(heroGeometry.gap >= 65 && heroGeometry.gap <= 95,
      'Landing title should retain the original generous 76px gap below nav');
    assert.match(heroGeometry.background, /linear-gradient/);
    assert.match(heroGeometry.background, /31, 79, 232|#1f4fe8/i,
      'The supplied cobalt-to-pastel sky gradient should remain intact');

    await first.setViewportSize({ width: 390, height: 844 });
    const mobileHeroGap = await first.evaluate(() => {
      const nav = document.querySelector('.reference-nav')!.getBoundingClientRect();
      const title = document.querySelector('.reference-hero h1')!.getBoundingClientRect();
      return title.top - nav.bottom;
    });
    assert.ok(mobileHeroGap >= 68,
      'On phones the hero title should not crowd the floating nav');
    await first.setViewportSize({ width: 1280, height: 760 });

    await first.getByRole('button', { name: /Create a room/ }).click();
    await first.locator('.connection.connected').waitFor();
    assert.equal(await first.locator('.site-header').count(), 0, 'Room workspace must have no header');
    assert.equal(await first.locator('.workspace-topline').count(), 0, 'Room breadcrumbs and room-active strip are removed');
    assert.equal(await first.locator('.workspace-invite-heading').count(), 0, 'Sidebar must not have an introductory hero');
    assert.equal(await first.getByRole('heading', { name: /In the room/ }).count(), 1);
    const firstCode = (await first.locator('.room-code').textContent())?.trim();
    assert.match(firstCode ?? '', /^\d{6}$/);
    assert.equal(await first.locator('.qr-plate svg').count(), 1);
    const sidebarWordmark = first.locator('.sidebar-brand');
    assert.equal((await sidebarWordmark.innerText()).trim(), 'flashview');
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
    await host.getByText('Anyone with the code can join').waitFor();
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
    // Reference v8 uses a fixed 118px preview tile, separate filename and
    // a rounded action footer. The PDF JPEG must not resize that fixed tile.
    const card = host.locator('.document-row').filter({ hasText: 'smoke.pdf' });
    const tile = await card.boundingBox();
    const swatch = await card.evaluate(element => {
      const visual=element.querySelector('.document-card-visual')!;
      return {
        height: visual.getBoundingClientRect().height,
        background: getComputedStyle(element.querySelector('.document-thumb')!).backgroundColor,
      };
    });
    assert.ok(tile && tile.width > 170 && tile.height > 170, 'Reference gallery cards need readable dimensions');
    assert.ok(Math.abs(swatch.height - 118) < 2, 'Reference HTML preview height is 118px');
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
        document.querySelector('.student-drive') !== null &&
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
    await host.getByRole('button', { name: /End room/ }).click();
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
    await host.getByLabel('Require approval').check();
    await host.getByRole('button', { name: /Create a room/ }).click();
    const code = await host.locator('.room-code').innerText();
    await host.locator('.connection.connected').waitFor();
    await student.goto(url + '/?perf=1');
    await student.locator('#code').fill(code);
    await student.getByRole('button', { name: /Join room/ }).click();
    await host.locator('.approval').getByRole('button', { name: 'Allow' }).click();
    await student.locator('.student-drive').waitFor();
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

    await student.evaluate(() => {
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
    await student.evaluate(() => {
      const sockets = (window as typeof window & { __flashviewSockets?: WebSocket[] }).__flashviewSockets;
      const ws = sockets?.at(-1);
      if (!ws?.onmessage) throw Error('Expected active student socket');
      ws.onmessage.call(ws, new MessageEvent('message', {
        data: JSON.stringify({ v: 1, type: 'host.offline' }),
      }));
    });
    await student.locator('.transfer-pill').waitFor({ timeout: 7000 });
    assert.match(await student.locator('.transfer-pill').innerText(), /Connecting/);
    await student.evaluate(() => {
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
        }, code);
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



test('QR joins open the upload workspace immediately; leaving or ending a room returns to a clean homepage', {timeout: 100000}, async () => {
  const {port,child}=await runningServer();
  const browser=await browserEngine.launch({headless:true});
  const host=await browser.newPage();
  const student=await browser.newPage({viewport:{width:390,height:820}});
  const root='http://127.0.0.1:'+port;
  try {
    // Capture a flash even if the server accepts before Playwright evaluates
    // the page; a MutationObserver sees every mounted join-form panel.
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
    await host.locator('.end-check input').check();
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
    await host.locator('.end-check input').check();
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
    await host.locator('.participant-row').nth(1).waitFor();
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
        cards.length===3 && cards.every(c=>Boolean(c.querySelector('.document-owner-dot')) &&
          Boolean(c.querySelector('.document-pdf-symbol svg linearGradient stop')));
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
        displayName:card.querySelector('.document-file-owner')?.textContent?.trim(),
        dot:getComputedStyle(card.querySelector('.document-owner-dot')!).backgroundColor,
        gradient:card.querySelector('linearGradient stop')?.getAttribute('stop-color'),
      }));
      return {avatars,cards};
    });
    assert.equal(ui.avatars.length,2);
    assert.ok(ui.avatars.every(a=>a.name==='Student'),'Both people have the same display name');
    assert.notEqual(ui.avatars[0].id,ui.avatars[1].id);
    assert.notEqual(ui.avatars[0].color,ui.avatars[1].color,'Different people must get different hues');
    const colorFor=(id:string|undefined)=>ui.avatars.find(a=>a.id===id)?.color;
    const rgb=(hex:string)=>{
      const num=Number.parseInt(hex.slice(1),16);
      return 'rgb('+((num>>16)&255)+', '+((num>>8)&255)+', '+(num&255)+')';
    };
    for(const card of ui.cards){
      const color=colorFor(card.ownerId);
      assert.ok(color,'Every file must refer to a real participant');
      assert.equal(card.displayName,'Student');
      assert.equal(card.dot,rgb(color!),'The owner dot must match the avatar color');
      assert.ok(card.gradient && card.gradient!=='#4a5062','The pixel icon must not be gray');
    }
    const [a,b,c]=['slides-one.pptx','archive-one.zip','installer-two.apk'].map(
      name=>ui.cards.find(card=>card.name===name)!);
    assert.equal(a.ownerId,b.ownerId,'Two files from the same student share one participant ID');
    assert.equal(a.gradient,b.gradient,'Every icon from one student has an identical gradient');
    assert.notEqual(a.ownerId,c.ownerId);
    assert.notEqual(a.gradient,c.gradient,'Different students get different icon gradients');
    await host.getByRole('button',{name:/End room/}).click();
    await host.locator('.end-check input').check();
    await host.getByRole('button',{name:/End & clear cache/}).click();
  } finally {
    await host.close();await first.close();await second.close();await browser.close();
    child.kill('SIGTERM');
  }
});


test('refined file cards align owner dots, truncate long names and keep phone controls readable', {timeout:80000}, async()=>{
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
      const line=element.querySelector<HTMLElement>('.document-file-meta')!;
      const owner=element.querySelector<HTMLElement>('.document-file-owner')!;
      const name=element.querySelector<HTMLElement>('.document-owner-name')!;
      const dot=element.querySelector<HTMLElement>('.document-owner-dot')!;
      const size=element.querySelector<HTMLElement>('.document-file-size')!;
      const titleRect=title.getBoundingClientRect();
      const cardRect=element.getBoundingClientRect();
      const dotRect=dot.getBoundingClientRect();
      const nameRect=name.getBoundingClientRect();
      const sizeRect=size.getBoundingClientRect();
      const lineRect=line.getBoundingClientRect();
      return {
        filename: title.textContent,
        titleEllipsis:getComputedStyle(title).textOverflow,
        titleHasOverflow:title.scrollWidth>title.clientWidth,
        titleRightPadding:parseFloat(getComputedStyle(title).paddingRight),
        titleRightEdge:titleRect.right,
        cardRightEdge:cardRect.right,
        ownerDisplay:getComputedStyle(owner).display,
        metaWrap:getComputedStyle(line).flexWrap,
        nameHasOverflow:name.scrollWidth>name.clientWidth,
        dotCenter:(dotRect.top+dotRect.bottom)/2,
        nameCenter:(nameRect.top+nameRect.bottom)/2,
        sizeRightEdge:sizeRect.right,
        metaRightEdge:lineRect.right,
      };
    });
    assert.equal(check.filename,longName,'Long original filename remains intact');
    assert.equal(check.titleEllipsis,'ellipsis');
    assert.equal(check.titleHasOverflow,true,'Long file name visually ends in ellipsis');
    assert.ok(check.titleRightPadding>=12,'File name gets breathing room on the right');
    assert.ok(check.cardRightEdge-check.titleRightEdge>=12,'Text should not touch the card edge');
    assert.ok(['flex','inline-flex'].includes(check.ownerDisplay), 'Owner metadata must use a horizontal flex row');
    assert.equal(check.metaWrap,'nowrap');
    assert.ok(Math.abs(check.dotCenter-check.nameCenter)<4,
      'The color dot is centered beside the sender name, never above it');
    assert.equal(check.nameHasOverflow,true,'Long sender names also truncate rather than wrap');
    assert.ok(check.sizeRightEdge<=check.metaRightEdge+1,
      'File size remains visible without overflowing the metadata row');
    await host.getByRole('button',{name:'List view'}).click();
    const list=host.locator('.document-grid.is-list');
    await list.waitFor();
    const dot=await list.locator('.document-owner-dot').first().boundingBox();
    const name=await list.locator('.document-owner-name').first().boundingBox();
    assert.ok(dot&&name&&Math.abs((dot.y+dot.height/2)-(name.y+name.height/2))<4,
      'List mode keeps the owner dot beside the name too');
    await host.getByRole('button',{name:'End room'}).click();
    await host.locator('.end-check input').check();
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
    assert.equal((await compact.locator('.mobile-host-byline').innerText()).trim(),'by flashview');
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
    assert.equal(await host.getByText('Approve each person').isVisible(),true);
    assert.equal(await host.getByRole('heading',{name:'In the room · 0'}).isVisible(),true);

    await student.goto(root);
    await student.locator('#code').fill(code);
    await student.getByRole('button',{name:/Join room/}).click();
    const request=host.locator('.sidebar-approval');
    await request.waitFor({timeout:20000});
    assert.equal(await host.getByRole('heading',{name:'In the room · 0'}).isVisible(),true,
      'Pending approvals do not count as connected people');
    await request.getByRole('button',{name:'Allow'}).click();
    await student.locator('.student-add-fab:not([disabled])').waitFor();
    await host.getByRole('heading',{name:'In the room · 1'}).waitFor();
    assert.equal(await host.locator('.participant-row').isVisible(),false,
      'Approved participants are shown as a count, not as a mobile list');

    await student.locator('input[type=file]').setInputFiles({
      name:'mobile-host-demo.txt',mimeType:'text/plain',buffer:Buffer.from('Hello from the student'),
    });
    const card=host.locator('.document-row').filter({hasText:'mobile-host-demo.txt'});
    await card.waitFor({timeout:25000});
    assert.equal(await card.isVisible(),true,'Received files remain available on mobile');
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
    const pptx=await makePowerPointFixture();
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
        follows:left.right+5<=right.left,background:paint.backgroundColor,
        border:paint.borderTopWidth,icon:el.querySelector('.document-card-present svg path')?.getAttribute('d')};
    });
    assert.ok(actionStyle.withinRow&&actionStyle.aligned&&actionStyle.follows,
      'Outlined Present must be to the right of Download in the same horizontal row');
    assert.ok(['rgb(255, 255, 255)','rgb(248, 249, 251)'].includes(actionStyle.background),
      'Present should be white when ready or pale gray while download is incomplete');
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
    [popup]=await Promise.all([host.waitForEvent('popup'),presentButton.click()]);
    await popup.locator('.flashview-pptx-controls').waitFor({timeout:45000});
    assert.equal(await popup.getByText('Slide 1 / 1').count(),1,
      'Actual PowerPoint rendered from IndexedDB without cloud conversion');
    assert.equal(await popup.getByRole('button',{name:'Start slideshow'}).count(),1);
    assert.equal(await popup.locator('.flashview-pptx-state').count(),0);
    const [dl]=await Promise.all([host.waitForEvent('download'),downloadButton.click()]);
    const got=await readFile(await dl.path());
    assert.equal(createHash('sha256').update(got).digest('hex'),
      createHash('sha256').update(pptx).digest('hex'),
      'PowerPoint Download must preserve original bytes');
  }finally{
    await popup?.close().catch(()=>{});
    await host.close();await student.close();await browser.close();child.kill('SIGTERM');
  }
});
