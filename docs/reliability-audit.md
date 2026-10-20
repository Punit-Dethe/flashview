# FlashView — Reliability Audit Tracker

**Status:** Living engineering document · **Last updated:** 19 October 2026 · **Baseline audit:** `0581111e2` · **Latest merged fix:** [`30f011b`](https://github.com/Punit-Dethe/flashview/commit/30f011b2931d7d3891466897e0ee262dba93eb9e) (PR #32's full CI passed; post-merge main CI was started). The original audit remains at 9 resolved, 3 partial and 18 open/unverified.

This document tracks the original **30 reliability findings** (H1–H10, M1–M14, L1–L6). It is not a new audit, and it does **not** count PRs as bugs: one PR may fix multiple symptoms; several PRs may address one finding.

## At a glance

| Priority | Verified resolved | Partially mitigated | Still open / not verified resolved | Total |
|---|---:|---:|---:|---:|
| High (H1–H10) | 7 | 3 | 0 | 10 |
| Medium (M1–M14) | 2 | 0 | 12 | 14 |
| Low (L1–L6) | 0 | 0 | 6 | 6 |
| **Original audit** | **9** | **3** | **18** | **30** |

**Status meanings:** `Resolved` = an identified failure path has a merged, passing regression test; `Partial` = important mitigations merged but the full category is still open; `Open` = known issue with outstanding work; `Needs baseline wording` = no confirmed original issue description was retained, so its resolution cannot be asserted. CI success verifies tested scenarios, **not** every device/network/production environment. The counts above treat all unverified entries as *not verified resolved*, not necessarily reproduced bugs.

**Product guardrails:** prioritize file-transfer reliability and speed over PDF/PPTX cosmetic work; never restart a whole room to repair one file; avoid introducing per-chunk relay metadata traffic; preserve the original file bytes and no-cloud-file-storage architecture. Make one isolated change at a time, with Node, Cloudflare, browser, and integrity/performance checks as appropriate.

## High priority

| ID | Status | Problem / user impact | Work done / what's still needed | Evidence |
|---|---|---|---|---|
| H1 | **Resolved** | Host handover could falsely announce that the host was offline. | Only mark offline if an old socket closed *without* a replacement host. | [`b73bde4`](https://github.com/Punit-Dethe/flashview/commit/b73bde4) |
| H2 | **Resolved** | Phone file offers could be delayed while an old host-availability flag stayed false. | Announce/replay offers after authenticated socket readiness even with stale host status. | [`b73bde4`](https://github.com/Punit-Dethe/flashview/commit/b73bde4) |
| H3 | **Partial** | Healthy files could remain at 0% when scheduler or browser-storage operations stalled. | Scheduler wake-up for new files [#24](https://github.com/Punit-Dethe/flashview/pull/24); IndexedDB deadline and retryable index reads [#27](https://github.com/Punit-Dethe/flashview/pull/27). **Left:** real-device suspended-tab, long-session and persistent-stall verification. | [#24](https://github.com/Punit-Dethe/flashview/pull/24), [#27](https://github.com/Punit-Dethe/flashview/pull/27) |
| H4 | **Resolved** | A single file/range error could force the entire room socket to reconnect. | Distinguish file-specific failures from genuinely unresponsive room connectivity. | [`3c1baa9`](https://github.com/Punit-Dethe/flashview/commit/3c1baa9) |
| H5 | **Partial** | One failed IndexedDB write could leave a document permanently stuck and silently incomplete. | Retry the original failed chunk without reuploading [#25](https://github.com/Punit-Dethe/flashview/pull/25); bound stalled writes [#27](https://github.com/Punit-Dethe/flashview/pull/27). **Now addressed in [#30](https://github.com/Punit-Dethe/flashview/pull/30):** repeated confirmed full-quota writes pause the affected file and show a persistent host Retry saving action. **Left:** real-device low-space validation and a larger-memory fallback policy. | [#25](https://github.com/Punit-Dethe/flashview/pull/25), [#27](https://github.com/Punit-Dethe/flashview/pull/27), [#30](https://github.com/Punit-Dethe/flashview/pull/30) |
| H6 | **Resolved** | Cloudflare forwarding could drop packets or overfill receiver buffers under backpressure. | Enforce bounded forwarding when queue metrics exist and avoid false rejection when they don't. | [`8ee1550`](https://github.com/Punit-Dethe/flashview/commit/8ee1550), [`6b9e599`](https://github.com/Punit-Dethe/flashview/commit/6b9e599) |
| H7 | **Resolved** | Lost completion acknowledgments could leave student-side Done/progress stale. | Add relay-receipted, idempotent completion notices and replay until receipted. | [`2ceaa43`](https://github.com/Punit-Dethe/flashview/commit/2ceaa43) |
| H8 | **Resolved** | Classroom could expire two hours after *creation* despite continued use. | Node and Durable Object now expire after the latest authenticated host activity; test alarm/recovery behavior. | [#23](https://github.com/Punit-Dethe/flashview/pull/23) |
| H9 | **Resolved** | Selecting an eleventh file produced an impossible phantom upload when the sender already had ten shares. | Enforce the existing ten-file-per-sender limit in picker and both relays; reject before creating a local card. | [`6b53c40`](https://github.com/Punit-Dethe/flashview/commit/6b53c40) |
| H10 | **Partial** | Large completed files amplified memory through bulk IndexedDB reads and duplicate full-size JavaScript buffers. | Cursor-based sequential reconstruction [#28](https://github.com/Punit-Dethe/flashview/pull/28); [#32](https://github.com/Punit-Dethe/flashview/pull/32) merged after full CI: downloads now build verified Blob parts without a second full-size JS buffer. **Left:** renderer allocations, real-device 50–200 MiB memory tests and pressure UX. | [#28](https://github.com/Punit-Dethe/flashview/pull/28), [#32](https://github.com/Punit-Dethe/flashview/pull/32) |

## Medium priority

| ID | Status | Problem / impact | Work done / what's pending | Evidence |
|---|---|---|---|---|
| M1 | **Resolved** | Progress repeatedly summed an ever-growing set of persisted 64 KiB chunk indexes (quadratic cumulative work). | [#31](https://github.com/Punit-Dethe/flashview/pull/31) maintains an O(1) byte counter updated on each committed add/delete/clear. One initial scan remains for browser cache restoration. Duplicate writes, stale-cache repairs and partial tail chunks have targeted tests, plus existing browser transfer/integrity and benchmark CI. | [#31](https://github.com/Punit-Dethe/flashview/pull/31) |
| M2 | **Open** | One IndexedDB write transaction per 64 KiB block increases storage overhead. | An **opt-in** batching A/B exists, not a proven default replacement. Profile actual mobile/desktop reliability and throughput before enabling; safeguard atomic resume. | [#15](https://github.com/Punit-Dethe/flashview/pull/15) |
| M3 | **Resolved** | In-memory cached-index data could claim 100% after a persisted chunk disappeared. | Cross-check persisted keys at completion, invalidate missing memory copies, retract stale Done, re-fetch missing ranges and verify byte hash. | [#26](https://github.com/Punit-Dethe/flashview/pull/26) |
| M4 | **Needs baseline wording** | Original finding description not available in committed audit records. | Recover exact finding, reproduce or inspect, then define a scoped fix/test. | Baseline `0581111e2` |
| M5 | **Needs baseline wording** | Original finding description not available in committed audit records. | Recover and verify before implementing. | Baseline `0581111e2` |
| M6 | **Needs baseline wording** | Original finding description not available in committed audit records. | Recover and verify before implementing. | Baseline `0581111e2` |
| M7 | **Needs baseline wording** | Original finding description not available in committed audit records. | Recover and verify before implementing. | Baseline `0581111e2` |
| M8 | **Needs baseline wording** | Original finding description not available in committed audit records. | Recover and verify before implementing. | Baseline `0581111e2` |
| M9 | **Needs baseline wording** | Original finding description not available in committed audit records. | Recover and verify before implementing. | Baseline `0581111e2` |
| M10 | **Needs baseline wording** | Original finding description not available in committed audit records. | Recover and verify before implementing. | Baseline `0581111e2` |
| M11 | **Needs baseline wording** | Original finding description not available in committed audit records. | Recover and verify before implementing. | Baseline `0581111e2` |
| M12 | **Needs baseline wording** | Original finding description not available in committed audit records. | Recover and verify before implementing. | Baseline `0581111e2` |
| M13 | **Needs baseline wording** | Original finding description not available in committed audit records. | Recover and verify before implementing. | Baseline `0581111e2` |
| M14 | **Needs baseline wording** | Original finding description not available in committed audit records. | Recover and verify before implementing. | Baseline `0581111e2` |

## Lower priority

| ID | Status | Problem / impact | Pending |
|---|---|---|---|
| L1 | **Needs baseline wording** | Original title not retained. | Recover original audit text; then reproduce/verify. |
| L2 | **Needs baseline wording** | Original title not retained. | Recover original audit text; then reproduce/verify. |
| L3 | **Needs baseline wording** | Original title not retained. | Recover original audit text; then reproduce/verify. |
| L4 | **Needs baseline wording** | Original title not retained. | Recover original audit text; then reproduce/verify. |
| L5 | **Needs baseline wording** | Original title not retained. | Recover original audit text; then reproduce/verify. |
| L6 | **Needs baseline wording** | Original title not retained. | Recover original audit text; then reproduce/verify. |

## Next engineering queue (not extra IDs)

1. **H5 — persistent quota UX ([#30](https://github.com/Punit-Dethe/flashview/pull/30)).** Visible pause after repeated quota errors and deliberate retry; verify on real low-storage phones and define a safe fallback that does not delete live room data.
2. **H10 — remaining memory pressure.** With [#32](https://github.com/Punit-Dethe/flashview/pull/32) limiting JS copies for downloads, profile PDF/PPTX rendering and 50–200 MiB mobile memory usage; verify missing-cache integrity and memory-pressure handling.
3. **H3 — remaining real-device stalls.** Validate long-lived host sessions, background tab suspension, student phone lock/reconnect and different internet connections.
4. **M2 — IndexedDB write amplification.** Evaluate the existing opt-in batching experiment on real devices with explicit throughput, fairness, and atomicity checks. M1 was addressed in [#31](https://github.com/Punit-Dethe/flashview/pull/31).
5. **M4–M14 and L1–L6.** Recover the original 17 missing descriptions from the 18 October 2026 read-only audit, or re-audit the current code and **explicitly assign new descriptions** (do not present guesses as original findings).

## 19 October transfer regression follow-up (in progress)

The user reported unpredictable 0%/mid-file stalls and slow recovery after the
phone file picker in the **main application**. This predates the isolated room
lifecycle preview. H3 remains **Partial**; the original 9/3/18 counts are unchanged.
The earlier passing tests did not cover a socket that remains OPEN while both
traffic and its close acknowledgement disappear. This report is evidence that
real-device validation is still needed, not grounds to mark those scenarios fixed.

| New ID | Status | Reproduced failure | Targeted correction |
| --- | --- | --- | --- |
| N7 | **In progress** | Repeated foreground events reset the 12-second probe; heartbeat/authentication timeouts then depend on an eventual WebSocket close event. | Retire obsolete sockets locally. Follow-up removes the probe wait after recorded sender suspension, freeze or network restoration; duplicate signals reuse one attempt. Ordinary focus and healthy receiver tab switches keep their connection. |
| N8 | **In progress** | When a replacement phone socket authenticates before the old socket closes, outstanding byte requests remain stranded on the old connection. | Both relays replay that sender's outstanding, uncancelled requests after its restored manifest, retaining request IDs and deadlines. The receiver clears old network backoff on authenticated reconnection. |
| N9 | **In progress** | A delayed join acknowledgement erases a file-selection validation error, including the ten-file limit warning. | Keep local validation errors when a join/resume response arrives after selection. |
| N10 | **In progress** | Losing the first join acknowledgement can make a replacement socket join as a second participant. | Generate the private resume capability before first hello; both relays adopt it. Verify pending approval, one participant and cached bytes across first-acknowledgement loss. |

`tests/socketRecovery.test.ts` reproduces N7 with a socket that never acknowledges
closure. `tests/transferRecovery.browser.ts` reproduces N8 with a blackholed phone
socket during a 20 MiB transfer, twice, and checks the SHA-256 of browser-cached
bytes. It also covers a file selected before the dead socket recovers. Run it
against Node, Cloudflare emulation, Firefox, and optionally an isolated deployment
using `RECOVERY_ORIGIN`. These simulations cannot establish phone/network timing
or prove the cause of every reported large-file stall. Keep transfer tuning and
the unmerged architecture changes separate while this recovery fix is validated.

Validation of recovery commit `b30c32c`: 48 unit/protocol tests passed; complete
Chromium browser suites passed on Node (22/22) and Cloudflare (22/22); Firefox
passed the interrupted-transfer scenario. On the isolated live Worker, two
mid-file interruptions reached renewed cache progress in 3.815 and 3.865 seconds with matching cached
SHA-256; the existing main deployment failed the same simulated picker-return
check before promotion. Three alternating live 20 MiB binary transfers per
deployment gave median cache completion of 4.249 seconds before and 4.198 seconds
with the patch, all hash-verified. This small same-PC comparison shows comparable
ordinary throughput; it does not measure physical phone/Wi-Fi reliability. The
cache-repair test also now releases future reads when ending its artificial
pause, removing a race in the test harness itself.

Timing clarification: those interruption-to-progress figures include a 600 ms
injected pre-return outage, as well as the probe and reconnect work. They are not
isolated foreground-to-reconnect measurements. See the separate
[foreground reconnect decision](./reconnection-design-proposal.md) and its
[two-policy evaluation](./reconnection-evaluation.md). The selected implementation
initiates replacement immediately after recorded sender suspension, freeze or
network restoration, coalesces return events, and preserves healthy receiver
focus. Researching twelve alternatives did not mean trialling all twelve.

## 20 October handover regression pass (in progress)

Review baseline: `ee20017` (the deployed WarpView header, on top of PR #37).
Both #37 and #38 passed GitHub CI. That did not cover the cases below.
These gaps also exist before the recent recovery changes; more frequent socket
replacement makes correct handover especially important. They are not proof
that every reported phone stall has the same cause. The original 9/3/18 audit
counts remain unchanged; these new IDs are separate and unmerged.

| New ID | Status | Reproduced failure | Correction and evidence |
| --- | --- | --- | --- |
| N11 | **In progress** | An obsolete Node phone can still revoke a file while its close handshake is pending. An obsolete Cloudflare host can still end the room. | Retire authenticated authority before sending close; clear Cloudflare's serialized attachment as well. Re-check host authority after awaiting storage. A protocol test pauses old clients' inbound close frames and tries both actions after takeover. |
| N12 | **In progress** | Node retains all 48 outstanding requests after receiver takeover; the new host cannot request bytes until old entries leave the table. Cloudflare already clears these requests. | Clear obsolete receiver requests before announcing authenticated room state. Fill all 48 slots, replace the receiver, and immediately transfer verified original bytes. |
| N13 | **In progress** | Both relays reject an existing phone's resume while the host is briefly offline. The client treats that rejection as leaving the room and loses its retained File references. | Authenticate a known private resume capability independently of host presence, preserve approval/manifest, and explicitly report `host.offline`. New admissions still require a host. Reconnect both ends and compare original bytes. |
| N14 | **In progress** | Explicit Stop sharing becomes approved again after sender reconnection. Cloudflare also retains the stopped file's outstanding requests. | Port the previously isolated terminal-stop slice from #35: persist `revoked`, share the transition helper, cancel requests, and reject late bytes. Test stop, replacement, replayed offer, rejected retry and late response on both backends. |
| N15 | **In progress** | An old asynchronous phone file read rejects after reconnect, sending `range.error` on the new socket and cancelling its replayed request. | Give each range response a connection-bound handle for both bytes and errors. The browser fault test holds old reads, reconnects, then rejects the held reads; before the fix, four stale errors reached the receiver. Verify exact final bytes and no stale errors after the fix. |

Before corrections, all four new relay scenarios failed against Node. Against
Cloudflare, N11/N13/N14 failed and the existing N12 behavior passed. After
corrections, all four pass against each backend. Node unit/protocol tests pass
59/59 after N15. Full Chromium browser suites passed 22/22 on each backend before
the final N15 response-handle change. On the final build, PDF transfer under
backpressure, universal binary integrity and the expanded interruption/late-read
scenario passed 4/4 on each backend; Firefox passed the expanded scenario too.
The latter verifies a 20 MiB cached SHA-256 after the injected failures. Final
release validation is recorded in the PR. These local timings are not campus
or physical-phone performance measurements.
The Cloudflare relay contract suite now runs in CI as well as Node's suite.

N14 advances Phase 0 of the [implementation plan](./architecture-improvement-plan.md).
It intentionally ports only terminal file state from #35; R2 remains deferred.
The independent lease/end-room work on #36 remains unmerged and is not part of
this patch. Mobile OS suspension and campus-network behavior still require
physical-device verification.

## 20 October room lifecycle integration (in progress)

The lease/end-room slice from #36 is reconciled onto the recovery/header line,
preserving N7–N15. This does not complete the full shared room engine or migrate
the local cache identity. Original audit totals remain 9 resolved / 3 partial /
18 open or unverified until appropriately tested fixes merge.

| New ID | Status | Problem / correction | Evidence |
| --- | --- | --- | --- |
| N16 | **In progress** | A hidden dashboard could stop renewing the classroom, while an unrelated two-hour timer silently shut down its presenter bridge. Dashboard and presenter now independently use a restricted generation-scoped HTTP lease; remove the fixed bridge cutoff. | Browser clock advance past two hours verifies both independent renewal and a fresh bridge handshake. Lease cannot authenticate as host, read original bytes or end the room. Physical OS suspension remains unverified. |
| N17 | **In progress** | End room discarded local credentials/cache before confirming relay closure. Lost close messages could leave the server classroom alive with no retry path. | Persist intent before sending; generation-scoped idempotent HTTP closure before local deletion. Browser faults cover failed request, committed closure with lost response, refresh and stale-generation denial on Node/Cloudflare. |
| N18 | **In progress** | Cleanup dropped its cache handle before deletion succeeded, making a later Retry falsely succeed without deleting the original cache. | Keep the handle until successful deletion, bound IndexedDB cleanup, and retain separate server-closed state. Tests cover immediate retry and refresh with network control blocked, plus old host-session upgrade without losing bytes. |
| N19 | **In progress** | Presenter popups inherited a copy of the dashboard's host credential through session storage. | Remove the copied host session and detach the opener before loading renderer code. Only the scoped lease identity crosses the existing bridge. This narrows authority; complete same-origin renderer isolation is still future work. |

Pre-integration PR #39 CI failed on the first Cloudflare browser test because the
emulator's default inspector socket was already in use. The remaining 21 browser
tests passed. A separate test-only follow-up on #39 assigns debugger ports through
the OS; this integration includes that correction. It does not weaken assertions
or change production networking.

Initial checks: 68 unit/protocol tests and 9 Cloudflare relay contracts pass.
The four lifecycle browser scenarios pass on Node, Cloudflare and Firefox;
the expanded Firefox interrupted-transfer/integrity scenario also passes.
Final broad suites and deployment validation are recorded with the integration PR.
Short-code cache-key migration, aggregate admission limits, full room-rule
extraction and worker/OPFS integration remain in the implementation plan.

## 20 October cache namespace integration (in progress)

N20: Original-byte and preview keys used only a reusable six-digit room code.
With the same file ID, a later room could inherit old same-length chunks and
incorrectly report complete, or read/delete another room's cached data. New
clients now negotiate `cache=2`; both relays pin that choice and advertise an
immutable generation namespace at creation and host sync. The receiver persists
and uses it throughout cache, presenter, exports and cleanup.

Older clients and existing rooms keep their original cache layout, including
when adopting generation-scoped lease credentials. New rooms never fall back to
legacy bytes. This drains old rooms rather than deleting or copying live data.
It does not resolve content hashing, arbitrary same-origin access, storage
eviction, aggregate admission or independent viewer lifetime.

The new browser regression seeds complete same-length chunks and previews under
the reused code and another generation, transfers the same file ID, disconnects
the source, refreshes, checks the original export hash, then confirms cleanup
preserves the other caches. A second case creates a real legacy-mode room and
verifies exact bytes and cleanup after saved lease/cache metadata is removed.
Protocol coverage checks creation, sync, host takeover and old-client creation
against both adapters. Original 9/3/18 audit counts remain unchanged until merge.

Prior recovery PRs #39 and #40 have now both passed their complete CI runs.
Current slice's final validation and release evidence are recorded in its PR.
Local validation: 71 unit/protocol tests, 10 Cloudflare relay contracts, full
Chromium browser suites 28/28 on Node and 28/28 on Cloudflare, and 7/7 targeted
Firefox cache/lifecycle/interrupted-transfer cases passed. The strengthened cache
restoration case also removes saved namespace metadata before refresh and checks
that preview reads use only the authenticated namespace. Build, TypeScript and
Worker dry-run passed. Physical devices/campus networks remain unverified.

## 20 October shared admission integration (in progress)

PR #41's complete CI passed. The following slice advances Phase 1 without
changing the relay packet size, transfer queue or 200 MiB per-file cap. It does
not complete shared room-command/revision orchestration or abuse protection.

| New ID | Status | Problem / correction | Evidence |
| --- | --- | --- | --- |
| N21 | **In progress** | Per-sender limits allowed room-wide file bytes and historical join identities to grow far beyond one receiver's intended working set. Shared synchronous admission now reserves at most 300 retained manifests / 4 GiB, bounds retained identities at 120 and enforces the existing 30 simultaneous sender places on disconnected resumes as well as new joins. Exact retries/takeovers keep their place and known capabilities are never evicted. | Protocol cases fill the byte budget, race its last 100 bytes, test stop/replay, verify healthy byte forwarding, fill active places and all 120 identities. Known temporary capacity failures keep private resume identity and retry. |
| N22 | **In progress** | An admission failure could leave a phone retrying an unaccepted candidate indefinitely. Existing duplicated offer code could also promote a legacy pending manifest before checking its owner/immutable metadata. | Shared validation precedes mutation; structured rejection stops replay and releases only the candidate's local slot. Unit cases retain pending state under conflicts; browser case fills metadata budget without transferring gigabytes, repeatedly reconciles, selects nine further candidates, and verifies the original cached download. |
| N23 | **In progress** | Host rejection waited for socket closure before releasing sender authority/place/ranges. A suspended sender could delay cleanup. A raw browser close also stalled in Cloudflare emulation. | Retire authority and serialized attachment before persistence/close, cancel ranges, retain cached originals offline. Paused-close protocol test attempts late bytes/revoke/new offer and checks no mutation. Cloudflare's event handler explicitly completes closure; targeted browser fixture verifies the close event. |

4 GiB is a room-wide reservation policy, not a higher per-file allowance or a
promise of browser storage availability. Completed, offline and stopped files
stay charged until the room ends because cached bytes may remain. Existing
over-budget legacy rooms retain their originals/replays; new admissions fail
without deletion. A fresh identity can still join an open-admission room after
host rejection but cannot inherit another identity's files.

Remaining Phase 1 work includes unauthenticated sockets and distributed
creation/join rate limits. Full room-engine revisions/persistence and subsequent
worker/OPFS/integrity/viewer phases remain pending. Original 9/3/18 counts are
unchanged until appropriately verified fixes merge. Release evidence is recorded
with the integration PR; physical-phone/campus proof remains pending.

Local checks: 81 unit/protocol tests, 14 Cloudflare relay contracts, full Chromium
browser suites 29/29 on Node and 29/29 on Cloudflare, and 8/8 targeted Firefox
cases passed. Build/TypeScript/Worker dry-run passed. The initial new Cloudflare
browser case exposed the raw-close stall; it passes after the explicit close
reply. A separate browser check against pre-release public version `95da8029`
also did not receive a raw sender close event within five seconds. Post-release
public validation is recorded in the PR. One early existing relay-contract wait
timed out; its isolated and subsequent full runs passed, and timeout diagnostics
now identify the awaited message. This does not establish a cause for every
reported phone/network stall.

## 20 October connection guards integration (in progress)

PR #42's full CI passed. N24–N27 continue Phase 1 on top of the shared
admission/recovery line; the original 9/3/18 counts remain unchanged until merge.

| New ID | Status | Problem / correction | Evidence |
| --- | --- | --- | --- |
| N24 | **In progress** | Unauthenticated sockets could remain indefinitely and consume relay resources. Bound pending sockets (64 per Cloudflare room / 256 per Node process), total sockets including closing connections (128 / 4096), and require authentication within ten seconds. Cloudflare's single alarm services both authentication and room expiry; host renewal cannot postpone login cleanup. | Real socket tests fill the pending pool, verify 503, authenticate one to free a slot immediately, expire idle peers, admit another login and forward exact bytes over the original authenticated phone. Cloudflare owns final TCP closure: application access is retired at expiry; a hard ten-second TCP teardown is not promised. |
| N25 | **In progress** | Cloudflare lacked a durable source creation quota; Node's source map was unbounded and allowed only 20 creations/hour, which is tight for shared campus addresses. Apply 120 creations/source/hour, a bounded Node map, and 120 new identities/room/minute. Cloudflare persists counters in source-hash-prefixed objects in the existing namespace; scheduled cleanup expires the one-hour metadata. Known private resumes and host takeovers bypass the new-identity quota. | Protocol tests exhaust each quota, preserve quota after host rejection, resume existing files at the limit, reject foreign Origin before charging, ignore spoofed forwarded-for and verify creation denial survives a Cloudflare emulator restart. Unit tests cover expiry, immutable windows and bounded maps without evicting active quotas. |
| N26 | **In progress** | A throttled new phone could repeatedly reconnect or lose its selected File references if temporary denial was treated as leaving. Honor the server retry deadline, coalesce return events while waiting, retain the workspace and clear only its own notice after admission. Room creation displays the server's meaningful error. | Fake-clock socket test fires twenty return/retry events without bypassing the deadline; a real browser selects a file during a four-second injected admission wait, resumes the same private identity, verifies the cached original and clears the notice. Tested on Node, Cloudflare and Firefox. |
| N27 | **In progress** | The first public guard deployment returned `404` during creation despite local tests passing; it was immediately rolled back. The new edge endpoint depended on a Durable Object method absent from the previous version. | Add compatibility for exactly the old guard-endpoint `404`, preserving established creation during version overlap. Other denials/errors/exceptions never bypass enforcement. A response header reports legacy/enforced mode. Fault tests cover legacy, allowed, quota denial, server failures and thrown storage errors. Quotas are deliberately absent while the object still runs pre-guard code; release evidence must verify enforced mode. |

These are bounded resource policies, not complete DDoS protection or proof that
shared campus addresses can never encounter a limit. Source hashes are
pseudonymous. Node counters remain process-local and do not trust forwarded
addresses; a reverse-proxy deployment needs a deliberate trusted-source policy.
Cloudflare socket/alarm scheduling still depends on its runtime. The changes add
no quota work to individual binary packets and keep the 200 MiB per-file cap.
Full shared command/revision/persistence orchestration, worker/OPFS integration,
content integrity and independent completed-file viewers remain pending.

Initial validation: 88 unit/protocol tests, 17 Cloudflare relay contracts, 30/30
Node Chromium checks and 9 targeted Firefox checks passed. The first full
Cloudflare Chromium run passed 29/30: the packet-size case timed out waiting for
its file input, before any bytes were selected. Its isolated rerun passed; the
cause is unconfirmed. The subsequent full Cloudflare run passed 30/30. Deployment
evidence is recorded in the PR. TypeScript, build and Worker dry-run passed. Physical phones and campus
networks remain unverified.

Cloudflare documents the [mixed-version code-update window](https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates).
It is consistent with the initial public `404`; the immediate rollback avoided
leaving that dependency failure deployed. The simultaneous browser check also
failed to find the homepage's Create button; its asset/propagation cause was not
established. Public verification now checks the referenced JavaScript asset as
well as creation, authentication, idle expiry and interrupted original bytes.
After the compatibility change, all 89 unit/protocol cases, 17 Cloudflare relay
contracts and three targeted Cloudflare browser cases (packet sizes, admission
wait and interrupted 20 MiB integrity) passed. Final live results are recorded
in the PR.

## 20 October shared file engine integration (in progress)

PR #43's full CI passed. N28–N30 advance the shared room-engine phase on top of
that release; the original 9/3/18 counts remain unchanged until merge.

| New ID | Status | Problem / correction | Evidence |
| --- | --- | --- | --- |
| N28 | **In progress** | File offer, completion/reset, approval, Stop and disconnect/resume logic was duplicated across the two relay adapters. A shared `RoomFileEngine` now owns those metadata transitions and their effects. It preserves budgets, ownership, terminal Stop, exact retries and optional per-file revisions, while leaving sockets/storage/byte forwarding in adapters. | Shared unit cases cover unauthorized commands, immutable snapshots, legacy records, terminal state, duplicate receipt/Stop and restoration. One contract scenario runs on both adapters and checks revisions, lost-receipt retry, zero reset, Stop/replay, disconnect/resume and exact original bytes; Cloudflare also restarts with persisted metadata. |
| N29 | **In progress** | Cloudflare emitted some file updates before saving, and other updates after an await without checking whether a newer transition had superseded them. Disconnect cleanup also sent `student.left` after awaiting persistence even if the private identity had returned. | Publish after a confirmed save and re-evaluate immutable transition identity; suppress old approval/completion/offline effects, reconcile delayed offers to current state and recheck current participant/generation. Cancel obsolete ranges before awaiting disconnect persistence. Approval/session and affected legacy file metadata commit together. Unit tests deliberately reverse transition completion; these expose ordering hazards, not a reproduced physical-device stall. |
| N30 | **In progress** | The extracted engine needed an explicit pending-versus-saved contract: a non-resetting persistence adapter could otherwise treat a duplicate after a failed write as already saved. This is a forced adapter-fault case, not a reproduced Cloudflare outage; Cloudflare already resets objects and discards output on disk-write failure. | Track pending mutation/checkpoint versions, confirm only successful adapter writes, flush dirty metadata on command retry and authenticated snapshots, and keep newer changes pending when an older write finishes. Fault tests fail offer and completion writes, retry identical commands, hold an older save across Stop, and confirm already-saved retries perform no extra write. |

Initial full browser suites passed 30/30 on Node and 30/30 on Cloudflare, with
9 targeted Firefox cases. After the persistence-checkpoint follow-up, all 97
unit/protocol cases, 18 Cloudflare relay contracts, 11 targeted Cloudflare browser
cases and TypeScript/Worker dry-run passed. Build passed before that backend-only
follow-up; client assets are unchanged. Final speed/live evidence is recorded in
the [integration PR](https://github.com/Punit-Dethe/flashview/pull/44) and
[validation report](./room-engine-validation.md). The public 20 MiB median was
4748 ms before and 4676 ms after (three samples each, all exact cached hashes),
and a room prepared before deployment retained private resume, completion
metadata, exact original bytes and terminal Stop afterward.

This is the file-metadata portion of the room engine. Participant command rules,
room-wide revisions/snapshot ordering and full persistence orchestration remain
pending. Optional file revisions are compatible metadata, not content hashes or
client-side stale-snapshot protection. Node still loses room metadata on process
restart. No per-packet storage work, new transfer scheduler, R2 path, cache
migration or larger per-file allowance is introduced. Physical phones/campus
networks remain unverified.

Cloudflare's default [storage input/output gates](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
remain enabled: successful `put()` submission may precede disk flush, while
outgoing messages wait for confirmation and failed writes reset the object.
The shared checkpoint tests deliberately model failure without that automatic
reset. They make the engine's adapter contract explicit; they do not prove the
deployed runtime previously acknowledged failed disk writes.

## 20 October room metadata engine integration (in progress)

PR #44's full CI passed. This finishes the planned shared metadata-engine
implementation on the integration line; the original 9/3/18 counts remain
unchanged until appropriately verified fixes merge.

| New ID | Status | Problem / correction | Evidence |
| --- | --- | --- | --- |
| N31 | **In progress** | Participant admission, capability ownership, names, approval/rejection and host presence were still duplicated between adapters. Shared `RoomEngine` now owns these transitions, including retiring an offline capability without deleting retained originals. | Unit cases cover immutable pending/approval results, private takeover, obsolete disconnects, join quota after rejection, host absence, end and offline rejection. Matching relay contracts check pending-private snapshots and ensure a retired capability cannot regain old file ownership. Existing capacity, Stop and byte-forwarding contracts remain. |
| N32 | **In progress** | File-only saves could not express one ordered checkpoint for session, file, quota and room-revision state. | One serialized/coalescing queue atomically saves existing `files`, `sessions`, `joinWindow` plus additive `roomRevision`. Failed writes stay retryable; queued saves cannot recreate an ended room. Restore active authority from trusted attachments plus durable sessions. Fault tests hold/fail saves and race End; the Cloudflare contract restarts with a persisted room revision and verifies it advances on host return. Default platform storage gates remain enabled. |
| N33 | **In progress** | Clients had no room-wide stale-snapshot guard; replaying an older list or pending approval could replace current UI state. Terminal notices could stop recovery before the UI checked generation. | Generation-scoped room revisions reject older metadata, preserve equal-revision effects, request private resync and leave same-generation host capability negotiation intact. Pending snapshots include only own files/approval/host status. Socket rejects foreign/old terminal notices before stopping. The browser injects old room/pending snapshots plus a foreign closure, verifies the cached row never disappears, preserves cache identity and exports the exact original on Node/Cloudflare/Firefox. |

110 unit/protocol cases passed, including 19 Node contracts; a fresh complete
Cloudflare contract run also passed 19/19.
Full Chromium suites passed 31/31 on each backend and 10 targeted Firefox cases
passed. Build/TypeScript and Worker dry-run passed. An initial Cloudflare
new-join-rate wait timed out during a run concurrent with an asset build; the
isolated and subsequent full 18-case runs passed, followed by the new 19th
contract and strengthened revision-restoration case. The cause of that initial
timeout is unconfirmed; it is not silently counted as a passing run.
Fresh-suite, speed and public release evidence are recorded in
[shared room engine validation](./shared-room-engine-validation.md) and the PR.

This does not migrate byte routing, packet sizes, scheduling, browser storage or
viewers. Node retains process-local metadata. Legacy unstamped peers remain
compatible without the new ordering guarantee. End-to-end worker/OPFS transfer
isolation, content hashes, completed-file readers/viewers, campus/device proof
and broader operational abuse controls remain later work. R2 and personal
multi-gigabyte mode remain deferred; the 200 MiB cap is unchanged.

## 20 October relay transfer worker integration (in progress)

Parent PR #45 passed full CI. This slice retains relay transport, packet sizes,
IndexedDB schema and the 200 MiB cap; it changes browser ownership. Counts for
the original 30 findings remain unchanged until merge.

| New ID | Status | Problem / correction | Evidence |
| --- | --- | --- | --- |
| N34 | **In progress** | File reads, socket handling, scheduling, cache writes and completion notices depended on the UI event loop. A dedicated worker now owns these on each page; authoritative metadata drives receipt before React sees it. A bounded/coalesced mailbox carries status and bounded passive cache RPCs. | A browser case blocks both UI threads for ten seconds, independently observes complete persisted bytes and relayed completion before either returns, then exports the exact original. See worker validation for complete suites and public speed comparison. |
| N35 | **In progress** | Pause removed queued jobs without cancelling their pending range/write attempts. A source revoked during send-buffer backpressure could also finish its old send. | Per-file abort controllers cancel ranges/storage attempts, invalidate uncommitted memory and prevent obsolete results from changing a new attempt's backoff. Sends recheck authority during backpressure. A browser holds source reads, completes a healthy file, drops range-error notices, stops the held file, verifies cancellation and releases old reads without late binary responses. A unit case revokes during send backpressure. |
| N36 | **In progress** | A new worker failure boundary must not silently lose private identity/File handles, leave RPCs pending or create a parallel UI scheduler. | Worker replacement terminates the old owner, rejects pending reads and retains initial private capability, learned generation and source handles. Two automatic attempts are bounded. Browser tests crash sender/receiver mid-file and verify one participant/file plus exact export. Bridge cases cover settlement, cancelled reads, stale-session replies, startup failure and exhaustion. Page cleanup can delete only after a failed worker is terminated. |
| N37 | **Open** | Complete UI independence is not established in the tested Firefox build: worker timers ran during a ten-second parent-page busy loop, but native Blob reads and incoming WebSocket delivery waited for the page to yield. | In the gated native-read stress test, first source read/send and receiver delivery occurred at/after the block ended. A test-only FileReaderSync probe moved source reading/sending inside the block, but receiver delivery still waited; that probe is not production code. Chromium must finish persistence/relayed completion inside both blocks. Firefox is explicitly tested for bounded, exact recovery after the block, not silently counted as passing the stricter criterion. Mitigation continues through bounded renderer work/process separation and real-browser/device validation. |

Initial checks caught React callback replacement delaying displayed completion;
the listener is now bound from the stable presentation instance. Page-only fault
hooks also had to move into the actual worker. Failed attempts are not counted
as passes. See [worker validation](./relay-worker-validation.md) for final
suite/release/performance results. OPFS, production content hashes, phone PDF
preview removal, completed-only viewers and physical-device/campus proof remain
pending. This slice does not complete the entire roadmap.

## How to keep this tracker current

- Each reliability PR **must** link affected IDs and update the affected tracker rows, status counts, completed approach, regression coverage, and remaining limitations in this same PR.
- A status changes to **Resolved** only when the relevant fix has merged with the appropriate CI checks. For an unmerged PR, label the work **In progress**, not **Resolved**.
- Don't silently overwrite old issue IDs, reassign severity, or count experimental switches as a complete fix.
- After every merge, confirm `main` CI and record the verified commit or PR; **production deployment and real-device reliability require separate verification**.
- If a new issue is found, give it its own ID outside the original 30 (for example `N1`) instead of hiding it inside an unrelated old item.
