# Optional-name QR welcome — 21 October 2026

Historical validation record. The welcome flow is now on main and the public
app at [warpview.net](https://warpview.net/); versions/timings below describe the
original preview run. The current host's Copy code action copies the six digits,
while its QR retains the invitation URL described here.

Scanned invitations now open a single white card on the existing hero sky.
The card offers an optional name, Join room and Skip for now. Skip discards
partially typed text and keeps the existing anonymous `Student` fallback.
No sender authenticates until a choice is made. Manual code entry and host
approval retain their existing behavior.

New QR/copied links use `/join/<code>#invite=<token>`; the browser cleans that
to `/join/<code>` and keeps the invitation in the current history entry.
The private resume identity and chosen name survive refresh after joining.
Leaving clears them. Old query invitations, opaque Node tokens and prefixed
Cloudflare tokens remain supported. Invalid supplied tokens do not downgrade
to room-code admission. This does not change the transfer worker or cache.

Validation:

- Build/typecheck and 119 unit/protocol tests passed, including three new
  invitation-format/history/isolation cases.
- Full Chromium browser suites: 36/36 Node and 36/36 Cloudflare.
- Targeted Firefox suite: 17/17, including the new flow.
- Final optional-name scenario passed again on Node, Cloudflare and Firefox:
  named and anonymous file owners, no pre-choice hello, Skip after typing,
  cleaned legacy links, refresh with the same private identity and Leave cleanup.
- Desktop 1440×1000 and phone 390×844 visual inspection: no horizontal overflow,
  both actions visible, 16px input and touch targets >=44px. Screenshots are
  generated in the CI UI artifacts. Mechanical design findings were incumbent
  font/header-transition choices; the requested hero styling was preserved.

Isolated public preview:
[open the app](https://warpview-join-preview.outlanderwatr.workers.dev/), create
a room and scan its QR code. A layout-only example is
[/join/123456](https://warpview-join-preview.outlanderwatr.workers.dev/join/123456)
(that code is illustrative, not an active room). Preview Worker version:
`011d2d47-6981-4abb-af16-5d255e8c34a9`. It uses its own room namespace.
Named Join, Skip and clean-path resume were checked against that public build.
One synthetic 20 MiB transfer completed in 5353 ms and independently matched
SHA-256. Selection/transfer/cache timing starts after joining. The first attempt
used the benchmark's old fixed production origin, so it did not test this
preview and is excluded. `BENCH_ORIGIN` is now explicit and validated.
This is desktop browser evidence, not physical phone/QR-camera proof.

The original preview branch was based on production main through PR #47 and
was independent of storage experiment #48. Normal rooms still use IndexedDB;
this record does not establish production OPFS support. The original preview
did not manually deploy production. Current release ownership and verification
are described in [Deployment](./deployment.md#current-hosted-application).
