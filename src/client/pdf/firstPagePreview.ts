import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorker;

/**
 * Produce a real first-page JPEG directly on the sender's device, without
 * waiting for the original PDF to cross the network. It is a visual fallback
 * until the exact PDF is fully available in the teacher's local byte cache.
 */
export async function makeFirstPagePreview(file: File): Promise<string> {
  const data = new Uint8Array(await file.arrayBuffer());
  const task = getDocument({
    data, maxImageSize: -1,
    cMapUrl: '/pdf-assets/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/pdf-assets/standard_fonts/',
    wasmUrl: '/pdf-assets/wasm/', iccUrl: '/pdf-assets/icc_profiles/',
  });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const normal = page.getViewport({ scale: 1 });
    // Keep previews usable on a smartboard without allocating enormous
    // canvases on a small phone. The exact PDF replaces this after caching.
    const scale = Math.min(2.5, 1400 / Math.max(normal.width, normal.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    let quality = .78;
    let output = canvas;
    let url = output.toDataURL('image/jpeg', quality);
    // Compress first, then reduce dimensions if a dense photographic slide
    // still exceeds the 300 KB relay budget. Exact PDF stays untouched.
    for (let step = 0; url.length > 370000 && step < 8; step++) {
      if (quality > .45) {
        quality = Math.max(.43, quality - .12);
      } else {
        const smaller = document.createElement('canvas');
        smaller.width = Math.max(320, Math.floor(output.width * .72));
        smaller.height = Math.max(320, Math.floor(output.height * .72));
        smaller.getContext('2d')?.drawImage(output, 0, 0, smaller.width, smaller.height);
        output = smaller;
        quality = .68;
      }
      url = output.toDataURL('image/jpeg', quality);
    }
    if (url.length > 390000) throw Error('Preview image exceeds safe relay size');
    return url;
  } finally {
    await task.destroy().catch(() => {});
  }
}
