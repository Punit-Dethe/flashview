# Security, storage and reliability

The worker described below is live for user-authorized reproduction of the N38
speed outlier. The outlier remains unexplained; deployment does not resolve it.
See [worker validation](./relay-worker-validation.md) for versions and rollback.

Relay transfer now runs in one dedicated worker per sender/host page. Workers
own socket authentication, File reads, scheduling and cache writes; original
transfer buffers do not pass through React. This is scheduling isolation, not
a new origin/security boundary. Renderer isolation and completed-file reader
leases remain roadmap work. Bounded worker replacement retains capabilities
and File handles and rebuilds committed cache. Aborted requests cannot regain
source authority after Stop. See [worker validation](./relay-worker-validation.md).

This document describes **current boundaries and recovery behavior**, not a security certification. See [Transfer protocol](./transfer-protocol.md) and the living [30-issue reliability audit](./reliability-audit.md) for evidence and unresolved work.

## Trust boundaries

The gated OPFS integration adds integrity checks and a sealed-file reader/cleanup
boundary without introducing cloud object storage. It is not the normal default
and does not encrypt bytes or authenticate content against a malicious relay.
See [the exact guarantees and limits](./opfs-cache-validation.md).

| Component | Access and obligations |
| --- | --- |
| Sender browser | Holds the original selected `File` object; sends requested byte slices and optional PDF preview |
| Relay | Knows room membership and file metadata, validates requests and **sees file bytes in transit** |
| Host browser | Receives and persists original bytes in local IndexedDB; can download and present received files |
| Presentation tab | Reads through same-origin host `BroadcastChannel` and local cache; copied host session removed before loading; only a restricted server lease capability, no host relay socket |

- FlashView has **no accounts**, no direct peer-to-peer transfer and **no end-to-end encryption**. Do not describe it as suitable for confidential documents without a separate threat review.
- Joining via QR/link or six-digit code is not a grant of host privileges. Host authentication requires a separate high-entropy secret; student approval can be enabled per room.
- Node enforces WebSocket Origin checks, Cloudflare checks the request Origin, and both relays validate role, room, ownership, range bounds and size limits. Neither relay should execute content from uploaded files.
- A document's extension only determines safe display options; arbitrary transferred bytes must not be interpreted as executable markup by the host.

## Where data resides

1. **Source:** Original file stays on the sending device until its browser context releases it.
2. **In flight:** Bytes travel as bounded WebSocket binary frames through the relay, which need not store whole files.
3. **Receiver:** IndexedDB database `flashview-room-cache` stores 64 KiB chunks indexed by room/document, optional JPEG previews and local room-expiry data. A bounded memory LRU accelerates reads.
4. **Metadata:** Node uses an in-memory room map. Cloudflare Durable Objects persist **room, session, file manifests and completion metadata** to survive hibernation. This is *not* persistent original-file storage.
   Shared room revisions, private sessions, file metadata and the admission
   window now save atomically through an ordered metadata queue. Client
   snapshots are generation-scoped and stale lists/terminal notices are rejected.
   A pending participant can sync only their own metadata and approval state.
   Creation protection also keeps a counter/reset time under a hashed source
   address key for its one-hour window, independently of End room. Cleanup is
   scheduled at window expiry; an expired counter is ignored on reuse. The
   source key is pseudonymous, not anonymized. No raw address is written into
   application quota state; hosting-platform request processing/logging is separate.
5. **Deletion:** Ending a room records intent and confirms relay closure before deleting local chunks/previews. Credentials are retained until cleanup succeeds. Failed/uncertain closure and failed local deletion are separate retryable outcomes, restored on refresh. Browser expiration cleanup occurs on later visits; site-data erasure and disk-forensic erasure are **not** the same thing.

## Expected failure and recovery behavior

| Condition | Implemented handling | Remaining limitation |
| --- | --- | --- |
| Short disconnection / host reconnect | Session-aware `hello`, resume and manifest sync; sender retains `File` references while page stays alive | OS may kill the tab entirely |
| Stalled or expired range | Bounded timeouts and per-file backoff; missing requests can be retried | A domain that blocks WSS cannot relay |
| Lost completion receipt | Idempotent full-file completion notice; replays until receipt | Only persisted-byte complete counts as Done |
| Missing saved chunk | Cross-check IndexedDB keys when claiming 100%; retract stale completion, invalidate that memory copy and re-fetch missing bytes | Sender needs to remain available for missing ranges |
| IndexedDB request hangs | Timeouts/abort attempts and retryable index lookup; affected file isolated from healthy peer transfers | Browser timer suspension may delay deadlines |
| Temporary write failure | Retain the failed original chunk; retry persisting it without reuploading | Browser may have permanently exhausted its quota |
| Repeated confirmed full quota | Pause only affected file; show host **Retry saving** after user frees space | Never clear active room's site data to make space; real-device quota behavior varies |
| Large completed downloads | Build verified browser-native `Blob` parts without duplicate full-file JS buffer | Browser-native Blob may still consume memory; PPTX/PDF renderers use full buffers |
| Background phone tab | Pause picker heartbeat; foreground `wake()` validates or reconnects socket | Cannot override mobile OS suspension or recover destroyed `File` objects |
| Hidden dashboard while presenting | Dashboard/presenter independently send scoped HTTP lease renewals; no fixed two-hour presenter bridge cutoff | If all pages are suspended/killed, renewal cannot be guaranteed; byte transfer still belongs to the dashboard |
| Lost end-room response | Durable browser intent; generation-scoped HTTP retry confirms closed/absent before deletion | Server absence confirms current generation absence, not historical command execution |
| Local cleanup fails after closure | Keep confirmed closure and cache handle; explicit retry or refresh retries deletion | Clearing session storage manually discards the cleanup intent |
| A six-digit code is reused | Newly negotiated rooms use immutable generation cache namespaces for originals/previews/readers/deletion | Existing rooms drain in their original namespace; this does not isolate same-origin rendering or detect same-length corruption |
| Room admission exceeds capacity | Shared rules bound retained files/bytes/session identities; denials stop candidate replay; current work stays admitted | This is not a browser free-space estimate; explicit Stop does not delete already-cached bytes or release reserved room budget |
| Sender is rejected while its socket stays open | Retire authority/serialized attachment, mark originals offline and cancel pending ranges before closing | Cached bytes remain; an open-admission room may still accept a fresh identity, which cannot own the old files |

**Important:** A filename appearing in the host list is **not** proof of receipt. The sender's **Done** state means the host has verified all original bytes as locally persisted. A preview image is not proof that all PDF bytes arrived.

## Limitations and operational safeguards

- **Storage quotas** are imposed by the browser/operating system. Private or restricted contexts may prohibit IndexedDB. Never claim the room has backed up files to a cloud account.
- **Memory** remains a concern for 50–200 MiB presentations. Peak memory on real devices and large PDF/PPTX rendering is not yet fully validated.
- **Client timers** may pause in background tabs; the transfer scheduler can run while a presenter tab is foreground, but not if the owning classroom tab is killed.
- **No HTTP fallback**, no application-level E2EE and no guarantee of throughput under restrictive networks.
- **Temporary room credentials and invitations** should be treated as sensitive; don't paste them into logs, issue reports or public documentation.
- **Presenter lease** can renew only its own generation. It cannot authenticate as host, request original bytes, or close a room. Removing copied session credentials narrows access; same-origin storage/rendering isolation remains additional work.
- **Public deployment** needs rate-limit and abuse/operational review appropriate to expected load; existing caps are defenses, not a proof of hardening.
- **Room admission** now bounds normal growth at 300 manifests / 4 GiB and 120
  retained identities. Reconnects preserve known capabilities, with at most 30
  simultaneous sender places. Pending sockets now have ten-second authentication
  deadlines and bounded pending/closing pools. Creation is limited to 120/source
  address/hour (durable on Cloudflare, process-local on Node), and new sender
  identities to 120/room/minute; known private resumes bypass the latter. These
  remain partial abuse defenses, not comprehensive DDoS protection. An IP/source
  bucket is shared by users behind NAT/proxies. Node does not trust arbitrary
  forwarded-for headers. Already-admitted legacy data above a new cap is not evicted.

## Triage when a transfer stalls

1. Confirm host and sender are both in the **same room** and authenticated; check the sender's availability.
2. Inspect whether the stalled file is approved, whether other files still progress, and whether a storage-warning banner is visible.
3. Do not clear site data while the room is active. For quota failures, free other device/browser storage without erasing FlashView's persisted chunks, then use **Retry saving**.
4. Check WebSocket connection and pending range errors; use `?perf=1` for local diagnostic timings.
5. Reproduce on the Node backend **and** the Cloudflare backend where applicable; include a byte-integrity test for resumed transfers.
6. File the regression with steps, browser/device conditions and the relevant original audit ID. Update [the tracker](./reliability-audit.md).

## Documentation and validation rule

A passing browser CI run verifies **tested paths**, not all mobile operating systems, browsers, storage quotas or network policies. State measured results with test conditions and keep unverified claims explicitly pending. A reliability PR should update the audit status, implemented remedy, test evidence and known limitations in the **same change**.
