import { useEffect, useState } from 'react';
import { perf, type PerfSnapshot } from './perf';

/** Opt-in Stage-0 measurements; export requires a direct user click. */
export function PerfPanel() {
  const [opened, setOpened] = useState(false);
  const [snapshot, setSnapshot] = useState<PerfSnapshot>(() => perf.snapshot());
  const [copyError, setCopyError] = useState('');
  useEffect(() => {
    if (!opened) return;
    setSnapshot(perf.snapshot());
    const id = setInterval(() => setSnapshot(perf.snapshot()), 1000);
    return () => clearInterval(id);
  }, [opened]);
  if (!perf.enabled) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(perf.snapshot(), null, 2));
      setCopyError('');
    } catch {
      setCopyError('Clipboard unavailable. Try a secure (HTTPS) connection.');
    }
  };
  return <section className="perf-panel" data-testid="perf-panel">
    <button type="button" className="perf-toggle" onClick={() => setOpened(v => !v)}
      aria-expanded={opened}>
      {opened ? 'Hide performance diagnostics ↑' : 'Performance diagnostics ↗'}
    </button>
    {opened && <div className="perf-content">
      <p>Stage 0 · Local-only timings. No filenames, PDF data, names or room credentials.
        Copying a report is optional; nothing is sent to a server.</p>
      <div className="perf-actions">
        <button type="button" onClick={() => void copy()}>Copy JSON report</button>
        <button type="button" onClick={() => {
          perf.clear();
          setSnapshot(perf.snapshot());
        }}>Clear measurements</button>
      </div>
      {copyError && <p role="status">{copyError}</p>}
      {snapshot.summary.length === 0
        ? <p>Awaiting measurements. Share a PDF, present it or change pages to collect timings.</p>
        : <div className="perf-table-scroll">
          <table aria-label="Performance metrics">
            <thead><tr><th>Metric</th><th>Samples</th><th>Median</th><th>P95</th><th>Mean</th><th>Errors</th></tr></thead>
            <tbody>{snapshot.summary.map(item => <tr key={item.metric}>
              <td>{item.metric}</td>
              <td>{item.count}</td><td>{item.medianMs} ms</td>
              <td>{item.p95Ms} ms</td><td>{item.meanMs} ms</td><td>{item.errors}</td>
            </tr>)}</tbody>
          </table>
        </div>}
      <small>Timing estimates are from this browser tab only. Student and classroom clocks are not synchronized;
        compare each device's local timings separately.</small>
    </div>}
  </section>;
}
