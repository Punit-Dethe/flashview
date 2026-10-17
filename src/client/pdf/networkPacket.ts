/**
 * Phase 1 packet-size experiment. Network payloads may span multiple 64 KiB
 * persistent cache blocks, but the IndexedDB schema never changes.
 * Use ?packet=128 or ?packet=256 on the HOST URL to opt in.
 */
export function packetChunksFromQuery(query: string): 1 | 2 | 4 {
  const size = new URLSearchParams(query).get('packet');
  return size === '128' ? 2 : size === '256' ? 4 : 1;
}

/** Select one contiguous, currently missing byte range without crossing a
 * cached/reserved hole or wrapping at the end of the PDF. All indices are
 * 64 KiB cache blocks; selection is synchronous so callers can reserve them.
 */
export function selectMissingChunkGroup(
  total: number, cursor: number, cached: ReadonlySet<number>,
  reserved: ReadonlySet<number>, maxChunks: 1 | 2 | 4,
): number[] {
  if (!Number.isSafeInteger(total) || total <= 0) return [];
  for (let checked = 0; checked < total; checked++) {
    const index = (cursor + checked) % total;
    if (cached.has(index) || reserved.has(index)) continue;
    const indices = [index];
    for (let next = index + 1; next < Math.min(total, index + maxChunks); next++) {
      if (cached.has(next) || reserved.has(next)) break;
      indices.push(next);
    }
    return indices;
  }
  return [];
}
