# System architecture

**Status:** Current source design, including the unmerged relay-lifecycle changes (19 October 2026); production deployment is tracked separately. For wire-level behavior see [Transfer protocol](./transfer-protocol.md); for current unresolved reliability work see [Audit tracker](./reliability-audit.md).

## Overview and ownership

```text
Sender browser(s)                       Relay                         Host browser
┌────────────────────────┐      ┌─────────────────────────┐      ┌───────────────────────────┐
│ React sender UI        │ WSS  │ Node / ws OR Cloudflare │ WSS  │ React classroom dashboard │
│ Original File objects  │◀────▶│ Workers + Durable Object│◀────▶│ RoomPdfCache (scheduler)  │
│ File.slice(range)      │      │ Auth + metadata +       │      │ IndexedDB 64 KiB chunks   │
│ Best-effort PDF JPEG   │      │ bounded range forwarding│      │ Local file download       │
└────────────────────────┘      └─────────────────────────┘      └────────────┬──────────────┘
                                                                            │ BroadcastChannel
                                                                            ▼
                                                                   /present browser tab
                                                                   PDF.js or PPTX viewer
                                                                   (passive cache reader)
```

**Three responsibilities are deliberately separate:**

1. **Sender** owns the original browser `File`. It responds to validated range requests using `File.slice(begin, end).arrayBuffer()`; it does not upload a permanent copy to the relay.
2. **Relay** authenticates room participants, checks ownership and range bounds, forwards short binary frames and maintains room/file/session metadata. It is not a persistent file-storage service and can inspect traffic in transit.
3. **Host** owns the background byte transfer, IndexedDB cache, progress, downloads, and presentation tabs. The presenter never opens another host WebSocket or requests additional sender data itself.

## Code map

| Component | Source | Responsibility |
| --- | --- | --- |
| Room UI | [`App.tsx`](../src/client/App.tsx) | Create/join/approve/end flows, file pickers and host cards |
| WebSocket client | [`socket.ts`](../src/client/socket.ts) | `hello` handshake, reconnect, heartbeat, binary range requests |
| Room controls | [`client/roomControl.ts`](../src/client/roomControl.ts), [`shared/roomControl.ts`](../src/shared/roomControl.ts) | Restricted lease renewal, generation-scoped close authorization and recoverable end/cleanup |
| Transfer/cache | [`roomCache.ts`](../src/client/pdf/roomCache.ts) | Host-only IndexedDB, prefetch scheduler, downloaded chunks, failure recovery |
| Transfer windows | [`adaptiveWindow.ts`](../src/client/pdf/adaptiveWindow.ts), [`networkPacket.ts`](../src/client/pdf/networkPacket.ts) | Adaptive per-file concurrency, grouping missing 64 KiB blocks |
| Tab bridge | [`presentation.ts`](../src/client/presentation.ts) | `BroadcastChannel` metadata, local range reads and cancellation |
| Presentation entry | [`Presenter.tsx`](../src/client/Presenter.tsx) | Selects PDF or PPTX/PPSX presentation |
| PDF viewer | [`Viewer.tsx`](../src/client/pdf/Viewer.tsx) | PDF.js, partial-cache range transport, fallback to completed local file |
| PowerPoint | [`PowerPointPresenter.tsx`](../src/client/pptx/PowerPointPresenter.tsx) | Local OOXML inspection and slide viewer after full download |
| Node relay | [`src/server/index.ts`](../src/server/index.ts) | HTTP, WebSocket upgrades, in-memory rooms and bounded forwarding |
| Cloudflare relay | [`src/cloudflare/index.ts`](../src/cloudflare/index.ts) | Worker routes, per-room Durable Object, hibernation and room metadata |
| Shared contracts | [`src/shared/`](../src/shared/) | File manifests, binary encoding, limits, liveness and backpressure |

## A file's journey

1. `POST /api/rooms` creates a room, code and secret tokens. Host connects over WebSocket, authenticates as `host`, and displays the QR/join link.
2. Sender authenticates using a six-digit code or opaque join token. If `autoApprove` is disabled, the host must admit the sender. Joining another room does not make a sender a host.
3. Sender validates selected file size (and PDF signature for `.pdf`), creates a file ID, then announces metadata with `file.offer`. The host can display it before any full-file transfer.
4. The host's `RoomPdfCache` automatically queues approved files and requests missing ranges; the relay authorizes and routes them to the correct sender. Sender replies with binary data.
5. Each verified range is split into the canonical **65,536-byte IndexedDB chunks**. The host updates the saved-byte count only after persistence succeeds. Completion is checked against stored keys before declaring **100%**.
6. On full completion, the host sends a completion notice to the relay; the relay informs that file's sender and receipts the host's notice. Intermediate byte progress stays local to the host.
7. A download builds validated browser-native `Blob` parts from stored chunks. The file is not reconstructed by the relay.

### Host cache and scheduling

[`RoomPdfCache`](../src/client/pdf/roomCache.ts) is instantiated in the classroom dashboard and outlives presenter tabs. Its IndexedDB database (`flashview-room-cache`) contains `chunks`, `rooms` and `previews` stores. Chunk keys include room, file ID and numeric index, allowing room-scoped deletion. Existing cached chunks are skipped when a transfer resumes.

- **64 KiB** is the persistent chunk unit; network packets group **up to 256 KiB** by default (128 KiB and 64 KiB available for A/B comparison). Packet size does not alter the persistent schema.
- The scheduler rotates across queued files, with up to **16 global in-flight range requests**. Each file starts with a window of **6** and adapts between **2–10**. Temporary failure backs off the affected file, not the whole room.
- A bounded **48 MiB** in-memory LRU reduces repeated IndexedDB reads, but **IndexedDB**, not the LRU, is the source of truth for completion.
- Progress bookkeeping uses an incremental persisted-byte counter rather than summing all previous indices on every chunk. The final persisted-key verification detects missing chunks, retracts false completion, and queues repair.
- IndexedDB operation deadlines and per-file retries handle stalled reads/writes. Repeated confirmed `QuotaExceededError` pauses only affected files, exposing **Retry saving** on the host.

### Separate presentation path

The host opens `/present#<generated-key>`, then communicates using a same-origin `BroadcastChannel`. The presenter asks the **host cache** for bytes and listens to progress and preview events. It never controls transfer priority or creates a second room socket.

Presentation opens through a blank same-origin tab: copied `flashview-host`
session credentials are removed and the opener detached before loading renderer
code. The bridge supplies only a restricted lease identity for server liveness.
The arbitrary two-hour bridge cutoff is removed; explicit tab/room teardown
still cancels reads and closes channels. This does not yet implement full renderer
storage isolation or independence from a terminated dashboard.

- **PDF:** PDF.js can consume whichever cached ranges are already present; an early first-page JPEG is only a visual placeholder. Once fully cached, the viewer can load the complete local PDF buffer. A visible page may still depend on distant PDF structures even at a high transfer percentage.
- **PPTX/PPSX:** waits until the complete file is cached, then loads the local OOXML bytes into `pptx-vanilla-viewer`. `.ppt` and other general formats are download-only.
- A viewer tab can be closed without deleting the room cache or interrupting the background scheduler.

## Room lifetime and cleanup

Room sessions have a **two-hour renewable idle lifetime**. Host activity or a
restricted HTTP lease renewal extends it. The dashboard and presenter each own
a bounded renewal loop, including while the dashboard is hidden; sender picker
heartbeat behavior remains unchanged. Browsers can still suspend or terminate
all involved pages, so client timers are not an indefinite liveness guarantee.

Explicit **End room** records intent in session storage, stops transfer work,
confirms server closure, then clears only that room's local chunks and previews.
Cloudflare deletes its state before announcing closure. HTTP retries are scoped
to an immutable generation, so a reused short code cannot make an old end command
close a new classroom. Unconfirmed closure retains local bytes; failed local
deletion retains its cache handle and confirmed-closure state for retry, including
after refresh. Cleanup operations have a bounded IndexedDB deadline. Sender source
files are never deleted. Expired local cache cleanup still occurs on later visits.

Local cache keys still use the existing room-code identity; migration to immutable
generation keys remains part of the cache work. Server generation safety should
not be mistaken for completion of that separate storage migration. See
[Security and reliability](./security-and-reliability.md) for cleanup limitations.

## Node versus Cloudflare

Both relay implementations handle compatible messages but differ operationally:

| | Node baseline | Cloudflare deployment |
| --- | --- | --- |
| Room management | Process-memory map | Per-room Durable Object |
| Metadata persistence | Lost on process restart | Room/session/file metadata in DO storage for hibernation |
| Original file bytes | Routed only, not stored | Routed only, not stored |
| Asset serving | Built `dist/` from Node | Worker static assets |
| Lifetime | Host activity and room sweep | Activity and DO alarms |
| Deployment | `npm start` behind HTTPS reverse proxy | `wrangler deploy` |

See [Deployment](./deployment.md) for configuration and verification. Real-network speed depends on both endpoints and the relay; the design does not guarantee any particular throughput.

## Known architectural limits

No HTTP-only transport fallback or end-to-end file encryption is implemented. Sender tab suspension can halt uncached byte delivery. Large PPTX/PDF renderers still require significant host memory despite lower-copy download assembly. These are **known limitations**, not resolved by the room relay. Track verification in [the audit](./reliability-audit.md).
