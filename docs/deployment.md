# Deployment

FlashView needs a publicly reachable frontend, an API endpoint for room creation, and **WebSocket upgrades** for relay traffic. It does not require a file-storage bucket. See [Security and reliability](./security-and-reliability.md) before exposing a public instance.

## Node.js / self-hosting

**Requirements:** Node.js **22+**, npm, and HTTPS/WSS termination for public deployments.

```bash
npm install
npm run build
npm start
```

The Node process listens on `PORT` (default **3000**), serves `dist/` and upgrades `/ws` connections. A minimal [.env.example](../.env.example) illustrates:

```ini
PORT=3000
PUBLIC_ORIGIN=https://your-flashview.example
```

`PUBLIC_ORIGIN` is optional for local development but should be set to the exact external HTTPS origin behind a reverse proxy; the Node WebSocket endpoint checks `Origin`. Your proxy must preserve WebSocket `Upgrade` / `Connection` headers and forward requests to `/ws`, `/api/*` and the frontend. Do not serve a mixed HTTP page with an inaccessible WSS endpoint.

A [Dockerfile](../Dockerfile) is provided for container builds; it exposes port 3000. The Node implementation keeps **room state in process memory**. A server restart loses room metadata and active sender connections; a browser's own IndexedDB cache is separate.

Check the health endpoint:

```bash
curl http://localhost:3000/health
```

The Node endpoint returns JSON with `ok: true`.

## Cloudflare Workers + Durable Objects

The current [Wrangler configuration](../wrangler.jsonc) deploys:
- the Worker in [`src/cloudflare/index.ts`](../src/cloudflare/index.ts);
- `dist/` as static assets with SPA fallback;
- a SQLite-backed Durable Object class `ClassroomRoom` bound as `ROOMS`, using migration tag `v1`.

```bash
npm install
npx wrangler login
npm run deploy
```

For a local Cloudflare-style environment:

```bash
npm run dev:cloudflare
```

The Worker routes `POST /api/rooms`, `/ws?room=<code>` and static assets. Room/session/file **metadata** is stored in the Durable Object to survive hibernation; the **original file bytes are not saved** to Durable Object storage. The receiving computer's IndexedDB is the file cache.

No particular free-tier request allowance or hosting cost is guaranteed by this repository. Check [Cloudflare's current Workers](https://developers.cloudflare.com/workers/platform/pricing/) and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) before deployment, especially for sustained multi-user transfers.

## Production smoke checks

1. Verify `/health` loads through the public HTTPS URL.
2. Create a room and ensure the host WebSocket becomes authenticated; QR and six-digit code should appear.
3. Join from a **different connection** (cellular versus school or home Wi-Fi) and test approval on/off.
4. Transfer a general file and a PDF; verify the host receives the full file and can download it correctly.
5. Open a PDF while it is partially cached, then check PPTX/PPSX only after completion.
6. Drop/reconnect the sender network; ensure previously committed bytes are reused.
7. Test End room and local cache cleanup.
8. Observe room expiration and memory use with expected session load; CI does not replace production monitoring.

## Network and security considerations

- Public access requires **HTTPS and WSS**. Campus or corporate networks that block WebSocket upgrades are **not supported** by an HTTP-only fallback.
- A join code or link is a bearer capability for room membership (subject to approval); do not publish invitation links widely.
- The relay is trusted with document contents **in transit**, because end-to-end encryption is not implemented.
- The browser may evict locally cached data under storage pressure. Displayed completion must correspond to verified persisted chunks.
- Never store secret tokens in source, environment examples, screenshots or PR logs. Use provider secrets/account-level configuration.
- Scale and rate limits exist but are not a substitute for production abuse controls and real-device load tests.

## Rolling back

Both deploy targets accept normal source rollback/redeployment. **Do not promise an active transfer will survive a relay restart or incompatible protocol downgrade.** Roll back to a compatible commit and create a fresh classroom room when necessary. The host's local cache may remain until ended or cleaned, but sender source files must still be reachable to repair missing chunks.

See [Development and testing](./development.md) for CI and performance regressions.
