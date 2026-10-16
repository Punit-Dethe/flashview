# FlashView

**Instant PDF presentation across devices.** A teacher opens a room on a smartboard, a student scans its QR code from their phone, chooses a PDF, and the teacher can view its pages without waiting for the entire file to upload.

[Read the full technical roadmap and design decisions](./plan.md).

## Architecture

- Cloudflare Worker + per-classroom Durable Object (Free tier) is the production relay; the small Node/`ws` server remains a local testing baseline.
- React + Vite browser UI: QR pairing, host document review, mobile file selection, and presentation controls.
- Mozilla PDF.js requests only necessary byte ranges for fast first-page opening. Once the first page renders, the classroom tab downloads the rest in the background into room-scoped IndexedDB. Presentation tabs share the persistent byte cache.
- No cloud file storage. The sender **must stay online until the entire PDF is cached on the classroom computer**; afterward, the PDF is available without the sender. The relay can access document bytes in transit (not end-to-end encrypted).
- Direct P2P and upload-to-storage are deliberately out of scope for the first release.

## Local development

Requires Node.js 22+.

```bash
npm install
npm run dev
```

Open **http://localhost:5173**. Create a room in the host tab. Join with a separate private browser window using the six-digit room code, allow the student, and choose a PDF. The teacher must approve the file before opening it.

The QR produced by a localhost development server will not be reachable from a separate phone. Use a public HTTPS deployment or an HTTPS tunnel exposing the Vite frontend for cross-device testing.

To build and launch as one process:

```bash
npm run build
npm start
```

The production app listens on `PORT` (default 3000), serves `dist`, and handles `/ws` WebSockets. Behind a reverse proxy, enable WebSocket upgrades and TLS. Set `PUBLIC_ORIGIN` to the deployed HTTPS origin.

## Testing

```bash
npm test
npm run build
```

For a meaningful connectivity test, place host and student on **different internet connections**; campus Wi-Fi should be tested independently. The initial MVP requires WebSocket upgrade access via port 443. Ordinary HTTPS fallback and live-device benchmarking are planned but **not yet implemented**.

## Room cache and cleanup

- The teacher can open/close individual presentation tabs without losing the classroom queue.
- FlashView saves received original PDF bytes in **IndexedDB on the teacher's computer**, not Cloudflare.
- The dashboard shows each PDF's saved bytes; a fully cached document remains presentable after the sender disconnects.
- As soon as an approved student shares a PDF, FlashView starts a room-owned background download before any presentation is opened. The teacher approves students only; there is **no separate file approval**.
- The downloader rotates fairly across students and uses up to three chunks per file batch; current-page requests take priority.
- Once complete, the presenter reconstructs the PDF from IndexedDB and gives PDF.js the entire Uint8Array directly, avoiding the custom byte-range transport during rendering.
- PDF.js's additional CMap, standard-font and WASM decoder resources are bundled locally for scanned/image-heavy and international PDFs.
- **End session** opens a confirmation dialogue. Only after checking the warning does FlashView close presentation tabs and delete the room's cached PDFs, without touching original student files. Refreshing/closing a tab doesn't delete the room cache.
- Abandoned rooms get cleaned on a later website visit after the room's expiry. Browser storage quotas or private mode may limit persistent caching; FlashView displays a warning when local storage fails.
- Deleting browser data is not forensic disk erasure.

## Limitations / work remaining

- Multi-page and simulated connection-loss cases are covered in automated Chromium tests. Real classroom phones and the exact problematic slide PDF still need testing.
- Student tab suspension/phone lock may interrupt downloads of **uncached** bytes. Keep the sender tab open until the teacher's cache shows 100%.
- No HTTP-only fallback when firewalls block WebSocket upgrades yet.
- Data is not encrypted end-to-end; do not use with confidential PDFs.
- The local Node server uses transient rooms. Cloudflare uses short-lived persisted room metadata so objects can hibernate; PDF bytes are never saved.
- Large or unusual PDFs may need multiple noncontiguous ranges before page 1 can render.
- Host can approve student connections and each submitted document; high-traffic production abuse controls need additional work.

## Why not fork PairDrop or Holo?

PairDrop's complete WebRTC/TURN infrastructure is unnecessary for our firewall-friendly server relay design. Holo is closer conceptually, but mixing its Go relay and larger Next.js frontend would require rewriting the central file protocol anyway. FlashView's small, all-TypeScript implementation keeps a custom PDF.js range-request protocol easy to reason about and optimize.

## License

Project license has not yet been chosen. External dependencies retain their respective licenses.

## Permanent free hosting — Cloudflare Workers (recommended)

FlashView is designed for the **Cloudflare Workers Free + SQLite-backed Durable Objects Free** tiers. No expiring trial, paid container or custom domain is required. Cloudflare serves the React site as static assets and uses one hibernatable Durable Object per classroom, even when students are on different networks.

1. Register for **Cloudflare Workers Free** and enable your free `workers.dev` subdomain.
2. On your computer run `npm install`, then `npx wrangler login` to authorize deployment.
3. Run `npm run deploy` to build and publish the website plus Durable Object relay.
4. Open the resulting HTTPS `workers.dev` URL; create a room and scan its QR from a phone on mobile data.

To run the Cloudflare backend locally, use `npm run dev:cloudflare`. For the existing Node baseline, `npm run dev` still works.

Current Cloudflare Free allowances include 100,000 Durable Object requests/day and 13,000 GB-s/day of compute. Over-limit requests fail rather than becoming automatic paid overages on the Free plan. Real performance and quotas still need testing.

Vercel gained native WebSocket support in June 2026, but a student and host can be assigned different function instances, adding coordination complexity. Deno Deploy has a free tier with 20 GiB monthly egress, but that quota may constrain streamed PDFs.

**Security boundary:** The hosted server has no end-to-end PDF encryption and should not be used with sensitive documents. Enable the campus firewall's outbound HTTPS access to the domain and verify WebSocket upgrades. If WSS is blocked, an ordinary HTTP fallback is still a future milestone.


Cloudflare references: https://developers.cloudflare.com/durable-objects/platform/pricing/ · https://developers.cloudflare.com/durable-objects/best-practices/websockets/ · https://developers.cloudflare.com/workers/static-assets/

## Fast first-slide preview

Some PDFs are not arranged for early byte-range rendering, so even an otherwise correct PDF.js viewer can wait for more data before displaying page 1. FlashView now uses a complementary preview:

- On selecting a PDF, the student's browser generates a compressed JPEG of page 1 and sends it to the classroom using the authenticated WebSocket relay.
- That image appears in presentation tabs **while the original PDF continues downloading**. It is a temporary visual preview, not a replacement for the PDF document.
- The classroom caches the exact original PDF, not just the preview. Once the PDF becomes renderable it replaces the image; after 100% caching every page can open from the original PDF offline.
- Both original PDF bytes and the preview are stored only in IndexedDB on the classroom computer. Confirming **End session** deletes both, never the student originals.
- The range-only PDF.js transport now uses a single complete response per requested range, with explicit range-stream completion.

Preview generation is best effort on low-powered phones and unusually large or password-protected PDFs. The compressed image may look less sharp than the final document.

## Transfer throughput while a presentation tab is open

The classroom tab owns the WebSocket and downloads PDFs continuously after student approval. Opening a presentation no longer pauses the background queue. The downloader retains up to **six concurrent 64 KiB background requests** per round, and immediate PDF.js page-range requests can run concurrently and share already-pending chunk downloads.

Importantly, successful batches are processed by a **continuous asynchronous pump**, not a repeating short timer: browsers throttle short timers when the original classroom dashboard becomes a background tab after the teacher opens Present. The dashboard now shows an approximate **KB/s or MB/s transfer rate** alongside the saved-byte counter for real-world comparison.

The speed is limited by the sending phone's upload link and the available WebSocket relay/network bandwidth; the app cannot guarantee constant throughput across different cellular networks or browsers. A fully suspended or closed classroom tab can still stop transfer; keep the room tab open.


## Performance audit optimizations

- **Less IndexedDB overhead:** an indexed cache manifest distinguishes stored chunks from missing chunks, so known missing chunks are fetched directly from the sender, without unnecessary IDB reads. Present-page requests still reuse inflight transfers.
- **Throttled UI work, not transfers:** chunk bytes persist immediately; the teacher and viewer only receive visible progress broadcasts roughly every 350 ms, with immediate completion events.
- **Independent student scheduling:** a bounded global window of 16 background chunk requests, up to 6 per file, runs round-robin across all queued PDFs. One slow student's request does not block other students' available slots. Page reads use independent requests. Disconnected senders are paused until they return.
- **Lower phone memory for large previews:** for PDFs of at least 12 MB, PDF.js reads local byte ranges from the phone instead of first allocating the whole file as an ArrayBuffer. On unusual PDFs where the local range reader cannot finish promptly, the established full-file preview method is retained as a fallback. JPEG compression is asynchronous.
- **64 KiB original PDF cache chunk layout remains unchanged.** A different chunk size would require a cache-format migration and real-network benchmarks; larger messages are not automatically faster.
- Fully cached PDFs still use the original document bytes from IndexedDB. Their reconstruction across new presentation tabs has not been restructured because doing so risks extra persistent storage and memory usage.

Tests include stalled foreground requests, a slow student alongside a second student completing a PDF, real PDF rendering, and a separate large-preview fixture. Automated green tests do not establish a universal network speedup. For useful before/after measurements, compare similar 10–20 MB PDFs with the same phone, browser and network, once with the presentation tab open and once closed.


## Performance 2.0 — Stage 0, measurement only

The new diagnostics do not change PDF transfer, caching or rendering. They are
opt-in, memory-only and never uploaded to a server.

Add ?perf=1 to the classroom or student page URL. For an invitation URL which
already contains ?join=..., append &perf=1. Then open the Performance diagnostics
section at the bottom of the page. Use Copy JSON report to manually collect
local timing samples. Filenames, students' names, PDF contents, room codes and
access tokens are not included. Records clear when the tab closes.

Measurements: connection handshake, heartbeat RTT, file receipt, preview
generation and relay, sender disk reads, range RTT, IndexedDB writes, full-cache
completion, PDF.js opening, page rendering and first-slide-after-Present time.
The latest 1600 samples are retained in memory. Render timings from new
presentation tabs go only to the teacher's original tab through BroadcastChannel.

Repeatable synthetic browser baseline:

    npm run build
    npm run bench:baseline

Additional scenarios:

    BENCH_MIB=12 BENCH_RUNS=3 BENCH_STUDENTS=5 BENCH_FILE_READ_DELAY_MS=25 npm run bench:baseline
    FLASHVIEW_BACKEND=cloudflare BENCH_MIB=2 BENCH_RUNS=2 npm run bench:baseline

The script creates a deterministic 10-page non-linearized synthetic PDF,
starts a local Node or Cloudflare relay, runs real Chromium student and host
sessions, caches and presents the PDF, and exports
test-artifacts/stage0-*.json.

GitHub Actions saves one-run Node and Cloudflare baseline JSON artifacts.
These measure a synthetic file on local headless Chromium, not real campus
Wi-Fi, cellular latency or phone CPU. Compare the same hardware and scenario,
preferably with three or more runs, before implementing Stage 1.
