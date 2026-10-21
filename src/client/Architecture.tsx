import { useEffect, useState } from 'react';
import { SiteHeader } from './SiteHeader';
import { MAX_FILE_BYTES, MAX_STUDENT_FILES, ROOM_TTL_MS } from '../shared/protocol';
import { MAX_ACTIVE_SENDERS, MAX_ROOM_BYTES, MAX_ROOM_FILES, MAX_ROOM_SESSIONS } from '../shared/roomAdmission';
import './styles.architecture.css';

const source = 'https://github.com/Punit-Dethe/flashview/blob/main/';
const journey = [
  { name: 'Announce', title: 'A file starts as a name, not an upload.', text: 'The sender keeps the original browser File and announces its name, size and file ID. The relay checks admission, ownership and room limits before the receiving screen adds it to the queue.', detail: 'Source: sender browser · Authority: room engine' },
  { name: 'Request', title: 'The receiver asks for the pieces it needs.', text: 'The receiving transfer worker schedules missing byte ranges across files. A bounded adaptive window keeps several requests in flight without letting one slow sender block the whole room.', detail: 'Up to 16 requests globally · Per-file window starts at 6 and adapts between 2–10' },
  { name: 'Relay', title: 'A short, authorized trip through the relay.', text: 'The relay routes each request to the correct sender. Its worker reads that slice of the original and returns a binary packet. The relay forwards the packet; it does not save a permanent copy of the original.', detail: 'WSS transport · Network packets up to 256 KiB' },
  { name: 'Commit', title: 'Received is only counted after it is saved.', text: 'The receiving worker writes the response into canonical 64 KiB IndexedDB chunks. Progress advances after the write commits. Before declaring completion, it checks that the expected stored chunk keys are present.', detail: 'Browser IndexedDB is the source of truth for completion' },
  { name: 'Confirm', title: 'A receipt completes the journey.', text: 'Once the cache is verified complete, the host reports completion to the relay. The relay updates the file’s metadata, tells the sender and acknowledges the host. An explicit Download exports the cached original.', detail: 'Completion notices are acknowledged and retried' },
];
const codeMap = [
  ['Room and file rules', 'src/shared/roomEngine.ts', 'Shared authority, participant identity, revisions and state transitions.'],
  ['File state machine', 'src/shared/roomFileEngine.ts', 'File offers, approval, Stop, reconnect and completion checkpoints.'],
  ['Transfer owner', 'src/client/relayWorker.ts', 'The socket, original reads, scheduler and cache work away from UI rendering.'],
  ['Browser cache', 'src/client/pdf/roomCache.ts', 'Committed chunks, bounded reads, verification, retries and cleanup.'],
  ['Cloudflare adapter', 'src/cloudflare/index.ts', 'Public HTTP routes and a Durable Object for each room.'],
  ['Node adapter', 'src/server/index.ts', 'An alternative Node/WebSocket relay using the same room rules.'],
  ['Preview bridge', 'src/client/presentation.ts', 'Same-origin metadata and cache reads for separate presentation tabs.'],
  ['PDF and PowerPoint', 'src/client/Presenter.tsx', 'Selects the local renderer without taking over file transfers.'],
];

function Arrow({ label }: { label?: string }) {
  return <div className="arch-flow-arrow" aria-hidden="true"><span>→</span>{label && <small>{label}</small>}</div>;
}

export default function Architecture() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const title = document.title;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const description = meta?.content;
    document.title = 'WarpView architecture — From file to screen';
    if (meta) meta.content = 'How WarpView transfers files through dedicated workers, coordinates rooms and renders previews from browser cache.';
    const frame = requestAnimationFrame(() => {
      if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
    });
    return () => { document.title = title; if (meta && description !== undefined) meta.content = description; cancelAnimationFrame(frame); };
  }, []);
  return <div className="premium-app architecture-shell">
    <SiteHeader landing={false} publicNavigation architecture onHome={() => location.assign('/')}/>
    <main className="architecture-page">
      <header className="arch-intro">
        <h1 className="reference-serif">A file’s journey.<br/>By design.</h1>
        <div className="arch-intro-copy">
          <p>WarpView architecture</p>
          <p>File transfer has its own work to do. The interface and the preview have theirs.
            Here is how the current system keeps those jobs separate, and brings your file to the big screen.</p>
          <a href={source + 'docs/architecture.md'}>Read the technical notes <span aria-hidden="true">↗</span></a>
        </div>
      </header>

      <nav className="arch-contents" aria-label="Architecture sections">
        <a href="#system">The system</a><a href="#file-journey">A file’s journey</a>
        <a href="#independence">Independent work</a><a href="#cache-preview">Cache & preview</a>
        <a href="#recovery">Recovery</a><a href="#boundaries">Limits & trust</a><a href="#code-map">The code</a>
      </nav>

      <section className="arch-section arch-overview" id="system" aria-labelledby="system-title">
        <div className="arch-section-heading"><h2 id="system-title" className="reference-serif">Three places.<br/>One room.</h2>
          <p>The original stays on the sending device. The relay coordinates its journey.
            The receiving browser builds the room’s temporary local copy.</p></div>
        <figure className="arch-system-figure">
          <div className="arch-system-flow">
            <div className="arch-system-node"><span className="arch-node-symbol" aria-hidden="true">
              <svg viewBox="0 0 48 48"><rect x="13" y="4" width="22" height="40" rx="4"/><path d="M20 9h8M22 38h4M18 17h12M18 22h12M18 27h8"/></svg>
            </span><h3>Sending device</h3><p>Original File<br/>Transfer worker</p></div>
            <Arrow label="WSS"/>
            <div className="arch-system-node arch-relay-node"><span className="arch-node-symbol" aria-hidden="true">
              <svg viewBox="0 0 48 48"><rect x="6" y="8" width="36" height="13" rx="3"/><rect x="6" y="27" width="36" height="13" rx="3"/><path d="M12 14h1M12 33h1M31 14h5M31 33h5M24 21v6"/></svg>
            </span><h3>Cloudflare relay</h3><p>Worker routes<br/>One Durable Object per room</p></div>
            <Arrow label="WSS"/>
            <div className="arch-system-node"><span className="arch-node-symbol" aria-hidden="true">
              <svg viewBox="0 0 48 48"><rect x="4" y="6" width="40" height="28" rx="3"/><path d="M24 34v8M15 42h18M10 13h15M10 19h27M10 25h20"/></svg>
            </span><h3>Receiving screen</h3><p>Transfer worker<br/>IndexedDB room cache</p></div>
          </div>
          <div className="arch-preview-branch"><span>Local branch from the receiving screen</span>
            <span aria-hidden="true">↓</span><strong>Separate preview tab</strong><p>PDF.js or the PowerPoint renderer · reads the browser cache</p></div>
          <figcaption>Original bytes travel over authenticated WebSockets. The preview uses a same-origin BroadcastChannel bridge, without another room WebSocket.</figcaption>
        </figure>
        <p className="arch-note">Cloudflare is the deployed relay. A Node/WebSocket adapter is also available for running the same room protocol elsewhere; it is an alternative, not another hop in the diagram.</p>
      </section>

      <section className="arch-section" id="file-journey" aria-labelledby="journey-title">
        <div className="arch-section-heading"><h2 id="journey-title" className="reference-serif">Follow the bytes.</h2>
          <p>From a file offer to a confirmed browser copy. Select a stage to see what happens there.</p></div>
        <figure className="arch-journey-figure">
          <ol className="arch-journey-stages">
            {journey.map((item, index) => <li key={item.name}><button type="button" aria-pressed={step === index}
              onClick={() => setStep(index)}><span>{index + 1}</span>{item.name}</button></li>)}
          </ol>
          <div className="arch-journey-detail" aria-live="polite" aria-atomic="true">
            <h3>{journey[step].title}</h3><p>{journey[step].text}</p><small>{journey[step].detail}</small>
          </div>
          <figcaption>This is a logical sequence, not a speed benchmark. Real transfers repeat the request → relay → commit loop until all chunks are saved.</figcaption>
        </figure>
      </section>

      <section className="arch-section" id="independence" aria-labelledby="independence-title">
        <div className="arch-section-heading"><h2 id="independence-title" className="reference-serif">Let each job<br/>keep its own pace.</h2>
          <p>Previewing a slide should not tell the transfer scheduler what to do next. Work is divided by responsibility, not by what is currently visible.</p></div>
        <figure className="arch-lanes-figure">
          <div className="arch-work-lane"><h3>Interface</h3><div><span>Pick files</span><span>Room controls</span><span>Progress updates</span></div><p>Small commands and status cross the worker boundary.</p></div>
          <div className="arch-work-lane arch-transfer-lane"><h3>Transfer worker</h3><div><span>Socket & auth</span><span>Range scheduler</span><span>Chunk writes</span></div><p>Original transfer packets stay in the worker path.</p></div>
          <div className="arch-work-lane"><h3>Preview tab</h3><div><span>Read cached bytes</span><span>Render pages</span><span>Zoom & navigate</span></div><p>Closing this tab leaves the room transfer and cache in place.</p></div>
          <figcaption>The worker owns the sender’s File reads and the receiver’s network/cache work. This removes application-level dependencies on interface rendering, but cannot override browser or operating-system suspension.</figcaption>
        </figure>
        <div className="arch-prose-columns"><div><h3>One set of room rules</h3><p>Node and Cloudflare share the room engine and file state machine.
          The same rules decide admission, ownership, approval, Stop and completion. Each adapter handles its own sockets and persistence.</p></div>
          <div><h3>Old messages cannot rewrite a new room</h3><p>Room generations identify a specific room lifetime. Revisions order metadata changes.
            The client rejects stale snapshots, and cache identities keep a reused six-digit code separate from the earlier room’s files.</p></div></div>
      </section>

      <section className="arch-section" id="cache-preview" aria-labelledby="cache-title">
        <div className="arch-section-heading"><h2 id="cache-title" className="reference-serif">A browser cache.<br/>A window onto it.</h2>
          <p>Room files are cached in the receiving browser. They do not appear in the computer’s Downloads folder unless someone explicitly chooses Download.</p></div>
        <figure className="arch-cache-figure">
          <div className="arch-cache-input"><strong>Network response</strong><span>Up to 256 KiB</span></div>
          <Arrow/>
          <div className="arch-chunks"><strong>Persisted chunks</strong><div aria-label="Four 64 KiB chunks"><span>64 KiB</span><span>64 KiB</span><span>64 KiB</span><span>64 KiB</span></div><p>IndexedDB · scoped to this room and file</p></div>
          <figcaption>Illustrative split of one full-sized response. The final chunk may be smaller. Network packet size and persistent chunk size are separate choices.</figcaption>
        </figure>
        <div className="arch-format-table" role="region" aria-label="Preview formats">
          <div><h3>PDF</h3><p>PDF.js reads available cached ranges. An early first-page image can appear while more bytes arrive; the viewer can switch to the complete local file when needed.</p></div>
          <div><h3>PPTX / PPSX</h3><p>The original must be fully cached first. The browser then inspects the OOXML archive and renders slides locally, without a cloud conversion service.</p></div>
          <div><h3>Other files</h3><p>Transfer and Download preserve the original bytes. Legacy .ppt and other unsupported preview formats remain download-only.</p></div>
        </div>
        <p className="arch-note">The cache has a bounded 48 MiB read LRU, but IndexedDB remains the source of truth. A storage quota problem pauses affected files for recovery; an in-memory copy does not count as safely saved.</p>
      </section>

      <section className="arch-section" id="recovery" aria-labelledby="recovery-title">
        <div className="arch-section-heading"><h2 id="recovery-title" className="reference-serif">Reconnect.<br/>Reuse. Continue.</h2>
          <p>A brief interruption should not require starting the original over. Recovery rebuilds what is known and asks only for what is missing.</p></div>
        <figure className="arch-recovery-figure">
          <ol><li><strong>Connection interrupted</strong><p>Outstanding reads lose authority; late responses from an obsolete connection are ignored.</p></li>
            <li><strong>Private session resumes</strong><p>Reconnect and focus signals retry the handshake. The room engine restores the existing identity.</p></li>
            <li><strong>Saved chunks are checked</strong><p>The receiver reuses committed browser data and reconstructs its missing-range queue.</p></li>
            <li><strong>Missing ranges continue</strong><p>Per-file retry and bounded concurrency let other files keep making progress.</p></li></ol>
          <figcaption>Recovery depends on the source still being available. Reloading or closing a sender page loses its selected File handles; a worker is not a background daemon.</figcaption>
        </figure>
        <div className="arch-prose-columns"><div><h3>Keep the room alive</h3><p>Rooms have a {ROOM_TTL_MS / 3_600_000}-hour renewable idle lifetime.
          The dashboard and presentation tabs renew restricted leases, including when the dashboard is hidden. Browser suspension can still delay those timers.</p></div>
          <div><h3>End deliberately</h3><p>End room records the intent and stops transfer work. The app confirms server closure before clearing that room’s chunks and previews.
            If confirmation or deletion fails, cleanup can be retried. Original device files stay untouched.</p></div></div>
      </section>

      <section className="arch-section" id="boundaries" aria-labelledby="boundaries-title">
        <div className="arch-section-heading"><h2 id="boundaries-title" className="reference-serif">Clear limits.<br/>An honest trust boundary.</h2>
          <p>These are the current application budgets. They are not promises about available disk space, network speed or how long a browser will keep running.</p></div>
        <dl className="arch-limits">
          <div><dt>Per file</dt><dd>{MAX_FILE_BYTES / 1_048_576} MiB</dd></div>
          <div><dt>Files per sender</dt><dd>{MAX_STUDENT_FILES}</dd></div>
          <div><dt>Active senders</dt><dd>{MAX_ACTIVE_SENDERS}</dd></div>
          <div><dt>Retained file records</dt><dd>{MAX_ROOM_FILES}</dd></div>
          <div><dt>Declared room bytes</dt><dd>{MAX_ROOM_BYTES / 1_073_741_824} GiB</dd></div>
          <div><dt>Room join sessions</dt><dd>{MAX_ROOM_SESSIONS}</dd></div>
        </dl>
        <div className="arch-boundary-copy"><div><h3>Encrypted in transit, not end-to-end</h3><p>HTTPS/WSS protects transport to the relay. WarpView does not currently use end-to-end encryption;
          the relay can inspect bytes in transit. It persists room, session and file metadata, not permanent copies of original file payloads.</p></div>
          <div><h3>Admission is separate from host authority</h3><p>A room code or invitation allows joining, subject to the host’s chosen approval policy.
            Host and private resume capabilities are distinct. Names are optional; the system identifies participants by their own session identity.</p></div>
          <div><h3>Local does not mean unlimited</h3><p>Device storage quota, browser memory, sender availability and the network all matter.
            Preview tabs run on the same origin and are not a complete storage-isolation boundary. R2, OPFS and WebRTC/TURN are not part of this deployed transfer path.</p></div></div>
      </section>

      <section className="arch-section" id="code-map" aria-labelledby="code-title">
        <div className="arch-section-heading"><h2 id="code-title" className="reference-serif">From the diagram<br/>to the code.</h2>
          <p>The implementation is the reference. These entry points connect each responsibility to its source.</p></div>
        <div className="arch-code-map">{codeMap.map(([name, path, description]) => <a href={source + path} key={path}>
          <span><strong>{name}</strong><small>{description}</small></span><code>{path.split('/').at(-1)}</code><span aria-hidden="true">↗</span>
        </a>)}</div>
        <div className="arch-finish"><p className="reference-serif">Ready for the big screen?</p><a href="/#create-room">Create a room <span aria-hidden="true">→</span></a></div>
      </section>
    </main>
    <footer className="reference-footer"><span>WarpView. An easier way to present.</span><a href="/">Back to home</a></footer>
  </div>;
}
