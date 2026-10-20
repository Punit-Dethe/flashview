# Shared room metadata engine validation — 20 October 2026

This completes the shared metadata-engine slice on the integration branch:
participant admission/approval/private resume, host presence, file lifecycle,
ordered Cloudflare persistence and generation-scoped client snapshot ordering.
Original byte routing, scheduling, browser storage and viewers are unchanged.
The remaining worker/OPFS/viewer phases are in the architecture improvement plan.

## Correctness checks

- 110 unit/protocol tests passed, including 19 Node relay contracts. A fresh
  complete Cloudflare relay run passed all 19 contracts.
- Full Chromium suites passed 31/31 on Node and 31/31 on local Cloudflare.
  Ten targeted Firefox cases passed, including interrupted byte integrity and
  stale snapshot/approval/foreign-closure injection against a cached original.
- Build, TypeScript and Worker dry-run passed. Fault tests cover overlapping
  checkpoints, failed-write retry, queued saves after End, offline capability
  rejection and obsolete socket closes. Restarts preserve room revisions.
- An earlier Cloudflare new-join-rate wait timed out while another build ran.
  The cause remains unconfirmed. Isolated reruns and subsequent complete suites
  passed; that failed attempt is not counted as a pass.

## Public comparison procedure

Baseline Worker: `b04f8a7e-54ac-4f3d-93b4-105c4d0f2b17`, source `30feb75`
(subsequent `28e101d` changes only documentation and an unused helper).
Three sequential repetitions use synthetic random 20 MiB originals, fresh rooms
and browser contexts, one sender/receiver on this Windows desktop. The interval
includes automated selection, transfer, browser-cache persistence and completion
UI. Every copy must match SHA-256; hashing is outside the timed interval.
Run `BENCH_TARGET=public npm run bench:transfer` using your shell's environment
syntax. Other suites are idle during these measurements.

Baseline cache times: **4730 / 4749 / 4426 ms**, median **4730 ms**. All originals
matched. WebSocket create/host/first join/private resume times were also sampled
in three fresh rooms; private resume was **702 / 206 / 782 ms**. These small
network samples are regression checks, not proof of physical-phone or campus
performance. Release and after measurements will be recorded below.

## Scope and rollout

Existing Durable Object namespace, metadata keys and default storage gates are
retained. `roomRevision` is additive; no migration or room reset is required.
Legacy unstamped peers remain compatible without the new ordering guarantee.
Node remains process-local. Synthetic test rooms are ended after checks; the
relay stores metadata, and original bytes remain in private browser cache.
R2 and personal multi-gigabyte mode remain deferred; the cap is 200 MiB.
