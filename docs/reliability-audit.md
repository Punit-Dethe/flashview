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

**Product guardrails:** prioritize file-transfer reliability and speed over PDF/PPTX cosmetic work; never restart a whole room to repair one file; avoid introducing per-chunk relay metadata traffic; preserve original file bytes and private browser caching. Retain the relay while R2 is deferred after live testing. Make one isolated change at a time, with Node, Cloudflare, browser, and integrity/performance checks as appropriate. Follow the [current implementation plan](./architecture-improvement-plan.md) for the remaining architecture work.

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

## New implementation findings (outside the original 30)

| ID | Status | Finding and evidence |
|---|---|---|
| N1 | In progress — PR #35 CI passed; unmerged | Explicit stop previously used the same offline state as disconnection and could be undone on resume. A shared file lifecycle now persists a terminal `revoked` marker; both relays cancel pending ranges. `tests/relay.test.ts` verifies stop, late bytes, reconnect, replay and normal disconnect recovery against Node and local Cloudflare. The isolated relay deployment includes the fix; main/production release remains pending. |
| N2 | In progress — PR #35 CI passed; unmerged | Benchmark reported the first completed file as all completed, accepted rounded percentages, and mislabeled default packet size. The v2 observer measures every explicit completion/retraction; SHA-256 cache readback checks original bytes. Browser observer regression, simultaneous-sender local benchmarks and full CI pass. Historical v1 performance results are not equivalent to v2. |
| N3 | In progress — implemented; unmerged | Hidden-dashboard heartbeats/sync were suppressed, leaving Cloudflare expiry dependent on foreground activity; the presentation bridge also closed after a fixed two hours. Restricted HTTP leases now renew independently from dashboard/presenter, and the fixed cutoff is removed. Shared authorization tests and Node/local Cloudflare browser regressions cover hidden renewal, presenter renewal and a two-hour clock advance. Physical all-page suspension remains a limitation. |
| N4 | In progress — implemented; unmerged | Host erased cache/credentials after an unchecked WebSocket end send; Cloudflare announced closure before durable deletion. Close intent is now persisted, generation-scoped HTTP closure is confirmed before local deletion, and Cloudflare persists termination before announcing it. Browser fault tests cover failed/lost responses, refresh and retry; contract tests cover authorization and obsolete generations. Full shared engine and cache-generation migration remain pending. |
| N5 | In progress — implemented; unmerged | A failed local room deletion detached its cache handle, so the next retry could falsely succeed. Retain the handle until actual deletion, preserve confirmed server closure, and bound the delete transaction deadline. Browser tests abort the first deletion, check retained bytes/session, then prove retry really clears the original cache. |
| N6 | In progress — implemented; unmerged | Presentation tabs inherited a copy of the dashboard host secret in sessionStorage. Blank-tab initialization now removes that copy and detaches the opener before renderer navigation. Browser regression checks the presenter has no stored host session; only scoped lease fields are passed in metadata. This is not full same-origin renderer storage isolation. |

These entries do not change the original audit's resolved counts. R2 is now
deferred; physical campus/device reliability and performance remain verification
gates for the retained relay and its future worker/cache improvements.

## How to keep this tracker current

- Each reliability PR **must** link affected IDs and update the affected tracker rows, status counts, completed approach, regression coverage, and remaining limitations in this same PR.
- A status changes to **Resolved** only when the relevant fix has merged with the appropriate CI checks. For an unmerged PR, label the work **In progress**, not **Resolved**.
- Don't silently overwrite old issue IDs, reassign severity, or count experimental switches as a complete fix.
- After every merge, confirm `main` CI and record the verified commit or PR; **production deployment and real-device reliability require separate verification**.
- If a new issue is found, give it its own ID outside the original 30 (for example `N1`) instead of hiding it inside an unrelated old item.
