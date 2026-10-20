# WarpView implementation plan — fast relay, independent transfer and viewing

**Revision 4 · 20 October 2026 · R2 deferred by the user after live testing.**
Keep the existing relay as the production byte path. Continue the reliability,
worker, browser-cache and viewer improvements without making them depend on R2.
The earlier cloud proposal is [archived](./archive/r2-migration-proposal-2026-10-19.md);
it is not the current implementation specification.

## Product contract and transport decision

- Accountless phone-to-classroom sharing through QR/code rooms remains the workflow.
- Receive originals automatically into private browser cache, preferably OPFS.
  Never silently save originals into Downloads or invoke a save picker.
- All admitted files transfer automatically through one bounded, fair queue.
  Opening, navigating or closing a viewer cannot change transfer scheduling,
  retries, cancellation, concurrency or original-byte requests.
- Open PDFs/PPTX only after complete, verified local receipt. Add images through
  the same completed-file interface. Remove progressive/phone-preview complexity.
- Preserve exact original bytes. Transfer, verification and rendering have
  distinct outcomes; rendering failure cannot turn a successfully cached file
  into a failed transfer.
- **With the relay, the phone must remain connected until the teacher has fully
  cached the file.** There is no durable cloud upload milestone that permits it
  to leave earlier. After verified local completion, the teacher can use the
  cached copy without the phone. Browser storage can still be cleared or evicted.
- Physical CPU, memory and disk remain shared. Separate subsystem ownership and
  bound renderer work; measure contention instead of promising zero impact.

The measured 20 MiB pilots were approximately 2.86 s through the current relay
versus 8.3 s through either tested R2 layout. The user also found the R2 pilot
much slower and chose to skip it for now. This defers R2, not Cloudflare hosting
of the existing relay. Keep experimental code and evidence separate; no R2
production migration, cloud-finalization work or further R2 tuning is scheduled.
Do not replace the current relay with another unmeasured storage provider.
See [the evidence and decision](./r2-benchmark-results.md).

## Current implementation status

This accepted plan and its historical R2 evidence were restored from the
isolated relay-lifecycle branch so the deployed recovery/header line has the same
roadmap. The 20 October regression pass ports only terminal stop behavior from
#35 and adds N11–N13 handover corrections. The other #35/#36 work remains separate;
do not merge an old branch over the newer recovery fixes without reconciling them.
See the [audit tracker](./reliability-audit.md) for reproduction and release status.

| Area | Status |
|---|---|
| Relay transfer path | Existing production architecture; retained |
| Terminal file stop and pending-range cancellation | Ported to the current handover-fix branch for both backends; regression-tested; not merged to main |
| Reconnection and socket handover | Immediate foreground recovery on #37; 20 October follow-up retires obsolete authority, clears receiver requests and preserves sender resume during host absence |
| All-file benchmark and bounded original-byte readback | Implemented on #35; not ported to this branch |
| Lockfile and reproducible installs | Implemented on #35; not ported to this branch |
| Worker-owned transfer and OPFS receipt | Demonstrated in the isolated R2 pilot; **not integrated into the relay application** |
| Completed local PDF/image preview | Demonstrated in the isolated pilot; production viewer migration pending |
| Shared room engine | File and participant admission plus terminal stop/control/cache-identity rules shared; full command/revision/persistence orchestration pending |
| Room admission budgets | 300 retained manifests / 4 GiB originals, 120 retained session identities, 30 concurrent senders; exact retries and existing capabilities preserved |
| Lease/end lifecycle | Deployed on the recovery line; PR #40 full CI passed: scoped renewals, generation-safe HTTP closure, retryable cleanup, legacy session upgrade and removal of fixed presenter cutoff; physical-device verification pending |
| Local cache identity | Generation-based namespaces implemented for newly negotiated rooms; legacy rooms drain in place. Regression/release evidence tracked under N20 |
| R2 | Deferred; prototype retained for reference |

[PR #35](https://github.com/Punit-Dethe/flashview/pull/35) passed its full CI run
on `f2b21b4`, including application build, unit/fault tests, Chromium, Firefox,
local Cloudflare browser checks and benchmark comparisons. The manual pilot also
passed browser integration against deployed R2. These are automated checks,
not proof of physical-device/campus reliability. The original audit's open and
partial findings are not automatically resolved by that CI result.

## Implementation phases

Each phase should be a reviewable change with its own acceptance evidence.
Retain the current transfer path until its replacement passes integrity and
performance checks; avoid maintaining two permanent schedulers.

### Phase 0 — Close the transport decision and preserve the baseline

1. Retain relay transport and mark R2 deferred throughout the active plan and
   experiment notes. Preserve measured results without relabeling them as campus
   guarantees or mixing older inaccurate benchmark reports into the comparison.
2. Review and merge the already-tested stop/reconnect fix and benchmark/install
   infrastructure through the normal review process. Verify the deployment
   separately; a pushed branch is not a production release.
3. Expand the relay baseline with representative PDF/PPTX/binary files at
   1–200 MiB, multiple senders up to the current 30-person limit, and both idle
   viewing and active navigation of a previously cached file. Measure per-file
   and whole-room completion, fairness, retries, memory and fully verified cache.

**Exit:** a recorded relay decision and trustworthy comparison data for the
subsequent changes. No R2 result is a prerequisite for continuing.

### Phase 1 — Shared room rules and lifecycle correctness

**Current slice:** shared control authorization/validation and restricted lease
renewal are implemented in both adapters. Close intent survives refresh; server
confirmation precedes cache deletion; failed cleanup retains its handle. Presenter
tabs no longer inherit host session storage and the fixed bridge cutoff is gone.
Generation-based cache identities are now negotiated at creation and shared by
the receiver, presenter, previews, export and cleanup; older rooms drain in place
without erasing active data. File/participant admission now shares synchronous
transitions and aggregate budgets across adapters. Remaining Phase 1 work includes
full command/revision/persistence orchestration, unauthenticated-socket bounds and
creation/join rate limiting. Physical background/OS suspension
behavior is still a release verification task. Personal multi-gigabyte transfer
mode is deferred at the user's request; the current 200 MiB cap stays unchanged.

**Touch:** both relay adapters, shared contracts/domain code, room lifetime,
client command handling and the reliability tracker.

1. Extract validated commands, admission, ownership, terminal transitions,
   idempotency and revisions into one room engine. Keep Node and Cloudflare
   socket/persistence details in adapters. Preserve current working behavior
   through matching contract tests rather than a simultaneous transport rewrite.
2. Fix hidden-dashboard liveness and the presenter's unrelated two-hour cutoff.
   Give the teacher shell/presenter a narrow lease-renewal capability, without
   granting the viewer original-byte access or transfer control.
3. Acknowledge End room before discarding credentials. Track server closure and
   local cleanup independently; reconnect must not resurrect closed/revoked work.
4. Bound aggregate room bytes/files, historical sessions, unauthenticated
   sockets and repeated joins/creation. Use immutable room generations for
   storage identity, separate from reusable six-digit codes.

**Exit:** both backends pass duplicate-command, stop/reconnect, stale-snapshot,
hidden-dashboard, host-takeover and lost-end-acknowledgment cases.

### Phase 2 — Move the relay transfer engine off the UI thread

**Touch:** room socket ownership, range transport, scheduler, progress and
cache-worker interfaces. Preserve the measured relay packet path initially.

1. Put byte transfer and its scheduling in a dedicated worker, with one owner
   for the transport and bounded message queues. Keep React responsible for
   commands/status; avoid duplicate sockets or full-buffer copies between threads.
2. Preserve fair automatic receipt across senders, bounded in-flight bytes,
   backpressure and adaptive concurrency. Viewer state must never enter this API.
3. Give every request a cancellation handle, deadline and attempt generation.
   Pause/revoke must cancel outstanding work, release slots and reject late
   results. A failed file must not restart healthy files or the entire room.
4. Resume missing verified ranges while the phone remains available. Report
   source disconnection honestly; do not imply the browser can recover a File
   lost when the sender page closed or the browser terminated.
5. Remove phone PDF parsing/preview generation from the transfer path and split
   sender, host and renderer entry bundles so sharing does not load viewer work.

**Exit:** large/multiple transfers remain responsive during UI activity, exact
bytes survive interruption/cancellation tests, and no material speed regression
appears against the relay baseline. Worker lifetime remains tied to its page.

### Phase 3 — Production OPFS cache and content integrity

**Touch:** transfer worker persistence, cache metadata, original-file manifests
and completed-file storage. This work is independent of remote object storage.

1. Adapt OPFS receipt to relay ranges, replacing the per-64-KiB IndexedDB write
   path. Keep compact metadata/checkpoints in IndexedDB and buffers bounded.
   Handle partial writes, quota errors, stalled operations and writer closure.
2. Hash source data off the UI thread and pin integrity metadata to an immutable
   file generation. Verify received content before declaring cached-ready;
   length/index checks alone do not detect same-length corruption. Account for
   hashing time in speed comparisons, including on slower phones.
3. Commit completion metadata only after validated persistence and writer close.
   On restart reconcile bytes/checkpoints, discard uncommitted tails and resume
   verified missing ranges instead of trusting stale 100% metadata.
4. Implement an immutable CompletedFileStore with reader leases. Cleanup must
   not remove a file while a viewer uses it. Surface cache eviction, unsupported
   storage and quota failures explicitly; no silent fallback to OS Downloads.
5. Verify browser support and migration before selecting any bounded fallback.
   Drain compatible existing rooms; do not clear active user cache to upgrade.

**Exit:** corrupt/truncated/interrupted writes never become ready, memory stays
bounded at 200 MiB, and storage removal/quota recovery affect only the relevant
file. Current Chrome/Firefox plus physical target-browser checks establish the
supported behavior; OPFS is not assumed to guarantee permanent storage.

### Phase 4 — Completed-file viewers with independent lifetimes

**Touch:** presenter bridge, PDF/PPTX adapters, optional image adapter and UI.

1. Give viewers only a completed local File/Blob and presentation metadata.
   Remove progressive reads and all original-byte network/scheduler capabilities.
2. Keep an already-open completed presentation usable after dashboard closure
   or network loss. Resolve local files through a narrow broker if needed;
   missing/evicted bytes show unavailable rather than triggering viewer fetches.
3. Lazy-load viewers; bound PDF canvases, archive expansion, renderer allocations
   and render concurrency. Cancel/destroy timed-out work and release resources
   on close. Isolate untrusted rendering from room credentials and host storage.
4. Support PDFs and PPTX/PPSX first, then ordinary images. Unsupported files
   still transfer exactly. Rendering errors remain separate from cache success.

**Exit:** navigation/zoom/open/close cannot alter transfer commands or byte
requests; cached presentation works offline while another original transfers.
Explicit Download a copy remains a separate optional user action.

### Phase 5 — Network compatibility, real-device proof and rollout

1. Test the retained WSS relay on actual campus networks. Deferring R2 does not
   automatically provide HTTPS file transfer when WSS is blocked. If required,
   separately design and measure an authenticated HTTPS relay fallback using the
   same transfer contract; control polling alone cannot carry the original bytes.
2. Test phone lock/reconnect, hidden host tabs, long sessions, independent
   networks, low storage and 50–200 MiB files on real classroom hardware. Include
   WebKit/iOS where support is intended; CI's browser results are not substitutes.
3. Repeat whole-room performance/fairness and viewer-contention measurements.
   Record original integrity, retries, failure/recovery rates and memory alongside
   latency. Keep the user's typical 7–10-second observation as a reproducible
   classroom target, not a universal network-speed promise.
4. Roll out new protocol/cache versions to new rooms in cohorts. Drain old rooms,
   retain rollback compatibility and remove obsolete scheduler/cache/viewer code
   after verification. Update deployment docs and audit statuses with evidence.

**Exit:** a measured relay-to-private-cache application with completed-file
viewing, bounded resources and documented recovery/network limitations.

## Immediate work order

Shared lifecycle/room-end/lease correctness first; then the relay worker engine
and OPFS/integrity integration together, followed by viewer migration and device
validation. The R2 prototype proves useful components, not production completion
of any of these phases.
