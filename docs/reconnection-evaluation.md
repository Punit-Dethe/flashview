# Immediate foreground reconnect evaluation

19 October 2026. Two policies were selected for comparison: the existing
two-second probe and one immediate, coalesced replacement after recorded sender
suspension. The other researched alternatives were not implemented or trialled.

The candidate preserves healthy receiver focus, handles freeze/resume and
persisted page restoration, and retains outage backoff. Sender File objects,
approval and browser-cache chunks survive. A private 256-bit resume capability
is generated before the first hello; both relays adopt a valid initial
capability so even loss of the first join acknowledgement cannot create a
second student. Existing clients retain server-generated capability behavior.

## Interrupted transfers

Three initial live tests per deployment, two interruptions per 20 MiB file:

| Policy | Return-to-persisted-progress samples (ms) | Median |
| --- | --- | --- |
| Existing probe | 3175, 2546, 3465, 2593, 2579, 3023 | 2808 ms |
| Immediate replacement | 768, 489, 507, 984, 542, 561 | 551.5 ms |

All received files passed SHA-256 verification. Each immediate return handler
created exactly one replacement, despite consecutive resume/focus/pageshow
events. These are small, same-PC browser simulations over the public Cloudflare
network, initially using separate main/preview Workers. The approximately 80%
median reduction is an observed screening result, not a guaranteed phone/network
speedup. A final candidate smoke including lost first acknowledgement also
passed with return-to-progress times of 566/957 ms.

A same-Worker, same-build confirmation with the comparison query then passed
both policies: probe returned to persisted progress in 3067/1638 ms, immediate
in 477/1139 ms. Each immediate return handler constructed one connection in
0.3–0.4 ms. This confirmation also checked lost first acknowledgement, one
participant, a healthy empty picker return and the final cached-file hash.

The clock starts at the simulated return event. A separate interruption clock
includes 600 ms of deliberately injected pre-return outage; it must not be
reported as pure foreground recovery time.

## Healthy transfers and selection gate

An initial three-run-per-deployment comparison was uneven: median 20 MiB
selection-to-cache completion was 4.214 seconds on main and 5.718 seconds on
the preview. It included healthy native picker interaction and final hash
verification. This potentially material difference must not be described as
unchanged throughput or dismissed as noise without a control.

The controlled follow-up uses the **same preview Worker and build** for both
policies, alternating their order for five transfers each. The only policy
switch is `?resumePolicy=probe` versus the default immediate policy; the real
picker, initial session protocol, file bytes, packet/cache sizes and hash
verification are identical. No other browser tests run concurrently with this
measurement. The switch is an experimental query parameter, with no product UI.

The committed harness is `tests/resumeThroughput.ts` (`npm run bench:resume`).
Set `RESUME_BENCH_ORIGIN` to an isolated deployment of this build; optionally
set `RESUME_BENCH_RUNS` (1–10, default 5). It alternates policy order, transfers
the same random 20 MiB original, hashes browser-cached bytes and closes its own
rooms. Results are written to ignored `test-artifacts/` files. The interrupted
scenario is `tests/transferRecovery.browser.ts`; `RECOVERY_ORIGIN` selects the
deployment and `RECOVERY_POLICY=probe|immediate` selects the control/candidate.

Promotion requires both prompt stale-connection recovery and acceptable healthy
selection-to-cache timing. A faster recovery number alone is insufficient.

Controlled healthy results (20 MiB, five transfers per policy, all SHA-256 verified):

| Policy | Selection-to-cache completion samples (ms) | Median |
| --- | --- | --- |
| Probe | 4338, 4231, 4205, 4404, 4183 | 4231 ms |
| Immediate | 4827, 4738, 4196, 4849, 4272 | 4738 ms |

The immediate policy adds 507 ms (about 12%) at the median in this small healthy
picker sample. It should not be advertised as a universal speed improvement.
The selected trade-off favors prompt recovery after a recorded sender suspension
and keeps ordinary focus/healthy receiver tab switches on their existing
connection. One fresh connection can cost a handshake when the old phone socket
was still healthy. This must remain visible in release notes and physical tests.

## Validation and limits

The complete Node/Cloudflare Chromium suites passed 22/22 each for the immediate
policy. After adding the lost-first-acknowledgement safeguard, the Node protocol
test and the expanded Chrome/Cloudflare/Firefox transfer scenario passed,
including exactly one participant, a healthy empty picker return, two mid-file
blackholes and exact cached bytes. Unit coverage includes healthy receiver
focus, real freeze, duplicate wake signals, initial capability generation and
closed-socket backoff bypass. Build, TypeScript and Worker dry run passed.
The final unit/protocol run passed 54/54. The expanded scenario also checks a
network-restoration hint received while the receiver is hidden, followed by
immediate reconnection on return and byte-exact completion.

Physical Android/iOS and campus-network testing remains outstanding. Source and
deployment status are tracked in [PR #37](https://github.com/Punit-Dethe/flashview/pull/37).
