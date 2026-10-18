/**
 * PPTX thumbnails are generated on the receiver only after active transfers
 * finish. Use the SAME installed OOXML viewer as PowerPoint presentation,
 * rather than an SVG-as-image export (blob: media in those SVGs can fail).
 */
export async function makePowerPointThumbnail(bytes: Uint8Array): Promise<string | null> {
  if (!bytes.byteLength || bytes.byteLength > 125 * 1024 * 1024) return null;
  const { createPptxViewer, renderToCanvas } = await import('pptx-vanilla-viewer');
  const mount = document.createElement('div');
  // The renderer and html2canvas need layout; neither display:none nor
  // visibility:hidden is safe for image capture.
  Object.assign(mount.style, {
    position: 'fixed', top: '0px', left: '-100000px', width: '960px',
    height: '540px', pointerEvents: 'none', zIndex: '-1', overflow: 'hidden',
  });
  document.body.appendChild(mount);
  let viewer: ReturnType<typeof createPptxViewer> | null = null;
  try {
    viewer = createPptxViewer(mount, {
      editable: false, showToolbar: false, showThumbnails: false,
      showCompatibilityToasts: false,
      onError: message => console.warn('[FlashView] PPTX preview renderer:', message),
    });
    // Complete local bytes only. This viewer does not open a relay range or
    // download any media from the original sender.
    await viewer.loadFile(bytes);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const stage = mount.querySelector<HTMLElement>('.pptxv-stage') ??
      mount.querySelector<HTMLElement>('[aria-roledescription="slide"]');
    if (!stage) throw Error('No rendered slide stage available');
    const { width, height } = stage.getBoundingClientRect();
    if (!width || !height) throw Error('Slide stage has no dimensions');
    const images = Array.from(stage.querySelectorAll('img'));
    await Promise.race([
      Promise.allSettled(images.map(image => image.decode())),
      new Promise<void>(resolve => setTimeout(resolve, 3_000)),
    ]);
    const raster = await renderToCanvas(stage, {
      scale: Math.min(1, 360 / width),
      backgroundColor: '#ffffff', logging: false, useCORS: false,
    });
    if (!raster.width || !raster.height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = Math.max(1, Math.min(360, Math.round(360 * height / width)));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return null;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(raster, 0, 0, canvas.width, canvas.height);
    let image = canvas.toDataURL('image/jpeg', .75);
    if (image.length > 350_000) image = canvas.toDataURL('image/jpeg', .5);
    return image.length <= 350_000 ? image : null;
  } finally {
    viewer?.destroy();
    mount.remove();
  }
}
