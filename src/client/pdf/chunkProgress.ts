/**
 * An IndexDB chunk set with O(1) byte-accurate progress. The initial key
 * scan happens once on cache hydration; per-chunk progress never rescans
 * previously persisted records. 64 KiB chunks, short last chunk allowed.
 */
export class CachedChunkIndex extends Set<number> {
  private bytesSaved = 0;
  private readonly totalChunks: number;
  constructor(readonly fileSize: number, indexes: Iterable<number> = []) {
    super();
    this.totalChunks = Math.ceil(fileSize / 65536);
    for (const index of indexes) this.add(index);
  }
  private length(index: number): number {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.totalChunks) return 0;
    return Math.min(65536, this.fileSize - index * 65536);
  }
  override add(index: number): this {
    if (this.has(index)) return this;
    super.add(index);
    this.bytesSaved += this.length(index);
    return this;
  }
  override delete(index: number): boolean {
    if (!super.delete(index)) return false;
    this.bytesSaved -= this.length(index);
    return true;
  }
  override clear(): void {
    super.clear();
    this.bytesSaved = 0;
  }
  progress(fileId: string): {fileId: string; bytes: number; size: number; complete: boolean} {
    return { fileId, bytes: this.bytesSaved, size: this.fileSize,
      complete: this.size === this.totalChunks && this.bytesSaved === this.fileSize };
  }
}
