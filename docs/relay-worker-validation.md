# Relay transfer worker validation — 20 October 2026

**Historical release/measurement record.** Main now includes this worker
architecture. The versions below identify the 20 October experiment and are
not today's active version or a recommended rollback across later lifecycle,
cache and deletion changes. Cloudflare automatic deployment from main has since
been confirmed by the user. See [Deployment](./deployment.md) for current release
ownership and compatibility checks; the exact cause of the recorded N40 incident
is not established by this documentation update.

**User-authorized live trial.** On 20 October, the user explicitly authorized
merging and deploying the worker so they could reproduce N38 on the hosted app.
Worker `e3939396-6867-43ee-899a-86765f28eb53` (runtime source `4a1c306`, full CI
passed) was promoted at 100%. Domain/route triggers were preserved. The prior
room-engine Worker `2635dc65-1792-48b0-8f04-fed6bc4782f7` (source `6a04b58`)
was the prior version at that promotion. Deployment does not resolve the unexplained
15.4-second sample or establish predictable speed. N37–N39 remain open or
unconfirmed; the phase is not complete. During the merges, a later untagged
deployment (`863caf70`, 15:26 UTC) replaced this promotion with older application
behavior, including no HTTP End endpoint. Its publishing source is unconfirmed
(N40). Validate the active assets and control endpoints after the final merge;
a successful deploy command alone cannot establish which code remains live.

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

116 unit/protocol cases passed, including offline Stop across replacement,
idle worker warm-up with no socket,
worker RPC settlement/cancellation,
stale session replies, capability/generation preservation, startup failure,
retry exhaustion and source revocation during backpressure.

New browser cases check committed bytes and relayed completion while both UI
threads are blocked for ten seconds; crash sender and receiver workers mid-file
without reselection/duplicates; and stop held reads while a healthy file finishes,
verifying request cancellation and no late binary responses. Exports must match
synthetic originals exactly. Existing picker/disconnect, stale snapshot, quota,
storage failure, eviction, handover, PDF/PPTX and binary tests remain.
Final full Chromium suites passed **35/35 each** on Node and local Cloudflare.
The final gated UI-stall case passed on each backend: persisted cache and relay
completion landed about 1.5–1.6 s into both ten-second blocks. The final Node
three-case worker stress run also passed. **16/16** targeted Firefox cases passed
with the explicit weaker stall criterion below; Firefox `157.0`, Chromium
`156.0.8078.4`. Normal recovery, worker crashes, Stop and exact exports passed.
Build, TypeScript and Worker dry-run passed. A small 2 MiB synthetic baseline
with 40 ms sender reads passed with all required timing metrics present.
After the warm-up follow-up, targeted cache-upgrade/UI-stall/worker-crash/picker
checks passed 4/4 on Node and 4/4 on local Cloudflare, plus 3/3 Firefox worker and
picker checks. The warm-up only overlaps worker-script loading with room setup;
it does not open an idle WebSocket or change the transfer worker.

Runtime commit `4a1c306` passed full GitHub CI. The later diagnostics-only commit
`3416923` failed its Firefox stress case: receipt arrived 927 ms after the blocks,
but the observer timestamp was still zero at the single early inspection. The
test asserted a five-second recovery budget without waiting through that budget.
It now polls only the Firefox observations until the existing deadline and still
asserts their recorded timestamps. Chromium's stricter inside-block criterion is
unchanged. The corrected targeted Firefox case passed locally with exact export.

The final review found an offline Stop edge: checking page-side connection state
before retiring the worker's source could leave its File alive for reconnect.
The worker rollout was temporarily reverted to the prior room-engine release
while this was corrected. Stop now retires local source/reader authority even
offline, retains intent across worker replacement and replays it after private
authentication or an unreconciled manifest. A real-browser case holds original
reads, disconnects, stops offline, releases old reads and reconnects: no binary
response is sent, the relay records terminal revocation, and another exact file
still finishes. Pending reader slots are retired on Stop/disconnect; a 15-second
read deadline also rejects late results. Native Blob reads are not physically
abortable with this API; their late results have no send authority.

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

The initial worker release (`137820c`, Worker
`e79a6772-de0b-436f-bfb2-f7dc8d1ed205`) measured **4237 / 4413 / 4775 ms**, median
**4413 ms**, all SHA-256 matches. Cold room-setup samples were 2476/1468/2426 ms
versus baseline 1452/1430/1889 ms. This exposed a separate worker-script fetch on
the room-start path, so the page now warms the idle worker before room creation
and overlaps loading with the HTTP request. Final warm-up samples follow below.

## Public upgrade verification

A browser room prepared on the previous UI-owned release retained its complete
cached original across host reload into the first worker release. Cache identity
was unchanged and the new host had exactly one transfer worker. The old phone
bundle and selected File handles remained open and sent another original into
the new receiver; independent hashes matched both originals. No room/cache
migration or fresh selection of the first original was needed.

The final corrected worker also passed that legacy-browser/cache/old-phone
check after a five-second post-deployment settling interval. One earlier
immediate post-deploy host reload timed out waiting for connection; its cause is
unconfirmed. Two ordinary reloads on the final version passed. The successful
repeat does not establish that every near-deployment reload is safe (N39).
The public offline-Stop case passed, including terminal relay state, no stopped
binary responses and exact subsequent export. A separate public 20 MiB run
passed lost-first-acknowledgement and repeated-interruption/obsolete-read tests;
return to persisted progress was 1220/684 ms, with final SHA-256 matched.

## Final public measurements and open performance investigation (N38)

| Batch | Cache samples (ms) | Median |
| --- | --- | --- |
| Previous room-engine baseline | 4786 / 3795 / 4311 | 4311 ms |
| First worker trial | 4237 / 4413 / 4775 | 4413 ms |
| Worker warm-up trial | 4204 / 4296 / 4882 | 4296 ms |
| Corrected offline-Stop worker, ordinary measurement | 4443 / **15409** / 4807 | 4807 ms |
| Corrected worker with optional diagnostics enabled | 4142 / 4654 / 4138 | 4142 ms |

Every copy matched SHA-256. Do not discard the slow ordinary sample or replace
it with the diagnostic median. The diagnostic rerun changes observation overhead
and enables optional performance counters; it did not reproduce or explain the
15.4-second event. Each traced transfer completed 80 ranges, with no unfinished
range/error. Source read maxima were 5.1 ms; host write maxima 4.8–6.4 ms; slowest
range round trips 674–707 ms. These locate the healthy path, not the prior stall.

Ordinary final room-ready samples were 1415/1940/2421 ms versus baseline
1452/1430/1889 ms. Warm-up removes a serial fetch opportunity, but these small
public samples do not prove setup latency is unchanged. Isolate selection,
network, retry and cache stages in another slow occurrence, compare against the
previous owner under matched conditions, and then repeat release validation.
The user authorized live reproduction before this investigation is complete.
OPFS migration should not conceal or silently reclassify the unresolved issue.

These small desktop/network samples are regression checks, not campus/phone
proof, 200 MiB behavior or multiple-sender fairness. Optional worker performance
diagnostics are sampled/coalesced by metric to bound UI traffic; their counts
are not packet counts. The transfer benchmark uses its own end-to-end timer.
