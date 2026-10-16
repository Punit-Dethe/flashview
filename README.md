# FlashView

**Instant PDF presentation across devices.** A teacher opens a room on a smartboard, a student scans its QR code from their phone, chooses a PDF, and the teacher can view its pages without waiting for the entire file to upload.

[Read the full technical roadmap and design decisions](./plan.md).

## Architecture

- One TypeScript/Node server with `ws`: ephemeral classroom rooms, join approval, PDF metadata announcements, and binary WebSocket byte-range relay.
- React + Vite browser UI: QR pairing, host document review, mobile file selection, and presentation controls.
- Mozilla PDF.js `PDFDataRangeTransport`: requests PDF byte ranges from the student's browser via the server, not a full-file upload before opening.
- No permanent cloud file storage or database. The sender **must remain online**; the server **can access relayed document bytes** (not end-to-end encrypted).
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

## Limitations / work remaining

- PDF range loading works as a designed transport interface but must be validated end-to-end with real PDF fixtures, browsers, and physical phones.
- Student tab suspension/phone lock may interrupt streaming. Keep the sender tab open.
- No HTTP-only fallback when firewalls block WebSocket upgrades yet.
- Data is not encrypted end-to-end; do not use with confidential PDFs.
- Session/room data is transient. Restarting the server loses rooms.
- Large or unusual PDFs may need multiple noncontiguous ranges before page 1 can render.
- Host can approve student connections and each submitted document; high-traffic production abuse controls need additional work.

## Why not fork PairDrop or Holo?

PairDrop's complete WebRTC/TURN infrastructure is unnecessary for our firewall-friendly server relay design. Holo is closer conceptually, but mixing its Go relay and larger Next.js frontend would require rewriting the central file protocol anyway. FlashView's small, all-TypeScript implementation keeps a custom PDF.js range-request protocol easy to reason about and optimize.

## License

Project license has not yet been chosen. External dependencies retain their respective licenses.

## Production deployment

A public HTTPS deployment is required for students on mobile data and college smartboards to share a room. The repository includes a multi-stage `Dockerfile` and `railway.json` for Railway or an equivalent always-on container host.

1. Connect this GitHub repository to the hosting provider (Railway is one reasonable option).
2. Deploy the Dockerfile as a web service and obtain its public HTTPS domain.
3. Set the service environment variable `PUBLIC_ORIGIN` to that exact HTTPS origin (without a trailing path), e.g. `https://flashview.example.app`. The service honors the provider's `PORT`.
4. Check `/health`, then open the website on the smartboard and scan its QR code from a phone on **mobile data**.

**Security boundary:** The hosted server has no end-to-end PDF encryption and should not be used with sensitive documents. Enable the campus firewall's outbound HTTPS access to the domain and verify WebSocket upgrades. If WSS is blocked, an ordinary HTTP fallback is still a future milestone.

