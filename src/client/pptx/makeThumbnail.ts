import { readEmbeddedPowerPointThumbnail } from './embeddedThumbnail';

function encodeThumbnail(image: CanvasImageSource, width: number, height: number): string | null {
  if (!width || !height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 360;
  canvas.height = Math.max(1, Math.round(360 * height / width));
  if (canvas.height > 720) return null;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return null;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  let encoded = canvas.toDataURL('image/jpeg', .75);
  if (encoded.length > 350_000) encoded = canvas.toDataURL('image/jpeg', .5);
  return encoded.length <= 350_000 ? encoded : null;
}

async function decodeSavedThumbnail(blob: Blob): Promise<string | null> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return encodeThumbnail(image, image.naturalWidth, image.naturalHeight);
  } catch { return null; }
  finally { URL.revokeObjectURL(url); }
}

/** Receiver-only work after transfers finish. Office's saved image is enough
 * for a card; use the full viewer only when the file has no usable image. */
export async function makePowerPointThumbnail(source: Blob | Uint8Array): Promise<string | null> {
  const size = source instanceof Blob ? source.size : source.byteLength;
  if (!size) return null;
  const embedded = await readEmbeddedPowerPointThumbnail(source);
  if (embedded) {
    const preview = await decodeSavedThumbnail(embedded);
    if (preview) return preview;
  }
  // Keep the existing memory bound for the expensive full-deck fallback.
  // The embedded-image path above also supports larger allowed room files.
  if (size > 125 * 1024 * 1024) return null;

  const mount = document.createElement('div');
  Object.assign(mount.style, {
    position: 'fixed', top: '0px', left: '-100000px', width: '960px',
    height: '540px', pointerEvents: 'none', zIndex: '-1', overflow: 'hidden',
  });
  let viewer: ReturnType<typeof import('pptx-vanilla-viewer').createPptxViewer> | null = null;
  let expired = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const render = async () => {
    const [bytes, { createPptxViewer, renderToCanvas }] = await Promise.all([
      source instanceof Blob ? source.arrayBuffer().then(buffer => new Uint8Array(buffer)) : source,
      import('pptx-vanilla-viewer'),
    ]);
    if (expired) return null;
    document.body.appendChild(mount);
    viewer = createPptxViewer(mount, {
      editable: false, showToolbar: false, showThumbnails: false,
      fitPadding: 0, maxFitScale: null,
      customization: { hiddenPanels: ['titleBar', 'statusBar', 'notes'] },
      showCompatibilityToasts: false,
      onError: message => console.warn('[WarpView] PPTX preview renderer:', message),
    });
    await viewer.loadFile(bytes);
    if (expired) return null;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (expired) return null;
    const stage = mount.querySelector<HTMLElement>('.pptxv-stage') ??
      mount.querySelector<HTMLElement>('[aria-roledescription="slide"]');
    if (!stage) throw Error('No rendered slide stage available');
    const { width, height } = stage.getBoundingClientRect();
    if (!width || !height) throw Error('Slide stage has no dimensions');
    await Promise.race([
      Promise.allSettled(Array.from(stage.querySelectorAll('img'), image => image.decode())),
      new Promise<void>(resolve => setTimeout(resolve, 3_000)),
    ]);
    if (expired) return null;
    const raster = await renderToCanvas(stage, {
      scale: Math.min(1, 360 / width),
      backgroundColor: '#ffffff', logging: false, useCORS: false,
    });
    return expired ? null : encodeThumbnail(raster, width, height);
  };
  try {
    return await Promise.race([
      render(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(Error('PowerPoint thumbnail rendering timed out')), 30_000);
      }),
    ]);
  } finally {
    expired = true;
    if (deadline) clearTimeout(deadline);
    try { (viewer as { destroy(): void } | null)?.destroy(); }
    finally { mount.remove(); }
  }
}
