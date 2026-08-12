# 0014 — Promotion is a confirm on the receiver, not a command from the claimant

Status: **Accepted** (2026-08-11)

Related: [ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md) (the pack listener and its
two factors) · [ADR 0012](./0012-every-machine-runs-a-collie-and-the-pack-has-a-lead.md) (the
vocabulary this ADR's verb has to fit) · contract: [`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §8.5,
§8.6, §14, §16

## Context

`POST /pack/v1/lead` (§14) is the route that moves the crown. As shipped in `1.0.0-alpha.9` it takes
a **self-claim**: an enrolled member says "I am the lead now", the claim is authenticated by §8.6's
signature and checked against one rule — the claimed member id must be the admitted one — and the
receiver acts on it. The signature proves **which member is speaking**. Nothing in the exchange
proves **that an operator willed it**, and the wire cannot tell an operator-run `collie promote` from
a compromised peer running the same verb.

§8.5 has documented this since 2026-08-08 (finding **F2**) and named the mitigation without shipping
it. This ADR is that mitigation, and it is a **beta blocker**: a compromised peer is supposed to
reach "its own machine's terminals", and this route is how it reaches past that.

### The capture chain, as the code actually stands

The claim lands on `newLead()` (`bridge/pack/router.ts`), which branches on whether the receiver is
leading:

- **On the lead → `demoteSelf` (`bridge/pack/enrollment.ts:645-664`).** The current lead steps down
  **on disk** and answers with its **full roster** — every remaining member's id, address and
  certificate. The claimant is pinned as the new lead in that same write, so the demoted machine's
  **next restart** brings it back as a peer of the attacker, which then drives the former lead's
  panes, journal and uploads. One compromised peer therefore buys pack-wide **denial** (the front
  door moves, no operator consented) plus **a second machine's terminals** — the reach §8.5
  otherwise reserves to a compromised *lead*.
- **On a peer → `adoptLead` (`:608-632`).** The receiver re-pins the claimant and starts dialling it,
  keeping its member id and the pack secret.

The peer branch is worth being precise about, because the honest reading is that **the transport
already closes it in v1** — and it is gate 1, on the demotion, that closes the reachable capture
chain.

**A compromised peer cannot reach another peer's `adoptLead`, and the transport is why.** A peer's
listener is built with `ca: [<its lead's certificate>] · requestCert · rejectUnauthorized`
(`bridge/pack/transport.ts:51-63`, §8.1's 2026-08-07 amendment), and a peer's roster holds exactly
one member — a peer cannot even gain peers, because `pack invite` is refused on a peer
(`cli/pack.ts:323-324`). So the **only** caller that can reach a peer's `adoptLead` branch is the
peer's own currently-pinned lead, and that self-claim `adoptLead` collapses to a no-op (`already`
check, `enrollment.ts:611-617`). A promoted *new* lead is refused at the TLS handshake, before HTTP
exists. There is no live peer-re-pin path in v1's topology for a route-level rule to close.

The demoted-but-not-restarted window does **not** widen this, and the earlier draft's claim that it
did was wrong. `demoteSelf` sets `peers: []` (`bridge/pack/enrollment.ts:655-660`), so during that
window `pinnedMembers()` is `[claimant]` only — no *other* member can authenticate to the demoted
machine at all, and the claimant re-claiming is the same no-op above. So the only reachable branch is
the demotion itself, and gate 1 closes it.

What a route-level peer rule *would* be for is a **future** topology in which a peer can pin more than
its single lead — roaming, multiple leads, a mesh — where the transport can no longer be the whole
answer and §8.6's receiver-naming note comes due. That is reserved, not built (§16); v1 has no such
topology.

### Why warn-only was rejected for beta

The obvious cheap answer is to keep the self-claim and make it loud: audit the demotion, log it,
surface it in `collie pack status`. That is the right instinct for a control Collie cannot enforce
(§3's wildcard-bind warning is exactly that shape, and ADR 0013 argues for it). It is the wrong one
here, for a reason the two cases do not share: **a wildcard bind is the operator's own decision being
reported back to them; an unconsented demotion is an attacker's decision being reported back to
them.** A warning about a state change that has already committed, on a machine whose front door has
already moved and whose roster has already been handed over, arrives after everything it would warn
about. Collie *can* enforce this one, cheaply, so declining to is not humility.

## Decision

**Promotion is a confirm on the receiver, not a command from the claimant.** One gate, on the
demotion — the reachable branch — because the peer branch is already transport-closed in v1 (above).
The full wire contract is `PACK_PROTOCOL.md` §14; what follows is the reasoning.

### The gate: old-lead consent on the demotion

A new operator verb, run **on the current lead**: `collie pack approve-promote <member-id>`. It mints
a **pending handover approval** in the trust store — `{ memberId, createdAt, expiresAt }`, ten
minutes, single-use, at most one live at a time, minting replaces any prior, swept lazily exactly as
invites are. `newLead()` on a leading collie demotes **only** if a live approval names the claimant,
and consumes it in the same committed transition. Without one it refuses honestly and names the verb
the operator must run.

**The approval is not a secret and carries no token.** The claim is already signature-authenticated
against a pinned certificate (§8.6); what was missing was never *who is speaking* but *whether this
machine's operator agreed*. Consent therefore only has to name **who may take over** — no new secret
material crosses the wire, nothing new leaks if the store does, and the approval record is inert to
anyone who cannot already produce a valid §8.6 signature for that member id.

**Consent lives on the receiver because that is the machine being taken from.** Running the verb on
the lead proves the operator controls the machine that is about to lose its terminals, its roster and
its front door. Any design where the claimant supplies the consent — a flag, a second signature, a
confirmation token it was handed earlier — proves control of the machine that stands to *gain*, which
is the machine the attacker already has. Promotion now touches both machines, and that is the point,
not a cost to be optimised away.

Three mechanics keep the gate from leaking, each verified against the code as it stands:

- **The approval survives into the process that consumes it — `approve-promote` restarts the lead.**
  A collie reads its trust store at most once per process (`trust-store.ts:329-341`,
  `loaded` latch), so a CLI-minted approval would be invisible to the already-running collie and the
  promotion would refuse forever. The verb therefore mints **and** restarts (`applyLocally`, as every
  membership verb does), so the process that later fields the claim has read the approval. The cost is
  honest — the restart drops the lead's live pack links and the phone's connection for a moment — but
  it happens at approve-time, before the operator walks to the peer.
- **Consent binds the certificate, not just the id.** `newLead` today checks only
  `claim.memberId !== from.memberId` (`router.ts:436-438`) and then pins the *claim's* certificate, so
  an approved member could pin any key under their id. The demotion additionally requires
  `claim.fingerprint === from.fingerprint`; since `parseRosterEntry` enforces
  `fingerprint === sha256(certPem)`, matching the fingerprint binds the pinned key. "Consent names who
  may take over" is only true if the key is the one already pinned.
- **The refusal has an error channel.** The pure transition returns a **discriminated** refusal —
  `not-leading` → `400`, `not-approved` → `403` — rather than the bare `null` that already means "no
  change" (`router.ts:446`), so the router can emit §14.3's honest `403`. Reading the approval and
  demoting stay **one committed transition** inside the single serialised `TrustStore.update` write:
  one `next`, the approval consumed with the role flip, one audit line, and no pre-read/expiry race.

### `--force` now strands every peer, and says so

`--force` exists for an old lead that is gone. A peer pins its *current* lead at the handshake (§8.1's
2026-08-07 amendment), so a promoted lead a peer does not yet pin is refused at that peer's TLS
handshake — and `promote --force` therefore skips the peer sweep entirely rather than sending requests
it knows will be refused. Every remaining member must re-join with a fresh token, and the checklist
says so for each of them by name. (In the shipped code `--force` already carries an empty roster, so
the sweep had nobody to dial; the change is that the promise now matches.)

This is accepted, not regretted. §14 has always declared transparent failover a non-goal and
re-enrollment the recovery path, and §8.4 imposes the same rule on a peer that misses a rotation. **A
dead lead's peers falling back to re-enrollment is the honest outcome**: a peer that cannot reach the
old lead has no trustworthy way to learn the new one on the wire, and the alternative — letting a peer
accept a claim "because the lead is unreachable" — is a fallback an attacker can *cause*, by taking
the lead offline.

## Consequences

- **Promotion becomes a two-machine operation.** `collie pack approve-promote <member>` on the lead,
  then `collie promote` on the peer inside a ten-minute window. An operator who can only reach one of
  the two machines cannot promote cleanly; that is the same statement as "consent proves control of
  the machine being demoted", and it is the feature.
- **`approve-promote` restarts the lead.** The approval must reach the running collie (which reads its
  trust store once per process), so the verb restarts as every membership verb does — momentarily
  dropping the lead's live pack links and the phone's connection. It happens at approve-time, before
  the operator crosses to the peer, so the `promote` itself runs against a lead that already holds
  the consent.
- **`--force` is now strictly worse than it was, and correctly so.** It previously appeared to keep
  reachable peers; it now cannot, and the output enumerates the re-joins. (In the shipped code it
  already kept none — `promoteSelf` receives an empty roster under `--force`, so the sweep had nobody
  to dial. The change is that the promise now matches.)
- **The trust store gains one optional field, and no new wire object.** `pendingHandover` is a
  top-level field, sibling to `invites`; absent means *no live approval* — never a default-open
  reading — and it must be added to `parseTrustStore`'s whitelist in both the validator and the result
  literal or it is dropped on every read. `PACK_PROTOCOL_VERSION` and `TRUST_STORE_VERSION` both stay
  `1`: the change is additive, §7's exact-1 window would take **every** route down between skewed
  members to close a hole in one, and a store-version bump would make an updated collie reject its own
  pre-amendment store.
- **Version skew closes on the lead's update.** The gate lives entirely on the machine being demoted,
  so a pack realizes the fix the moment its lead is updated; a pre-spec lead accepts the unattested
  claim as it does today, and no peer needs the new build. The general policy for a skewed pack is
  **not** settled here — it is its own pre-beta gate item (§17).
- **The audit trail gains the consent, not just the effect.** `pack.handover.approve`,
  `pack.handover.cancel`, the approval consumed inside `pack.demote`, and a refused unapproved claim
  are all recorded, so "who agreed to this, and when" is answerable from the demoted machine's own
  log rather than inferred from a leadership change.

### Alternatives considered

- **Claim-then-confirm, asynchronously.** The peer posts a *pending* claim; the lead's operator
  confirms it later; the peer polls until it is granted. Rejected: it adds two endpoints, a
  pending-inbound state on the lead that has to be listed, expired and cancelled, and a waiting loop
  on the peer — all to avoid the operator touching the second machine, which is the thing that
  actually establishes consent. The synchronous shape has the same security property with one new
  record and no new route.
- **A countersigned roster generation.** Give the roster a monotonic generation, have members
  countersign each transition, and let a peer accept a lead whose generation is newer and carries
  enough signatures. Rejected: that is quorum machinery, and this protocol has two roles and
  frequently two members. It buys consensus properties nothing here needs, and it would put a
  distributed-agreement failure mode inside an operator verb whose entire design (§14, ADR 0013) is
  "a deliberate operator action, not an election".
- **Also ship a live peer-side handover now (a second gate).** Have the old lead sign a handover
  object, carry it on every peer-bound claim, and make a peer refuse a claim that lacks one. Rejected:
  its precondition does not exist in v1. A peer admits exactly one member — its pinned lead — so the
  only claim that can reach a peer's adopt branch is that lead's own, and a promoted new lead is
  refused at the TLS handshake. Verifying a signature there is verification for a request that cannot
  arrive; the peer path is already transport-closed. The design is preserved as reserved future work
  (§16) so the topology change that eventually needs it inherits the shape rather than bolting it on.
- **A shorter or longer approval TTL.** Ten minutes is the invite's window (`INVITE_TTL_MS`), for the
  same reason: long enough to walk to the other machine, short enough that an armed approval is not a
  standing capability. `--cancel` covers the operator who armed it and changed their mind.
- **Verb naming.** `collie pack approve-promote <member>` was chosen over `pack allow-promote`
  (weaker — it reads as policy rather than a one-shot consent), `pack hand-over <member>` (reads as
  though it *performs* the handover, which happens on the other machine), and `pack step-down --to
  <member>` (accurate but flag-shaped, and it buries the member id). It is plain English and it names
  exactly the verb it consents to, per ADR 0012.

### What would justify revisiting

- **A topology where a peer can pin more than its single lead** — roaming, multiple leads, a mesh.
  That is precisely when the transport stops being the whole answer for the peer branch, and when the
  §16-reserved route-level rule — the outgoing lead's signed handover, verified against a pinned key —
  becomes worth building. It is reserved rather than dropped for exactly this reason: the shape is
  ready to inherit, not to re-derive.
- **A pack that is routinely more than two machines, with more than one operator.** Consent from one
  machine's operator is the whole model here; a pack with distinct operators per machine is a
  different question, and it is the one that would make a quorum scheme worth its cost.
- **Collie growing a real identity model.** The same trigger ADR 0013 names: once requests carry a
  *person* rather than a machine credential, "the operator consented" can be a property of the
  request, and this ADR's two-machine dance is replaced rather than amended.
