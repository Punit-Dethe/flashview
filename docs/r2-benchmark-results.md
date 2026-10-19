# Phase 0 results — 19 October 2026

Historical experiment record restored on 20 October from PR #35/#36. Prototype
code and its additional tests remain on those branches; this recovery branch
does not integrate the R2 gateway or the pilot's worker/cache engine.

**Decision: defer R2 and retain the existing relay.** After trying the deployed
pilot, the user also reported substantially slower transfers and chose to skip
R2 for now. This is additional qualitative feedback, not another controlled
timing sample. Neither tested R2 layout demonstrated comparable live speed in
the measured pilot. Continue the worker/cache/reliability improvements through
the [relay-first implementation plan](./architecture-improvement-plan.md).

## Live pilot

Three repetitions per candidate, one sender, one incompressible 20 MiB file,
Chromium on this computer. Runs were sequential. The relay ran in its own
protected Cloudflare deployment using the current app; R2 used a separate
protected Worker and APAC Standard bucket. Timing ends at complete browser
caching plus bounded original SHA-256 readback. No viewer was opened.

| Candidate | Settings | Median verified cache time |
|---|---|---:|
| Existing live relay | 256 KiB packets, existing IndexedDB cache | 2.86 s |
| R2 completed object | 5 MiB multipart, up to 4 uploads, then one GET into OPFS | 8.34 s |
| R2 transfer-only pipeline | 8 MiB checked segments, up to 4 uploads, overlapping receipt into OPFS | 8.32 s |

The two R2 pilots are about 2.9 times the relay median. The observed difference
is large enough to trigger the user's reconsideration requirement. These are
small pilot samples, not a campus speed guarantee or a finding that R2 cannot
meet the target after changing the data path.

The completed-object runs spent roughly 4.0–4.3 s in upload including finalization,
1.1–1.4 s in admission, and 2.6–3.0 s in cache receipt/readback. Serial stages and
control overhead are visible contributors; the experiment does not isolate
every underlying network/storage cause. The segmented prototype also performs
11–13 metadata snapshots and three original reads for this case. Its current
polling/read path did not recover the speed gap.

The R2 timing revision used here preloads the cache worker before file selection
and performs admission through the sender's browser connection. Earlier runs
with a separate Node admission connection/cold worker startup are exploratory
and should not be mixed into this table. Relay v1 reports are also not equivalent:
the old benchmark measured the first completion and could mislabel packet size.

## What is implemented and verified

- All-file cache observer: explicit completion, corrections, and bounded original
  hash verification. A browser regression distinguishes rounded 100% from actual
  completion and handles a previously completed file being retracted.
- Isolated authenticated R2 gateway: small PUT, multipart, repeated completion,
  verified length, and cleanup. An alternative checked-segment experiment exists
  only for comparison, with no viewer priorities or early rendering.
- Worker-owned OPFS receipt with bounded 8 MiB buffers, write-count handling,
  flush/close, and persisted-byte SHA-256 readback. The completed-object receiver
  starts after the phone page closes; receiving does not require that sender.
- Local emulator runs include two simultaneous 20 MiB files and one 200 MiB
  multipart file. Local timings are not evidence of actual R2 performance.
- The test bucket was observed reporting zero objects after live run cleanup;
  explicit deletion and a one-day lifecycle/abandoned-upload backstop are configured.
- Shared terminal stop behavior prevents reconnection/replayed offers from
  restoring revoked files. Both backends reject their late range responses.

Validation completed: TypeScript, application build, production Worker dry-run,
benchmark observer test, local R2 API/fault test, 45 ordinary tests (plus the R2
test separately), all three relay tests on both Node and local Cloudflare, and
three Chromium smoke scenarios covering PDF flow, mobile progress, and general
binary integrity. The subsequent full PR #35 CI run on `f2b21b4` also passed
Chromium, Firefox presenter checks, local Cloudflare browser checks and benchmark
comparisons. WebKit and physical classroom/device fault testing remain outstanding.

## Deferred experiment and evidence to preserve

A real-device pilot is now implemented alongside the automated runner. It has
expiring role-scoped invitations, worker-owned source hashing/upload and FIFO
OPFS receipt, persisted original-byte verification, cached PDF/image preview,
and an explicit timing-report export. The integration test closes the sender
before the host starts receiving, verifies exact OPFS bytes, checks that no
automatic download occurs, and confirms preview makes no original-byte network
request. The same pilot integration test also passed against the deployed R2
Worker, including rejecting a corrupt original and removing its partial OPFS
cache. It does not constitute a physical-device or campus result.

The manual pilot displays separate device-local stage times; one-second host
discovery polling and source admission are not hidden inside a claimed complete
cross-device timing. Use the automated overall metric or an external stopwatch
for that comparison. New part diagnostics separate authorization, provider/body
streaming, and durable receipt; they do not by themselves explain the whole gap.

If R2 is explicitly revisited later, use the gateway diagnostics and
isolate cache reads further; remove unnecessary
per-file/control round trips and test notification-driven transfer pipelining
against the current polling prototype. Test actual representative files and
physical phones on campus, including WSS-blocked operation and recovery.

A small speed tradeoff might be justified by improved connectivity and durable
receipt, but the present gap was not accepted. R2 tuning and production migration
are deferred. The classroom application retains its existing byte path; only
isolated test deployments use R2. Their resources and prototype code have not
been deleted as part of this decision.

Raw local reports are in ignored `test-artifacts/`. Reproduction instructions
and limitations are in [the experiment guide on the pilot branch](https://github.com/Punit-Dethe/flashview/blob/codex/reliable-transfer-pilot/benchmarks/r2/README.md).
