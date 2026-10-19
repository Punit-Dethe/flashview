import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// The owner token stays in the environment or ignored local Wrangler directory.
// Only bounded, expiring test invitations are written to the local links page.
const root = resolve(import.meta.dirname, '..');
const token = process.env.BENCH_R2_TOKEN ?? JSON.parse(await readFile(resolve(root,
  '.wrangler/benchmark-secrets.json'), 'utf8')).BENCH_TOKEN as string;
if (typeof token !== 'string' || token.length < 32) throw Error('Missing private benchmark owner token');
const r2 = process.env.BENCH_R2_ORIGIN ?? 'https://flashview-r2-benchmark.outlanderwatr.workers.dev';
const relay = process.env.BENCH_RELAY_ORIGIN ?? 'https://flashview-relay-benchmark.outlanderwatr.workers.dev';
for (const origin of [r2, relay]) if (new URL(origin).protocol !== 'https:') throw Error('Test invitations require HTTPS');
async function create(origin: string, route: string): Promise<Record<string, string | number>> {
  const response = await fetch(origin + route, { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  if (!response.ok) throw Error('Invitation creation failed: ' + response.status);
  return response.json() as Promise<Record<string, string | number>>;
}
const [pilot, baseline] = await Promise.all([create(r2, '/api/pilots'), create(relay, '/__benchmark/invite')]);
const escape = (value: unknown) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const path = resolve(root, 'test-artifacts/manual-test-links.html');
await mkdir(resolve(root, 'test-artifacts'), { recursive: true });
await writeFile(path, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer"><title>FlashView test invitations</title>
<style>body{font:18px/1.6 system-ui;max-width:720px;margin:48px auto;padding:24px;background:#f6f5f0;color:#1d302d}a{color:#284f49}h1{font-size:36px}li{margin:18px 0}</style>
<h1>FlashView real-device test</h1><p>Private invitations expire ${escape(new Date(Number(pilot.expiresAt)).toLocaleString())}. Test with non-sensitive files. The R2 pilot accepts up to 10 files, 200 MiB each, 512 MiB total.</p>
<ol><li><a href="${escape(pilot.hostUrl)}">Open R2 test on the classroom computer</a>. Scan its QR code with your phone. Pick a file and keep the phone page open until upload completes. The computer verifies its original bytes in private browser storage.</li>
<li><a href="${escape(baseline.url)}">Open current relay for comparison</a>. First open this same access link on both devices, then create a classroom and scan its normal QR code. Keep the sender page open until the computer finishes caching.</li></ol>
<p>Use the same file and network for both. Originals are not sent to OS Downloads. Use the R2 page's explicit export action to save a timing report. Preview is separate from transfer. R2 access expires with the invitation; object cleanup runs afterward, with bucket lifecycle as an extra backstop.</p>
<p>Generate fresh invitations locally with <code>npm run bench:invite</code>.</p></html>`);
console.log(JSON.stringify({ linksFile: path, expiresAt: pilot.expiresAt, hostUrl: pilot.hostUrl, relayUrl: baseline.url }, null, 2));
