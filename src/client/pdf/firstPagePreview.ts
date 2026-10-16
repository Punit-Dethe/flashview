import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorker;
const LOCAL_RANGE_BYTES = 65_536;
const LARGE_FILE_BYTES = 12 * 1024 * 1024;
const PREVIEW_BYTES = 275_000;

class LocalFileRanges extends PDFDataRangeTransport {
  private stopped = false;
  constructor(private readonly file: File) {
    // A File is random-access; no full progressive stream is needed.
    super(file.size, null, true);
  }
  override requestDataRange(begin: number, end: number): void {
    if (this.stopped || begin < 0 || end <= begin || end > this.file.size) return;
    void this.file.slice(begin, end).arrayBuffer().then(data => {
      if (!this.stopped && data.byteLength === end - begin) {
        // PDF.js expects ONE complete response at the requested begin offset.
        this.onDataRange(begin, new Uint8Array(data));
      }
    }).catch(() => {
      // Local File access can be interrupted after the browser picker closes.
      // A bounded caller watchdog falls back to the original full-data path.
    });
  }
  override abort(): void { this.stopped = true; }
}

const pdfOptions = {
  maxImageSize: -1,
  cMapUrl: '/pdf-assets/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdf-assets/standard_fonts/',
  wasmUrl: '/pdf-assets/wasm/',
  iccUrl: '/pdf-assets/icc_profiles/',
};

async function jpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    // Unlike toDataURL, encoding does not synchronously block the mobile UI.
    canvas.toBlob(result => result ? resolve(result) : reject(Error('Cannot encode JPEG')), 'image/jpeg', quality);
  });
}
async function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || Error('Cannot read preview'));
    reader.readAsDataURL(blob);
  });
}

async function renderFirstPage(file: File, ranged: boolean): Promise<string> {
  const transport = ranged ? new LocalFileRanges(file) : null;
  const source = ranged
    ? { range: transport!, rangeChunkSize: LOCAL_RANGE_BYTES, disableAutoFetch: true, disableStream: true }
    : { data: new Uint8Array(await file.arrayBuffer()) };
  const task = getDocument({ ...pdfOptions, ...source });
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const render = async (): Promise<string> => {
      const pdf = await task.promise;
      const page = await pdf.getPage(1);
      const normal = page.getViewport({ scale: 1 });
      const scale = Math.min(2.5, 1400 / Math.max(normal.width, normal.height));
      const viewport = page.getViewport({ scale });
      let canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const context = canvas.getContext('2d');
      if (!context) throw Error('Canvas unavailable');
      await page.render({ canvas, canvasContext: context, viewport }).promise;

      let quality = .78;
      let output = await jpeg(canvas, quality);
      for (let step = 0; output.size > PREVIEW_BYTES && step < 10; step++) {
        if (quality > .45) {
          quality = Math.max(.43, quality - .12);
        } else {
          const smaller = document.createElement('canvas');
          smaller.width = Math.max(320, Math.floor(canvas.width * .72));
          smaller.height = Math.max(320, Math.floor(canvas.height * .72));
          smaller.getContext('2d')?.drawImage(canvas, 0, 0, smaller.width, smaller.height);
          canvas = smaller;
          quality = .68;
        }
        output = await jpeg(canvas, quality);
      }
      if (output.size > PREVIEW_BYTES) throw Error('Preview exceeds safe relay size');
      return dataUrl(output);
    };
    if (!ranged) return await render();
    // An unusual PDF or browser can make local range rendering hang. Never
    // sacrifice the reliable whole-file preview: fall back after 12 seconds.
    const bounded = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(Error('File-backed preview timed out')), 12_000);
    });
    return await Promise.race([render(), bounded]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    transport?.abort();
    await task.destroy().catch(() => {});
  }
}

/** Return a bounded first-slide JPEG, while the original PDF transfers independently. */
export async function makeFirstPagePreview(file: File): Promise<string> {
  if (file.size >= LARGE_FILE_BYTES) {
    try {
      // For large files, read PDF.js's requested local byte ranges, instead
      // of copying the whole 12-50 MB original into phone memory.
      return await renderFirstPage(file, true);
    } catch {
      // Keep the known-compatible path for difficult PDFs and browsers.
    }
  }
  return renderFirstPage(file, false);
}
