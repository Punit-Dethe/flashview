/** First PPTX experiment: check the completed ZIP package before mounting a renderer.
 * zip.js is deliberately isolated here for a future range-backed Reader.
 * This function never requests file bytes from the network. */
export async function inspectPptx(bytes: Uint8Array): Promise<void> {
  const { ZipReader, Uint8ArrayReader } = await import('@zip.js/zip.js');
  const archive = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    const entries = await archive.getEntries();
    // Avoid exposing ZIP internals to the PowerPoint UI; report actionable errors.
    const names = new Set(entries.map(entry => entry.filename.toLowerCase()));
    if (!names.has('[content_types].xml') ||
        !names.has('ppt/presentation.xml') ||
        !names.has('ppt/_rels/presentation.xml.rels') ||
        ![...names].some(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))) {
      throw new Error('This file is not a valid PowerPoint presentation.');
    }
  } finally {
    await archive.close();
  }
}
