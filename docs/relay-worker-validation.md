# Relay transfer worker validation — 20 October 2026

One worker owns each page's socket, source File reads, metadata-driven receipt
queue, IndexedDB writes, progress correction and completion receipts. React gets
coalesced status batches; original transfer packets never cross that boundary.
The passive PDF bridge remains bounded/cancellable. Completed export/PPTX
readers still use local cache.

## Scope and compatibility

- Wire protocol, relay adapters, packet sizes, concurrency, cache identity/schema,
  admission guards and the 200 MiB limit are retained. Rooms/cache are not reset;
  originals are never automatically written into OS Downloads. R2 is deferred.
- Stop/dispose aborts per-file range/write attempts. Source authority is checked
  again while a congested send waits, not only before reading the File.
- Two bounded worker replacements preserve private capability, learned room
  generation and source handles. The obsolete owner is terminated first. A
  terminated failed worker permits deletion-only page cleanup; there is no UI
  transfer fallback. Exhausted retries report an explicit error.
- Presenter/optional PDF thumbnail code is lazy-loaded. Phone PDF previews and
  the progressive local reader remain transitional. OPFS, production content
  hashes and independent completed-viewer lifetimes are later work. Workers
  still depend on their parent page and shared OS scheduling/resources.

## Correctness evidence

114 unit/protocol cases passed, including worker RPC settlement/cancellation,
stale session replies, capability/generation preservation, startup failure,
retry exhaustion and source revocation during backpressure.

New browser cases check committed bytes and relayed completion while both UI
threads are blocked for ten seconds; crash sender and receiver workers mid-file
without reselection/duplicates; and stop held reads while a healthy file finishes,
verifying request cancellation and no late binary responses. Exports must match
synthetic originals exactly. Existing picker/disconnect, stale snapshot, quota,
storage failure, eviction, handover, PDF/PPTX and binary tests remain.
Full Chromium suites passed **34/34 each** on Node and local Cloudflare.
The final gated UI-stall case passed on each backend: persisted cache and relay
completion landed about 1.5–1.6 s into both ten-second blocks. The final Node
three-case worker stress run also passed. **15/15** targeted Firefox cases passed
with the explicit weaker stall criterion below; Firefox `157.0`, Chromium
`156.0.8078.4`. Normal recovery, worker crashes, Stop and exact exports passed.
Build, TypeScript and Worker dry-run passed. A small 2 MiB synthetic baseline
with 40 ms sender reads passed with all required timing metrics present.

### Firefox limitation (audit N37, still open)

Do not interpret worker ownership as universal browser-level isolation. In the
tested Firefox build, worker timers fired during a scheduled ten-second page
busy loop, but native Blob reads completed only after the page yielded. A
test-only FileReaderSync probe completed reading/sending about 1.1 s into the
block, while receiver delivery still waited until the block ended. The probe
does not ship; changing file-read API alone did not meet the isolation goal.
This is observed behavior in this harness/build, not a universal assertion about
every Firefox release or a confirmed upstream root-cause diagnosis.
The native-read Firefox case completed and acknowledged about 0.5–0.6 s after
both blocks ended, with the original unchanged.

The retained stress regression gates initial reads until both page blocks have
been scheduled, records timestamps inside an independent cache-observer worker
and the native sender socket, then inspects them after the blocks. This avoids
counting a transfer completed before the block or delayed DevTools observation
as isolation proof. Chromium requires committed bytes and relayed completion
inside both blocked intervals. Firefox requires prompt exact recovery after the
interval; that weaker criterion is explicit in the test/CI diagnostics. Bounded
rendering, renderer isolation and physical-browser proof remain required work.

## Repeatable public speed check

Baseline source/release: `6a04b58` / Worker
`2635dc65-1792-48b0-8f04-fed6bc4782f7`. Three sequential synthetic 20 MiB originals
in fresh rooms/desktop Chromium contexts, with other suites idle, produced
**4786 / 3795 / 4311 ms**, median **4311 ms**. All originals matched SHA-256.
Run `BENCH_TARGET=public npm run bench:transfer` using your shell's environment
syntax. Timing includes selection, transfer, cache persistence and completion
UI; independent hashing is outside the interval. After samples follow release.

These small desktop/network samples are regression checks, not campus/phone
proof, 200 MiB behavior or multiple-sender fairness. Optional worker performance
diagnostics are sampled/coalesced by metric to bound UI traffic; their counts
are not packet counts. The transfer benchmark uses its own end-to-end timer.
