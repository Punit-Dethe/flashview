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

## Documentation and review expectations

- A transfer or storage code change updates [Architecture](./architecture.md), [Protocol](./transfer-protocol.md) or [Security and reliability](./security-and-reliability.md) if behavior changes.
- Every reliability-audit PR updates the matching entry in [the tracker](./reliability-audit.md), including limitations and a specific test or CI result.
- Historical designs in [the archived plan](./archive/initial-engineering-plan.md) are not implementation authority; avoid copying outdated PDF-only claims into current docs.
- Never commit tokens, room links, actual user files or confidential logs.
