# 0036 — The map of machines is Collie's, a mux reports one machine

Status: **Accepted** (2026-09-08)

Contract: [`MUX_CONTRACT.md`](../MUX_CONTRACT.md) · [`PACK_PROTOCOL.md`](../CREW_PROTOCOL.md) ·
Related: [ADR 0011](./0011-the-pack-protocol-is-the-mux-driver-seam.md) (which kept federation above
the seam and made every peer a full collie) ·
[ADR 0022](./0022-the-mux-seam-is-a-port-collie-owns.md) (which made the port host-local and said it
must never grow a host)

## Context

Collie has two axes and has had them since M2. The **host axis** is the pack: the lead's list of
machines, each one a full collie dialled over mTLS, merged into one view for the phone. The **pane
axis** is the multiplexer port: one adapter, one machine, panes and spaces in Collie's own
vocabulary. ADR 0011 put the host axis above the seam. ADR 0022 put the pane axis below it and said
in as many words that the port takes no host and may not grow one.

herdr 0.9.0 shipped in September 2026 and its release note says it can now manage multiple machines.
The source at tag `v0.9.0` was read first-hand on 2026-09-08, and the note oversells what moved.

- **The daemon still knows one machine.** The machine linking is in the herdr TUI client, not in the
  daemon.
- The client keeps its ssh targets in `state_dir()/client/endpoints.json` as `SavedSshEndpoint`
  profiles: an id, a label, a target, a session and an enabled flag.
- Per endpoint it opens an ssh stdio bridge behind a private unix socket
  `herdr-ssh-<pid>-<profile_id>.sock`, and runs one supervisor.
- It adds an endpoint handshake, `endpoint.hello.v1` and `endpoint.welcome.v1`, whose welcome returns
  a method list and a capability list, so a missing method disables one action and keeps the link up.
- **The public socket `herdr.sock` did not change.** All 102 methods were checked. There is no
  `machine.*` method, no machine field in the snapshot and none in the events. The only machine fact
  visible to a tool outside herdr is `herdr machine list --json`.

So herdr built inside its own client what Collie built as the pack. At the machine level herdr is a
competing client, not a building block, and today it offers Collie nothing to take.

There is a cheaper route, it is obvious, and it will be proposed the day it becomes possible: **wait
until herdr exposes linked panes on its socket, then let the adapter report them.** One method
answering "here are panes on three machines" reads as a free feature. The pack's host reach would
arrive without a pack, without an enrolment, without a second collie to install.

It fails for the reason ADR 0011 already worked out one layer up, and the table in that ADR is the
whole argument. A pane is not the unit of work. The unit of work is a pane plus the machine it runs
on, and four things live on that machine's disk: the transcript history under `bridge/journal/`, the
uploads directory handed to the multiplexer **by local path**, the 0600 audit log, and the derived
state keyed to panes on this host. A linked pane arriving through the adapter moves the typing and
strands all four. History either 404s or reads the lead's own disk and returns another machine's
transcript. An image uploaded from the phone lands in the lead's state directory and the far
multiplexer is handed a path that does not exist there. A reply typed into a far terminal is audited
on the machine that did not execute it.

The host axis would then sit inside `bridge/mux/`, where none of those four can follow it, and each
would be fixed by inventing a small remote protocol of its own. That is the pack protocol again,
built one leak at a time, by people who never got to decide what it should look like. It would also
carry a second trust model onto the wire, one that only herdr can walk, and a pane that is both a
pack member's pane and a linked pane would show twice in one list.

None of this is pressing. That is why the rule is written now, while nothing is pushing against it.

## Decision

**The map of machines is Collie's. A multiplexer adapter reports one machine, and that machine is
this one.**

- **Two axes, never mixed.** The host axis lives in the pack. The pane axis lives in the adapter. A
  read or a write resolves the host first and then the pane. Nothing in `bridge/mux/` ever sees a
  host, in any parameter, in any config key and in any return shape. This restates ADR 0022's
  host-local clause as a rule about the *listing*, not only about the interface.
- **An adapter reports only panes whose terminal runs on this machine.** If a multiplexer ever
  exposes linked panes on its socket, its adapter drops them. A dropped pane is not a refusal and
  not an error; it is simply not this collie's pane. This sentence is the contract's, and it is a row
  in `MUX_CONTRACT.md` § Contract-owned rules.
- **A machine-linking multiplexer may contribute exactly one thing:** a list of ssh targets, offered
  to the operator as candidates for `pack add`. It never arrives through the `MuxAdapter` interface.
  It is an optional module-level provider on the adapter factory, read-only, and Collie never writes
  the multiplexer's own endpoint state. A later spec builds that seam; nothing about it is built
  here.
- **The named end state is a member with no multiplexer at all.** Such a member joins a pack and
  offers uploads, the journal, launchers and updates, and it offers no panes. Naming it here is what
  keeps the two axes separable in later work, because a pack that needs a pane axis to exist has
  already merged them. **This milestone does not build it.**

## Consequences

- **The pack works the same under Herdr, tmux and zellij, and under none of them.** Cross-machine
  reach is one mechanism with one enrolment and one audit trail, so a peer's multiplexer is the
  peer's business. That is what ADR 0011 bought, and this ADR is what stops it being spent.
- **One pane can never show twice.** A pane belongs to exactly one collie, and the merged view has
  one authority for who owns it. Without the rule, a pack member reachable both as a peer and as a
  linked endpoint appears in two places with two ids and two histories.
- **One trust model on the wire.** The pack link is mTLS with a pinned certificate, a pack secret and
  a signed request. A forwarded ssh stdio bridge inside an adapter would be a second one, carried by
  a third party, with no gate chain in front of it and no audit line behind it.
- **A competing client's convenience is refused, on purpose.** The day a multiplexer offers panes on
  three machines for free, Collie declines and asks the operator to run `pack add` instead. That is
  slower for the operator and it is the price of the three points above.
- **A machine list is not a pack.** `herdr machine list --json` and `collie pack status` will differ,
  and an operator will notice. The docs owe an explanation of what each list is and why one is not
  the other; the code owes nothing, because neither list is derived from the other.
- **What would justify revisiting.** A multiplexer that carried the journal, the uploads and the
  audit log across the machine boundary, with its own trust model, its own containment rule and its
  own record of what was typed where. That is a different question from the one ADR 0011 answered,
  because ADR 0011's argument rests on those four things being unable to travel. If one day they can,
  the argument has to be made again from the start, against whatever that transport actually promises.
  It would be a new ADR, and this one would be superseded by it. It is not an edit of this one, and a
  socket method that merely lists remote panes is not that transport.
