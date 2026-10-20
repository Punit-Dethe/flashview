/**
 * Stage 0 only: optional, entirely local performance timings.
 * Enable with ?perf=1 on a student or classroom page.
 *
 * No cookies, tracking, remote logging, filenames, PDF contents, join tokens,
 * room codes or student names are recorded. Nothing is uploaded.
 */
export type PerfName =
  | 'socket_connect_ms' | 'heartbeat_rtt_ms' | 'file_receipt_ms'
  | 'preview_generate_ms' | 'preview_receive_ms' | 'sender_read_ms'
  | 'range_roundtrip_ms' | 'cache_write_ms' | 'cache_complete_ms'
  | 'pdf_open_ms' | 'page_render_ms' | 'first_slide_after_present_ms'
  | 'sender_backpressure_ms' | 'source_hash_ms' | 'opfs_checkpoint_ms' | 'opfs_scan_ms' | 'opfs_seal_ms';

export type PerfRecord = {
  metric: PerfName;
  ms: number;
  timestamp: number;
  bytes?: number;
  page?: number;
  outcome?: 'ok' | 'error';
};
export type PerfSummary = {
  metric: PerfName;
  count: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  errors: number;
};
export type PerfSnapshot = {
  version: 1;
  environment: {
    browser: string;
    visibility: DocumentVisibilityState;
    sampleCount: number;
  };
  summary: PerfSummary[];
  samples: PerfRecord[];
};

let ENABLED = (() => {
  try { return new URLSearchParams(location.search).get('perf') === '1'; }
  catch { return false; }
})();
export const perfEnabled = ENABLED;
const MAX_SAMPLES = 1600;
const records: PerfRecord[] = [];
const anchors = new Map<string, number>();
let publishRecord: ((record: PerfRecord) => void) | undefined;
export function configureWorkerPerf(enabled: boolean, publish: (record: PerfRecord) => void): void {
  ENABLED = enabled; perf.enabled = enabled; publishRecord = publish;
}

function rounded(n: number): number { return Math.round(n * 100) / 100; }
function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  return rounded(values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)]);
}
export const perf = {
  enabled: ENABLED,
  mark(key: string): void {
    if (!ENABLED) return;
    anchors.set(key, performance.now());
  },
  elapsed(metric: PerfName, key: string, bytes?: number): void {
    if (!ENABLED) return;
    const begin = anchors.get(key);
    anchors.delete(key);
    if (begin !== undefined) this.record(metric, performance.now() - begin, { bytes });
  },
  record(metric: PerfName, ms: number, extras: {
    bytes?: number; page?: number; outcome?: 'ok' | 'error';
  } = {}): void {
    if (!ENABLED || !Number.isFinite(ms) || ms < 0) return;
    const safe: PerfRecord = { metric, ms: rounded(ms), timestamp: Date.now() };
    if (Number.isFinite(extras.bytes) && (extras.bytes ?? 0) >= 0)
      safe.bytes = Math.floor(extras.bytes!);
    if (Number.isSafeInteger(extras.page) && extras.page! > 0) safe.page = extras.page;
    if (extras.outcome === 'error') safe.outcome = 'error';
    else safe.outcome = 'ok';
    records.push(safe);
    if (records.length > MAX_SAMPLES) records.shift();
    publishRecord?.(safe);
  },
  clear(): void {
    records.length = 0;
    anchors.clear();
  },
  snapshot(): PerfSnapshot {
    const groups = new Map<PerfName, PerfRecord[]>();
    for (const record of records) {
      const bucket = groups.get(record.metric) ?? [];
      bucket.push(record);
      groups.set(record.metric, bucket);
    }
    const summary: PerfSummary[] = [];
    for (const [metric, group] of groups) {
      const values = group.map(item => item.ms).sort((a, b) => a - b);
      summary.push({
        metric, count: group.length,
        meanMs: rounded(values.reduce((a, b) => a + b, 0) / values.length),
        medianMs: percentile(values, .5),
        p95Ms: percentile(values, .95),
        maxMs: rounded(values[values.length - 1]),
        errors: group.filter(item => item.outcome === 'error').length,
      });
    }
    summary.sort((a, b) => a.metric.localeCompare(b.metric));
    return {
      version: 1,
      environment: {
        browser: navigator.userAgent,
        visibility: document.visibilityState,
        sampleCount: records.length,
      },
      summary,
      samples: records.map(item => ({ ...item })),
    };
  },
};
if (ENABLED && typeof window !== 'undefined') {
  // Dev/Playwright hook. There are no writes or uploads; diagnostics stay local.
  (window as typeof window & { __flashviewPerf?: typeof perf }).__flashviewPerf = perf;
}
