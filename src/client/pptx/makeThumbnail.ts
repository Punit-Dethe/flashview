/**
 * Small thumbnail of the first slide, produced only by the receiving browser
 * AFTER its transfer queue has finished. Never uses the relay or sender CPU.
 *
 * Render with the actual OOXML slide renderer instead of exporting an SVG and
 * reloading it as an <img>: Chromium/Firefox can reject embedded blob: media
 * in image-mode SVGs, leaving real-world PPTX cards without a thumbnail.
 */
export async function makePowerPointThumbnail(bytes: Uint8Array): Promise<string | null> {
  if (!bytes.byteLength || bytes.byteLength > 125 * 1024 * 1024) return null;
  const {
    loadPresentation, revokeBlobUrls, renderSlideStage, renderToCanvas,
    createDefaultRegistry, createTranslator,
  } = await import('pptx-vanilla-viewer');
  const deck = await loadPresentation(bytes.slice().buffer, {
    allowExternalImages: false,
    maxUncompressedBytes: 350 * 1024 * 1024,
  });
  let mount: HTMLDivElement | null = null;
  try {
    const { width, height } = deck.canvasSize;
    if (!deck.slides.length || !Number.isFinite(width) || !Number.isFinite(height) ||
        width < 1 || height < 1 || width > 100_000 || height > 100_000) return null;
    const stage = renderSlideStage({
      document, slide: deck.slides[0], canvasSize: deck.canvasSize,
      mediaDataUrls: deck.mediaDataUrls,
      colorScheme: deck.colorScheme,
      fontScheme: deck.fontScheme,
      formatScheme: deck.formatScheme,
      tableStyleMap: deck.tableStyleMap,
      registry: createDefaultRegistry(),
      t: createTranslator('en'), scale: 1, presenting: false,
      slides: deck.slides, currentSlideIndex: 0,
    });
    mount = document.createElement('div');
    // html2canvas-pro needs an attached DOM tree. Keep this off-screen but
    // NOT visibility:hidden / opacity:0, which would capture empty pixels.
    Object.assign(mount.style, {
      position: 'fixed', left: '-100000px', top: '0px',
      width: width + 'px', height: height + 'px',
      pointerEvents: 'none', zIndex: '-1', overflow: 'hidden',
    });
    mount.appendChild(stage);
    document.body.appendChild(mount);
    const images = Array.from(stage.querySelectorAll('img'));
    await Promise.race([
      Promise.allSettled(images.map(image => image.decode())),
      new Promise<void>(resolve => setTimeout(resolve, 3_000)),
    ]);
    // html2canvas-pro is loaded only for this background thumbnail operation.
    const canvas = await renderToCanvas(stage, {
      scale: Math.min(1, 360 / width),
      backgroundColor: '#ffffff',
      logging: false,
      useCORS: false,
    });
    if (!canvas.width || !canvas.height) return null;
    // Copy into a small bounded JPEG even for unusual slide aspect ratios.
    const target = document.createElement('canvas');
    target.width = 360;
    target.height = Math.max(1, Math.min(360, Math.round(360 * height / width)));
    const ctx = target.getContext('2d', { alpha: false });
    if (!ctx) return null;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, target.width, target.height);
    ctx.drawImage(canvas, 0, 0, target.width, target.height);
    let preview = target.toDataURL('image/jpeg', 0.75);
    if (preview.length > 350_000) preview = target.toDataURL('image/jpeg', 0.5);
    return preview.length <= 350_000 ? preview : null;
  } finally {
    mount?.remove();
    revokeBlobUrls(deck.blobUrls);
    deck.handler.dispose();
  }
}
