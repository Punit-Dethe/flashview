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
