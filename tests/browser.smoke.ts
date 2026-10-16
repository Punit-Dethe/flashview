import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
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
function makePdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length 45 >>\nstream\nBT /F1 24 Tf 72 700 Td (FlashView demo) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  // The exact length must match the encoded content stream.
  const stream = 'BT /F1 24 Tf 72 700 Td (FlashView demo) Tj ET';
  objects[3] = '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream';
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += (i + 1) + ' 0 obj\n' + objects[i] + '\nendobj\n';
  }
  // Comments are ignorable, but force a tail xref lookup as for ordinary PDFs.
  pdf += ('% ' + 'PDF DATA '.repeat(15) + '\n').repeat(1400);
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
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
  host.on('pageerror', error => browserLogs.push('host JS ERROR: ' + error.message));
  student.on('pageerror', error => browserLogs.push('student JS ERROR: ' + error.message));
  host.on('console', message => { if (message.type() === 'error') browserLogs.push('host CONSOLE: ' + message.text()); });
  student.on('console', message => { if (message.type() === 'error') browserLogs.push('student CONSOLE: ' + message.text()); });
  try {
    await host.goto(root);
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
    await host.locator('.document-row').getByRole('button', { name: 'Allow' }).click();
    const [presentation] = await Promise.all([
      host.waitForEvent('popup'),
      host.locator('.document-row').getByRole('button', { name: /Present/ }).click(),
    ]);
    // Teacher's queue remains available while the PDF is projected.
    assert.equal(await host.locator('.document-row').count(), 1);
    await presentation.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.page-shell canvas');
      return Boolean(canvas && canvas.width >= 500 && canvas.height >= 700 &&
        !document.querySelector('.page-overlay'));
    }, null, { timeout: 20000 });
    assert.equal(await presentation.locator('.viewer-alert').count(), 0);
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
        (document.querySelector('.sent-row')?.textContent ?? '').includes('approved');
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
      .getByText('Received by server').waitFor();
    // The host refreshes all server-persisted submissions after missed broadcasts.
    await host.getByRole('button', { name: /Refresh submissions/ }).click();
    assert.equal(await host.locator('.document-row').count(), 2);

    const [secondPresentation] = await Promise.all([
      host.waitForEvent('popup'),
      host.locator('.document-row').getByRole('button', { name: /Present/ }).click(),
    ]);
    await secondPresentation.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.page-shell canvas');
      return Boolean(canvas && canvas.width >= 500 && !document.querySelector('.page-overlay'));
    }, null, { timeout: 20000 });
    await secondPresentation.close();
    // Closing the presentation must not close the classroom or remove the queue.
    assert.equal(await host.locator('.document-row').count(), 2);
    assert.equal(await host.locator('.connection.connected').count(), 1);
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
    console.error('BROWSER_DIAGNOSTICS', JSON.stringify({ hostState, studentState, browserLogs }));
    await mkdir('test-artifacts', { recursive: true });
    await host.screenshot({ path: 'test-artifacts/host-failure.png', fullPage: true }).catch(() => {});
    await student.screenshot({ path: 'test-artifacts/student-failure.png', fullPage: true }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
});
