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

| Public relay | Before samples (ms) | Before median | After samples (ms) | After median |
| --- | --- | --- | --- | --- |
| 20 MiB selection → browser cache/UI | 4730 / 4749 / 4426 | 4730 ms | 4227 / 4214 / 4726 | 4227 ms |

All six originals matched SHA-256. Chromium `156.0.8078.4`, Node `v24.11.1`.
These samples show no material slowdown; the smaller after values do not prove
a throughput improvement. CPU warm-up, routing and network conditions vary.

WebSocket timings (fresh rooms, before/after separately, milliseconds):

| Operation | Before samples | After samples |
| --- | --- | --- |
| Create room | 959 / 946 / 832 | 778 / 814 / 821 |
| Host authentication | 829 / 920 / 681 | 247 / 742 / 230 |
| First sender join | 801 / 884 / 908 | 733 / 741 / 768 |
| Private resume takeover | 702 / 206 / 782 | 778 / 696 / 753 |

An unauthenticated socket timed out in 10206 ms. A fresh login was then admitted
while the authenticated sender remained open; the creation guard was enforced.
These small desktop/network samples are regression checks, not proof of
physical-phone/campus performance, multiple-sender fairness, 200 MiB boundary
behavior or independence from viewer load.

## Public release verification

Source `6a04b58` was uploaded and deployed at 100% as Worker
`2635dc65-1792-48b0-8f04-fed6bc4782f7`, retaining existing domain/route triggers.
A synthetic room prepared on the previous public version resumed after upgrade
with its private identity and completed-file metadata preserved. The new engine
assigned room revisions, forwarded exact original bytes and kept Stop terminal
when an offer was replayed. After measurements above use the deployed version.
A separate public 20 MiB run passed after loss of the first join acknowledgement,
two mid-file interruptions and an obsolete asynchronous read failure. Its final
cached original matched SHA-256. Return to persisted progress was 520 / 552 ms;
full mid-file recovery was 1126 / 1162 ms on this desktop/network. CI status is
recorded in [PR #45](https://github.com/Punit-Dethe/flashview/pull/45).

## Scope and rollout

Existing Durable Object namespace, metadata keys and default storage gates are
retained. `roomRevision` is additive; no migration or room reset is required.
Legacy unstamped peers remain compatible without the new ordering guarantee.
Node remains process-local. Synthetic test rooms are ended after checks; the
relay stores metadata, and original bytes remain in private browser cache.
R2 and personal multi-gigabyte mode remain deferred; the cap is 200 MiB.
