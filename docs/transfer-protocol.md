# Transfer and room protocol

**Status:** Implementation reference, version 1. Sources: [shared contracts](../src/shared/protocol.ts), [browser socket](../src/client/socket.ts), [Node relay](../src/server/index.ts), [Cloudflare relay](../src/cloudflare/index.ts). This is a contributor guide, **not** a separate public API compatibility promise.

## Transports and authentication

- `POST /api/rooms?autoApprove=1|0` creates a room and returns a room identifier, six-digit code, join token, **separate host secret**, immutable `roomGeneration` and restricted `leaseToken`.
- The browser connects to `/ws` (Cloudflare's routing adds `?room=<six-digit-code>`) and sends a JSON `hello` with `v: 1`, a role and the required room credentials.
- The socket is **connected** in the app only after the server acknowledges the room or student session, not merely after the TCP/WebSocket handshake.
- A host authenticates with `roomId` and `hostToken`; a sender joins with `code` or `joinToken` and can later resume with a `resumeToken`. A room code is not equivalent to the host secret.
- Relay enforces role, sender ownership, approval and range bounds. A sender can only serve its own files; other students do not receive the host's file list.

### Invitation entry

New QR/copied invitations use `/join/<code>#invite=<joinToken>`. The entry screen
asks for an optional name; neither rendering nor typing authenticates a sender.
Join submits the trimmed name, while Skip discards any typed text and uses the
existing `Student` fallback. Both paths retain the normal approval policy.

The browser replaces the URL with `/join/<code>` and retains the invitation in
that tab's history state. New invitation fragments are not part of HTTP paths,
queries or referrers. Legacy `?join=` links remain readable and are cleaned
after loading; their initial request still contains the old query. Plain clean
links use the existing six-digit-code admission. Both opaque Node tokens and
code-prefixed Cloudflare tokens remain supported.

After an explicit choice, history also retains the private resume identity and
chosen name. Refresh resumes without another prompt or a new participant.
Leave/end clears that entry. A new scan starts a fresh choice, and a supplied
invalid token never silently falls back to code admission. This adds no room
lookup request or change to original-byte transfer scheduling.

### Browser cache identity

The current client creates rooms with `POST /api/rooms?cache=2&autoApprove=1|0`.
Both relays pin `cacheVersion: 2` in the room configuration and return a host-only
`cacheId` of `generation:<roomGeneration>` in creation and every `room.state`.
The host stores that exact namespace in its saved session and uses it for chunks,
previews, completed-file exports, presenter metadata and cleanup. The six-digit
code remains a join/display identifier; a new room never searches an old code's
cache for missing bytes or previews.

Requests without `cache=2` retain the legacy code-based namespace. This preserves
rooms created by already-open older clients. Existing persisted Cloudflare rooms
without `cacheVersion` also keep that namespace, even when they acquire new lease
credentials. They advertise `cacheId: <code>`; old servers/sessions without a
`cacheId` fall back to the code. Existing data is drained in place, not copied,
renamed or erased to upgrade. This is namespace separation, not a content hash or
isolation from arbitrary same-origin scripts.

### HTTP lifecycle controls

Both adapters implement `POST /api/rooms/<roomId>/lease` and `/end` with
`Content-Type: application/json`, body `{ "roomGeneration": "<uuid>" }`, and a
Bearer capability. Actual body length is limited to 256 bytes. Present Origin
headers must match the configured/same origin; no cross-origin CORS grant is added.

- `/lease` accepts only the room's lease token and returns generation, `active`
  and server expiry. It cannot join as host, read original bytes, approve senders,
  or end a room. The dashboard and presenter each renew about once a minute;
  Cloudflare still throttles durable activity writes to five-minute intervals.
- `/end` requires the host token for the current generation. It removes room
  state before confirming `closed`. A repeated request for a generation that is
  no longer present returns `absent`, including if a short code now belongs to
  another generation. This reports absence, not historical command execution;
  it never authorizes mutation of that other room. Expired rooms cannot be revived.
- Missing/invalid capabilities are rejected. A valid-shaped capability with a
  nonmatching generation can receive absence confirmation, but no room access.
- The host persists close intent before sending, confirms remote closure, then
  clears local cache. Lost responses retain intent/credentials/bytes for retry;
  confirmed closure with failed local cleanup retains a separate cleanup task.
  Refresh resumes the recorded task. Legacy WebSocket `room.end` remains supported.

Host `room.state` includes generation and lease token so existing Cloudflare
sessions can obtain their new control fields after host authentication. Student
admission responses do not contain those fields. Presenter metadata carries only
the restricted lease identity, never the host/join credentials. No new original
file bytes travel over HTTP; this is not an HTTPS file-transfer fallback.

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
| `file.rejected` | Relay → sender | Admission failed; includes `fileId`, stable `code` and readable `message`; no manifest reserved |
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

On a recorded sender file-picker/background return, or a browser freeze or
network-restoration signal, the client starts one replacement connection
immediately. It does not first wait for an old-socket probe or close acknowledgement.
Trailing focus/pageshow/change events reuse that fresh connection attempt.
Ordinary focus preserves an authenticated connection and uses a two-second
liveness probe; switching a healthy receiver between dashboard and presentation
does not force reconnection. Document freeze/resume and persisted pagehide/pageshow
are handled alongside visibility and file-picker events. Repeated failed attempts
still use bounded exponential backoff; immediate initiation does not guarantee
instant authentication or data delivery on the network.

After sender resume, the relay sends the restored file manifest **before**
replaying that sender's still-outstanding `range.request` messages. Request IDs,
offsets and original deadlines stay unchanged, cancelled requests stay cancelled,
and duplicate/late binary replies cannot satisfy a different request. Receivers
retain committed chunks and release old network retry delays after authentication.

New senders generate their private 256-bit resume capability before the first
hello. Relays adopt a valid initial 64-character hexadecimal capability, making
the initial join retryable even when its acknowledgement is lost. This secret
must never be derived from a room code or shared with the host. Clients that
omit it still receive a server-generated capability as before.

A known sender can resume its authenticated session while the host is temporarily
offline. It receives its manifest/approval followed by `host.offline`, retaining
the page's File references until `host.online`. A new admission still requires
an online host. This does not recover files from a phone page the OS destroyed.

Socket replacement retires the old peer's authority before initiating its close
handshake; late control and binary messages are ignored. Receiver takeover clears
obsolete outstanding requests on both adapters so the new receiver can request
its missing chunks immediately.

Each sender range response is bound to the socket that requested it, before any
asynchronous file read starts. Success, backpressure failure and read errors from
an obsolete connection cannot be emitted on its replacement, even when the relay
replays the same request ID. Only the replacement's own response can complete it.

An explicit `file.revoke` records `revoked: true` with the existing `offline`
status, cancels the file's outstanding requests and discards late responses.
Reconnecting or replaying the offer cannot resume that file ID. Transient network
loss leaves `revoked` unset and remains recoverable. This optional field preserves
older clients' status contract; stops recorded before this marker existed cannot
be distinguished retroactively from a disconnection.

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
| Authentication wait | **10 s**; expired/invalid unauthenticated sockets lose authority and receive closure |
| Pending sockets | Cloudflare **64/room**; Node **256/process** |
| Total sockets including closing | Cloudflare **128/room**; Node **4,096/process** |
| Room creation | **120/source address/hour**; `429` with `Retry-After` |
| New sender identities | **120/room/minute**; private sender resumes and host authentication bypass this quota |
| Retained join sessions | **120** per room; existing private resume capabilities are not evicted |
| Retained room manifests | **300**, including completed, stopped and offline files |
| Aggregate original sizes | **4 GiB** per room, reserved at file admission |
| Individual range | At most **256 KiB** |
| Outstanding relay ranges | At most **48** per room |
| Range timeout | **20 s** on relay; client request timeout also bounded |
| Room lifetime | **2 hours** after host activity or a valid scoped lease renewal |
| WebSocket access | File bytes require WSS; HTTP lease/end controls do not provide a file-transfer fallback |

IDs, file lengths and sender identity must be checked on **both relay implementations**. The sender never chooses a different file owner just by writing a `fileId`. The relay does not execute uploaded bytes or reveal one student's file list to another.

Both adapters use [shared admission transitions](../src/shared/roomAdmission.ts).
Ownership and immutable metadata are checked before any replay can promote a
legacy pending file. New manifests reserve their full length synchronously,
before Cloudflare persistence yields. Exact replays do not reserve again and
remain valid at capacity, including for stopped files; replay never reverses a
terminal stop. Offline/completed/stopped records remain charged because the host
may still hold their original bytes. End room releases the room budget.

Admission denials return `file.rejected` with `code` and `message`. The current
sender stops re-offering that selection, releases its local selection slot and
shows the reason. Already-admitted files continue. Previously admitted rooms
above a new budget retain their data and exact replays; new admissions are
refused, without evicting or deleting originals. These application budgets do
not promise that a device has 4 GiB available; browser quota handling still applies.

New participants rejected by capacity receive `join.rejected` with a reason.
A known sender replacing its current socket keeps its place even at capacity.
A known but disconnected sender returning when all places are taken receives
`error` with `code: ROOM_ACTIVE_LIMIT, retryable: true`, followed by closure.
The client retains its private resume token and selected Files and retries with
bounded backoff. The 120-session cap affects new identities, not reconnects.

Host rejection retires sender authority and cancels outstanding ranges before
waiting for closure or persistence. Cloudflare also clears the serialized socket
attachment; late commands and original bytes are ignored. Cloudflare explicitly
replies to received close events, including in local emulation. See Cloudflare's
[close-handler contract](https://developers.cloudflare.com/durable-objects/api/base/#websocketclose):
the call is safe when the runtime already completed the handshake.

### Connection guards and quota state

Both adapters use [shared guards](../src/shared/connectionGuards.ts). Authentication
must finish within ten seconds; failed credentials or invalid unauthenticated
commands release the pending slot. Authentication errors cannot renew a room.
Existing authenticated senders/hosts are not disconnected by these quotas.
Under connection pressure a new upgrade can receive `503`; HTTP lease/end
commands remain available independently. Closing sockets are counted separately
because the platform owns final TCP teardown, which can outlast application
revocation. A malicious peer is not assumed to acknowledge Close promptly.

Cloudflare serializes pending deadlines into socket attachments and schedules
its one alarm for the earliest pending deadline or room expiry. Renewing the
room must not postpone pending cleanup; hibernation must not reset deadlines or
replace an already-due alarm. Late hello messages recheck their deadline even if
an alarm is delayed. Node uses bounded pending timers and a process socket cap.

New sender admission charges a fixed one-minute window only after room/capacity
checks; host rejection does not refund that quota. Sessions and their admission
window persist together on Cloudflare. `JOIN_RATE_LIMIT` is retryable and carries
`retryAfterMs`. The browser retains its resume capability/selected Files, honors
that deadline despite focus/online signals, and clears only its waiting notice
after admission. Successful authentication restores immediate foreground recovery.
Known private resumes/takeovers and HTTP control do not consume this window.

Room creation checks a fixed one-hour window per source address, anchored at
first use. The 120-room allowance provides headroom for shared campus/NAT
addresses; Node's previous 20/hour allowance is raised to the same policy. Node
uses the socket address, a bounded 4,096-bucket map, and never evicts active quota
state to admit another source. Node quotas reset when that process restarts.
Forwarded-for headers are not trusted. Cloudflare uses its edge-provided
`CF-Connecting-IP`, hashes the address into a `creation:<digest>` object name in
the existing namespace, and atomically persists a counter/reset time there.
This is private rate metadata, not anonymous identity or original-file storage.
No public route can address a prefixed object or its internal permit endpoint.
The creation window survives room End and isolate/process restart; its alarm
schedules cleanup, and expired windows reset on use even if cleanup was delayed.
No new object class/binding or migration is required. Creation rejects a foreign
Origin before charging a window. `Retry-After` is rounded up to seconds.
During a mixed-version rollout/rollback, only an internal guard endpoint `404`
uses legacy creation without this quota. Real denials/errors never take that
path. Creation responses expose `X-WarpView-Creation-Guard: enforced|legacy` for
release verification. Fully updated objects enforce the durable window.

These are admission/resource bounds, not comprehensive DDoS protection. A full
transport pool can delay a new handshake, including a reconnect; authenticated
connections and scoped HTTP controls retain their independent paths.

## Changing the protocol

File manifests may include `revision`, increased only for a real metadata
transition. Old records/clients can omit or ignore it. Completion progress and
receipts may include `fileRevision`; original byte packets are unchanged.
Offers, terminal Stop, legacy approval, temporary disconnect/private resume,
completion and explicit zero reset use the shared file engine. Retries preserve
the revision and budget. Cloudflare confirms the pending metadata checkpoint
before publishing success; replay after a failed write is not a saved-state
shortcut. Delayed effects are checked against current immutable state.
The shared room engine additionally stamps metadata effects/full snapshots with
`roomGeneration` and `roomRevision`. A single transition can have multiple
effects at the same revision; only lower revisions are stale. Revisions advance
for file/participant/host metadata, not for byte packets or heartbeats. Cloudflare
persists the revision with files, sessions and the join window in one checkpoint;
Node retains its normal process-local state. Old clients ignore additive fields,
and new clients continue to accept legacy unstamped rooms/servers.

Client list reconciliation rejects older snapshots and requests a fresh
`room.sync` (host) or private `file.sync` (sender). A sender snapshot includes
`approved`, `hostOnline`, `roomCode` and only that sender's files, including while
pending. This repairs a delayed join acknowledgment without exposing others'
manifests or losing selected Files. Valid explicit zero corrections retract old
Done progress; stale resets cannot rewind a newer revision. Foreign/older
terminal notices cannot disable the socket's private recovery. An old list cannot
replace a newer one, while same-generation host capability negotiation still runs.

Update the shared encoder/types, **both** [Node](../src/server/index.ts) and [Cloudflare](../src/cloudflare/index.ts) handlers, browser sender/receiver, protocol and browser regression tests, then this guide. Make completion changes carefully: false Done acknowledgments are data-integrity bugs. See [Development and testing](./development.md).
