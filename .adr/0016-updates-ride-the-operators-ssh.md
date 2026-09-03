# 0016 — Updates ride the operator's SSH, never the pack wire

Status: **Accepted** (2026-08-15)

Related: [ADR 0015](./0015-pack-add-pushes-over-the-operators-ssh.md) (the same channel, for the same
reasons, one verb earlier) · [ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md) (a
peer listens for its lead and admits nobody else) · contract:
[`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §7.1, §8.5, §11

Amendment proposed: [ADR 0035](./0035-pack-updates-from-the-phone-amend-0016.md), a non-interactive
pack key on the lead, restricted on every peer by a forced command scoped to a **pinned tag**. It
removes the interactive consent this ADR relies on, so it is **Proposed**, not accepted; until it is
reviewed on its own, the phone does not push to peers.

## Context

A pack drifts. The lead updates, its peers do not, and `collie pack status` renders the skew as a
`warn:` per member (§7.1) — correctly, because skew refuses nothing. The remedy, until now, was a
sentence: *update the older machine*. On four machines that is four SSH sessions and four `collie
update`s, and the finding that names it is on the lead, where the operator already is.

`collie pack update <member>… | --all` closes that: it is `pack add` minus the enrollment. Same
bundle, same install leg, same operator SSH, plus a restart of the far machine's own bridge and a
`hello` verification that the skew warning has actually gone.

The road that will be proposed instead — repeatedly, because it *looks* like the tidy one — is to
carry the update over the link the two machines already have. The lead and the peer hold a pinned,
mutually-authenticated TLS channel with a shared secret over it (§8.1). A `POST /pack/v1/update`
would need no ssh, no operator credential and no second dependency, and would work for a peer the
operator cannot log into.

## Decision

**Code distribution to a peer is credentialed by the operator's own SSH, and by nothing else. The
pack link carries runtime data; it never becomes a software-distribution channel.**

Concretely:

- `collie pack update` reuses `pack add`'s transport and leg scripts (`cli/remote.ts`) and adds **no
  route, no header and no protocol vocabulary** — the same constraint ADR 0015 (d) put on `pack add`,
  for the same reason.
- A peer accepts nothing inbound that could change what code it runs. Its `/pack/v1/*` surface stays
  what §5 lists.
- What the operator typed to reach a machine is remembered **locally**, in `pack-ops.json` beside the
  trust store: member id → ssh host, remote checkout, port. It is written by `pack add` on a run that
  finished, refreshed when `pack update` is given an override, and dropped by `pack remove`.

### Why not over the wire

- **It would add exactly the inbound admission surface ADR 0013 rejected.** A peer publishes no front
  door and admits only its pinned lead precisely so that "what can reach this machine" stays a
  one-line answer. A route that unbundles and *builds* is the largest possible thing to put behind
  that answer.
- **It would make a compromised lead a code-execution credential on every peer.** §8.5 already grants
  a compromised lead every peer's terminals, and the reflex is to conclude that arbitrary code adds
  nothing. It adds two things. The terminal reach is *live* — it needs the attacker present, and it
  ends when the lead is cleaned; an installed build **persists across the cleanup** and survives on
  machines the operator will not think to check. And it is reachable **without any human**: an
  operator's SSH is a key that has to be held and used, while a pack request is something the daemon
  will do while nobody is looking. Requiring the operator's own credential keeps the blast radius of
  a stolen pack secret at "read the herd", which is where §8.5 draws it.
- **The pack secret is a symmetric bearer credential, and this would be its worst possible use.**
  Rotation exists (§8.4) because the secret can leak. Every capability behind it should be one where
  a leak costs an outage, not a supply chain.
- **The push does not need it.** The lead already has a channel that is strictly stronger for this
  purpose — ADR 0015 (e)'s argument, unchanged: SSH authenticates the operator to the machine
  continuously, and it is the channel by which that machine got its Collie in the first place.

### Why `pack-ops.json` is a second file

The ssh host could have been a field on `TrustedMember`. It is not, because that file is the *trust*
file: `TRUST_STORE_VERSION` whitelists its fields (`parseTrustStore`), every one of them is material
a pin, a secret or an admission depends on, and a malformed one invalidates the whole store. An ssh
alias is none of those things. It is also **operator-local by nature** — how *this* human reaches a
machine, which is not a property of the member and is not the same answer from another lead.

So it is a sibling file with the same 0600/0700 discipline and its own version, and the rule it must
never break is short: **`pack-ops.json` is never sent, never received, and never merged into
`pack-trust.json`.** A peer neither learns nor asserts how its operator dials it. Its entry in
`bridge/solo-baseline.test.ts`'s pack allowlist is the mechanical half of that promise — a solo
instance writes it never.

## Consequences

- **A peer the operator cannot SSH into cannot be updated from the lead.** That is the trade, stated
  plainly: `pack update` reports it as `skipped — no ssh record` and names `pack add`, and the fallback
  is `collie update` on that machine. A pack whose members are not administrable by their operator is
  not a case Collie will solve by widening what a lead may do to a peer.
- **The lead's ability to install software on another machine stays bounded by the operator's SSH.**
  No daemon does it, no pack request triggers it, and nothing about being a lead grants it — the same
  sentence ADR 0015 wrote about `pack add`, now load-bearing for a verb that runs against N machines.
- **One consent covers the batch.** Consent is per *operation*, asked once after every member has been
  probed read-only, and a non-interactive run aborts rather than proceeding. There is deliberately no
  `--yes`: a flag that skips it turns one typo into N rebuilt machines.
- **The verb is honest about what it verifies.** A member counts as updated only when the lead
  reaches it over the pack link afterwards and it answers `hello` (§5) — the same fact `pack status`
  renders as skew. An ssh exit code is not evidence that the skew is gone.
- **`pack-ops.json` is convenience, so it fails soft.** Unreadable ⇒ reported and left untouched,
  never rewritten; absent ⇒ the operator passes `--host` once and it is remembered.

### Alternatives considered

- **`POST /pack/v1/update`** — the decision above.
- **A peer that polls the lead for a newer commit.** Same objection, inverted and worse: a peer that
  pulls code from its lead on a timer needs no compromise of the *lead's* operator at all, and it
  turns §7.1's benign skew into an automatic, unsupervised rollout.
- **Reusing `collie update` on the peer instead of a bundle push** (`ssh peer collie update`). It
  fetches from GitHub, which is exactly the remote-egress assumption ADR 0015 (b) refused, and it
  levels the peer to *the default branch's tip* rather than to the commit the lead is running — which
  is the version-matching problem the push does not have.
- **Making `pack update` a wrapper around `pack add`.** Rejected: `pack add`'s enrollment legs are
  precisely what must not run again for an existing member, and its per-member replace prompt is the
  wrong consent shape for a batch. The verbs share their transport and their leg scripts, and not one
  word of their output.

### What would justify revisiting

- **A pack whose members are genuinely not SSH-reachable by their operator** — a fleet of appliances,
  say — where the only administrative channel that exists *is* the pack link. That is a different
  product shape than "machines you already own a shell on", and it would need its own admission
  story (signed artifacts, an operator-held signing key, a peer that verifies rather than trusts),
  not a widening of this one.
- **Collie graduating from Herdr into a standalone multiplexer** (discussion #67) with a real remote
  protocol of its own. If such a channel exists and is operator-credentialed, this ADR's *mechanism*
  moves onto it; its *rule* — the pack link is not a distribution channel — survives unchanged.
