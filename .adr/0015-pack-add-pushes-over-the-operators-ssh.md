# 0015 — `pack add` pushes the lead's own commit over the operator's SSH

Status: **Accepted** (2026-08-12)

Related: [ADR 0014](./0014-promote-is-a-confirm-on-the-lead.md) (the two-machine consent this ADR must
not weaken) · [ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md) (a peer publishes
nothing) · [ADR 0006](./0006-update-advances-the-checkout-herdr-installed.md) (the checkout shapes an
install lands in) · contract: [`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §8.2, §8.3

## Context

Enrolling a second machine costs, today, four steps across two shells and one clipboard: install
Collie on the far machine, start it, run `collie pack invite` on the lead, carry
`<token>.<lead-fingerprint>` over and run `collie join <lead-address> -` there (`cli/pack.ts`
`cmdPackInvite` / `cmdJoin`; §8.2). Every one of those steps is correct and none of them is
*discoverable*. The failure that dominates in practice is not a refused token — it is a peer whose
`COLLIE_HOST` stayed on loopback, so the lead cannot dial it and the member sits provisional, exactly
the trap §3 warns about and `pack status` reports after the fact.

The operator already has a channel to the far machine that is strictly stronger than the invite
token: an SSH login. `collie pack add <ssh-host>` is the verb that uses it — probe, install, configure,
enroll, over one connection. The decisions below are the ones that will be re-proposed, because each
has an obvious cheaper-looking road.

**Studied from herdr's `--remote` behavior.** Herdr solves the same shape (drive a second machine over
the operator's SSH) and its binary was read for the pattern book rather than its code: ride
`~/.ssh/config` and `known_hosts` rather than reimplementing them; add ssh options only
(`ControlMaster=auto`, `ControlPersist`, `BatchMode=yes`, `ServerAlive*`) and never touch
`StrictHostKeyChecking`; one multiplexed control socket so the operator authenticates once for the
whole run; every remote leg a `/bin/sh -s` script piped over **stdin** — no `curl | sh`, no login
shell, no `PATH` assumptions, `[ -x ]` probes at fixed paths; probe-before-install idempotency
("already compatible" vs. reinstall) with a y/N before every disruptive step and a legible abort when
non-interactive; atomic remote writes (tmp → verify → rename) and a post-install version re-check that
must match or hard-fail; three disjoint error families (ssh spawn failed / remote exited nonzero /
remote answer unparseable); an ssh-agent hint keyed off ssh's actual stderr rather than guessed;
secrets only ever on stdin. Those are adopted wholesale. What is **not** adopted is herdr's transport
itself — which is the first decision.

## Decision

### (a) Collie drives its own `ssh`; it does not delegate to `herdr --remote`

The obvious road is to shell out to the tool that already does this well and inherit its
multiplexing, its prompts and its error handling for free. It is refused: `pack add` would then only
work where Herdr is installed **on the lead**, in a version whose `--remote` flags have not moved, and
Collie's remote story would be a private, closed-source surface it cannot test, pin or read. Collie is
a Herdr plugin *today* and its graduation into a standalone multiplexer is anticipated (discussion
#67); a transport dependency is the one kind of coupling that would have to be unwound at exactly the
moment there is no Herdr to unwind it from. `ssh` is a stable, universal, testable interface, and the
pattern book above is the part of `--remote` worth having.

This is not a claim of independence Collie has not earned. `pack add` **requires Herdr on the remote
host** and stops legibly when it is absent, because a Collie there would have no herd to show. The
dependency is on the *destination*, where it is real, not on the *transport*, where it would be
gratuitous.

### (b) Distribution is a PUSH of the lead's own commit, as a `git bundle` over stdin

`git bundle` the commit the lead is running, pipe it into the SSH stdin, unbundle and check out
remotely, build with the existing shim. The alternative — have the far machine `git clone` GitHub or
fetch a release tarball — is refused on two counts. It requires **remote egress**, which a machine
reachable only over an overlay routinely does not have and which turns a two-machine setup into a
firewall conversation. And it reintroduces the problem the push does not have: *which version*. A
pull has to be told a ref, that ref has to be resolved, and the answer has to be checked against what
the lead is running. **The bundle IS the lead's commit**, so exact-version pinning is structural
rather than enforced — there is no ref to get wrong, and no window in which `main` moved between the
lead's install and the peer's.

The cost is stated rather than hidden: the far machine must have `git` (and `bun`, to build). Both are
probed in leg 1 and each absence produces one install hint, the same posture herdr takes toward
`curl`.

### (c) Source, not a prebuilt binary

`scp`-ing the lead's `bin/collie` looks like it removes the Bun dependency. It replaces it with a
worse one: the operator must now match architecture and libc across two machines, and Collie's answer
to a mismatch would be a binary that does not run. Collie is source-distributed by design — the M6
shim (`scripts/collie-ctl.sh`) exists precisely to build a native binary from a checkout in a minimal
environment with no login shell and no `PATH`, which is byte-for-byte the environment
`ssh host '/bin/sh -s'` provides. `pack add`'s install leg therefore runs **the same bootstrap the
plugin already runs on first start**, and cross-arch matching stops being a problem anyone has.

### (d) No new wire surface — SSH is the operator's channel, and the pack protocol stays ignorant

`pack add` adds **no route, no listener, no header and no protocol vocabulary**. It mints the invite
locally through the same `mintInvite` path as `collie pack invite`, and the far machine runs the same
`collie join <lead-address> -` an operator would have typed, with the token on stdin (§8.3 — never
argv). Everything `pack add` does is something the operator could have done by hand, in the same
order, with the same verbs. That is the design constraint, not a happy accident: an installer that
needed the protocol's help would be a second admission path into the pack, and the pack has exactly
one (§8.2).

### (e) Collapsing JOIN to one machine is consent-safe; collapsing PROMOTE never is

`pack add` runs both halves of an enrollment from the lead, and that is *not* a quiet reversal of ADR
0014's two-machine rule. The two verbs are two-machine for different reasons:

- **`join` is two-machine because of friction.** The invite token exists to substitute for a channel
  the operator does not otherwise have to the joining machine — it is a ten-minute, single-use bearer
  credential carried by hand precisely because there was no other way to speak to that host. An
  operator with **SSH to the host is that channel**, and a stronger one: it authenticates the operator
  to the machine continuously, where the token authenticates one exchange. Automating the carry does
  not weaken anything; it uses a better channel for the same purpose. (The token is still minted,
  still single-use, still ten minutes, still stdin-only — `pack add` is a courier, not a bypass.)
- **`promote` is two-machine because of security.** ADR 0014's gate exists so that consent proves
  control of the machine **being taken from**. Nothing about holding SSH to a peer establishes that
  the lead's operator agreed to be demoted — that is the whole content of the decision.

Therefore: **`pack add` never wraps, chains or automates `pack approve-promote` or `promote`.** It is
a non-goal with a reason, not an unimplemented feature.

### `collie doctor`, and why it belongs beside this

The same field traps that `pack add` closes *by construction* for a machine it installed still exist
on every machine it did not. `collie doctor` is the read-only counterpart: one check per line, each
warning naming the verb that fixes it, nonzero exit on any error-severity finding. It is not covered
by an ADR of its own — it closes off no road — but it is the reason `pack add` can stay narrow: a
diagnostic surface that names the loopback bind, the deny-all ACL (`cli/tailnet.ts`
`tailnetInboundBlocked`, currently read only by `qr`), clock skew against §8.6's ±5-minute window and
a rebuilt-but-not-restarted bridge is the thing that makes hand-rolled enrollments survivable, so
`pack add` does not have to grow into a repair tool.

## Consequences

- **Collie gains a dependency on `ssh` at the lead, and on `git` + `bun` + Herdr at the peer.** Each
  is probed before anything is written, and each absence produces one legible line naming the fix.
  Nothing is installed on the operator's behalf.
- **`pack add` inherits the operator's SSH configuration wholesale, including its mistakes.** Host
  aliases, jump hosts, keys and `known_hosts` all work because Collie does not reimplement them; a
  host whose key changed fails the way `ssh` fails, and Collie does not offer to accept it.
  `StrictHostKeyChecking` is never set, in either direction.
- **The lead becomes able to install software on another machine.** That is a real escalation of what
  the verb set can do, and it is bounded by being *the operator's own SSH*: no daemon does this, no
  pack request triggers it, and nothing about being a lead grants it. A compromised lead's reach is
  unchanged — §8.5's model already grants it every peer's terminals, which is strictly more than an
  install.
- **The peer's bind is correct by construction, not by advice.** Leg 1 reads the remote tailnet
  address and leg 3 writes it as `COLLIE_HOST`, which is the single change that closes the
  provisional-member trap. Hand-rolled joins keep the trap; `collie doctor` is where they meet it.
- **A peer installed by `pack add` still publishes no front door** (ADR 0013). The configure leg
  writes no serve mapping and the install leg does not start one.
- **Enrollment stays exactly one exchange.** Nothing in `PACK_PROTOCOL.md` changes, `PACK_PROTOCOL_VERSION`
  does not move, and a `pack add`-enrolled member is indistinguishable on the wire and in the trust
  store from a hand-joined one.

### Alternatives considered

- **Delegate to `herdr --remote`.** Decision (a). Free multiplexing and prompts, at the price of a
  closed, unpinnable dependency on the exact thing Collie expects to graduate from.
- **Pull from GitHub / a release tarball on the far machine.** Decision (b). Needs remote egress and
  hands back the version-matching problem the push does not have.
- **`scp` the built binary.** Decision (c). Trades a build dependency for an architecture-matching
  dependency, and Collie's whole distribution model already builds natively.
- **A `pack add` route in the protocol** — have the lead ask a running peer to enroll itself.
  Rejected as circular: the peer has no Collie yet, which is the entire problem. Any such route would
  be a second admission path into the pack.
- **Prompt-free, fully automatic install.** Rejected: the disruptive steps (overwriting a checkout,
  reconfiguring an existing instance) get a y/N, and a non-interactive run aborts legibly rather than
  guessing — herdr's posture, adopted.
- **A TUI for the progress display.** Rejected in the spec rather than here, for reasons that are
  operational rather than architectural: `pack add` runs under `env -i`, over pipes and inside SSH,
  and its transcripts have to paste into an issue.

### What would justify revisiting

- **Collie graduating from Herdr and growing its own remote protocol.** If a standalone Collie ever
  speaks to remote machines as a first-class capability, `pack add` should ride *that*, and decision
  (a)'s reasoning inverts: the thing it refuses to depend on would be Collie's own.
- **A host class with no `git`** — an appliance, a minimal container image, an airgapped box that
  cannot even receive a bundle through this path. That is when a signed artifact push (still a push,
  still exact-version) earns its keep and decision (b) narrows rather than reverses.
- **Herdr shipping a stable, documented remote-exec interface** with a compatibility promise. That
  changes (a) from "a private surface we cannot pin" to a real interface, and the delegation argument
  deserves a second hearing — though the graduation argument survives it.
