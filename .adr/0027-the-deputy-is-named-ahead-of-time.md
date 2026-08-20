# 0027 — The deputy is named ahead of time, and takes over on the operator's word

Status: **Accepted** (2026-08-20)

Subordinate to: [ADR 0026](./0026-the-operator-is-the-quorum.md) — this is the mechanism; the argument
for *why there is no election* lives there and is not repeated here.
Narrows: [ADR 0014](./0014-promote-is-a-confirm-on-the-lead.md), which stays the **no-deputy floor**
(`promote` / `promote --force`) and is unchanged.
Related: [ADR 0016](./0016-updates-ride-the-operators-ssh.md) ·
[ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md) · door: [ADR 0028](./0028-the-standby-door-is-a-second-listener.md)
Contract: [`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §18.1–18.6 (the warrant), §18.12 (the deposed state
and its self-heal), §18.13 (`collie pack deputy`), §18.16 (the takeover exchange).
Design history: [`PACK_DEPUTY_RFC.md`](../PACK_DEPUTY_RFC.md).

## Context

A lead that dies takes the pack's only front door with it. Until this decision the single answer was
`collie promote --force` at a keyboard on another machine, which strands every remaining peer
(ADR 0014). ADR 0026 settles what may *authorise* a replacement — a human decision, or a proof the
outgoing lead signed — and leaves open the object that carries such a proof and how it gets to the
machines that must honour it.

Three forces shape that object, and each one closes an obvious alternative.

**A dead lead cannot help.** Whatever authorises the succession must already be on disk, on every
machine, before the event. So the consent is *pre-signed* and *standing*, not requested when needed.

**Trust here is pinned certificates, not names.** A member admits its lead because it pinned that
lead's certificate. A consent naming only a member id would be spendable by anything that presents
that id.

**A pinned listener cannot be re-pinned while it runs.** `server.reload({ tls })` does not swap a
pinned `ca`, and a peer's listener is built with exactly one anchor — its lead's certificate
(`bridge/pack/transport.ts`). A machine the peer has never anchored is refused **before HTTP
exists**. No route, signature or warrant can climb that wall.

## Decision

**The operator names one deputy in advance. The lead signs a warrant saying so. A takeover spends
that warrant, on the operator's word, after the lead has been asked and the surviving peers have been
asked what they saw.**

- **One standing warrant, and naming a second deputy replaces the first.** Generation *N+1* naming
  the new member supersedes the old warrant everywhere it lands; `--revoke` mints *N+1* naming nobody.
  Revocation is a **positive, verifiable statement** rather than an absence, because an absence cannot
  be distinguished from a lost message ([`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §18.1, §18.3).
- **The lead signs; the deputy never attests.** The same key, algorithm and pinned certificate §8.6's
  request signatures already use — no new key, no CA, no new trust anchor. What deposes the old lead
  is *its own past consent handed back to it* ([`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §18.2,
  §18.12).
- **The warrant binds the deputy's certificate fingerprint, never just its id, and carries no
  address and no roster.** An address is a hint the operator may re-point; a roster would be a second
  source of truth about membership ([`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §18.2).
- **The generation stands; the signature is refreshed.** The lead re-signs the current generation on
  every healthy sweep, and the warrant is dead 30 days after its last refresh — so it is only ever as
  old as the last time the pack was healthy. Expiry and revocation are different mechanisms and
  neither substitutes for the other ([`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §18.4).
- **Arming is two-phase, and the second phase is a restart.** *Stored* — the warrant lands on a peer's
  disk over the pack link and is inert at the transport. *Anchored* — that peer's next restart builds
  its listener with `ca: [leadCert, deputyCert]`. Until then a takeover from that peer's side is
  **impossible**, not merely refused, and `pack status` names the un-anchored state as a finding
  *before* the outage ([`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §18.5, §18.13).
- **`collie pack deputy` therefore restarts the peers, over the operator's own SSH.** One consent for
  the whole batch, listed before it runs; ADR 0015/0016's channel, never a wire message. A machine
  with no SSH route is **reported**, never silently skipped
  ([`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §18.13).
- **The takeover asks before it acts, in a fixed order: the lead, then the peers, then itself.** One
  patient `hello` at the lead — *if it answers, the takeover is refused and nothing has changed*. Then
  a `probe` round that changes nothing anywhere; any peer answering `lead_is_alive` aborts the whole
  thing. That is evidence about one machine's own inbox, not a vote. Only then does the deputy commit
  locally ([`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §18.16).
- **The commit spends the warrant.** The pack has no deputy afterwards, the old lead is carried as an
  ordinary member, members that missed the commit round are `rePinPending` and reconcile with no
  operator step.
- **Re-entry mints nothing.** A deposed lead resolves its successor out of **its own roster**,
  requires `sha256(certPem) === deputyFingerprint`, keeps its member id and the pack secret, and heals
  to `peer` in one committed transition. Every certificate involved was pinned before the event; the
  transition is strictly privilege-decreasing, which is ADR 0026's corollary and the only reason an
  automatic membership change is tolerable here ([`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §18.12).

## Consequences

- **A deputy is provisioned, not declared.** Naming one touches every machine in the pack exactly
  once. That cost is the honest price of the anchor list, and the partially-armed state in between is
  a named state rather than a surprise.
- **A takeover is spent, so recovery leaves a follow-up.** After one, the operator names a new deputy
  at a keyboard. That is a decision, not a repair.
- **A peer that never restarted is invisible to a takeover** — its handshake refusal is
  indistinguishable from being down, so it lands in the pending bucket and reconciles later.
- **The old lead's front door is not torn down for it.** Publishing is that machine's operator's act
  (ADR 0001); failing the health check is what makes the un-torn-down door harmless meanwhile.
- **A rotation while a deposed machine is away still strands it.** §8.4's rule is not relaxed; what
  this decision adds is that the state is *named* instead of mistaken for silence.

### Alternatives considered

- **Any peer may claim leadership on lead-silence.** Rejected — it hands the choice of the new lead to
  whoever can take the old one offline, which is the shape ADR 0014 already refused. Pre-designation
  moves the choice back to the operator, made while the lead is healthy enough to sign it.
- **A warrant that expires a fixed time from issue.** Rejected: it expires precisely when it is
  needed. The lead is the only party that can re-issue one, so a *T*-from-issue lifetime is worthless
  for any outage beginning after the lead's last re-issue — an operator whose lead died on holiday
  would find the deputy disarmed at the one moment it mattered. This is exactly what separates a
  warrant from §14.1's ten-minute promotion approval: that is a consent to something happening *now*,
  minted by an operator standing at the machine; a warrant is a standing eligibility whose whole value
  is surviving the event. Refreshing a standing generation takes the useful half of both readings.
- **A deputy certificate carried independently of the warrant, or learned off the wire at takeover.**
  Rejected. A peer holds no roster beyond its lead, so the certificate must travel *with* the warrant
  push and is accepted only when `sha256(certPem)` equals the signed `deputyFingerprint` — the same
  rule enrollment already uses, because BoringSSL anchors on certificates and a hash cannot be
  anchored. Learning a certificate at takeover time would let the commit create trust that did not
  already exist; what a peer pins is the certificate **its own listener already anchored**.
- **Trigger the arming restart over the pack link.** Rejected: the pack link is not a control channel
  (ADR 0016, and ADR 0024's beacon rule generalises). A restart instruction on the wire is a remote
  code path guarded by the same two factors that guard a pane read, and it would make the link a
  control plane for the sake of skipping an SSH leg Collie already has.
- **Sign the deputy's certificate PEM into the warrant.** Rejected: it puts ~700 bytes under a
  canonical string for no additional guarantee, since the fingerprint already binds it.

### What would justify revisiting

- **A transport that can be re-pinned live.** If a listener could adopt an anchor without a restart,
  the two-phase arming collapses to one phase and `pack deputy`'s SSH leg becomes optional rather than
  load-bearing — the single largest cost in this decision.
- **More than one machine worth ranking.** A pack with several always-on candidates re-opens ADR
  0026's rule 2 first; this ADR's mechanism only follows.
- **Collie growing a real identity model.** The same trigger ADR 0013, 0014 and 0026 all name: once a
  request carries a *person*, "the lead signed this in advance" stops being the only pre-event proof
  available.
