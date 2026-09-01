# 0028 — The standby door is a second listener that arms on silence

Status: **Accepted** (2026-08-20)

Subordinate to: [ADR 0026](./0026-the-operator-is-the-quorum.md) — silence may *arm* a surface and may
never *authorise* an action; that argument is there, not here.
Amends: [ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md), exactly as 0013 amended
[ADR 0001](./0001-one-managed-front-door.md). **0013's criterion is untouched and still binding — a
peer publishes nothing.** What changes is that a peer may *bind* an unpublished, three-route browser
listener while a lead-signed warrant names it. 0013's own "what would justify revisiting" anticipates
this class of change; nothing in its body is retracted.
Related: [ADR 0027](./0027-the-deputy-is-named-ahead-of-time.md) (the warrant this door reads)
Contract: [`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §18.15 (the door), §18.14 (the pairing sync),
§18.16 (what the button runs), §18.12 (the deposed lead's answer on the same path).
Operator setup: [`docs/deployment.md`](../docs/deployment.md#the-standby-door--a-packs-failover-path).
Design history: [`PACK_DEPUTY_RFC.md`](../PACK_DEPUTY_RFC.md) §6.

## Context

ADR 0027 gives a deputy the standing right to take over. Spending it needs a surface the operator can
reach on the bad day, and the operator is holding a phone.

**The phone cannot reach the pack listener, and that is a measurement rather than a preference.**
`PACK_PROTOCOL.md` §8.1's amendment records that `COLLIE_PEER_BROWSER=1` and a pinned listener are
mutually exclusive: a browser cannot present the lead's client certificate, so BoringSSL refuses the
handshake before any Collie code runs. A phone is a browser. The choice was therefore a second
listener or no feature — there was never a third road where the existing port grows a page.

**The credential the phone already holds is per-origin.** Pairing tokens and the installed PWA both
live on the lead's origin, so a takeover page on a different origin is a page the phone cannot
authenticate to without hand-pasting a token.

**And the failover path is precisely when an ingress is misbehaving.** Anything the door depends on
that the *broken* component supplies is not a control there.

## Decision

**A deputy binds a second, unpublished HTTP listener that serves three routes, and it serves the
action only while three independent facts are true.**

- **Bound, never published.** `COLLIE_STANDBY_HOST` (default loopback) and `COLLIE_STANDBY_PORT`;
  **absent `COLLIE_STANDBY_PORT` means no door at all** — nothing bound, nothing served, and the
  deputy is a plain peer still recoverable from a keyboard by §14's promotion. Collie runs no
  `tailscale serve` here, never `funnel`, and writes no ownership record, so ADR 0001's criterion —
  *we manage only what we run and can test* — is untouched.
- **Three routes and no more:** `GET /standby/health`, `GET /standby`, `POST /standby/takeover`.
  Every other path on that port is a bare `404`. No PWA, no `/api/*`, no SPA fallback, no `/auth`
  placeholder — *a route that does not exist cannot be mis-gated*, which is 0013's own sentence
  applied to its own exception ([`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §18.15).
- **Armed is three facts, all of them, and none of them a soft signal:** a **verified warrant on this
  machine's own disk names this machine**; the lead has been silent for `COLLIE_STANDBY_ARM_MS`,
  measured from the later of the last landed call and this process's start; and the **synced pairing
  registry is non-empty**. Arming is reversible and instantaneous — the lead's next landed call
  disarms it, nothing is persisted, and a door that flaps with connectivity is correct because it
  grants nothing.
- **The threshold's default is a formula**, `max(30_000, 2.5 × COLLIE_POLL_IDLE_MS)`, so an operator
  who relaxes the idle poll moves the arming threshold with it instead of building a pack that arms
  its own door every night. An override below the idle poll is **warned about, never refused**.
- **The confirm is authenticated by the phone's pairing credential and by nothing else.** An empty
  synced registry **refuses to arm** rather than arming ungated: an ungated takeover button on an
  unpublished port is a takeover button for anyone who reaches the port.
- **`COLLIE_DEVICE_HEADER` is deliberately *not* applied here.** The two gates compose by AND on
  `/api/*` and that stays true everywhere else; this is the one exception, and it is written at the
  code as well as here or it reads as a bug ([`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §18.15).
- **The synced registry is quarantined in `standby-devices.json` and is never merged into the
  deputy's own `paired-devices.json`.** `PairingStore.enforced()` is *the registry is non-empty*, so a
  merge would silently switch on the deputy's **own** write gate, for its own operator, on a machine
  where nobody ran `collie pair`. Only hashes cross, and the entries are adopted into the deputy's own
  registry at takeover commit and only then ([`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §18.14).
- **A same-origin failover proxy is an accepted prerequisite of the phone-first half.** A pack without
  one keeps the warrant, the deposition and the self-heal, and recovers by §14's keyboard promotion.
  `/standby/health` is the one question — *should anything route here?* — answered by three kinds of
  machine: a lead `200`, a **deposed** lead non-`200`, a deputy `503` until it arms.

## Consequences

- **The first Collie listener that is not the front door and not the pack surface.** Its whole defence
  is that it is tiny: three routes, one gate, one page with no external asset, `default-src 'none'`
  with one hash-admitted inline script (the credential is in `localStorage` and a form post cannot
  carry an `Authorization` header).
- **`/standby` and `/standby/*` become reserved paths pack-wide** — in the service-worker denylist and
  in the front door's reserved set. In the same-origin deployment the phone hits a service worker
  minted from the *lead's* origin first, so this is the difference between reaching the door and being
  served a cached app shell.
- **A lead with the key set binds the port too, answering only the health check.** Otherwise a deputy
  that took over and came back up would leave the proxy health-checking a closed port and swinging the
  phone back onto the machine that died.
- **The cold page is readable before the bad day.** It states the fact and offers no action, so an
  operator can confirm their door works without spending anything.
- **A two-machine pack has no witness, is allowed, and the page says so above the button.** Two
  members is the size this protocol is most used at; refusing it would refuse the feature.
- **Tuning is one decision, not two.** The proxy fails the lead over in seconds while the deputy arms
  in tens of seconds, and both backends are honestly unhealthy in between. Tune the health check to
  the arming threshold, not the reverse.

### Alternatives considered

- **Serve the page on the existing pinned pack listener.** Not rejected on taste — it is impossible.
  A browser has no client certificate, and the peer's listener requires one at the handshake.
- **`COLLIE_PEER_BROWSER=1` on the deputy.** Rejected for the same reason, one level up: that flag and
  a pinned listener are mutually exclusive, so switching it on to reach the page would mean unpinning
  the pack surface — trading a two-factor gate on a terminal for a takeover button.
- **A door that is always open, gated only by the credential.** Rejected. Silence is the fact that
  makes the action *plausible*, and ADR 0026 draws the line exactly here: arming is reversible and
  grants nothing, so it may be triggered by a fact an attacker can manufacture; authorising may not.
  An always-open door also gives up the cheap, honest health answer that drives the failover proxy.
- **A second credential minted directly to the deputy, to avoid needing a same-origin proxy.**
  Rejected: a second registry to mint, sync, revoke and forget, forever, to avoid one line of config
  in a proxy the operator already runs. The prerequisite is accepted and `pack deputy` says so once.
- **The device header as a second factor on the confirm.** Rejected — see the Decision. A factor
  supplied by the component that just failed is not a factor.
- **Merging the synced hashes into the deputy's own registry.** Rejected: it arms a write gate the
  operator never asked for, on their own machine, and they discover it the day they use that machine
  directly.

### What would justify revisiting

- **A transport that lets a browser and a pinned peer share one listener.** That removes the entire
  reason this ADR exists, and the door should collapse back into the front-door router.
- **Collie growing a real identity model.** Once a request carries a *person*, "the phone holds a
  bearer token minted on the lead" stops being the only credential the deputy can check, and the
  pairing sync — the most awkward part of this decision — goes away with it.
- **Evidence that operators want a browser surface on a peer generally.** That is a *second front door
  per pack* and re-opens ADR 0001 at pack scale, exactly as ADR 0013 says; it would need its own ADR
  rather than a widening of this one.
