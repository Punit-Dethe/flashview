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
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
  });
  let output = '';
  child.stderr.on('data', data => { output += String(data); });
  for (let i = 0; i < 70; i++) {
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
    await host.locator('.document-row').getByRole('button', { name: /Open/ }).click();

    await host.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.page-shell canvas');
      return Boolean(canvas && canvas.width >= 500 && canvas.height >= 700 &&
        !document.querySelector('.page-overlay'));
    }, null, { timeout: 20000 });
    assert.equal(await host.locator('.viewer-alert').count(), 0);
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
