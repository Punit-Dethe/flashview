# OPFS originals and integrity — 21 October 2026

**Integration in progress; normal rooms still use IndexedDB.** This branch adds
an explicitly selected `?storage=opfs` creation mode, not a silent migration of
current classrooms. Cache version 3 is fixed at creation. Its identity is
`opfs:<room-generation>`; version 2 and legacy code-based caches drain in place.
R2 and the personal large-file mode remain deferred; the cap is still 200 MiB.

Rollback must retain version 3 readers/relay metadata while any version 3 rooms
are active. Restoring a pre-OPFS bundle is not a format-compatible rollback for
those rooms. A safe rollback disables new OPFS creation while keeping existing
OPFS rooms readable; legacy rooms remain unaffected. Use an isolated pilot
worker/namespace for public comparison before choosing a production cohort.

## Contract

- The dedicated transfer worker retains ownership of the socket, fair queue,
  original reads and persistence. Packet sizes/concurrency are unchanged.
- Before allocating an OPFS room, the idle worker probes the actual sync-file
  API. Unsupported/denied storage produces an explicit error without creating a
  relay room. Quota exhaustion does not silently switch storage or use Downloads.
- Source SHA-256 is calculated incrementally in the sender worker with reads of
  at most 1 MiB and at most two active source hashes. The original is announced
  only after its digest exists. Stop/replacement invalidates obsolete results.
- Both relay adapters require and pin the digest for OPFS offers. The digest is
  immutable with file ID, size, owner and sanitized name. Legacy offers remain
  compatible in old rooms. An older sender in a new OPFS room gets an explicit
  per-file refresh error, not unverified completion.
- SHA-256 on each binary range rejects changed bytes before persistence. No
  per-packet durable relay metadata or second transfer scheduler is introduced.
- OPFS stores originals; a separate `warpview-originals-v1` IndexedDB stores
  compact file records and committed-block digests. It does not upgrade/block
  the old room-cache database. Preview/room bookkeeping still uses the old DB.
- Pending 64 KiB blocks coalesce up to 1 MiB, or for at most 16 ms before a batch
  starts. A writer handles short writes, flushes, closes, and only then commits
  checkpoints. OPFS plus IndexedDB are **ordered, not an atomic transaction**.
- On restoration, only committed blocks whose bytes match their recorded hash
  count as saved. Sparse/uncommitted bytes do not count; excess tails are trimmed.
  Missing/changed blocks are invalidated individually. Before first completion,
  the flushed original must match the source's full SHA-256. A sealed record is
  committed only after validation and writer closure. Failed verification cannot
  show 100% or send a completion receipt. Repeated full-file mismatches stop only
  that file with an explicit warning.
- Completed originals no longer depend on the source's connection. Local
  verification can finish after Stop/disconnect if all bytes are already saved.
- `CompletedFileStore.acquire` verifies a sealed original and holds shared
  room/file reader leases. Writes and cleanup obey the corresponding exclusive
  locks. Snapshot readers release their lease after creating browser-native Blob
  data. Explicit Download remains optional and separate from automatic receipt.
- End/cleanup fences the immutable room generation with a closed marker before
  removing bytes and checkpoints. A late/obsolete writer cannot recreate it.
  A cleanup failure retains the existing Retry path.

These hashes detect accidental transmission/storage corruption. The relay can
see bytes and controls metadata: this is not encryption or protection from a
malicious relay/same-origin script. Browser storage can still be cleared/evicted.

## Implementation decisions

The first prototype used a pure-JS incremental hash and small write batches. It
was correct but slower. The retained implementation pins `hash-wasm` 4.12.0 for
bounded incremental SHA-256 and coalesces writes. Its WebAssembly is bundled;
there is no runtime CDN fetch. The committed lockfile makes this build repeatable.

Web Crypto's digest API requires its entire input at once, so it is not used to
allocate a 200 MiB source buffer. See [MDN digest](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest),
[OPFS flush](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle/flush),
and the [hash-wasm API](https://github.com/Daninet/hash-wasm#advanced-usage-with-streaming-input).

Synchronous native filesystem calls run in the transfer worker. JavaScript can
bound queued operations, asynchronous waits and late results, but cannot interrupt
a synchronous OS call already executing. Physical low-storage/suspension proof
and browser-specific behavior remain required. The closed-marker metadata is
deliberately retained; a bounded retention policy needs separate lifecycle proof.

## Fault and compatibility evidence

Tests exercise the real browser OPFS/IndexedDB APIs, with injected faults in a
test-only bundled store worker or the actual transfer owner. No debug module is
published by the application.

- Short writes loop until complete; a changed cached block is rejected, only its
  checkpoint is removed, and restoring that block restores exact completion.
- Even internally valid block checkpoints cannot seal an original with the wrong
  pinned whole-file root; all its checkpoints are invalidated and export refused.
- Bytes flushed immediately before an abort/absent checkpoint remain incomplete.
- Cleanup waits for a reader lease, and closed generations reject recreation.
- Worker restart reuses committed originals without asking the source again.
- An injected bad network packet is rejected and requested again; the completed
  export must independently match SHA-256.
- The near-limit 200 MiB desktop case passed (7 bytes below the cap), including
  a bad packet, worker restart, exact streamed export and generation cleanup.
  Source reads stayed at or below 1 MiB. Its 7932 ms cache timing includes an
  injected fault and path-based fixture selection; it is not a public speed claim.
- Native capability failure allocates no relay room; regular room creation still
  works. Quota pause preserves received bytes and lets a healthy file finish.
  Manual recovery saves retained bytes without re-requesting them.
- Stop while full local verification is deliberately held cannot produce early
  completion; releasing the local read finishes the original without source data.

The quota test exposed an uncommitted-memory edge in the shared cache: a missing
single block could return its RAM copy without saving it. Background receipt now
persists that retained copy; passive viewer reads remain separate. The first Stop
test also held the page-side export read by mistake; the fault is now restricted
to the transfer worker. Failed harness attempts are not counted as product passes.

Local final validation: build/typecheck, 119 unit/protocol cases, 35 existing
Chromium browser cases per relay backend, and all six new OPFS cases on each of
Chromium/Node, Chromium/Cloudflare and Firefox/Node passed. The new viewer case
renders genuine PDF and PPTX originals after closing the sender. Forced quota
and missing-capability tests are synthetic; they do not prove physical mobile
low-storage behavior. CI and public results remain separate from local passes.
The Cloudflare relay contract suite also passed 19/19, and Worker dry-run passed.

## Performance gate

Sequential local desktop Chromium 156, synthetic 20 MiB, three fresh rooms per
mode, all original hashes matched:

| Mode | Selection-through-cache samples (ms) | Median |
| --- | --- | --- |
| Existing IndexedDB path | 1618 / 1490 / 1669 | 1618 |
| OPFS plus source/range/persisted-content verification | 2108 / 2105 / 2093 | 2105 |

The new contract added about 487 ms / 30% to this local median. The comparison
includes integrity work absent from the legacy path; it does **not** isolate a
storage-only OPFS cost. A traced run located source hashing (~83 ms), checkpoint
work, committed-block scan (~107 ms) and full persisted readback (~73 ms). Tracing
has different overhead; do not replace the ordinary batch with its faster sample.
Earlier pure-JS hashing/less coalescing trials were slower and are superseded,
not evidence of a speed gain. Raw reports remain in ignored `.wrangler/` files.

Keep the normal default until matched public/device measurements justify a
switch. Benchmark both contracts, including source preparation and final
verification, and retain selection separately from network/storage stages. The
existing unexplained public outlier N38 is not resolved or reclassified by OPFS.
All timings here are desktop synthetic checks, not campus/iPhone/Android proof.

### Isolated public pilot

Pilot: [regular mode](https://warpview-opfs-pilot.outlanderwatr.workers.dev/),
[OPFS mode](https://warpview-opfs-pilot.outlanderwatr.workers.dev/?storage=opfs).
Version `8e0c0572-bd3d-491d-aecf-32344405a207` uses its own room namespace;
production `flashview` was not deployed or rebound for these tests. All six
synthetic 20 MiB originals below independently matched SHA-256. Runs were
sequential, three per mode, same deployed assets, no concurrent local suites.

| Mode | Selection-through-cache samples (ms) | Median |
| --- | --- | --- |
| Existing IndexedDB path | 5256 / 5265 / 7833 | 5265 |
| OPFS with integrity | 5274 / 4852 / 16490 | 5274 |

The similar medians do **not** establish stable performance: one experimental
run took 16.49 seconds. It lacks tracing, so it cannot yet be attributed to
OPFS, network routing or the existing N38 symptom. Keep this sample in the
record and the default unchanged; diagnostic runs are attribution attempts,
not replacements for this ordinary batch. This is not an R2 test.

Three follow-up traced OPFS runs took 5202 / 5755 / 5370 ms. Each used 80 ranges
with no unfinished requests. The slowest observed range per run was 679 / 787 /
731 ms, with source work of 11 / 14 / 12 ms for those ranges. They did not
reproduce the tail, so they do not establish its cause or resolve N44/N38.

## Remaining before default promotion

1. Pass the full CI matrix and investigate public tail latency; explain material
   regressions rather than promoting a faster-looking diagnostic rerun.
2. Verify intended WebKit/iOS and physical low-storage/background behavior; choose
   an explicit supported fallback policy. There is no automatic fallback for an
   already-created OPFS room.
3. Review orphan/closed-marker retention and active-room expiry cleanup policy;
   preserve current room data across upgrades and rollbacks.
4. Complete the independent viewer migration in phase 4. Existing PDF progressive
   reads, phone thumbnails and full-buffer renderer allocations are transitional.
   The new read-lease boundary exists; viewers do not yet hold leases for their
   whole lifetime. This slice does not complete the roadmap.
