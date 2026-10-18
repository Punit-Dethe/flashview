/**
 * Optional host-side thumbnail of slide one. Unlike PDF thumbnails, PPTX
 * thumbnails are generated ONLY after the host has cached *every* active
 * transfer. No sender CPU, Cloudflare frames, range requests or transfer
 * scheduler changes. Reuse the exact OOXML parser already bundled for Present.
 */
export async function makePowerPointThumbnail(bytes: Uint8Array): Promise<string | null> {
  if (!bytes.byteLength || bytes.byteLength > 35 * 1024 * 1024) return null;
  const { loadPresentation, revokeBlobUrls, exportSlideToSvg } =
    await import('pptx-vanilla-viewer');
  // Own the input; the OOXML loader consumes an ArrayBuffer, not a partial ZIP.
  const buffer = bytes.slice().buffer;
  const deck = await loadPresentation(buffer, {
    allowExternalImages: false,
    maxUncompressedBytes: 220 * 1024 * 1024,
  });
  let svgUrl: string | null = null;
  try {
    if (!deck.slides.length) return null;
    const width = deck.canvasSize.width;
    const height = deck.canvasSize.height;
    if (!(width > 0 && height > 0) || width > 100_000 || height > 100_000) return null;
    const svg = exportSlideToSvg(deck.slides[0], width, height);
    if (svg.length > 12 * 1024 * 1024) return null;
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    svgUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.decoding = 'async';
    image.src = svgUrl;
    await Promise.race([
      image.decode(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('PowerPoint thumbnail decode timed out')), 12_000)),
    ]);
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = Math.max(1, Math.round(360 * height / width));
    if (canvas.height > 360) return null;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return null;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    // A small JPEG fits the existing PDF-thumbnail cache without relay frames.
    const preview = canvas.toDataURL('image/jpeg', 0.78);
    return preview.length <= 350_000 ? preview : null;
  } finally {
    if (svgUrl) URL.revokeObjectURL(svgUrl);
    revokeBlobUrls(deck.blobUrls);
    deck.handler.dispose();
  }
}
