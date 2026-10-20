# Shared file engine validation — 20 October 2026

Baseline source/release: `6a9bdda` / Worker
`65f9528d-12bf-4648-8ecb-754bc6f485ff`. This slice centralizes file metadata rules;
participant commands and room-wide snapshot ordering remain pending. It does not
change transfer packets, concurrency, renderers or browser cache storage.

## Repeatable speed check

Three repetitions per target, run sequentially while other suites were idle.
Each batch uses one synthetic random 20 MiB binary file, a new room/browser
context per repetition, and one sender/receiver on this Windows desktop. Every
cached original must match SHA-256; the source fixture is reused within a batch.
Hashing is outside the timed interval. The interval includes automated selection,
transfer, cache persistence and the completion UI, not just network throughput.

| Target | Before samples (ms) | Before median | After samples (ms) | After median |
| --- | --- | --- | --- | --- |
| Local Node | 2435 / 1808 / 1735 | 1808 ms | 1580 / 1571 / 1571 | 1571 ms |
| Local Cloudflare | 2176 / 2146 / 2143 | 2146 ms | 2082 / 2088 / 2077 | 2082 ms |
| Public relay | 4751 / 4748 / 4747 | 4748 ms | Post-deployment verification pending | Pending |

All listed copies matched exactly. These local samples show no slowdown; the
smaller after values are not proof of a throughput improvement. CPU clocks,
browser/runtime warm-up and network placement can vary. Local emulation is not
the deployed network. The test does not establish physical-phone/campus behavior,
multiple-sender fairness or the application's 200 MiB boundary behavior.

Reproduce with `npm run bench:transfer`; choose `BENCH_TARGET=node|cloudflare|public`.
See [development instructions](./development.md). The new committed harness uses
the same default fixture size, three-repeat flow and timing/integrity procedure
as the initial probe; it adds configurable bounds and runtime version fields.
After samples: Chromium `156.0.8078.4`, Node `v24.11.1`.

## Correctness coverage

- Initial full Chromium suites: 30/30 each on Node and Cloudflare; 9 targeted
  Firefox cases, including interrupted 20 MiB SHA-256 verification.
- Final persistence-checkpoint follow-up: 97 unit/protocol cases, all 18
  Cloudflare relay contracts, and 11 targeted Cloudflare browser scenarios
  (cache identity, lifecycle, binary formats, host handover, admission retry,
  admission budget and interrupted byte integrity) passed.
- Build passed before that backend-only follow-up; final TypeScript and Worker
  dry-run passed. Client assets are unchanged.
- Engine fault tests deliberately delay effects and fail adapter writes. They
  validate immutable snapshots, terminal Stop, duplicate receipts/retries, dirty
  checkpoints and older saves leaving newer mutations pending. These are forced
  engine/adapter cases, not reproduced campus incidents. Cloudflare's existing
  default storage gates also hold output until flush and reset failed objects.

## Release verification

One synthetic room was prepared on the previous public version, with a private
resume identity and completion metadata, to verify upgrade without losing them.
Post-deployment public speed, old-room upgrade, interruption integrity, version
and CI status are added after the release checks. All synthetic rooms are ended
after their checks; original file bytes remain browser-cached, never cloud stored.
