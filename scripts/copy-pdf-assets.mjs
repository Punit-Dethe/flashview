import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// PDF.js optionally fetches built-in CMaps, font data and decoder WASM
// while rendering image-heavy, international or unusual PDFs.
// Serve those assets locally so classroom firewalls cannot block a CDN.
const root = resolve('node_modules/pdfjs-dist');
const destination = resolve('public/pdf-assets');
await mkdir(destination, { recursive: true });
for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'icc_profiles']) {
  const source = resolve(root, folder);
  if (existsSync(source)) {
    await cp(source, resolve(destination, folder), { recursive: true, force: true });
  }
}
