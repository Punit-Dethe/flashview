/**
 * IndexedDB transaction coalescing experiment.
 * Each item resolves ONLY when the transaction containing it commits.
 * Short timed partial flushes prevent small PDF transfers from stalling.
 */
export type WriteBatchSize = 1 | 4 | 8 | 16;
export function writeBatchSizeFromQuery(query: string): WriteBatchSize {
  const size = new URLSearchParams(query).get('batch');
  return size === '4' ? 4 : size === '8' ? 8 : size === '16' ? 16 : 1;
}
type Entry<T> = {value: T; resolve: () => void; reject: (error: unknown) => void};

export class ChunkWriteBatcher<T> {
  private queue: Entry<T>[] = [];
  private active = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly limit: WriteBatchSize,
    private readonly persist: (records: T[]) => Promise<void>,
    private readonly maxWaitMs = 8) {}

  enqueue(value: T): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({value, resolve, reject});
      this.schedule();
    });
  }

  flush(): void {
    if (this.active || !this.queue.length) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const entries = this.queue.splice(0, this.limit);
    this.active = true;
    void Promise.resolve().then(() => this.persist(entries.map(x => x.value))).then(
      () => { for (const entry of entries) entry.resolve(); },
      error => { for (const entry of entries) entry.reject(error); },
    ).finally(() => {
      this.active = false;
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.active || !this.queue.length) return;
    // Reaching the limit immediately cancels any pending partial-batch timer.
    if (this.queue.length >= this.limit) {
      this.flush();
      return;
    }
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.maxWaitMs);
  }
}
