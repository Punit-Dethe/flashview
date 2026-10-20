# Development and testing

For the architecture first, read [Architecture](./architecture.md). This guide follows the current [package scripts](../package.json), [Vite config](../vite.config.ts) and [CI workflow](../.github/workflows/ci.yml).

## Requirements and local startup

Install **Node.js 22+** and npm. From the repository root:

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Vite runs the React frontend on port **5173**, while `tsx watch` runs the Node relay on port **3000**. Requests to `/api`, `/ws` and `/health` are proxied to Node.

Use two browser windows to test a room locally: create it in one, join by its six-digit code in the other. For tests on different devices, use a public HTTPS origin or a tunnel exposing both the frontend and WebSocket upgrade route. A localhost QR is never reachable from a separate phone.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start Vite and the Node relay together |
| `npm run dev:server` | Start only the Node relay in watch mode |
| `npm run dev:client` | Start only Vite |
| `npm run build` | Prepare PDF.js assets, TypeScript type-check and build `dist/` |
| `npm start` | Serve built `dist/` and `/ws` on the Node relay |
| `npm run dev:cloudflare` | Build and run local Wrangler Worker |
| `npm run check:cloudflare` | Dry-run the Worker deployment |
| `npm run deploy` | Build and deploy via Wrangler (requires credentials) |
| `npm test` | Run `tests/*.test.ts` with Node's test runner |
| `npm run test:browser` | Browser E2E suite |
| `npm run test:browser:cloudflare` | Launch the Cloudflare-backed browser runner |
| `npm run bench:baseline` | Synthetic transfer benchmark harness |

Playwright browsers may need a one-time installation such as `npx playwright install --with-deps chromium`.

## Repository orientation

- [`src/client/App.tsx`](../src/client/App.tsx): role state, join/create logic, offers, browser file picker, downloads and room lifecycle.
- [`src/client/socket.ts`](../src/client/socket.ts): handshake, liveness and automatic reconnect.
- [`src/client/pdf/roomCache.ts`](../src/client/pdf/roomCache.ts): IndexedDB, scheduler, local ranges and repair.
- [`src/client/presentation.ts`](../src/client/presentation.ts): host-presenter BroadcastChannel bridge; keep presenter **passive**.
- [`src/client/pdf/Viewer.tsx`](../src/client/pdf/Viewer.tsx) and [`src/client/pptx/`](../src/client/pptx/): format-dependent viewing.
- [`src/server/index.ts`](../src/server/index.ts) and [`src/cloudflare/index.ts`](../src/cloudflare/index.ts): two relay implementations of the same protocol.
- [`src/shared/protocol.ts`](../src/shared/protocol.ts): wire encoding and authoritative transfer limits.

For file types, `.pdf` is signature checked; general files are transferred unchanged, and `.pptx`/`.ppsx` are locally rendered only after full completion.

## Tests and merge gates

Run at least:

```bash
npm run build
npm run check:cloudflare
npm test
npm run test:browser
```

The [GitHub Actions workflow](../.github/workflows/ci.yml) goes further: browser E2E on Chromium, Firefox presenter compatibility, Cloudflare Durable Object browser tests, and comparable synthetic throughput runs for Node and Cloudflare (fixed/adaptive concurrency plus 128/256 KiB packet A/B checks). Inspect the **entire** CI conclusion before merging.

For transfer changes, add deterministic tests for duplicates, missing bytes, resume, sender disconnect, full storage and data integrity. Keep server and Cloudflare paths in parity. A green synthetic benchmark is **not** proof of real-world mobile throughput or memory use.

### Repeatable manual smoke test

1. Open host and sender on **separate internet connections** (e.g. desktop broadband and phone mobile data).
2. Join, send a small PDF and a general binary file, confirm both names appear immediately.
3. Check the PDF's preview, cached ring, page navigation and completed downloaded-file hash.
4. Send PPTX/PPSX and verify presentation starts only after full cache completion.
5. Interrupt the phone connection and reconnect without erasing previously cached host bytes.
6. Put the phone in the background, then restore it; document whether the browser preserved its File.
7. Simulate full browser storage without clearing active site data; verify a visible paused state and manual retry.
8. End the room; check that its IndexedDB data is cleared while unrelated room data remains intact.

## Profiling and performance experiments

Add `?perf=1` to the **page URL** for optional local metrics (socket connect, range timing, cache writes, first-slide and render timing). This diagnostic mode stores no uploaded analytics; the browser exposes `window.__flashviewPerf` to its own local page/tests. Avoid publishing personal room identifiers or user file data.

Query parameters for controlled transfer comparisons:

- `?transfer=fixed` uses the fixed transfer window instead of the adaptive window.
- `?packet=64` or `?packet=128` selects smaller network packets; the default is 256 KiB. All use the same 64 KiB IndexedDB storage blocks.

Do not infer a faster real-world connection from one localhost throughput sample. Compare consistent fixtures, senders, network conditions and number of students, and keep benchmark artifacts with the PR when useful.

`npm run bench:transfer` measures a synthetic 20 MiB arbitrary binary three times
and requires a SHA-256 match of each browser-cached original. `BENCH_TARGET` is
`node` (default), `cloudflare` (local emulation) or `public` (the deployed relay).
For an isolated public preview, `BENCH_ORIGIN=https://<worker>.workers.dev`
overrides the default origin. The benchmark explicitly skips the optional-name
screen before starting its transfer timer; room entry time is separate.
Optional `BENCH_MIB=1..45`, `BENCH_RUNS=1..10` and `BENCH_RESULT` select fixture,
repetitions and report path; defaults write ignored `test-artifacts/` JSON.
Public mode creates and ends temporary rooms and consumes that source's normal
creation quota. It never selects existing user files or uses OS Downloads.
Run comparisons sequentially while other suites are idle. The interval includes
automated file selection, transfer, persistence and the completion UI; hashing
must pass but is outside that interval. It is not isolated network throughput,
multi-sender fairness or a physical-phone/campus benchmark. Room setup is timed
separately. Keep before/after raw samples and source/version information.
The 45 MiB fixture ceiling avoids the automation API's large in-memory upload
restriction; the application's 200 MiB allowance is unchanged.

`BENCH_DIAGNOSTICS=1` additionally enables local perf counters and records
selection latency, anonymous control-event types, outstanding range counts and
the three slowest range stages. It never records auth payloads, filenames,
capabilities or original bytes. Selection latency is also reported in ordinary
runs. Diagnostic overhead differs from ordinary timing; preserve both batches
and never substitute fast traced runs for an unexplained slow ordinary sample.

## Documentation and review expectations

`transfer worker:` browser cases block both UI threads while independently
checking committed cache and the relay's completion message, crash sender and
receiver workers, and stop held requests before releasing obsolete source reads.
`tests/transferHarness.ts` holds initial worker commands until test-only faults
are installed via Playwright, rather than adding production debug APIs. Faults
that affect WebSockets, File reads or transfer-cache writes must run in the
worker; page DOM and completed export checks still run in the page.
The offline-Stop case can also target the deployed app: set
`WORKER_RECOVERY_ORIGIN` and run only `--test-name-pattern="offline Stop"`
against `tests/browser.smoke.ts`. It creates/ends a synthetic room, exercises a
real private reconnect and explicitly exports only its generated test binary.

- A transfer or storage code change updates [Architecture](./architecture.md), [Protocol](./transfer-protocol.md) or [Security and reliability](./security-and-reliability.md) if behavior changes.
- Every reliability-audit PR updates the matching entry in [the tracker](./reliability-audit.md), including limitations and a specific test or CI result.
- Historical designs in [the archived plan](./archive/initial-engineering-plan.md) are not implementation authority; avoid copying outdated PDF-only claims into current docs.
- Never commit tokens, room links, actual user files or confidential logs.

## Relay lifecycle regression checks

`tests/roomControl.test.ts` checks scoped authorization, stale/expired generations,
bounded metadata, serialized lease renewal and end/cleanup ordering under lost
responses, deadlines and persistence failures. `tests/relay.test.ts` exercises
the same HTTP lifecycle contract on Node and local Cloudflare, including operation
without a host WebSocket and denial of host privileges to a presenter lease.

The `room lifecycle:` browser scenarios inject failed/lost end responses, refresh
with a pending close, and abort the first cache deletion before retry. They also
advance the dashboard clock by over two hours while hidden, prove independent
presenter renewal/bridge responsiveness, and check copied host credentials were
removed before rendering. These are synthetic browser conditions; physical OS
suspension is still a device test. CI runs these scenarios on Chromium/Node,
Chromium/Cloudflare and Firefox/Node alongside existing transfer/viewer checks.

Emulator test launchers use `--inspector-port 0` so the OS assigns the debugger
port. This avoids the default inspector listener colliding with a previous
Wrangler process that is still shutting down; application HTTP ports are already
allocated independently. Each emulator also uses a distinct worker name and
ignored state directory under `.wrangler/test-state/`, preventing parallel test
files from sharing the same development identity and persistent room state.
