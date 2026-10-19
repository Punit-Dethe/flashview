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

## How to keep this tracker current

- Each reliability PR **must** link affected IDs and update the affected tracker rows, status counts, completed approach, regression coverage, and remaining limitations in this same PR.
- A status changes to **Resolved** only when the relevant fix has merged with the appropriate CI checks. For an unmerged PR, label the work **In progress**, not **Resolved**.
- Don't silently overwrite old issue IDs, reassign severity, or count experimental switches as a complete fix.
- After every merge, confirm `main` CI and record the verified commit or PR; **production deployment and real-device reliability require separate verification**.
- If a new issue is found, give it its own ID outside the original 30 (for example `N1`) instead of hiding it inside an unrelated old item.
