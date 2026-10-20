# Storage decision — 21 October 2026

**Keep IndexedDB as the normal backend. Do not promote the current OPFS design.**
Corruption checks and verified completion are useful; they do not require OPFS.
The next candidate is bounded batch writes in IDB with the same checks. Its
comparison driver is a prototype, not a release-ready fallback implementation.

PR #48's full CI passed at `6599eca` ([run](https://github.com/Punit-Dethe/flashview/actions/runs/39483920439)).
That verifies the tested integration scenarios, not a speed benefit. Production
and normal cache selection have not changed in this evaluation.

## Matched comparison

`npm run bench:storage` uses real APIs in a dedicated worker and a persistent
desktop profile. Path-based synthetic Files are read in <=1 MiB windows. Every
driver checks source SHA-256, sender/receiver range hashes, per-block hashes,
persisted blocks and the whole original. An independent final streaming digest
must also match Node's source digest.

Drivers: current-style 64 KiB IDB transactions with verification added; batched
IDB with <=1 MiB **strict-durability** transactions; actual experimental OPFS.
Batching changes transaction granularity too: this compares designs, not only
APIs. Reference IDB drivers lack the complete room/lease/cleanup/retry policy.

Three rounds rotate driver order. These are median **receipt plus final
verification** times (ms), excluding common source hashing, which is measured
separately. Network, file-picker automation and viewers are excluded. These are
warm desktop storage measurements, not transfer times or memory benchmarks.
The saved-block scan runs in the same worker; separate integration tests cover
actual worker restart and recovery.

| Browser / size | Current-style IDB + checks | Batched strict IDB + checks | OPFS + checks |
| --- | ---: | ---: | ---: |
| Chromium 156 / 20 MiB | 479 | 441 | 512 |
| Chromium 156 / 200 MiB | 4881 | 4629 | 5708 |
| Firefox 157 / 20 MiB | 464 | 418 | 7294 |
| Playwright WebKit 27.2 on Windows / 20 MiB | 874 | 656 | unsupported by this backend |

All completed originals matched. Sizes are seven bytes below the stated MiB,
including the existing cap. WebKit returned `NotSupportedError` for OPFS: this
is **not** evidence that Safari/iOS lacks OPFS or a passed Safari test.

The initial Firefox 200 MiB batch overlapped browser installation/typechecking
and is excluded from timing conclusions; raw samples are retained. A subsequent
isolated paired smoke took 4246 ms for batched IDB versus 55941 ms for OPFS, with
exact originals. This is one paired check, not another three-run median. Do not
mix these persistent-profile storage tests with earlier fresh-context network
benchmarks.

## Firefox diagnosis

A separate traced 20 MiB OPFS case took 7064 ms to become verified:

| Native operation | Calls | Total (ms) |
| --- | ---: | ---: |
| Open | 22 | 54 |
| Write | 320 | 31 |
| Flush | 20 | 10 |
| Close | 22 | 6506 |

Handle closure dominates in this environment. Retaining a writer could reduce
repeated closure, but requires a different lease, reader-handoff, cancellation
and cleanup design. That is a hypothesis, not an implemented fix or measured
production win. The existing experimental contract remains unchanged.

Both backends remain subject to origin quotas and eviction; neither promises
permanent storage. See [MDN's OPFS description](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
and [WebKit's storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/).
Actual capability checks and storage-loss handling are still required.

## Live tail investigation

A lighter test-only trace now timestamps the actual transfer worker without
enabling app performance metrics or copying binary payloads into the runner.
It records offer, range round trips, final-byte arrival and completion notice.
Enable `BENCH_WORKER_TRACE=1` with `node --import tsx`; there is no production
debug endpoint or permanent telemetry. Instrumentation can affect timing, and
worker termination can discard its in-memory trace.

Five fresh public rooms per mode, same isolated pilot build:

| Mode | Selection through cache samples (ms) | Median |
| --- | --- | ---: |
| Normal IDB | 4396 / 4976 / 5472 / 5436 / 3765 | 4976 |
| OPFS with integrity | 4955 / 5917 / 4926 / 5414 / 4937 | 4955 |

All originals matched; each used 80 ranges with none unfinished. The slowest
observed range was 783 ms. OPFS sent completion 200–226 ms after the last byte.
These runs did **not** reproduce the earlier 16490 ms transfer. N38/N44 stay
open: similar medians cannot establish its cause or prove it fixed. Public
modes retain their different integrity contracts and automated file selection.

## Next implementation

1. Keep backend choice behind a verified-original interface. Viewers receive
   completed immutable File/Blob data, not a storage selector.
2. Implement bounded batched IDB persistence with atomic bytes/checkpoints,
   immutable identity, corruption invalidation, per-file quota recovery,
   explicit completion sealing and closed-generation cleanup. Preserve existing
   namespaces; never silently change a live room's backend.
3. Carry source/range/root checks into it. Repeat Stop, crash, corruption,
   cleanup-lease and healthy-peer regressions against the real integration.
4. Repeat whole-app speed and physical target-browser checks before changing
   normal room creation. Finish viewer independence separately.

Raw synthetic measurements and exclusions are in
[the evidence JSON](./benchmarks/storage-evaluation-2026-10-21.json).
R2 and the personal larger-file mode remain deferred.
