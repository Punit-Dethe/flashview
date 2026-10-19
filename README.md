# FlashView

**From your phone, onto the big screen.**

FlashView is a browser-based file sharing and presentation tool. Create a room, invite others with a QR code or six-digit room code, and receive files from their devices—no accounts or cloud drive links required.

Files travel through a WebSocket relay and are cached **in the receiving browser**, rather than uploaded to permanent cloud file storage.

## What you can do

- **Share files across networks** without signing in (up to **200 MiB per file** and **10 files per sender**).
- **See incoming files** and their local transfer progress.
- **Present PDFs** with an early first-page preview when possible.
- **Present PPTX/PPSX** after the full file has arrived, or **download any supported transfer**.
- **Choose whether participants need approval** and end the room when finished.
- **Resume interrupted transfers** where possible using locally saved file chunks.

## Try it locally

Requires **Node.js 22+** and npm.

```bash
git clone https://github.com/Punit-Dethe/flashview.git
cd flashview
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173), create a room, then join it in a second browser window. To join from a physical phone, use an HTTPS deployment or tunnel: a `localhost` QR link cannot reach a different device.

## Documentation

All current engineering documentation lives under **[`docs/`](./docs/README.md)**.

| Guide | What it covers |
| --- | --- |
| [Architecture](./docs/architecture.md) | Components, browser/relay responsibilities, data flow, presentation and caching |
| [Transfer protocol](./docs/transfer-protocol.md) | WebSocket authentication, control messages, binary packets, progress and limits |
| [Development & testing](./docs/development.md) | Setup, scripts, codebase navigation, CI, reproducible tests and profiling |
| [Deployment](./docs/deployment.md) | Self-hosted Node and Cloudflare Workers / Durable Objects |
| [Security & recovery](./docs/security-and-reliability.md) | Threat boundaries, browser storage, failure handling and operational checks |
| [Reliability audit tracker](./docs/reliability-audit.md) | What is fixed, partly fixed and still pending, with PR evidence |
| [Historical engineering plan](./docs/archive/initial-engineering-plan.md) | Original planning notes; **not** the current specification |

## Important limitations

A sender's browser must stay available until the host has **fully cached** the file. Mobile operating systems may suspend tabs. The relay can access bytes in transit: FlashView is **not end-to-end encrypted**, and it does not provide long-term cloud file storage. Browsers also impose storage and memory limits; PDF previews, PPTX rendering and transfer speed vary by file and device.

## License

A project license has **not** been selected yet. Public source availability does not grant an open-source reuse license; dependencies retain their own licenses.
