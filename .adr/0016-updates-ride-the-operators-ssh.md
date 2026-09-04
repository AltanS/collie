# 0016 — Updates ride the operator's SSH, never the pack wire

Status: **Accepted** (2026-08-15)

Related: [ADR 0015](./0015-pack-add-pushes-over-the-operators-ssh.md) (the same channel, for the same
reasons, one verb earlier) · [ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md) (a
peer listens for its lead and admits nobody else) · contract:
[`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §7.1, §8.5, §11 · narrowed in scope, not reversed, by
[Addendum — 2026-09-04](#addendum--2026-09-04-peers-follow-and-the-link-still-carries-nothing)
below (`PACK_PROTOCOL.md` §19, §20)

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

## Addendum — 2026-09-04: peers follow, and the link still carries nothing

Status is unchanged: **Accepted**. Nothing above this line is rewritten. This addendum records what
M16 built on top of the decision, and answers the reader who stops at *Alternatives considered* and
concludes the decision was reversed. It was not.

### 1. What did not change

The pack link carries **no code, no update route, no update verb and no order**. A peer's
`/pack/v1/*` surface is still exactly what §5 lists, and `X-Pack-Protocol` is still `1`
(`PACK_PROTOCOL.md` §20). A lead still cannot install anything anywhere. The decision sentence above
still reads true, word for word: the lead distributes nothing, and a peer's source of code is
GitHub.

### 2. What is new

A peer reads two additive-optional facts off the sweep its lead already makes: the release the lead
is itself running and has **settled**, and a read-only turn token. On its own decision, and against
its own guards, it then fetches that **public release tag** from GitHub over anonymous HTTPS and
runs the same detached updater, health gate and rollback it runs for `collie update`. The headers
are `X-Pack-Lead-Release` (`bridge/pack/follow.ts:37`) and `X-Pack-Update-Turn`
(`bridge/pack/follow.ts:46`); the lead attaches them in `bridge/pack/peer-client.ts:627-629`, the
peer reads them in `bridge/pack/router.ts:926-927`. The peer answers with an optional `updateRun`
field beside its snapshot (`bridge/update-action.ts:285`, `bridge/index.ts:1595`), which is a report
about itself and carries no pid, no log tail and no recovery command.

### 3. The turn is state, not an order

`X-Pack-Update-Turn` carries a member name and an opaque run id, and nothing else: no version, no
ref, no URL, no command (`bridge/pack/follow.ts:46`, `:85-101`). It is a mutex token with a receipt.
A peer ignores a turn that does not name itself, so a lead cannot address one peer and have another
act. And `X-Pack-Lead-Release` can only ever name what the lead is itself running: it is composed
from the same `collieVersionBare` the lead answers `hello` and `/api/health` with
(`bridge/pack/follow.ts:68`, `bridge/index.ts:1176`). A lying lead therefore moves a peer onto a
real Collie release and nowhere else, which is inside the threat model §8.5 already draws.

### 4. Why this is not "a peer that polls the lead for a newer commit"

That alternative is rejected above, and this is the paragraph that says why M16 is not it. Five
facts, each checkable in the tree:

- **The peer never dials.** It reads a header off a request its lead already made. There is no poll,
  no client, no schedule, and no address for the lead on the peer's side to call. The headers ride
  the existing sweep precisely because a running peer never dials its lead (`PACK_PROTOCOL.md` §20).
- **The header cannot name anything but the lead's own running version.** There is no field in
  which a lead could express "install this other thing" (`bridge/pack/follow.ts:68`).
- **Every guard is on the peer.** Release-build-only, strictly-higher, no-major-crossing, a turn
  naming this member, not-a-tag-already-rolled-back, preflight-green, tag-resolves: all eight are
  evaluated peer-side (`bridge/pack/follow.ts:149`, `:249`). A lead cannot bypass one, because it never
  evaluates one.
- **One attempt per (tag, run id).** A peer that rolled back does not retry inside a run. Only a
  fresh operator confirm on the phone mints a new run id, and that grants exactly one further
  attempt (`bridge/pack/follow.ts:191-201`).
- **One attempt per hour, on the peer.** `FOLLOW_ATTEMPT_INTERVAL_MS`
  (`bridge/pack/follow.ts:52`) is enforced from the peer's own run record, so it survives that
  machine's restart. A lead cycling the headers cannot cycle a peer through restarts.

That is the argument, and here is the honest sentence that goes with it. **Adding these two headers
is a narrowing of this ADR's "no route, no header and no protocol vocabulary" line.** Two headers
were added. The route and the vocabulary were not, no code crosses the link, and the five facts
above are why the narrowing is the smaller change. But it is a narrowing, and a reader who is told
otherwise has no reason to trust the rest of this document.

### 5. The two rejected alternatives, by name

- **"A peer that polls the lead for a newer commit."** Both clauses of the refusal are about a peer
  pulling **from its lead**: it "needs no compromise of the *lead's* operator at all", and it "turns
  §7.1's benign skew into an automatic, unsupervised rollout". M16's peer pulls from GitHub, so the
  lead is not a source of code and compromising it does not distribute one. And the rollout is not
  unsupervised: it cannot begin without an operator confirm on the lead, and the lead's own settled
  version bounds where it can go.
- **"Reusing `collie update` on the peer instead of a bundle push."** Its second reason is answered
  outright: `collie update --to-tag v<x.y.z>` pins the plan to one exact release
  (`cli/update.ts:283-296`), so a peer levels to the tag the lead is running and never to a branch
  tip. Its first reason is not answered, and this addendum will not pretend it is. **M16 assumes a
  peer can reach `github.com` over HTTPS.** That is the remote-egress assumption ADR 0015 (b)
  refused, narrowed here to one destination and one artifact kind. A peer that cannot reach GitHub
  is reported as behind and levelled from the terminal, exactly as *Consequences* above already
  describes for a peer with no ssh record.

### 6. A third alternative, rejected here for the first time: give the bridge an SSH key or an agent

It is the obvious way to let the phone drive `collie pack update` directly, and it is worse than
what M16 builds. It puts a **standing shell credential for every peer** on the lead: readable by a
network-facing, long-lived service, valid for every command on every machine, and still valid after
the incident that exposed it. Outbound HTTPS to GitHub for a pinned public tag is a strictly smaller
blast radius: no credential at all, one destination, one artifact kind, and a checksum the peer
verifies for itself with the mechanism it already had. The argument above for keeping a stolen pack
secret's worst case at "read the herd" applies here unchanged.

### 7. An accepted gap

A lead **rolled back by hand** after its peers have advanced leaves peers ahead of their lead.
Nothing steps a peer down over the link, and nothing will: a lead that could move a peer backwards
is a lead that could move it anywhere, which is the credential this ADR refuses. §7.1 makes the
resulting skew harmless, and the remedy is `collie pack update <member>` from the lead, over the
operator's own SSH, exactly as before.

### 8. The sweep is now heartbeat and rollout trigger

§10.1's poll was a liveness and data cadence. It now also carries the fact that starts an install,
and that is a cost worth naming. The bound on it is one that already existed: `COLLIE_POLL_IDLE_MS`
is clamped at `min: 1000` (`bridge/config.ts:493`), so no configuration makes a lead sweep faster
than once a second. Together with the peer's one-attempt-an-hour limit, that is what keeps a rollout
trigger from becoming a restart amplifier. The lead's turn queue is in-memory only
(`bridge/pack/follow.ts:402`), so a lead restart re-derives it rather than resuming a turn that
outlived the process it described.

### 9. What would justify revisiting

Unchanged. Neither trigger above has fired: this is not a fleet of appliances, and Collie has not
become a standalone multiplexer. Both remain the cases that would move this ADR's mechanism rather
than its rule.
