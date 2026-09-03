# 0035 — Pack updates from the phone (amends 0016)

Status: **Proposed** (2026-09-03), decision deferred. Nothing here is implemented, and no
phone-driven peer push may be built until this ADR is reviewed on its own and accepted.

Amends: [ADR 0016](./0016-updates-ride-the-operators-ssh.md) (updates ride the operator's SSH) ·
Related: [ADR 0020](./0020-a-major-upgrade-is-consented-by-flag.md) (consent without a TTY) ·
contract: [`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §7.1, §8.5

## Context

`collie pack update` is now one sequenced flow: preflight every machine, update the lead, then the
peers one at a time, aborting at the first failure (M15/06). It is driven from a terminal, and it
asks the operator one question before it touches anything.

The phone can now update the machine it is talking to. The obvious next tap is "update the pack",
and that tap has no TTY. ADR 0016's consequences name the reason there is nothing to skip the
question with: *"There is deliberately no `--yes`: a flag that skips it turns one typo into N
rebuilt machines."* So a phone-driven pack update is not a missing button. It is the removal of the
consent ADR 0016 relies on, which is why this is an amendment to that ADR rather than a new one
beside it.

ADR 0016's rule survives either way: the code still goes over SSH and never over `/pack/v1/*`. What
is at stake is *whose* SSH, and what stands in for the human at the terminal.

## Decision (deferred)

Two options. Neither is adopted here.

### (a) A dedicated non-interactive pack key on the lead

The lead holds a key of its own, not the operator's agent, and every peer restricts that key in
`authorized_keys` with a forced command that can run **only** `collie update --to <pinned tag>` and
nothing else. No shell, no bundle push, no second verb, plus `no-pty`, `no-port-forwarding` and
`no-agent-forwarding`.

**The pin is the whole restriction.** A forced command that accepts whatever version the lead names
is a general code-execution credential wearing a restriction: the lead says "update to this", and
"this" is anything. Pinned to one named tag, the peer accepts exactly one published release and the
lead cannot express anything else. The tag is a release the operator cut, which is where the human
judgement moves to.

**What it gives up is the interactive consent at a TTY.** Today one human answers one question
after every member has been probed. Option (a) replaces that with a standing credential: a key on
disk, on the lead, usable by whatever can reach it, with no human in the loop at the moment it is
used. That is a real loss, and it is why this ADR is not accepted with a shrug.

**What narrows the blast radius, if it is ever taken:**

- The forced command, pinned to a tag. The peer runs one command with one argument, or nothing.
- No bundle. The peer takes a published, tagged release rather than this lead's working commit, so a
  lead whose checkout is compromised cannot hand its own code to anybody.
- The peer's own health gate and single rollback (M15/04) still run, on the peer, under its control.
- The key is the *lead's*, not the operator's. It can be revoked on every peer without touching how
  the human logs in, and revoking it is one line per peer.
- The pairing credential the phone already holds is what authorises the request at the lead, so the
  chain is device, then lead, then pinned tag, and no step in it is a general shell.

### (b) Pack updates stay terminal-only

The status quo, and what this milestone ships. The phone updates the machine it is talking to; a
pack-wide update is an operator at a terminal with their own agent. The card links to the command
instead of running it, and there is still no `--yes`.

**First cut is (b).** It ships the sequenced, health-gated flow with the existing consent model
intact and adds no new credential. §7.1 tolerates skew, so a pack that levels one machine now and
the rest this evening is a supported state, not a defect the phone must fix.

## Consequences

- **Until this ADR is accepted, the phone does not push to peers.** That is enforced by there being
  no route: `bridge/server.ts` has no pack-update surface, and M15/06's spec pins it.
- **This amendment carries its own review.** It is not implied by accepting the sequenced flow, and
  it must not be merged as a side effect of building the update card.
- **If (a) is ever accepted, ADR 0016's consequence about `--yes` is amended, not deleted.** The
  terminal verb keeps its prompt. What changes is that a second, narrower path exists, and its
  narrowness is carried by the forced command rather than by a human.
- **If (a) is rejected for good, say so here and close it.** A decision that stays deferred for a
  year is one somebody will re-open by writing the code.
