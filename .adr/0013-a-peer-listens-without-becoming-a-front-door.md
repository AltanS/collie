# 0013 — A peer listens without becoming a front door

Status: **Accepted** (2026-08-06)

Amends: [ADR 0001](./0001-one-managed-front-door.md) — *one managed front door* graduates from
**per machine** to **per pack**. 0001 is not superseded; its criterion is unchanged and still binding.
**Amended in scope by:** [ADR 0028](./0028-the-standby-door-is-a-second-listener.md) — a peer that
holds a lead-signed warrant may **bind** an unpublished, three-route standby listener. Nothing below
is retracted: *a peer publishes nothing* is unchanged, and the standby door is bound, not published.
Related: [ADR 0011](./0011-the-pack-protocol-is-the-mux-driver-seam.md) · contract:
[`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md)

## Context

`ARCHITECTURE.md` §6 states the posture in one line and does not hedge it: **the bridge binds
`127.0.0.1` only**, and "binding `0.0.0.0` makes the whole access check theater." Every other control
— the same-origin gate, the identity check, the device gate that fails closed since 0.15.0 — is
scoped to that bind and to the single hardened ingress in front of it
([ADR 0001](./0001-one-managed-front-door.md)).

A **peer** is a Collie instance the **lead** dials. Read literally against §6, that is the *first
off-loopback listener in this project's history*, on every machine in the pack. It deserves to be
argued rather than slipped in as an implementation detail of federation, because a pack request can
type into a real terminal.

Two proposals are already live, and they are wrong in opposite directions:

- *"It's on the tailnet — just bind `0.0.0.0` and gate on the pack secret."* This is exactly the
  substitution ADR 0001 refuses: reachability is not authorisation, and a shared secret guarding a
  root shell is a root password. It also throws away the one thing the bind is good for — bounding
  *which* networks can even attempt the gate.
- *"Give the peer a `tailscale serve` mapping too, it's easier."* This is a second managed front door
  per machine, which is the decision 0001 exists to prevent, plus a browser surface on a machine that
  has no business serving one.

The gate chain cannot simply be widened to cover this. `checkAccess()` (`bridge/server.ts:1113-1151`)
assumes a **browser**: an `Origin` to compare against `Host`, an optional `Tailscale-User-Login`, an
optional device header. A pack request has none of the three, by construction — trust here is
**application-layer**, because the whole enrollment contract is *an address and a token*
(transport-agnostic on purpose: the operator brings reachability, Collie never integrates with an
overlay network). A gate that cannot know which network a packet arrived from must not be a widened
version of one that assumed it.

## Decision

### The distinction, in one paragraph

A **front door** is a *published, discoverable* ingress that a **browser** is meant to reach: it
terminates TLS, it serves the PWA, its callers are unauthenticated until the gate chain runs, and
Collie manages its lifecycle. A **pack listener** is an *unpublished* endpoint whose only legitimate
caller is one enrolled lead: nothing advertises it, it never serves the PWA, and **two independent
factors are checked before any handler runs**. A peer has a pack listener. It does not have a front
door.

### What follows

**ADR 0001 graduates from per-machine to per-pack: exactly one managed front door *per pack*, held by
the lead.** 0001's criterion is untouched — *we manage only what we run and can test* — and
`tailscale serve` on the lead is still the only thing Collie manages. A peer manages none.

- **A peer publishes nothing.** On becoming a peer it tears down its own `tailscale serve` mapping,
  using the existing ownership record (`<config-dir>/tailscale-managed-handler`) and the existing
  rule: only ever tear down a mapping still matching that record. It creates no new mapping.
  **Never `tailscale funnel`** — the prohibition was always about reachability, and a peer inherits
  it whole.
- **A peer's browser surface is disabled entirely — not hidden.** No PWA, no `/api/*`, no
  same-origin-gated routes. A route that does not exist cannot be mis-gated.
- **The pack surface is `/pack/v1/*` — a path prefix on the existing server. There is no second
  port.** A second port is a second bind, a second TLS configuration, a second firewall rule, and a
  second place for the admission logic to drift out of agreement with the first; it makes nothing
  smaller, because the process is reachable or it is not. One listener with **one** admission decision
  at the front of the router is auditable in one place. The prefix must not collide with the paths
  already reserved for a fronting proxy — `/auth`, `/auth/*` (`bridge/server.ts:1348`) and
  `/cdn-cgi/`.
- **Admission is two independent factors, both, always, before routing**: pinned mutual TLS
  (transport) plus the pack secret (application header). Pinning survives a leaked secret; the secret
  survives an unexpected certificate chain. `checkAccess()` is **not** widened and not reused: a pack
  request never satisfies it, and a browser request is never admitted by pack credentials. Details in
  [`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md).
- **The bind is as narrow as the deployment allows: loopback plus exactly the address the operator
  supplied at `join` time. Nothing wildcard; `0.0.0.0` is never the documented value.** Concretely,
  per deployment:

  > **Amended (2026-08-08, F3).** The "loopback plus exactly the join address" dual-bind stated here
  > and in the table below was never implemented and is not expressible — `Bun.serve` takes a single
  > `hostname`, so the real bind is **`COLLIE_HOST` alone** (default loopback), and the operator owns
  > it exactly as they own reachability elsewhere. This ADR's *criterion* is unchanged — a wider bind
  > still only widens who may *attempt* the two-factor gate, never who passes — but the *mechanism* is
  > one address, not two. Collie now **warns** (never refuses, per the last Decision bullet) when a
  > peer's bind is wildcard (`0.0.0.0`/`::`/empty) and shows the resolved bind in `collie pack status`.
  > The corrected contract is [`PACK_PROTOCOL.md` §3](../PACK_PROTOCOL.md); the exposure table below
  > still holds row-for-row once "Bind" is read as *the value the operator sets `COLLIE_HOST` to* for
  > that deployment rather than an automatic dual-bind.

  | Deployment | Bind | Honest exposure |
  | --- | --- | --- |
  | Lead and peer on one host (dev, tests) | loopback | No change beyond the existing local-uid surface §6 already documents. |
  | Operator-provided overlay (tailnet, NetBird, ZeroTier, …) | the **specific** overlay interface address | Reachable by **every device on that overlay**, gated only by the two factors. Say this plainly in the docs; do not imply loopback safety. |
  | LAN | the specific LAN address | Reachable by the whole broadcast domain, gated only by the two factors. |
  | Operator-owned tunnel or reverse proxy terminating on the peer | loopback | The operator owns the ingress and Collie publishes nothing — the DEPLOYMENT.md Variant E shape, unchanged. |

- **`tailscale whois` is an optional extra, never a factor.** It demotes to a
  `COLLIE_TRUSTED_USER`-shaped *narrowing* on top of a gate that already holds without it — never
  something the model depends on, never discovery, and never a reason to relax either factor.
- **The peer surface is held to the same posture as the front door**, because it has the same power.
  Writes arriving over a pack link are audited **on the peer** (`bridge/audit.ts`), identifiable as
  pack-originated — the peer's audit log is the record of what happened on the peer's terminals.
  Refusals fail closed and are indistinguishable to the caller: an absent secret, a wrong secret and
  an unpinned certificate all produce the same answer.
- **A peer refuses to *publish* a front door; it does not refuse to *start*.** It never creates a
  managed mapping, and tears down the one it owns. It does **not** abort on detecting some other
  mapping on the host — Collie cannot tell a legitimate mixed deployment (a machine that also serves
  something unrelated on 443) from a mistake, and a startup refusal it cannot justify is paternalism
  that breaks real setups. It warns, loudly, once.

## Consequences

- **`ARCHITECTURE.md` §6's loopback claim is no longer literally true and must name the exception.**
  A doc that overstates a control is worse than one that admits a gap, because it invites someone to
  skip a real control on the strength of this one — the same failure [ADR 0007](./0007-the-idle-lock-is-a-pause-not-a-gate.md)
  corrected for the idle lock. §6 gains the **pack listener** as a named, scoped exception with its
  two factors stated.
- **The local-uid surface gains the pack prefix (on the same port), and it is the first Collie
  surface that does not treat local as trusted.** §6 already documents that any uid in the host's network namespace can reach
  `127.0.0.1:$COLLIE_PORT` and drive the herd. A local uid can also *reach* the pack listener — but
  reaching it admits nothing without both factors, where the existing port admits reads
  unconditionally. So it is **not worse, and structurally better**, with one honest caveat: the pack
  secret and the private key live 0600 under `stateDir`, so a process running **as you** has them —
  and that process already had the existing port. The improvement is against a *different* uid (the
  `sudo -u agent-review` containment case §6 calls out), which is exactly the case that mattered.
- **Solo pays nothing.** With no pack configured there is no key, no certificate, no listener, and no
  `/pack/v1` prefix mounted. Federation is not a tax on the single-machine install.
- **The pack's blast radius is stated, not implied.** A compromised lead reaches every peer's
  terminals; the lead is a lateral-movement hub by construction. The threat model lives in
  [`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md), and this ADR is the reason it is not optional.
- **Every non-tailnet deployment stays the operator's, exactly as ADR 0001 promised.** Collie
  publishes nothing new; a pack listener is a listener, not an ingress Collie supervises.
- **(Added 2026-08-07, implementation) The certificate factor is enforced at the *handshake*, and the
  two directions are not symmetric.** "Two independent factors, both, always, before routing" holds
  in both directions; *where* the first one is checked differs, because Bun 1.3.14 can **enforce** a
  client certificate on `Bun.serve` but exposes no way to **read** one. So a **peer** pins its lead in
  the listener's `ca` (an unpinned caller is refused before HTTP exists — a transport refusal, which
  reveals less than the uniform 401 and does not weaken §8.5), while a **lead** pins nothing inbound:
  its pack surface rides the front door, and `tailscale serve` or a conforming proxy terminates TLS
  before the process sees the connection. Peer→lead requests carry a signature over the request,
  verified against the pinned certificate, instead (`PACK_PROTOCOL.md` §8.6). Three follow-ons worth
  keeping in view: a peer's `ca` holds exactly one certificate, so admission takes the transport's
  verdict as a boolean set by the code that built the listener rather than as a readable identity;
  there is **no live re-pin** (`server.reload` does not swap `ca`), so membership changes land through
  the restart the verbs already perform; and `COLLIE_PEER_BROWSER=1` cannot coexist with a pinned
  listener, because a browser has no client certificate to present. This narrows the decision's
  *mechanism*, not its criterion — a peer still has a pack listener and still has no front door.

### What would justify revisiting

- **A deployment where the lead reaches a peer without a TCP listener at all** — a unix socket on a
  shared host, or an operator-owned tunnel terminating on the peer's loopback (the last row of the
  table). If that becomes the common case rather than one of four, the off-loopback bind should be
  demoted to opt-in and this ADR narrowed to match.
- **Collie growing a real multi-user identity model.** The pack secret is a *machine* credential; once
  requests carry an identity, the two-factor story changes shape and this ADR is superseded rather
  than amended.
- **Evidence that a peer's browser surface is wanted after all** — someone who wants to open a peer
  directly from a laptop on its own tailnet. That is a *second front door per pack*, and it re-opens
  ADR 0001's argument at pack scale rather than this one's; it would need its own ADR, and the answer
  today is `COLLIE_SKIP_SERVE=1` plus the operator's own ingress.
