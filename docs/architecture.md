# System architecture

**Status:** Worker ownership and the contributor sidebar are merged/live through PR #47. This branch adds opt-in OPFS rooms; normal rooms remain IndexedDB. See [OPFS validation](./opfs-cache-validation.md), [Transfer protocol](./transfer-protocol.md) and [Audit tracker](./reliability-audit.md) for release status and remaining work.

## Overview and ownership

```text
Sender browser(s)                       Relay                         Host browser
┌────────────────────────┐      ┌─────────────────────────┐      ┌───────────────────────────┐
│ React sender UI        │ WSS  │ Node / ws OR Cloudflare │ WSS  │ React classroom dashboard │
│ Transfer worker + File │◀────▶│ Workers + Durable Object│◀────▶│ Transfer worker + socket  │
│ Worker File.slice      │      │ Auth + metadata +       │      │ Scheduler + IndexedDB     │
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
| Worker transfer owner | [`relayWorker.ts`](../src/client/relayWorker.ts) | One socket, source reads, metadata-driven scheduling, cache writes and confirmed completion; independent of UI message consumption |
| Page/worker bridge | [`transferClient.ts`](../src/client/transferClient.ts), [`transferProtocol.ts`](../src/client/transferProtocol.ts) | Small commands/status, source File handles, bounded passive cache reads, session guards and bounded worker replacement |
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
| File metadata engine | [`roomFileEngine.ts`](../src/shared/roomFileEngine.ts) | Offers, terminal Stop, approval/reconnect/disconnect, completion/reset, immutable results, file revisions and persistence checkpoints; no byte packets or renderer work |
| Room metadata engine | [`roomEngine.ts`](../src/shared/roomEngine.ts) | Shared participant/host authority, private takeover, room revisions, and serialized atomic metadata saves |
| Client snapshot cursor | [`roomRevision.ts`](../src/client/roomRevision.ts) | Generation-scoped metadata ordering, equal-version effects, stale snapshot rejection and private resync |

## A file's journey

The host chooses automatic admission or approval only before creating a room.
Inside the room, pending requests retain Allow/Decline actions, but the admission
setting is not repeated. The "Shared by" list derives from retained file owners,
not live sockets: joining alone adds no row, and disconnecting or stopping a
shared original does not remove its owner. Pending/rejected offers alone do not
add contributors. Names remain distinct by owner ID even when display names
match; avatar/file colours share the same assignment, without pink swatches.
The host's connection indicator still reports its own relay status.

1. `POST /api/rooms` creates a room, code and secret tokens. Host connects over WebSocket, authenticates as `host`, and displays the QR/join link.
2. Sender authenticates using a six-digit code or opaque join token. If `autoApprove` is disabled, the host must admit the sender. Joining another room does not make a sender a host.
3. Sender validates selected file size (and PDF signature for `.pdf`), creates a file ID, then announces metadata with `file.offer`. The host can display it before any full-file transfer.
4. The host's `RoomPdfCache` automatically queues approved files and requests missing ranges; the relay authorizes and routes them to the correct sender. Sender replies with binary data.
5. Each verified range is split into the canonical **65,536-byte IndexedDB chunks**. The host updates the saved-byte count only after persistence succeeds. Completion is checked against stored keys before declaring **100%**.
6. On full completion, the host sends a completion notice to the relay; the relay informs that file's sender and receipts the host's notice. Intermediate byte progress stays local to the host.
7. A download builds validated browser-native `Blob` parts from stored chunks. The file is not reconstructed by the relay.

Version 3 rooms explicitly created with `?storage=opfs` instead use flushed OPFS
originals and a compact metadata/checkpoint database. Source/range digests and
persisted-content verification precede completion. Existing rooms retain their
original cache backend. See [the OPFS contract](./opfs-cache-validation.md).

### Host cache and scheduling

[`RoomPdfCache`](../src/client/pdf/roomCache.ts) is instantiated in the dashboard's dedicated transfer worker and outlives presenter tabs. Its IndexedDB database (`flashview-room-cache`) contains `chunks`, `rooms` and `previews` stores. Chunk keys include room, file ID and numeric index, allowing room-scoped deletion. Existing cached chunks are skipped when a transfer resumes.

The same worker entry runs in sender mode: it owns the socket, cloned browser
File handles and bounded asynchronous original reads. Original transfer packets
never cross the page/worker boundary. The page warms its idle worker before room
creation to overlap script loading with setup; warming opens no socket.
The page forwards focus/visibility/freeze
signals, commands and file selection; the worker independently handles
authentication, manifest repair, receipt scheduling and completion receipts.
One unacknowledged UI batch and at most 1024 coalesced pending events bound the
status mailbox; each file's progress is sampled at 350 ms with immediate
completion/correction. Optional performance records are sampled by metric in
this mailbox, so diagnostic sample counts are not wire-packet counts.

Passive cache operations have at most 128 pending RPCs and bounded deadlines.
Read buffers transfer ownership back to the page; they are separate from
original-byte scheduling. This is a transitional bridge for the existing
progressive PDF viewer; completed-only viewers and OPFS/integrity remain later
work. A worker cannot outlive a terminated parent page or guarantee that an OS
will keep it running in the background. See [MDN's worker lifecycle and API
description](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers).

Worker errors terminate the obsolete owner before replacement. Two automatic
restarts retain the private initial resume token, learned room generation and
browser File handles; new receiver workers rebuild committed IndexedDB indices.
Exhaustion/startup failure reports an explicit error, with no second UI transfer
implementation. End-room cleanup can delete cache directly only after a failed
worker has been terminated. Closing/reloading a sender page still loses its
selected File handles.
Stop removes the local source even while disconnected, retains the terminal
intent across worker replacement and retries it after private reconnect/sync.
Read attempts have a 15-second deadline and lose their slots/authority on
Stop or connection replacement; late native Blob results cannot send bytes.

Audit N37 records a measured Firefox limitation: under a ten-second parent-page
busy loop, worker timers ran but native File/WebSocket delivery still waited.
Chromium's independent receipt stress case and Firefox's bounded exact recovery
are separate criteria. Worker ownership removes application dependencies; it
does not guarantee every browser native subsystem is independent of page work.

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

New clients negotiate generation-based browser cache identity when creating a
room. The server pins its cache version and advertises `cacheId` on creation and
host sync; the host persists it and uses it for originals, previews, presenter
reads, exports and deletion. Reusing a six-digit join code does not reuse bytes.
Existing rooms and requests from older clients retain their code-based namespace
until they end; adopting lease credentials does not rename their cache. No live
data is deleted to migrate. See [the protocol](./transfer-protocol.md#browser-cache-identity)
and [Security and reliability](./security-and-reliability.md) for limitations.

## Node versus Cloudflare

Both adapters now use one file metadata engine. It reserves synchronously and
returns immutable transition results; Cloudflare persists before publishing
effects, then suppresses obsolete results if another transition superseded them.
A delayed offer reconciles to the latest file state instead of sending an old
approval. Duplicate completion still receipts a lost acknowledgment, duplicate
Stop remains terminal, and replay does not charge admission again. Legacy files
gain an optional metadata `revision` on their next real transition; room/cache
identity and the chunk schema are unchanged.

Persistence checkpoints advance only after a successful write. A duplicate
command after a failed save must still flush unsaved metadata before acknowledgment.
Approving a participant commits its session approval and affected legacy files
together. Shared `RoomEngine` now owns participant admission, names, private
capabilities, approval/rejection, takeover/disconnect and host-connection identity.
Adapters keep actual sockets, source creation guards, range tables and scoped
HTTP control I/O. Connections enter the engine only as opaque identities, never
file transports. Retired offline capabilities cannot regain their old ownership;
an open-admission room may still admit the holder as a new identity.

Every metadata mutation advances a room revision. Cloudflare atomically saves
files, private sessions, the join window and room revision under the existing
keys plus one additive key. A serialized/coalescing queue prevents old saves from
overwriting newer ones, and queued saves cannot recreate an ended generation.
No disk work is added to individual binary frames. The client accepts multiple
effects at one revision, rejects older snapshots, coalesces private resync, and
keeps host credential negotiation separate from stale list replacement. Foreign
or older terminal notices are rejected before they can stop socket recovery.
Legacy unstamped peers retain compatible behavior without the new ordering guarantee.
Cloudflare's default [storage gates](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
remain enabled. A resolved `put()` can mean buffered submission; the runtime
holds network output until flush and resets the object on write failure. The
checkpoint marks successful adapter submission and complements those gates; it
does not add a forced disk synchronization to each metadata command.

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

File/participant admission is shared between both relay adapters. A room retains
at most 300 new file manifests / 4 GiB of declared original sizes and 120 join
sessions, with the existing 30 concurrent sender and 10 files/person limits.
Budgets reserve before asynchronous persistence, include offline/stopped originals
and never double-charge exact retries. Existing records above a new budget are
preserved. These caps bound normal room growth, not the browser's available disk.
The 4 GiB budget leaves room for a 30-person, 50 MiB-per-person class (about
1.5 GiB); it is an application policy, not a browser or relay platform ceiling.
Pending authentication now has bounded slots/deadlines, and total transport
counts include closing sockets. Creation quotas persist per hashed source address
in separate prefixed objects within the existing Cloudflare namespace; they do
not store files or share room metadata. New-identity join quotas persist with
sessions, while authenticated private resumes and host/control operations bypass
that quota. One room alarm services both login deadlines and room expiry.
Node guards are process-local. Shared metadata commands/revision orchestration
are implemented; broader deployment abuse controls and physical-device proof
remain separate work.

No HTTP-only transport fallback or end-to-end file encryption is implemented. Sender tab suspension can halt uncached byte delivery. Large PPTX/PDF renderers still require significant host memory despite lower-copy download assembly. These are **known limitations**, not resolved by the room relay. Track verification in [the audit](./reliability-audit.md).
