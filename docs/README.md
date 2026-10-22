# WarpView engineering documentation

The repository [README](../README.md) introduces [WarpView](https://warpview.net/). These guides describe its current implementation; the public [architecture page](https://warpview.net/architecture) explains the system visually. Repository, package, database and compatibility identifiers can still use the earlier `flashview` name.

**Source review:** 22 October 2026, `main` baseline `3b63522` (PR #60). Runtime behavior was checked against source; historical test reports below have not been rerun as part of this documentation update.

## Current guides

| Document | Audience | Scope |
| --- | --- | --- |
| [Architecture](./architecture.md) | Contributors, maintainers | System components, data ownership, cache, presenters and boundaries |
| [Transfer protocol](./transfer-protocol.md) | Client/relay maintainers | Authentication, message directions, binary encoding and invariants |
| [Development and testing](./development.md) | Contributors | Local workflow, repository map, unit/E2E/benchmarks, diagnosis |
| [Deployment](./deployment.md) | Operators | Node, HTTPS/WSS, Cloudflare config and smoke checks |
| [Security and reliability](./security-and-reliability.md) | Developers, operators | Trust model, failure recovery and production caveats |
| [Reliability audit tracker](./reliability-audit.md) | Maintainers | Original 30-issue audit, verified fixes, partial work and next priorities |

## Decisions and historical validation

These retain the conditions, versions and limitations of the original measurements. A passing historical run is not evidence that every later release or physical device has been retested.

| Record | What it preserves |
| --- | --- |
| [Foreground reconnect decision](./reconnection-design-proposal.md) | Research and the selected immediate-return policy now implemented |
| [Reconnect evaluation](./reconnection-evaluation.md) | Measured policies, recovery intervals and healthy-transfer controls |
| [Shared file engine](./room-engine-validation.md) | File-transition extraction and its measured baseline |
| [Shared room engine](./shared-room-engine-validation.md) | Participant authority, persistence and stale-snapshot validation |
| [Transfer worker](./relay-worker-validation.md) | Worker ownership, failure recovery and unresolved speed/browser observations |
| [QR welcome](./qr-welcome-validation.md) | Name/Skip flow, invitation privacy and refresh behavior |
| [PowerPoint previews](./experiments/pptx-preview-toolbar.md) | Embedded-image optimization, bounded fallback and historical timings |
| [R2 comparison](./r2-benchmark-results.md) | Deferred storage experiment and comparison conditions |

The superseded implementation plan, original engineering plan and R2 migration proposal have been removed; Git history retains them. Current architecture and its unimplemented boundaries live in [Architecture](./architecture.md#implemented-and-not-implemented). The audit remains the issue/evidence record, not a new implementation plan.

## Documentation conventions

- **Code is authoritative** for actual behavior; claims below refer to the current files and configuration, not the initial design.
- Distinguish **implemented**, **tested in CI**, and **verified on real devices / public deployments**. These are not interchangeable.
- A change to the wire protocol, cache layout, authentication, deployment, or transfer scheduling should update the corresponding guide **in the same pull request**.
- Reliability fixes should update [the tracker](./reliability-audit.md) with their original issue ID, symptoms, remedy, evidence and remaining limitations.
- Put future design proposals in a separate, clearly labeled proposal or ADR. Do not mix unshipped ideas into descriptions of shipped features.
- No credentials, room tokens, original user files or personal data belong in docs or test reports.

Review the current guides when protocol, storage, authentication, deployment or preview behavior changes; keep dated evidence separate from current behavior.
