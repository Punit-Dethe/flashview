# FlashView

**From your phone, onto the big screen.**

FlashView is a lightweight, browser-based file sharing and presentation tool. Start a room on your computer, invite people with a QR code or room code, and receive files from their phones or laptops—no accounts, cables, or cloud drive links.

Files pass through a WebSocket relay and are cached **on the receiving computer**, not uploaded to permanent cloud file storage. Once a file is fully cached, you can download it even after the sender leaves.

## Features

- **Share without signing in.** Create a room, scan the QR code, or enter a six-digit room code.
- **Transfer any file type.** Up to **200 MiB per file** and **10 files per sender** in a room.
- **See what's arriving.** File cards show sender information, file type, local download progress, and supported thumbnails.
- **Present PDFs and PowerPoint.** PDFs offer an early first-page preview; **PPTX/PPSX** can be presented once fully cached. Other files are available to download.
- **Keep transfers moving.** Viewing a document is separate from the background transfer scheduler, so presenting doesn't start a duplicate download.
- **Recover from interruptions.** Chunk caching, reconnects, missing-data repair, storage retries, and a manual recovery action when browser storage stays full.
- **Choose who joins.** Optional host approval for new participants and an explicit end-room action.

## How it works

```text
  Sender (phone or laptop)       FlashView relay       Host (computer)
  ┌──────────────────────┐     ┌─────────────────┐   ┌──────────────────────┐
  │ Selects a local file │◀───▶│ Routes messages │◀─▶│ Receives byte ranges │
  │ Serves byte ranges   │ WSS │ and file bytes  │WSS│ Caches in IndexedDB  │
  └──────────────────────┘     └─────────────────┘   │ Downloads / presents │
                                                     └──────────────────────┘
```

1. The **host** creates a room and shares its QR code or invitation link.
2. A **sender** joins and selects files. Their names appear on the host before the entire transfer finishes.
3. The host's browser requests file ranges through the relay and saves them to its local **IndexedDB** cache.
4. The host can download a completed file or open a supported presentation. After the full file is cached, the sender no longer needs to stay connected.

The relay forwards file data in transit; it does **not** act as permanent file storage. This is not a direct peer-to-peer or end-to-end encrypted transfer system.

## Get started

You'll need **Node.js 22+** and npm.

```bash
git clone https://github.com/Punit-Dethe/flashview.git
cd flashview
npm install
npm run dev
```

Open **http://localhost:5173** and choose **Create a room**. Open the site in a second browser window, select **Join a room**, and enter the six-digit code to try the sender experience.

The Vite development frontend runs on port **5173** and proxies `/api` and `/ws` to the local Node relay on port **3000**.

> **Using a real phone?** A `localhost` invitation won't work across devices. Use an HTTPS deployment or an HTTPS tunnel exposing the development site. Both devices must be able to reach the website and its WebSocket endpoint.

### Run the production Node server

```bash
npm run build
npm start
```

The Node server serves the built frontend and the WebSocket relay on `PORT` (default: **3000**). For a public deployment, use HTTPS/WSS, support WebSocket upgrades at your reverse proxy, and configure `PUBLIC_ORIGIN` as appropriate. See [`.env.example`](./.env.example).

## Deploy with Cloudflare

FlashView also supports **Cloudflare Workers and Durable Objects**. A Durable Object manages each room's session and WebSocket connections; original file bytes are still held by the sender and locally cached by the host, not saved as cloud files.

```bash
npm install
npx wrangler login
npm run deploy
```

This builds and deploys the frontend and Worker using [`wrangler.jsonc`](./wrangler.jsonc). Cloudflare account setup, plan limits, and any charges depend on your account.

To test the Cloudflare implementation locally:

```bash
npm run dev:cloudflare
```

## Architecture

| Path | Responsibility |
| --- | --- |
| `src/client/` | React interface, room flow, document cards, and browser WebSocket client |
| `src/client/pdf/` | PDF.js viewer, IndexedDB chunk cache, transfer scheduler, and storage recovery |
| `src/client/pptx/` | PowerPoint inspection, slide thumbnails, and presentation |
| `src/server/` | Node.js HTTP/WebSocket relay |
| `src/cloudflare/` | Cloudflare Worker and Durable Object relay |
| `src/shared/` | Shared message protocol, file types, and transfer limits |
| `tests/` | Unit, integration, browser, and throughput tests |

**Built with:** TypeScript, React, Vite, WebSockets, IndexedDB, Mozilla PDF.js, a client-side PowerPoint viewer, Node.js, and Cloudflare Workers.

## Development and testing

```bash
npm test                       # Unit and protocol tests
npm run build                  # Type-check and build the frontend
npm run check:cloudflare       # Cloudflare deployment dry run
npm run test:browser           # Chromium browser tests
npm run test:browser:cloudflare # Cloudflare-backed browser tests
npm run bench:baseline         # Synthetic transfer benchmark
```

Browser tests require Playwright browser dependencies. The [CI workflow](./.github/workflows/ci.yml) also runs Firefox compatibility checks and transfer-performance comparisons.

For the current engineering status, see the **[Reliability Audit Tracker](./docs/reliability-audit.md)**. It documents completed fixes, partially resolved problems, open work, and links to the relevant changes. For the deeper technical background, see [`plan.md`](./plan.md).

## Privacy and limitations

- **No accounts or permanent cloud file storage doesn't mean end-to-end encryption.** The relay can access file bytes while forwarding them. FlashView is not intended for confidential files without evaluating that trust boundary.
- **Keep the sender browser open until completion.** Mobile operating systems may suspend background tabs; data not yet cached by the host won't remain available if the sender's page stops running.
- **Files are saved in the host browser.** IndexedDB quotas, private browsing, and clearing site data can affect cached files. Ending a room clears its associated local cache. Don't clear site data during an active transfer.
- **Preview support depends on file type.** An early PDF preview is best-effort, PowerPoint playback requires the completed file, and other types are download-only.
- **WSS connectivity is required.** There is currently no HTTP-only fallback for networks that block WebSocket upgrades.
- **No fixed performance guarantee.** Transfer rates depend on both networks, the browser, and the sending device. Large-file memory use and real-device reliability are still being improved.

## License

A project license has **not** been selected yet. The source is visible, but an open-source reuse license has not been granted. Dependencies retain their own licenses.
