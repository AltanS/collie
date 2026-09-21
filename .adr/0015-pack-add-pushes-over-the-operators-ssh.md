# 0015 — `pack add` pushes the lead's own commit over the operator's SSH

Status: **Accepted** (2026-08-12)

Related: [ADR 0014](./0014-promote-is-a-confirm-on-the-lead.md) (the two-machine consent this ADR must
not weaken) · [ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md) (a peer publishes
nothing) · [ADR 0006](./0006-update-advances-the-checkout-herdr-installed.md) (the checkout shapes an
install lands in) · contract: [`PACK_PROTOCOL.md`](../CREW_PROTOCOL.md) §8.2, §8.3 · joined, not
replaced, by [Addendum — 2026-09-21](#addendum--2026-09-21-a-lead-with-no-commit-installs-from-the-release)
below (a second route for a lead that has no commit)

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
a rebuilt-but-not-restarted collie is the thing that makes hand-rolled enrollments survivable, so
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

## Addendum — 2026-09-21: a lead with no commit installs from the release

Status is unchanged: **Accepted**. Nothing above this line is rewritten. In 2026-08 every Collie was
a checkout; `scripts/install.sh` and the packages came later, and a lead installed that way runs a
release tree with no `.git` in it. Decision (b) then reads as a refusal of `crew add` itself, so
1.11.0 shipped a refusal with a manual path, and a verb that prints instructions on two of three
install kinds is not a verb. This addendum records the second route `crew add` and the terminal
`crew update` grew for such a lead (#248).

### 1. Why (b)'s two refusals do not apply to a lead with no commit

- **Remote egress.** (b) refused an assumption about the member, and this lead's members have already
  made it: ADR 0016's addendum has a peer fetch its lead's release tag from GitHub to level itself,
  and the phone's crew update runs `collie update` on each member. A member that cannot reach GitHub
  cannot be led by a commitless lead at all. That is a fact about the pair, not a cost this route adds.
- **Version pinning.** (b) refused *a ref that has to be resolved*. A release tag is not one. It names
  one immutable artifact, `COLLIE_TAG` skips the installer's `api.github.com` call entirely, the
  installer verifies the download's sha256 against the release's own integrity manifest, and the leg
  re-reads `collie version` on the member afterwards and fails when it does not match. Pinning is
  verified here where the bundle had it structurally, which is a weaker claim honestly made.
- **Trust and consent.** The sha256 check is a consistency check against the release's own manifest,
  both fetched from github.com: it catches a corrupt or mismatched download, not a signature, and it
  is the same trust the lead itself was installed with by `install.sh` and the same trust `collie
  update` on a binary install already spends, so this route adds no new party to trust and no
  signature it did not have. The person who holds ssh to the member is the person who would otherwise
  type the install.sh line there by hand, and this route runs exactly that line with the tag filled
  in, so the consent is the operator's own, not the member's self-levelling borrowed as precedent.
  The route needs the MEMBER to reach github.com, which the bundle route never needed: a member with
  no route to github.com stays a bundle member and needs a checkout lead, and the installer's own
  download error is what such a member reports.

### 2. What stays

- **(a) in full.** Collie drives its own `ssh`: the release install is one more leg script down the
  same `RemoteRunner`, not a second transport. **(c) holds for the bundle route** and does not reach
  this one, where the member takes the platform tarball the project already publishes and checksums.
- **(d) and (e) in full.** No route, no listener, no header and no protocol vocabulary; enrollment is
  the same locally minted invite and the same `collie join`, token on stdin only; and `crew add`
  still never wraps `approve-promote` or `promote`.
- **The installer is a PAYLOAD over ssh, never `curl | sh` on the member.** `cli/installer-embed.ts`
  compiles `scripts/install.sh` into the lead's own binary, and the leg pipes it down the same quoted
  heredoc the bundle and the token ride. The far machine gains no second door and nothing new to trust.
- **The dependency moves, it does not grow.** A bundle member needs `git` and Bun; a release member
  needs `curl`, `tar` and a sha256 tool instead. Herdr is required on both, each is probed in leg 1,
  and each absence is one line naming the fix.

### 3. The route by member

`routeOf(kind)` picks the column from the LEAD's install kind and leg 1 reports the row. A member
that takes the other kind of code is named, never written over; a skipped one does not stop the run,
and a blocked one stops it before anything is sent.

| member | checkout lead: bundle | binary or packaged lead: release |
| --- | --- | --- |
| none | add: clone and build the commit · update: "no Collie there" | add: install.sh lays the tag down · update: "no Collie there" |
| git | add: prompt, then push the commit, dirty refused · update: the same | add: enrolled when already at this release, else refused, naming `collie update --to-tag` there · update: skipped, same remedy on the row |
| binary | add: refused, move it aside or add from a release lead · update: skipped, the phone's Updates page levels it | add: prompt, then replace at the same root · update: levelled to the lead's tag |
| other | add: the push fails, left as found · update: the same | add: refused, add it by hand · update: blocked, `collie update` there |
| packaged | add: not reached, the probe reads `$HOME` · update: skipped, `packaged` | the same |

On a release mismatch after the install, exit 26: the installer has already laid the version down
and flipped `current`, exactly as a hand-typed install.sh would have. Nothing is rolled back there,
and the operator is told the version the member now answers with.

### 4. The latent bug the probe closed

Leg 1 used to ask only whether a Collie is there. An install.sh member keeps its Collie behind
`<dir>/current`, which was in none of the probe's candidate paths, so a checkout lead saw a bare
machine and pushed a bundle that cloned a SECOND Collie into `~/.collie` beside the running one, and
`crew update` said "no Collie checkout there" about a machine that had one. The probe now reports
the two shapes it tells apart, `checkoutgit` and `installroot`, and looks behind `current`.

### 5. The trail

`routeOf` and `installReleaseScript` in `cli/remote.ts`, `planRelease` in `cli/crew-update.ts`, the
embedded script in `cli/installer-embed.ts`, the `routeOf (#248)`, `the release route` and `the
bundle route meets a release member` tests in `cli/remote.test.ts`, and `cli/installer-embed.test.ts`.

### 6. What would justify revisiting

Unchanged, and one of the three has half-fired. "A host class with no `git`" was named above as the
case where a signed artifact push narrows (b) rather than reverses it. This is that case from the
other end: the *lead* lost its git, not the member, and the artifact is pulled rather than pushed.
Either way a member runs one exact version the operator named, which is what (b) protects.
