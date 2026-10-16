# FlashView — Engineering Plan

**Status:** Cloudflare Workers Free / Durable Objects relay implemented. Build, Wrangler dry-run, Node relay tests and Cloudflare-emulated Chromium end-to-end PDF test passed (16 October 2026). Public deployment, campus firewall tests, HTTP fallback, and broader PDF fixtures are pending.  
**Last researched:** 16 October 2026  
**Product:** Instant, browser-based PDF presentation across different networks, particularly student phones to a classroom smartboard.

## 1. Product promise

A teacher opens FlashView on the smartboard; it displays a session QR code and a short code. A student on mobile data or institutional Wi-Fi scans or enters the code, picks a PDF, and sees a clear sending state. The PDF **appears in the host's document list immediately** (metadata first). The teacher selects it; FlashView shows the first available preview, then a real PDF page via PDF.js while the original PDF is still being fetched. The teacher can jump to any page: if its dependencies have not arrived, show an intentional loading state, request needed bytes with priority, then render it. No account, install, file download or manual upload to Drive should be necessary.

**Speed means time-to-usable-page, not necessarily total-file-transfer speed.** Never market instantaneous rendering as a guarantee: RTT, upstream bandwidth, PDF internal structure, sender backgrounding and institutional filtering all affect latency.

### Personas and scope

- **Host/teacher:** Creates and controls one classroom room, sees connected students and announced PDFs, accepts/declines files, opens one PDF, navigates pages, ends the room.
- **Sender/student:** Joins by QR/link or code, selects a PDF, stays online while host views it, sees readiness/connection state and can revoke their file.
- **V1:** PDFs only; one host, up to ~30 student connections; multiple listed files, one active document; no user accounts, permanent storage, OCR, PDF editing, screen casting, PPT conversion, native apps, WebRTC, or mandatory upload-before-preview.
- **File ownership:** The selected File stays in the sender browser; server streams bytes in volatile memory only. Sender leaving can prevent uncached pages from rendering.

### Non-negotiable acceptance criteria

1. Works with **two separate internet connections** (e.g., mobile data → school Wi-Fi) without inbound ports, LAN discovery or WebRTC.
2. PDF name appears on the host before the full file transfers; host can select it.
3. PDF pages render via PDF.js, with explicit loading/error states for not-yet-available pages.
4. Arbitrary page navigation requests required byte ranges from the sender rather than transferring intervening pages.
5. QR joining, host moderation, expiry, resource limits and sender-disconnect handling.
6. App uses HTTPS/WSS on port 443 when deployed; includes a planned ordinary HTTPS fallback for networks that reject WebSocket upgrades.
7. No claims of being fully tested on restrictive campus firewalls before an actual campus test.

## 2. Decisions and alternatives

| Concern | Choice | Alternatives and rationale |
|---|---|---|
| Starting codebase | **Small, purpose-built TypeScript application** | Do not fork PairDrop: extra discovery/WebRTC/TURN features increase debugging surface. Reuse concepts, not a whole unrelated stack. |
| Primary transfer | **One small Node.js HTTP server + native browser WebSocket / ws package** | The host and sender both open outbound secure connections; relay forwards requests/bytes without staging full files. Simpler to debug than a multi-service stack. |
| Data transfer behavior | **Demand-driven byte ranges; limited concurrency; binary messages** | Better for page jumps than uploading whole PDF sequentially. Use a small-file full-transfer optimization only after benchmarks. No base64 data frames. |
| Viewer/rendering | **Mozilla PDF.js (pdfjs-dist, Apache-2.0)** | Do not write a PDF parser/renderer. Build a minimal branded UI around getDocument and PDFDataRangeTransport. Start with the display layer, not a huge custom fork. |
| Source bytes | **Browser File.slice(begin, end).arrayBuffer() on the phone** | Reads slices of the selected local File on demand; no complete-memory-copy upload required. |
| Rooms | **Server-side ephemeral map of rooms; random host capability + opaque joining link** | No database in V1. Short human code is a convenience lookup, not a security credential. Room TTL/limit and join approval required. |
| QR | **Locally bundled QR component, generated from the current HTTPS origin and join link** | No third-party QR generation service receiving room links. Short-code manual entry fallback. |
| Initial deploy | **Single Node app serving built frontend and /ws; deploy to always-on HTTPS service with a region near Mumbai** | A single always-on service avoids complexity and cold-start delay. Railway/Fly/small VPS are possibilities; provider selection depends on actual egress price and billing preference. |
| Free demo deploy | **Render Free only for development demonstration** | Render free instances can spin down after 15 minutes idle and take ~1 minute to wake: unsuitable for the promised near-instant classroom experience. |
| Scale option | **Cloudflare Durable Objects per room, later if warranted** | Hibernating DO WebSockets may be economical, but migrating to its state/messaging model now adds complexity and incoming-message billing/limits need measurements. |
| HTTP fallback | **Add standard HTTPS long-poll / streaming chunk path after WSS MVP** | Some institutional proxies block WebSocket despite allowing HTTPS 443. Design shared commands so transport can be swapped. Requires bounded temporary in-memory HTTP response queues or pending requests. |
| WebRTC/P2P | **Not in MVP** | ICE/TURN adds setup delay and complexity and may fail behind managed campus firewalls. Optimize only after measurable benefit. |
| Linearization | **Optional benchmark/experimental optimization; never required** | PDF linearization can reorder bytes for progressive rendering, but transforming a whole PDF first defeats fast time-to-first-page for many documents. |
| Privacy | **TLS, strict room auth, host approval; no persistent file storage** | Relay can access payload unless future application-layer E2EE is implemented. State this plainly; do not claim end-to-end encryption. |

### Provider comparison and expense model

- **Single Node process on an always-on platform (recommended first):** straightforward WebSocket support, readable logs, easy integration tests, quick deployment and predictable request/response path. On a relay, **outbound document bytes to the host** count toward egress; inbound sender bytes normally do not. Exact charges depend on provider and region. Railway currently lists egress at $0.05/GB and a $5/mo Hobby plan; Render lists $0.15/GB excess public internet egress, plus included quotas; Fly.io's India regional egress differs materially from other regions. Verify prices before purchasing.
- **Cloudflare Workers + Durable Objects:** promising future optimization; DO WebSocket hibernation reduces idle compute billing, but per-message processing and limits are relevant to high-volume binary chunk relaying. DO is not interchangeable with a Node ws service. Evaluate using a measured load test before migration.
- **Object storage (R2/S3):** not the default first-page path. Adds a staging/upload stage unless independently implementing streamed/multipart viewing; helpful only for persistent or sender-offline access, which is out of scope.

**Rule:** Hosting account, payment details, domain, DNS and any college-network permission must be configured by the repository owner when needed; never store API tokens or secrets in Git.

## 3. System architecture

~~~text
Student browser (phone on LTE or campus network)
  local File object, File.slice, document sender, reconnect UI
        | outbound WSS (HTTPS 443)
        v
Single public FlashView server (Node + ws)
  ephemeral rooms / moderator capability / file manifest
  validates and routes control frames and bounded binary chunks
  DOES NOT need or retain complete PDFs
        ^
        | outbound WSS (HTTPS 443)
Teacher browser (smartboard on managed Wi-Fi)
  room + QR, document list, PDF.js custom byte-range source
  cache requested byte ranges / render / jump / loading state
~~~

For initial V1 host and sender can connect from any routable networks as long as each can reach the deployed site and WebSocket endpoint. This avoids firewall traversal, but cannot bypass a school's explicit service/domain block.

### Sender → host sequence

1. Host creates room via HTTPS (server supplies opaque join token/code); host WebSocket authenticates with high-entropy host capability. QR is constructed from public HTTPS link.
2. Sender follows link, requests to join room; host admits it (configurable classroom mode can auto-admit, after security review). Limit connections and rate-limit attempts.
3. Sender selects PDF. Validate actual File header (%PDF-), sensible max size, type/extension as advisory only. Sender sends metadata: random fileId, display name, exact byte length, sender id.
4. Server announces metadata to host **before** reading all bytes. Host authorizes file. No unsolicited heavy data yet.
5. Host opens file; create PDF.js loading task using PDFDataRangeTransport with known total length. PDF.js requests exact [begin,end) byte ranges.
6. Viewer forwards range request with requestId/fileId. Server validates sender/room/file ownership/bounds/concurrency, forwards to correct sender.
7. Sender reads File.slice, responds in bounded binary frames. Server forwards only to authorized host, respecting buffer-pressure caps. Host maps requestId + offset to PDF.js onDataRange.
8. PDF.js may request discontiguous structure/shared-resource byte ranges. Display **Loading page N…** while waiting; render when data is sufficient, else explicit timeout/retry. Do not assume pages occupy a contiguous byte interval.
9. Cache received ranges in host memory; eventually prefetch next-page dependencies if needed and bandwidth is available. Revocation/room close invalidates requests; clean up objects and cached data.

**Optional perception optimization:** In parallel with range service, sender may render a compressed page-1 image with PDF.js locally and publish it as a temporary placeholder. This is NOT the authoritative PDF page, may be slower on low-end phones, and must be benchmarked before shipping. Small files may be faster to proactively send whole, measured against range mode rather than assumed.

## 4. Wire protocol v1 (explicit and versioned)

Control messages: UTF-8 JSON, envelope {v:1, type, roomId?, requestId?, ...}. Types:

- host.create / room.created; host.join; student.join / join.pending / join.accept / join.reject; room.state / room.closed
- file.offer {fileId,name,size}; file.announced / file.approve / file.reject / file.revoke / file.unavailable
- range.request {requestId,fileId,begin,end}; range.error {requestId,code}; range.cancel {requestId}; peer.status / ping (WS protocol heartbeat preferred)
- Add message ordering/version validation; server **never trusts client-supplied role, senderId, room ownership or file size** without checks.

Binary range responses: defined header of fixed-width fields or length-prefixed UTF-8 metadata followed by raw bytes. Choose format unambiguously; support offset/requestId/fileId without base64 and cap to 64–128 KiB payload per frame initially. Reject oversize/non-matching replies. Use offset + exact length and cancel IDs to handle races and out-of-order delivery.

Transport safeguards: up to 4 simultaneous range requests per active PDF initially, queue additional requests, cap per-device/server bufferedAmount and use ack/credit-based flow control. Do not let a single mobile sender produce unlimited frames. Put strict maxPayload/max file-size/message-rate limits on server. No full-PDF server-side buffering. Re-evaluate chunk size with RTT/throughput benchmarks; chunk size is not CPU-core parallelism.

**HTTP fallback design:** Same room authorization semantics plus POST chunks to an authenticated server endpoint and GET range/long-poll responses, with short-lived bounded pending-byte buffers, cancellation, TTL and backpressure. Poll room metadata if event stream is blocked. A completely inaccessible domain cannot be fixed without school IT/network approval.

## 5. PDF.js details: decisive technical spike

Official PDF.js API supports PDFDataRangeTransport(length, initialData), requestDataRange(begin,end), and onDataRange(begin, Uint8Array). Integrate pdfjs-dist as a locally bundled dependency, configure workerSrc, set loading options intentionally:

- Start with disableStream:true and disableAutoFetch:true so range-mode behavior is measurable; confirm interactions with disableRange and rangeChunkSize on exact pinned PDF.js version.
- On document open, PDF.js may first need cross-reference structures in the tail, page tree, fonts and shared objects before even page 1 renders. **Range loading does not imply first page is one contiguous chunk.**
- Cache only completed ranges and deduplicate concurrent overlapping requests. Test PDFs with cross-reference tables, XRef streams, object streams, encryption/password, rotated pages, embedded fonts, very image-heavy pages, damaged files and optional linearization.
- Keep one active rendering task per canvas; cancel stale render on rapid page changes, free page resources and enforce canvas pixel limit. Only request/prefetch if sender remains connected.
- Unloaded jump: preserve last successful page or a neutral placeholder, show target page + skeleton/spinner and status; prioritize new page; cancel outdated prefetch, retry on timeout. If sender disconnects, show “Sender offline — cached pages remain available” and offer retry/reconnect; never show a silently blank canvas.
- Password-protected PDFs: in first release show an explicit unsupported/prompted state rather than hanging or exposing password to the relay.
- PDF links/scripts: keep an intentionally minimal, sandbox-aware viewer; do not execute PDF-embedded JavaScript or auto-open external links.

**Critical go/no-go experiment:** Does PDF.js plus custom transport actually render first and random pages with less transferred data than the full file, on a normal non-linearized PDF? Instrument each byte request and transferred byte. If PDF.js behavior or browser compatibility makes this unreliable, introduce a temporary authenticated HTTP endpoint offering HTTP 206 Range backed by pending sender slices, or use an adaptive full-file streaming fallback. Do not misrepresent an unsupported capability.

## 6. User experience / visual design

Editorial, restrained and classroom-friendly; no gradients, glowing cards or excessive animation. High contrast and big hit targets on the smartboard; short, accessible text on mobile.

- **Landing:** “Present a PDF from any device.” Create session / join with code.
- **Host room:** Large QR, short join code, current count, review queue, document list (student name, filename, size, status), end room, “Live / Reconnecting” indicator.
- **Sender:** Join state; file picker accepting .pdf; metadata-send status; “Keep this page open while presenting”; sharing/revoke control; clear offline handling.
- **Viewer:** Zoom/fit, previous/next, numeric page jump, page x / total; discreet “Loading page x”, connectivity and bytes requested. Fullscreen/PDF presentation mode.
- **Moderation:** Teacher approves sending/opening, no student can seize host display; reject out-of-room files. Keyboard shortcuts (arrows, Escape), responsive and accessible.
- **No account requirement:** name can be optional/anonymous, but teacher can distinguish connected devices via generated labels.

## 7. Reliability, security and privacy

**Trust boundaries:** URL join code is not host authorization. Give host a cryptographically strong secret held in host session; join links have separate random capability and short TTL; short 6-digit human code must be rate-limited and should trigger teacher approval. Reject any attempt to impersonate host or request bytes of another sender's unapproved file.

- Validate WebSocket Origin, use WSS + HTTPS only in production; deploy strict CSP and avoid unsafe HTML. Do not embed arbitrary PDF filename into HTML markup.
- Use maximum 50 MiB for initial PDF MVP (configurable), ~30 senders/room, capped rooms/server, socket payload and per-connection memory limits, request quotas, room TTL (~2h), idle timeouts.
- Limit API and WS join attempts per source/IP and room; account for proxy forwarding safely, cross-site WebSocket hijacking, uncontrolled file enumeration and denial-of-service. Ensure a room's tokens are never printed in logs.
- PDFs may contain confidential information. The relay transports content under TLS but is **not end-to-end encrypted**. Do not persist content; disable content logging and unnecessary analytics; expire session metadata.
- Heartbeat/pong, exponential reconnect, idempotent file announcement and in-flight request retry. When phone OS suspends the tab/locks the phone, progress is not guaranteed: show “Keep this page open” and recover when visible.
- Sender cancellation and host end-room must promptly stop transfer and clear application references.
- Gracefully handle server restart (rooms are ephemeral, user starts a new one) in initial version; durable rooms are not required.

## 8. Codebase layout (proposed)

~~~text
/
  plan.md
  README.md
  package.json
  .gitignore
  .env.example
  src/
    server/
      index.ts           HTTP server + WebSocket upgrades
      rooms.ts           ephemeral room lifecycle, capabilities
      protocol.ts        authenticated messages, routing, limits
    client/
      main.tsx           React app entry point
      App.tsx            host / join / send / viewer routes
      socket.ts          reconnecting typed transport
      pdf/
        range-transport.ts
        Viewer.tsx
      styles.css
    shared/
      protocol.ts        versioned schemas and constants
  tests/
    unit/                room/auth/ranges/protocol
    integration/         dual browsers, concurrent sends, reconnect
  .github/workflows/ci.yml
~~~

Choose Vite + React + TypeScript for simple, maintainable UI; Node + ws for server; pdfjs-dist for PDF; QR code rendered by a bundled package. Use one npm workspace/package initially to avoid complicated monorepo plumbing. Keep matching client/server types and strict TypeScript lint/test checks. Serve Vite assets from Node in production. No database, Redis, WebRTC or object storage until real necessity.

## 9. Development milestones (each independently demoable)

### M0 — Protocol + PDF feasibility (must pass before UI polish)
- [ ] Verify pdfjs-dist worker bundling and getDocument custom range transport in real Chrome/Firefox/Safari.
- [ ] Confirm first-page and random-page render with range-by-range slices on representative PDFs; log requested offsets, bytes, time to first render and errors.
- [ ] Compare against a streamed full-file baseline and (optional) qpdf-linearized copy. Pick adaptive threshold only from data.

### M1 — Minimal network vertical slice
- [ ] Create Node/TypeScript project, static client and WSS server.
- [ ] Create room, issue QR and code, join across different networks; host authorization and student room status.
- [ ] Select PDF; metadata appears on host without complete transfer.
- [ ] Binary request/response slices through server; basic limits and state cleanup.
- [ ] Basic integrated PDF.js page navigation + outstanding-load state.

### M2 — Classroom-quality experience
- [ ] Teacher document acceptance queue, reliable error/retry/revoke, multiple students.
- [ ] Zoom, fit, fullscreen, keyboard page navigation, obvious loading state, offline message.
- [ ] Prioritized demand fetch + small bounded prefetch/cache and cancellation; sender background warning.
- [ ] Stabilize timeouts, flow control, slow receiver handling, file size limits and abuse protections.

### M3 — Firewall hardening, deployment and analytics
- [ ] HTTPS/WSS deploy on an always-on endpoint with valid TLS, near intended Indian users.
- [ ] Test actual mobile data ↔ campus Wi-Fi, same protected Wi-Fi, and WSS-blocked network; implement HTTP fallback and measure.
- [ ] Add browser automation, protocol fuzz/bounds cases, performance instrumentation and CI.
- [ ] Publish deployment guide and troubleshooting checklist; verify security claims and privacy statement.

### M4 — Optional research/extensions (only after benchmarks)
- [ ] Compare relay hosting (Node vs Cloudflare DO), file prefetch algorithms and binary chunk sizes.
- [ ] Add optional sender-generated first-page placeholder.
- [ ] Try full small-file transfer when faster, HTTP range gateway, sender reconnect with pinned File handles where supported.
- [ ] Consider E2EE via QR-derived shared secret, if sensitive-document use demands it.
- [ ] Optional classroom retention via explicit opt-in storage; avoid by default.

## 10. Test and performance plan

Benchmark **median and p95** of:
- host room ready; scan/link-to-connected; file-picker-select-to-host-metadata;
- host-click-to-first-real-PDF-page and arbitrary jump-to-render;
- total bytes sent / full PDF bytes, time to full transfer in comparative baseline, peak sender/host/server memory;
- failures under intermittent data, server restart, phone screen lock, student disconnect, overloaded room and 30 simultaneous joiners.

Test corpus: 0.3 MB single-page, 2 MB normal, 10 MB image-heavy, 50 MB, linearized and non-linearized, remote-object-heavy, invalid/truncated, password protected. Conditions: same LAN, distinct 4G/Wi-Fi, simulated RTT 50/150/300ms + throttled upstream 1/5/20 Mbps; campus firewall where permitted. Collect no user PDF contents.

**Provisional UX goals, not guarantees:** <0.5s metadata after connected socket at low RTT, target ~1–2s first usable page for small ordinary documents on healthy networks; arbitrarily long for poor networks or complex PDFs, with visible status. Set realistic P95 SLOs only after field trials.

**Go/no-go:** If on-demand PDF.js requests frequently transfer almost the whole file before first-page render, adapt: display a pre-generated compressed first-page image and/or stream whole document for small sizes, while preserving the same UI.

## 11. Dependencies and things the owner must do outside chat

- Register and configure chosen deploy provider and billing if required; supply only non-secret deployment URL here.
- Authorize GitHub repository deployment integration and add secrets/environment vars through hosting UI, never through issue comments.
- Test the classroom smartboard browser/version; check it can access hosted HTTPS domain and WebSocket upgrade or permit school IT to whitelist the app. There is no legitimate client-side bypass for a fully blocked domain.
- Run two physical devices for final cross-network validation and report specific failure behavior.
- No database/domain purchase is needed to begin local development.

## 12. Sources consulted (primary, verified October 2026)

- Mozilla PDF.js range transport API: https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFDataRangeTransport.html
- Mozilla PDF.js document options (disableStream/disableAutoFetch): https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html
- Mozilla PDF.js integration guidance: https://github.com/mozilla/pdf.js/wiki/Setup-pdf.js-in-a-website
- Mozilla pdfjs-dist package and license: https://www.npmjs.com/package/pdfjs-dist
- MDN File.slice: https://developer.mozilla.org/en-US/docs/Web/API/Blob/slice
- MDN WebSocket buffering/backpressure: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
- MDN HTTP ranges: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests
- ws (binary frames, server and heartbeat): https://github.com/websockets/ws
- OWASP WebSocket security: https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html
- qpdf linearization design: https://github.com/qpdf/qpdf/blob/main/manual/linearization.rst
- Cloudflare DO pricing + hibernation: https://developers.cloudflare.com/durable-objects/platform/pricing/ and https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Render free sleep behavior: https://render.com/docs/free
- Render WebSocket support: https://render.com/docs/websocket
- Railway pricing: https://docs.railway.com/pricing/plans
- Fly.io regional egress: https://www.fly.io/docs/about/pricing/
- Browser page lifecycle: https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API

## 13. Implementation discipline

Keep changes small; implement M0/M1 first, validate with tests, then iterate M2/M3. Do not prematurely claim functionality merely because API supports it. Record benchmark findings and architectural deviations in this file as we learn. The core differentiator is **instant discoverability and progressive usability of a PDF across restricted networks**, not a claim of extraordinary raw bandwidth.

## 14. Zero-cost permanent hosting decision (16 October 2026)

**Project requirement:** ₹0 indefinitely, no expiring trial, no laptop kept running, and website accessible even after a month. Railway paid always-on, Fly.io paid and Render Free (~1-minute idle sleep) do not qualify.

**Primary hosting:** Cloudflare Workers Free for React static assets, API and WebSocket entry; SQLite-backed Durable Objects Free for hibernatable, room-specific WebSocket relays. Each classroom room code maps to one Durable Object, so all connected browser clients reach the same instance without Redis. Transferred PDFs stay in the student File object; relay forwards requested binary ranges without persistent storage. Room secrets and small manifests can be persisted to restore across object hibernation.

**Free limits (as of Oct 2026):** 100,000 DO requests/day; 13,000 GB-s/day; incoming WebSocket frames amortized 20:1 for billed request counts; outgoing DO WebSocket messages not billed as requests. Free overages fail rather than bill; Cloudflare Worker Free has its own request limits. This does not mean unlimited data/traffic, and it is subject to provider terms.

**Startup:** static assets are edge-hosted and do not wait for a sleeping web process. Room Durable Object may initialize on first contact or wake from hibernation, but there is no paid always-on instance. Real latency must be measured.

**Vercel correction:** Vercel Functions introduced WebSocket support in June 2026. However, new connections can land on distinct instances and cannot assume shared in-memory rooms. This complicates relay behavior vs per-room Durable Objects.

**Other permanent free alternatives:** Deno Deploy Free currently offers 20 GiB/mo egress; promising but finite PDF traffic budget. Render Free sleeps after 15 min inactivity and takes about a minute to wake.

**Manual deployment:** owner creates Cloudflare Workers Free account and authorizes Wrangler login/deploy. No paid plan, billing setup or custom domain needed. College Wi-Fi may still block WebSocket upgrades: HTTPS fallback remains on roadmap.

Official references: https://developers.cloudflare.com/durable-objects/platform/pricing/ | https://developers.cloudflare.com/durable-objects/best-practices/websockets/ | https://developers.cloudflare.com/workers/static-assets/ | https://vercel.com/changelog/websocket-support-is-now-in-public-beta | https://deno.com/deploy/pricing

### Implemented checkpoint — 16 October 2026

- [x] TypeScript/Node relay reference, ephemeral room creation, file metadata, host/student approval and binary range request protocol.
- [x] React classroom and phone UI, QR code, PDF.js range transport, basic navigation and loading UI.
- [x] Cloudflare Workers Free hosting config and hibernatable SQLite-backed `ClassroomRoom` Durable Object relay.
- [x] PDF.js worker `.mjs` served with correct JavaScript MIME on Node.
- [x] GitHub Actions automated TypeScript build, `wrangler deploy --dry-run`, protocol/Node integration tests, Chromium real PDF.js render against Node backend **and** local Cloudflare Durable Objects runtime.
- [ ] Publish to your free `workers.dev` URL (requires owner's Cloudflare login/deployment).
- [ ] Real phone on cellular data to smartboard on restricted college Wi-Fi, plus WSS-blocked HTTPS fallback.
- [ ] Benchmark first-page latency, random page jump, unusual and larger PDFs, mobile tab suspension, abusive clients and room persistence after hibernation.

**Tests passing is not the same as production readiness.** The browser smoke test uses one synthetic ~190KB single-page PDF in Chromium. PDF.js behavior on real scanned/large PDFs and multi-page jumps still needs measurement. Zero-cost is conditional on staying within Cloudflare Free limits.


## Independent presentation tabs — classroom queue enhancement

- [x] The main dashboard keeps the single authenticated host WebSocket and its full student/PDF queue.
- [x] A teacher selects **Present ↗** to open a PDF in a new browser tab; close it to return to the unchanged submission queue.
- [x] Presenter tab requests PDF byte ranges over a same-origin BroadcastChannel; the original dashboard forwards requests through its existing WebSocket. Presenter tabs never create another host socket.
- [x] Each presenter tab is scoped to one approved PDF and uses a temporary per-tab random channel key in the URL fragment (not sent to the server).
- [x] A browser integration test must open, render, close and reopen presentation tabs while verifying the host room and uploaded PDF remain present.

Limitations: **The host's original classroom tab must remain open.** Other tabs may be opened concurrently, but browsers can throttle background pages; use a modern desktop browser for smartboard presentation. Sender devices must still stay connected for uncached PDF pages. This first version shares the existing PDF viewer and still handles PDFs only, not native PPTX.

## Reliable document delivery — October 2026

Root issue: the UI previously listed a picked `File` immediately and called it uploaded even when the `file.offer` WebSocket frame had not been acknowledged. Host-side one-off announcements could also be missed after a network interruption or backgrounding. An open socket alone does not prove delivery.

- [x] Server responds with a `file.state` receipt and preserves approval when the same student retries `file.offer` (idempotent).
- [x] Student reconciles local File objects against server `file.manifest` after reconnect and periodically while visible; unacknowledged offers are resent.
- [x] Host `room.sync` restores the authoritative persisted document queue and current student list, on return to the tab or Refresh submissions.
- [x] Distinguish announcement pending from server-confirmed pending from approved; never label local selection as a complete upload.
- [x] PDF viewer shows a timeout/error and explicit retry rather than spinning forever when document bytes are unavailable.
- [ ] Validate the above against real mobile sleep and actual classroom network, and perform a long (5-15 minute) suspended-phone trial.

Comparison: `https://nologin.in/` (the service discoverable by research; `nologin.com` was not accessible) advertises full upload once, server-backed access from any device and default 48h expiry. No reliable open-source implementation link was found. This explains why sender closure does not affect NoLogin files. FlashView deliberately keeps byte-range PDFs on the sender for fast first-page delivery and zero object-storage costs. **It cannot load uncached pages while the sender browser is suspended or closed.** Future opt-in R2 staging, resumable uploads (tus.io protocol), and expiry policies need explicit cost/quota/privacy research, not promises.

References: https://nologin.in/ ; https://tus.io/faq.html ; https://developers.cloudflare.com/durable-objects/best-practices/websockets/ .


## Completed cache implementation (16 October 2026)

- [x] Room-scoped IndexedDB cache of original 64 KiB PDF byte chunks, shared across all presenter tabs on the classroom computer.
- [x] PDF.js receives cached byte ranges first, downloads missing ranges through existing Cloudflare WSS relay, deduplicates simultaneous misses, and retains chunks after the presenter tab closes.
- [x] After first successful page render, the classroom host downloads remaining PDF chunks in a modest parallel window; interactive page ranges take priority.
- [x] Progress displayed as unique cached bytes / original PDF size. Fully cached PDFs can be reopened even if the student's browser disconnects; no persistent cloud storage costs.
- [x] Fix 30s PDF.js watchdog destroying an already-open document; fix raster slide hiding from maxImageSize limit; guard asynchronous page render/cancel races; request upcoming page dependencies.
- [x] Explicit End Room dialog requires acknowledgement, closes presenter tabs, deletes only that room's locally cached PDF data (without deleting originals on student devices), and closes the room.
- [x] Refresh/accidental tab closure does not delete cache. Expired, abandoned rooms get cleaned up on a subsequent visit. Browser quotas/eviction can still remove local storage; privacy modes may disable IndexedDB.
- [ ] Physical-device test with large, scanned and image-heavy PDFs, slow networks and 15 simultaneous students (the supplied problematic file is not yet attached).
- [ ] Evaluate further JPEG2000/CMap decoder compatibility and per-file quality issues using failing document fixtures.

Privacy caveat: deletion removes browser-accessible IndexedDB records but does not guarantee forensic secure erasure. No promise of byte caching if browser storage is denied or full.
