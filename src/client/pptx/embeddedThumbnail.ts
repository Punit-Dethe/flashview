import { BlobReader, Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';

const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

/** Read Office's saved preview without parsing slides, media, fonts or charts.
 * Only raster images are accepted; the caller decodes and re-encodes them. */
export async function readEmbeddedPowerPointThumbnail(source: Blob | Uint8Array): Promise<Blob | null> {
  const archive = new ZipReader(source instanceof Blob ? new BlobReader(source) : new Uint8ArrayReader(source));
  try {
    const entries = await archive.getEntries();
    for (const entry of entries) {
      if (entry.directory || !/^docprops\/thumbnail\.(?:jpe?g|png)$/i.test(entry.filename) ||
          !entry.uncompressedSize || entry.uncompressedSize > MAX_THUMBNAIL_BYTES) continue;
      const bytes = await entry.getData(new Uint8ArrayWriter(), { useWebWorkers: false });
      if (!bytes?.length || bytes.length > MAX_THUMBNAIL_BYTES) continue;
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      const png = [137,80,78,71,13,10,26,10].every((byte,index) => bytes[index] === byte);
      if (jpeg || png) return new Blob([Uint8Array.from(bytes).buffer], { type: jpeg ? 'image/jpeg' : 'image/png' });
    }
    return null;
  } catch {
    // Missing, corrupt or unsupported metadata must not prevent full rendering.
    return null;
  } finally {
    await archive.close();
  }
}
