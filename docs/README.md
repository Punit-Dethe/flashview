# FlashView engineering documentation

This directory is the **current, code-backed documentation** for FlashView. The repository [README](../README.md) is a product overview and starting point; architecture, operations and implementation details belong here.

| Document | Audience | Scope |
| --- | --- | --- |
| [Architecture](./architecture.md) | Contributors, maintainers | System components, data ownership, cache, presenters and boundaries |
| [Transfer protocol](./transfer-protocol.md) | Client/relay maintainers | Authentication, message directions, binary encoding and invariants |
| [Development and testing](./development.md) | Contributors | Local workflow, repository map, unit/E2E/benchmarks, diagnosis |
| [Deployment](./deployment.md) | Operators | Node, HTTPS/WSS, Cloudflare config and smoke checks |
| [Security and reliability](./security-and-reliability.md) | Developers, operators | Trust model, failure recovery and production caveats |
| [Reliability audit tracker](./reliability-audit.md) | Maintainers | Original 30-issue audit, verified fixes, partial work and next priorities |
| [Foreground reconnect proposal](./reconnection-design-proposal.md) | Maintainers | Research, alternatives and proposed immediate-resume policy; not shipped behavior |
| [Original engineering plan (archive)](./archive/initial-engineering-plan.md) | Historical reference | Outdated PDF-first design; **do not use as an implementation specification** |

## Documentation conventions

- **Code is authoritative** for actual behavior; claims below refer to the current files and configuration, not the initial design.
- Distinguish **implemented**, **tested in CI**, and **verified on real devices / public deployments**. These are not interchangeable.
- A change to the wire protocol, cache layout, authentication, deployment, or transfer scheduling should update the corresponding guide **in the same pull request**.
- Reliability fixes should update [the tracker](./reliability-audit.md) with their original issue ID, symptoms, remedy, evidence and remaining limitations.
- Put future design proposals in a separate, clearly labeled proposal or ADR. Do not mix unshipped ideas into descriptions of shipped features.
- No credentials, room tokens, original user files or personal data belong in docs or test reports.

**Last code review for these guides:** 19 October 2026; baseline `main` commit `d8837c0`. Review again whenever implementation changes.
