/**
 * FlashView Performance 2.0 / Stage 0: repeatable browser baseline.
 * No production settings are changed.
 *
 * BENCH_MIB=2 BENCH_RUNS=2 BENCH_STUDENTS=1 npm run bench:baseline
 * BENCH_MIB=12 BENCH_RUNS=3 BENCH_FILE_READ_DELAY_MS=20 npm run bench:baseline
 * BENCH_PACKET_KIB=256 BENCH_MIB=4 BENCH_RUNS=3 npm run bench:baseline
 *
 * Read-delay simulation models slow access to phone bytes, NOT actual Wi-Fi.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const mib = Number(process.env.BENCH_MIB ?? 2);
const repeats = Number(process.env.BENCH_RUNS ?? 2);
const studentCount = Number(process.env.BENCH_STUDENTS ?? 1);
const slowReadMs = Number(process.env.BENCH_FILE_READ_DELAY_MS ?? 0);
const isCloudflare = process.env.FLASHVIEW_BACKEND === 'cloudflare';
const transferMode = process.env.BENCH_TRANSFER_MODE === 'fixed' ? 'fixed' : 'adaptive';
const packetKiB = Number(process.env.BENCH_PACKET_KIB ?? 64);
if (!(mib >= 1 && mib <= 45) || !(repeats >= 1 && repeats <= 10) ||
    !(studentCount >= 1 && studentCount <= 15) || !(slowReadMs >= 0 && slowReadMs <= 500) ||
    ![64, 128, 256].includes(packetKiB)) {
  throw new Error('Invalid baseline configuration');
}

function makePdf(targetBytes: number): Buffer {
  const pageCount = 10, fontId = 23;
  const refs = Array.from({length: pageCount}, (_, i) => String(3 + i * 2) + ' 0 R');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [' + refs.join(' ') + '] /Count 10 >>',
  ];
  for (let i = 0; i < pageCount; i++) {
    const text = 'BT /F1 26 Tf 72 690 Td (Baseline page ' + (i + 1) + ') Tj ET';
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ' +
      fontId + ' 0 R >> >> /Contents ' + (4+i*2) + ' 0 R >>');
    objects.push('<< /Length ' + Buffer.byteLength(text) + ' >>\nstream\n' + text + '\nendstream');
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += (i + 1) + ' 0 obj\n' + objects[i] + '\nendobj\n';
  }
  const filler = '% ' + 'repeatable-pdf-'.repeat(8) + '\n';
  pdf += filler.repeat(Math.max(1, Math.ceil((targetBytes - Buffer.byteLength(pdf) - 1500) / Buffer.byteLength(filler))));
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 ' + (objects.length+1) + '\n0000000000 65535 f \n';
  for (const offset of offsets) pdf += String(offset).padStart(10,'0') + ' 00000 n \n';
  pdf += 'trailer\n<< /Size ' + (objects.length+1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(pdf);
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No TCP port');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}
async function launchBackend() {
  const port = await freePort();
  const child = spawn(process.execPath,
    isCloudflare
      ? ['node_modules/wrangler/bin/wrangler.js','dev','--inspector-port','0','--port',String(port),'--ip','127.0.0.1']
      : ['--import','tsx','src/server/index.ts'],
    { cwd: process.cwd(), env: {...process.env,PORT:String(port),NODE_ENV:'test',BROWSER:'none'} });
  let output = '';
  child.stderr.on('data', value => { output += String(value).slice(0, 1000); });
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw Error('Server exited: ' + output.slice(-2000));
    try {
      if ((await fetch('http://127.0.0.1:' + port + '/health')).ok) return { port, child };
    } catch { /* starting */ }
    await delay(100);
  }
  child.kill('SIGTERM');
  throw Error('Could not start local backend: ' + output.slice(-1000));
}
type BenchMetric = { metric: string; count: number; medianMs: number; p95Ms: number; meanMs: number };
type Run = {
  repetition: number;
  timeToFirstSlideMs: number | null;
  timeToCacheAllMs: number;
  pageJumpMs: number;
  hostMetrics: BenchMetric[];
  studentMetrics: BenchMetric[][];
};
function median(nums: number[]) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a,b) => a-b);
  return sorted[Math.floor((sorted.length-1)/2)];
}
const fixture = makePdf(mib * 1024 * 1024);
const backend = await launchBackend();
const browser = await chromium.launch({headless:true});
const results: Run[] = [];
try {
  for (let iteration = 1; iteration <= repeats; iteration++) {
    const ctx = await browser.newContext();
    const host = await ctx.newPage();
    const senders: Awaited<ReturnType<typeof ctx.newPage>>[] = [];
    try {
      const origin = 'http://127.0.0.1:' + backend.port;
      await host.goto(origin + '/?perf=1' + (transferMode === 'fixed' ? '&transfer=fixed' : '') +
        (packetKiB !== 64 ? '&packet=' + packetKiB : ''));
      await host.getByLabel('Require approval').check();
      await host.getByRole('button', {name: /Create a room/}).click();
      const roomCode = await host.locator('.room-code').innerText();
      await host.locator('.connection.connected').waitFor();
      for (let i = 0; i < studentCount; i++) {
        const student = await ctx.newPage();
        senders.push(student);
        if (slowReadMs) {
          await student.addInitScript((wait: number) => {
            const original = Blob.prototype.arrayBuffer;
            Blob.prototype.arrayBuffer = async function(...args) {
              await new Promise(resolve => setTimeout(resolve, wait));
              return original.apply(this, args);
            };
          }, slowReadMs);
        }
        await student.goto(origin + '/?perf=1');
        await student.locator('#code').fill(roomCode);
        await student.locator('#student-name').fill('Bench ' + (i + 1));
        await student.getByRole('button', {name: /Join room/}).click();
        const awaiting = host.locator('.approval').filter({hasText:'Bench ' + (i + 1)});
        await awaiting.waitFor({timeout:20000});
        await awaiting.getByRole('button',{name:'Allow'}).click();
        await student.locator('.student-drive').waitFor();
      }
      const start = Date.now();
      await Promise.all(senders.map(sender => sender.locator('input[type=file]').setInputFiles({
        name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: fixture,
      })));
      const firstRow = host.locator('.document-row').first();
      await firstRow.waitFor();
      const [presenter] = await Promise.all([
        host.waitForEvent('popup'),
        firstRow.getByRole('button',{name:/Present/}).click(),
      ]);
      let firstSlide: number | null = null;
      try {
        await presenter.waitForFunction(() => {
          const canvas = document.querySelector('canvas[data-rendered-page="1"]');
          const img = document.querySelector<HTMLImageElement>('img[data-first-page-preview]');
          return Boolean(canvas || (img && img.complete && img.naturalWidth > 0));
        },null,{timeout:45000});
        firstSlide = Date.now() - start;
      } catch { /* still measure the full PDF */ }
      await host.locator('.document-row .cache-ring[aria-valuenow="100"]').first().waitFor({timeout:120000});
      const cacheDuration = Date.now()-start;
      await presenter.locator('canvas[data-rendered-page="1"]').waitFor({timeout:45000});
      const pageStart = Date.now();
      await presenter.getByRole('spinbutton',{name:'Page number'}).fill('10');
      await presenter.getByRole('spinbutton',{name:'Page number'}).press('Enter');
      await presenter.locator('canvas[data-rendered-page="10"]').waitFor({timeout:45000});
      const pageDuration = Date.now()-pageStart;
      const hostMetrics = await host.evaluate(() => {
        const w = window as typeof window & {__flashviewPerf?:{snapshot:()=>{summary:BenchMetric[]}}};
        return w.__flashviewPerf?.snapshot().summary ?? [];
      });
      const studentMetrics = await Promise.all(senders.map(sender => sender.evaluate(() => {
        const w = window as typeof window & {__flashviewPerf?:{snapshot:()=>{summary:BenchMetric[]}}};
        return w.__flashviewPerf?.snapshot().summary ?? [];
      })));
      // Instrumentation regressions must fail the benchmark instead of
      // silently producing zero-valued timing reports.
      const hostNames = new Set(hostMetrics.map(m => m.metric));
      for (const metric of ['socket_connect_ms', 'cache_write_ms',
        'cache_complete_ms', 'page_render_ms']) {
        if (!hostNames.has(metric)) throw new Error('Missing Stage 0 host metric: ' + metric);
      }
      if (studentMetrics.some(metrics => !metrics.some(m => m.metric === 'file_receipt_ms'))) {
        throw new Error('Missing student file acknowledgement timing');
      }
      results.push({repetition:iteration,timeToFirstSlideMs:firstSlide,
        timeToCacheAllMs:cacheDuration,pageJumpMs:pageDuration,hostMetrics,studentMetrics});
      console.log('Stage 0 host metrics: ' +
        hostMetrics.map(m => m.metric + '=' + m.count).join(', '));
      console.log('Baseline ' + iteration + '/' + repeats + ': first=' +
        (firstSlide ?? 'unavailable') + ' ms, cache=' + cacheDuration +
        ' ms, jump=' + pageDuration + ' ms');
    } finally {
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  backend.child.kill('SIGTERM');
}
const report = {
  schema: 'flashview-stage0-baseline-v1',
  label: 'synthetic-headless-localhost-not-real-classroom-speed',
  backend: isCloudflare ? 'cloudflare-local' : 'node-local',
  fixture: '10-page-nonlinearized-text-pdf-with-comment-padding',
  configuration: {mib,repeats,studentCount,simulatedFileReadDelayMs:slowReadMs,transferMode,packetKiB},
  median: {
    firstSlideMs: median(results.flatMap(x => x.timeToFirstSlideMs === null ? [] : [x.timeToFirstSlideMs])),
    cacheAllMs: median(results.map(x => x.timeToCacheAllMs)),
    pageJumpMs: median(results.map(x => x.pageJumpMs)),
  },
  runs: results,
};
await mkdir('test-artifacts',{recursive:true});
const filename = 'test-artifacts/stage0-' + (isCloudflare?'cloudflare':'node') +
  '-' + mib + 'mib-' + studentCount + 'students-' + slowReadMs + 'ms-' + transferMode +
  (packetKiB === 64 ? '' : '-packet' + packetKiB + 'kib') + '.json';
await writeFile(filename,JSON.stringify(report,null,2)+'\n','utf8');
console.log('Stage 0 report: ' + filename);
console.log(JSON.stringify(report.median));
