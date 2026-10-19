# Foreground reconnection: research and proposed decision

**19 October 2026 — proposal, not deployed behavior.** Code examined at
`13d8161`. The live recovery patch still probes an apparently open connection
for two seconds before replacing it. This document recommends changing that
policy for genuine suspension and network-restoration events. It does not
claim that one universally optimal reconnect algorithm exists.

## Decision for FlashView

Start one fresh, authenticated connection immediately when the sending phone
returns from its native file picker or a genuine background/freeze interval.
Bypass any scheduled retry delay and the old-socket liveness wait for this
attempt. Keep the phone's File objects, resume credentials and the receiver's
committed browser-cache chunks. Resume the same transfer, not a new upload.

An ordinary focus event without a recorded suspension should keep a healthy
connection and synchronize state. A teacher returning from a presentation tab
must not automatically tear down a healthy classroom transfer just because the
dashboard was hidden. Explicit freeze, back/forward-cache restoration and
network-restoration signals need their own handling rather than a shared
unqualified `wake()` call.

This is an application-specific recommendation based on the sources below.
Immediate first attempts and persistent-outage backoff solve different problems;
neither requires waiting two seconds before the first user-driven attempt.

## What established implementations actually do

- **Microsoft SignalR** documents automatic retry delays of 0, 2, 10 and 30
  seconds. Its first retry starts immediately. This supports an immediate-first
  policy, but does not prescribe FlashView's lifecycle or session protocol.
  [Official client guide](https://learn.microsoft.com/en-us/aspnet/core/signalr/javascript-client?view=aspnetcore-10.0#reconnect-clients)
- **Phoenix Channels** reconnects immediately on becoming visible when the
  connection is lost, cancels a previously scheduled reconnect and guards
  against `resume` plus `visibilitychange` restarting the same new connection.
  It also handles pagehide/pageshow and the document `resume` event. It does
  not blindly replace every connected socket on every focus event.
  [Examined source](https://github.com/phoenixframework/phoenix/blob/f35628b996eb1161eeee027ec807727cc3151859/assets/js/phoenix/socket.js)
- **Cloudflare PartySocket** provides explicit reconnect that retires the old
  socket, resets its retry counter and starts connecting again; its delay
  calculation returns zero for the first attempt. Its safeguards around old
  asynchronous close events are relevant to our previous failure.
  [Examined source](https://github.com/cloudflare/partykit/blob/6b977426fcaac8a2b4265085029dd2e0b813af2e/packages/partysocket/src/ws.ts)
- **Socket.IO recovery** separates a transport reconnect from restoring session
  state and missed messages. It explicitly requires handling failed recovery
  with state synchronization. The useful pattern for us is retained identity,
  reconciliation and safe replay, rather than changing libraries alone.
  [Recovery design](https://socket.io/docs/v4/connection-state-recovery/)
- **Browser lifecycle guidance** says frozen pages suspend timers and callbacks;
  Chrome documents `freeze`/`resume`, while MDN describes pageshow restoration.
  Our current App listens for visibility, focus, pageshow and online, but not
  document freeze/resume. Browser events are complementary signals, not proof
  that a connection is usable.
  [Chrome lifecycle guide](https://developer.chrome.com/docs/web-platform/page-lifecycle-api),
  [MDN WebSocket lifecycle example](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_client_applications#working_with_the_bfcache)
- **RFC 6455 section 7.2.3** recommends randomized and increasing delays after
  abnormal closures to avoid synchronized reconnect storms. It suggests a
  randomized initial delay too, leaving its parameters application-dependent.
  An immediate, coalesced user-return attempt is our deliberate application
  policy, not a claim that the RFC mandates immediate retries. Persistent
  failures still need bounded exponential backoff with jitter.
  [WebSocket standard](https://www.rfc-editor.org/rfc/rfc6455.html#section-7.2.3)

## Alternatives considered

The verdicts are engineering judgments for this application, not benchmark
results or statements that every option is intrinsically bad.

| Approach | Benefit | Limitation / decision |
| --- | --- | --- |
| Wait for browser close or periodic heartbeat | Small implementation | A dead mobile connection can still appear open. Retain as a fallback, not the return path. |
| Two-second old-socket probe | Preserves healthy sockets | Current policy; serializes detection before reconnect. Remove this wait on a recorded sender suspension. |
| Shrink every probe to 100–200 ms | Smaller imposed delay | Arbitrary short timeout mistakes ordinary mobile RTT or congestion for failure. Not a robust universal setting. |
| Replace the socket on every focus | Immediate attempt | Duplicate events and ordinary tab interactions can repeatedly disrupt healthy transfers. Reject as the blanket policy. |
| Immediate replacement after a recorded suspension | Removes serial detection delay; one active client transport | Recommended initial policy for the sending phone; healthy-picker cost must be measured. |
| Race an old-socket probe against a new connection | Could preserve the healthy fast path while eliminating serial delay | Candidate authentication can invalidate the old socket. Needs an explicit handoff protocol before treating either result as a winner. Reserve for a measured second experiment. |
| Adaptive probe deadlines using measured RTT | Better than one arbitrary threshold | Useful for ambiguous focus events; still delays a stale connection if used serially. Does not replace lifecycle handling. |
| Retry continuously with no backoff | Frequent opportunities | An outage becomes connection churn and server load. Reject; immediate first attempt, bounded later attempts. |
| Switch to Socket.IO / PartySocket | Reusable lifecycle and retry components | Cannot by itself preserve our cache truth, File objects, range ownership or replay safety. Do not migrate the protocol merely to remove a timer. |
| Worker / keep-awake approach | Can reduce UI-thread contention | Does not eliminate transport/authentication work or establish that the OS will keep a mobile page running. Worker isolation remains useful for transfer performance independently. |
| Resumable HTTP uploads such as tus | Explicit acknowledged progress | Useful recovery model; our receiver is a browser cache rather than an upload server. Not a direct replacement within the current relay architecture. |
| QUIC / WebTransport | QUIC supports path migration; WebTransport offers streams | A separate transport/backend project. Does not remove application authentication or recovery correctness requirements. Revisit after measuring the simpler policy. |

The HTTP-resume comparison comes from the [tus protocol](https://tus.io/protocols/resumable-upload),
which reconciles server offsets before continuing. FlashView instead needs the
receiver's persisted chunk set, including holes, as its completion truth.

QUIC migration is described in [RFC 9000 section 9](https://www.rfc-editor.org/rfc/rfc9000.html#section-9).
[MDN currently labels WebTransport Baseline 2026](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport);
older devices still matter, but blanket claims that no mainstream browser
supports it are outdated. Our current Node/Cloudflare relay implements WebSocket,
so applying it here would require implementation and deployment work.

## What the research papers add

[The Tail at Scale](https://research.google/pubs/the-tail-at-scale/) discusses
techniques including redundant requests to reduce unusually slow responses.
[When to Hedge in Interactive Services, NSDI 2021](https://www.usenix.org/conference/nsdi21/presentation/primorac)
examines when hedging helps and when additional congestion can outweigh its
benefit. [gRPC's hedging design](https://grpc.io/docs/guides/request-hedging/)
likewise bounds attempts and cancels redundant work.

These are evidence for considering a bounded parallel attempt, not proof that
racing authenticated WebSockets is fastest or safe in FlashView. RPC replicas
and a stateful single-owner classroom session have different semantics. We
should first test immediate single replacement, then add candidate racing only
if measurements show a worthwhile healthy-connection penalty.

## Implementation sequence

### 1. Replace generic wake handling with lifecycle reasons

Represent picker start/end, hidden/visible, freeze/resume, persisted pageshow,
online and ordinary focus explicitly. Record a suspension generation and the
socket it affected. The first valid return signal consumes that generation
and initiates its replacement synchronously; subsequent signals reuse the
same attempt. A newly connecting socket must not be restarted by the trailing
file-change or pageshow event from that same return.

On the sender, a recorded picker/background return initiates a fresh connection
without first pinging the old one. On the receiver, ordinary dashboard focus
preserves a healthy transfer; explicit freeze/cache restoration or a confirmed
connection failure takes the immediate path. Treat `online` as a retry hint,
not a gate: [MDN documents that navigator.onLine is unreliable](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine).
Do not add a health-check HTTP request before the WebSocket handshake.

### 2. Keep handover and resume correct

Detach the obsolete socket from local authority before closing it. Ignore its
late close/error/data callbacks. Do not wait for its close acknowledgement.
Keep one replacement attempt in progress and retain bounded handshake timeouts
and outage backoff if that attempt fails.

Audit both relays so the newly authenticated peer becomes authoritative before
old close callbacks can mark it offline. Old peers must not mutate the current
room or satisfy another request. Restore the sender manifest before replaying
its outstanding uncancelled requests. Preserve request IDs, ownership checks
and original deadlines; use the receiver's committed cache to request holes.
Most sender replay machinery is already in the deployed recovery patch, but
more frequent replacement warrants handover-race coverage.

Do not disconnect a healthy sender when it enters the picker; it may continue
serving its already selected files. Pause heartbeat deadlines as needed and
decide recovery on return. Do not create a new room or discard File objects.
Preview activity remains independent of transfer decisions.

### 3. Measure the right interval and compare policies

Record separately, without file names, credentials or room identifiers:

1. Foreground event to new WebSocket construction: no intentional timer;
   target under 50 ms when the event loop is running. This is an engineering
   acceptance target, not an already measured result.
2. WebSocket construction to authenticated session acknowledgement.
3. Return event to first newly committed cache chunk.
4. Recovery completion, bytes retransmitted, reconnect count, and final hash.

The existing interrupted-transfer test starts its stopwatch **before** a
600 ms artificially injected outage, then emits focus. Its previously recorded
3–4 second interval therefore includes that pre-return interval as well as the
two-second probe, authentication and cache progress. Preserve that result as
interruption-to-progress, and add an actual return-to-progress measurement.

Compare the deployed probe policy and the proposed immediate policy against
the same healthy-picker, blackholed-socket, slow-network and failed-handshake
cases. Report p50 and p95 over repeated trials, not just a best run. Include
duplicate focus/visibility/resume/change events, picker cancel, host presentation
focus, concurrent files, late old-socket events and exact final SHA-256. Verify
Android Chrome and iOS Safari physically; desktop automation cannot establish
their event ordering or radio recovery time.

Only promote the new policy after demonstrating earlier first-byte recovery
without repeated reconnects, duplicate participants, lost approvals, false 100%,
or materially worse healthy-transfer throughput. Network/TLS/authentication
latency remains real even when our intentional pre-reconnect delay is zero.
