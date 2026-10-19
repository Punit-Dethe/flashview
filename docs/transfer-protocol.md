# Transfer and room protocol

**Status:** Implementation reference, version 1. Sources: [shared contracts](../src/shared/protocol.ts), [browser socket](../src/client/socket.ts), [Node relay](../src/server/index.ts), [Cloudflare relay](../src/cloudflare/index.ts). This is a contributor guide, **not** a separate public API compatibility promise.

## Transports and authentication

- `POST /api/rooms?autoApprove=1|0` creates a room and returns a room identifier, six-digit code, join token and a **separate host secret**.
- The browser connects to `/ws` (Cloudflare's routing adds `?room=<six-digit-code>`) and sends a JSON `hello` with `v: 1`, a role and the required room credentials.
- The socket is **connected** in the app only after the server acknowledges the room or student session, not merely after the TCP/WebSocket handshake.
- A host authenticates with `roomId` and `hostToken`; a sender joins with `code` or `joinToken` and can later resume with a `resumeToken`. A room code is not equivalent to the host secret.
- Relay enforces role, sender ownership, approval and range bounds. A sender can only serve its own files; other students do not receive the host's file list.

## Control messages

Control messages are UTF-8 JSON over WebSocket and include `{ "v": 1, "type": "..." }`. Important implemented messages:

| Message | Direction | Purpose |
| --- | --- | --- |
| `hello` | Both clients → relay | Authenticate a host or sender |
| `room.state`, `room.sync` | Relay → host, host → relay | Rehydrate authoritative room and file state after reconnect |
| `join.accepted`, `join.pending`, `join.resumed`, `join.rejected` | Relay → sender | Admission and resume result |
| `student.pending`, `student.updated`, `student.left` | Relay → host | Participant roster changes |
| `student.accept`, `student.reject` | Host → relay | Admission decisions |
| `file.offer` | Sender → relay | Announce `fileId`, `name`, `size`; relay checks limits |
| `file.announced`, `file.updated` | Relay → host | File manifest and status updates |
| `file.state`, `file.approved`, `file.manifest` | Relay → sender | Confirm/replay that sender's file manifests |
| `file.sync`, `file.revoke` | Sender → relay | Reconcile or stop serving an offered file |
| `range.request` | Host → relay → sender | Request missing half-open byte interval `[begin, end)` |
| `range.cancel` | Host → relay | Drop a pending request |
| `range.error` | Sender / relay → host | Request-specific failure (invalid, timed out, offline, congested) |
| `preview.chunk` | Sender → relay → host | Small optional PDF first-page JPEG, split into text frames |
| `cache.progress` | Host → relay → owning sender | **Full-file** completion notice (or explicit zero correction); not a per-chunk progress stream |
| `cache.progress.receipt` | Relay → host | Idempotent receipt for completion |
| `heartbeat.ping`, `heartbeat.pong` | Client ↔ relay | Connection liveness |
| `host.online`, `host.offline`, `room.closed` | Relay → sender / participants | Availability and lifecycle |
| `room.end` | Host → relay | Close the room |

The relay's role is message validation and **routing**, not processing or retaining the original document.

## Binary file data

Byte payloads use a compact frame built by `encodeRangePacket`:

```text
+-------------------+----------------------+--------------------------+
| 2-byte BE length  | UTF-8 JSON header    | raw file-range bytes     |
+-------------------+----------------------+--------------------------+
```

The header encodes:

```json
{"type":"range.data","requestId":"<id>","fileId":"<id>","begin":0}
```

The header-length limit is **2,048 bytes**, and the payload for one request is bounded by `MAX_RANGE_BYTES = 256 * 1024`. The relay checks that a response matches an outstanding request's ID, sender, file, begin offset and exact requested length before forwarding it. Messages are **binary**, not base64-encoded file payloads.

For persistent storage, the receiver splits a range reply into **64 KiB chunks**. One network packet can span up to four storage chunks; packet size and cache block size are intentionally independent. The current default network packet grouping is **256 KiB** (`?packet=128` or `?packet=64` are experimental fallback configurations).

## Transfer state and completion

```text
file.offer → file.announced → missing range requests → binary range.data
                                  ↓
                           host IndexedDB commits
                                  ↓
                         all keys verified / complete
                                  ↓
                 cache.progress(full size) → owning sender Done
                                  ↑
                        cache.progress.receipt
```

Only bytes successfully **persisted** by the receiving browser count as complete. The UI may retract a stale `100%` status if a previously stored chunk is missing. In that case the host sends `cache.progress` with `snapshot: true, bytes: 0` so the sender does not keep an incorrect Done state.

Host completion notices are idempotent: if a receipt is lost, replaying a notice is safe. Ordinary intermediate progress is intentionally **local** to the host browser and is not stored in the Cloudflare Durable Object for every chunk.

## Safety limits and protocol invariants

| Setting | Implementation |
| --- | --- |
| File size | 1 byte–**200 MiB** per file |
| Sender manifest cap | **10** files per sender in a room |
| Room students | **30** concurrent students per room |
| Individual range | At most **256 KiB** |
| Outstanding relay ranges | At most **48** per room |
| Range timeout | **20 s** on relay; client request timeout also bounded |
| Room lifetime | **2 hours** after most recent authenticated host activity |
| WebSocket access | HTTPS/WSS for public usage; no HTTP-only fallback |

IDs, file lengths and sender identity must be checked on **both relay implementations**. The sender never chooses a different file owner just by writing a `fileId`. The relay does not execute uploaded bytes or reveal one student's file list to another.

## Changing the protocol

Update the shared encoder/types, **both** [Node](../src/server/index.ts) and [Cloudflare](../src/cloudflare/index.ts) handlers, browser sender/receiver, protocol and browser regression tests, then this guide. Make completion changes carefully: false Done acknowledgments are data-integrity bugs. See [Development and testing](./development.md).
