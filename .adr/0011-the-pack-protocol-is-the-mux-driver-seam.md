# 0011 — The pack protocol is the mux-driver seam, and peers are full collies

Status: **Accepted** (2026-08-06)

Contract: [`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) · Related: [ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md)
(how a peer listens) · [ADR 0012](./0012-every-machine-runs-a-collie-and-the-pack-has-a-lead.md) (the words used here)

## Context

Collie is growing **pack federation**: several machines, one phone. The shape being built is that
every machine runs a **full Collie instance** — a *collie* — one of which is the **lead** (it keeps
the single managed front door and is the only thing the phone talks to), while the rest are **peers**
(no front door, dialled by the lead over an enrolled link).

There is a cheaper design, it is obvious, and it will be proposed again by everyone who reads
`ARCHITECTURE.md` §5 carefully: **the lead already has a Herdr socket client — just point it at the
peer's Herdr socket.** No new HTTP surface on the peer, no second Collie to install, no
re-serialisation. On the face of it the repo has already done most of the work:

- **`herdr-client.ts` is the only module that knows socket method names** (`ARCHITECTURE.md` §5), so
  the coupling looks contained enough to relocate.
- **`bridge/dial.ts` already has two dialers**, and `COLLIE_HERDR_DIAL=net` (`bridge/config.ts:81`,
  `:209`) selects the `node:net` one — which reads, at a glance, like a network transport waiting for
  a host and a port.

That last reading is wrong on the facts. `COLLIE_HERDR_DIAL=net` exists for exactly one reason,
stated in the comment above it: Herdr's control socket is a **named pipe on Windows**, `node:net`
dials both shapes, and forcing that dialer on Linux is how the Windows branch stays tested without a
Windows box. It selects *which local dialer* opens a filesystem-path endpoint. It is not a remote
hook, it has never taken a host, and it must not grow one.

The real objections are three, and only the first two are about the socket at all.

### Everything except the typing is host-local by rule

A pane is not the unit of work. The unit of work is *a pane plus the machine it runs on*, and Collie
already owns four things that live on that machine's disk:

| What | Where | Why it can't move |
| --- | --- | --- |
| Transcript history | `bridge/journal/` — every path through `containedRealpath` (`files.ts:39`) | The agent writes its own session log to *its* disk. `/api/pane/:id/history` is a filesystem read, and the containment rule is absolute. |
| Uploads | `<stateDir>/uploads` (`bridge/server.ts:1075`), then handed to Herdr **by local path** (`bridge/uploads.ts:4`) | Herdr reads the file itself. A path is only meaningful on the machine that holds the bytes. |
| Audit trail | `<stateDir>/audit.log`, 0600 (`bridge/audit.ts:64-67`) | The record of what was typed into *these* terminals. |
| Derived state | `activity.json` ([ADR 0003](./0003-one-shared-seen.md)), `snooze.json`, `notify-prefs.json`, push subscriptions | Keyed to panes on this host. |

A forwarded socket moves the *typing* and strands all four. Pane history on a remote pane either 404s
or — worse — reads the lead's own disk and returns a different machine's transcript. An image uploaded
from the phone lands in the lead's `stateDir`, and the peer's Herdr is handed a path that does not
exist there. A reply typed into a peer's terminal is audited on the machine that didn't execute it.

Each of those is then fixed by inventing a small remote protocol for it: one for history, one for
uploads, one for audit shipping. That is the pack protocol, built one leak at a time, by people who
never got to decide what it should look like.

### A Herdr-shaped wire welds Collie to Herdr forever

If the pack link carries `pane.read` and `agent.send`, then Herdr's method names, id shapes, status
vocabulary and error codes **are** the federation contract. A machine that fronts something else —
tmux, or whatever the graduation RFC ([discussion #67](https://github.com/AltanS/collie/discussions/67))
lands on — can never join a pack without a translation layer that nobody is going to write, because
by then the translation would have to be bug-compatible with a socket contract that was reverse-
engineered in `HERDR_API.md`.

This is not a bet on #67. The clause costs nothing today: the lead is calling *some* API over the
link either way, and Collie's own HTTP API is the one the phone already exercises on every request,
so it is the best-tested surface in the product. The seam is free; it is only free *if it is written
down before the first line of federation code*.

### The socket is a bigger gun than the API

Collie's HTTP API is a deliberately narrow, gated, audited projection of the Herdr socket. A
forwarded socket hands the lead the **whole** RPC surface of a second machine with no gate chain in
front of it and no audit line behind it. "The lead can do to a peer exactly what a phone can do to
that peer" is a security property worth having, and it is only available if the lead speaks the API.

## Decision

**Multi-host Collie is a federation of full Collie instances speaking a Collie-owned protocol. The
lead consumes a peer's *Collie* HTTP API, and never a peer's Herdr socket.**

- **A peer is a full collie.** It runs its own bridge, its own journal adapters, its own uploads
  directory, its own audit log, its own state. It is responsible for whatever it fronts; the lead
  does not know or care.
- **No Herdr method name, type, status value or error code crosses a pack link.** The wire vocabulary
  is Collie's own domain model (`bridge/types.ts`), which is what makes a non-Herdr peer invisible to
  the lead, to the phone, and to the protocol. The contract is
  [`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md); this ADR is the reason it may not mention Herdr.
- **The Herdr socket is never dialled across a machine boundary.** `COLLIE_HERDR_DIAL` stays a
  *dialer selector* for a local endpoint and never grows a `host:port` form. If someone needs the
  Windows branch exercised, that is what `net` is for; if someone needs a remote pane, that is what a
  pack is for.
- **A capability that exists in Herdr but not in Collie's own HTTP API is unreachable across a pack
  link** until Collie's API grows it. This is a feature: it keeps the API honest and makes every new
  federated capability a deliberate, gated, audited addition rather than a socket passthrough.

**This ADR does not decide graduation.** It does not commit Collie to tmux, to standing alone from
Herdr, or to shipping a driver abstraction of any kind. There is no `MuxDriver` interface in the
decision and nothing here licenses writing one. It constrains exactly one thing — the protocol's
vocabulary — and its argument stands even if #67 closes as "no", because the host-local rule and the
blast-radius rule are independent of it.

## Consequences

- **One extra serialise/deserialise hop per peer request.** The peer renders its own JSON; the lead
  parses it and merges. Accepted: the merged snapshot has to be re-serialised anyway, and peer fetches
  are concurrent, so N peers do not cost N round trips (`PACK_PROTOCOL.md`).
- **The lead cannot exceed the phone's reach.** Anything the lead can do to a peer, a phone plugged
  directly into that peer could also do. That bound is the point, and it is only true while this ADR
  holds.
- **Pressure lands on Collie's API instead of on the socket.** When a federated feature needs
  something the API doesn't expose, the fix is a route on the peer — reviewed, gated, audited — not a
  new method name on the wire. Slower, and correct.
- **This is a promise, not a verified property.** Nothing in v1 exercises the seam with a non-Herdr
  peer, so the abstraction is only as real as the discipline behind it. The concrete leaks to watch
  for, greppable by a future non-Herdr peer implementer:

  1. **Session semantics.** Treating a peer's session names as Herdr sessions (primary-vs-named,
     `session.snapshot` shapes). They are opaque labels from the lead's side.
  2. **Pane identity.** Assuming a peer's pane id is a Herdr pane id — re-derivable, session-scoped,
     numeric, or stable across a peer restart in the way Herdr's happen to be.
  3. **Status vocabulary.** Pinning the wire to Herdr's agent-status values rather than to Collie's
     own `AgentStatus` domain type.
  4. **Journal assumed present.** `/history` may legitimately not exist on a peer. The local
     precedent is already the right shape: `bridge/journal/registry.ts` maps a pane's harness to an
     adapter, and *a harness with no adapter simply has no journal* (`ARCHITECTURE.md` §5). Across a
     pack link, an absent journal is a capability answer, not an error.
  5. **Keys assumed universal.** The `+`-joined `send_keys` grammar (`ctrl+c`, `shift+tab`) is
     Herdr's, verified in `HERDR_API.md`. A peer may accept a different set, or none.
  6. **`reachable` mis-read.** `SessionSummary.reachable` is `snap.bridge === "connected"`
     (`bridge/sessions.ts:171`) — *this collie's link to its own mux*. It is not "the peer is up",
     which is a separate, lead-side fact.
  7. **Paths assumed portable.** Upload paths, working directories and transcript locations are
     meaningful only on the machine that produced them. Nothing derived from a peer's filesystem is
     ever a path the lead resolves.

- **What would justify revisiting.** A *measured* latency problem demonstrably caused by
  re-serialisation — and even then the first fix is a narrower Collie-owned bulk route on the peer,
  not Herdr on the wire. Or #67 closing as "no", which would delete the seam argument but leave the
  host-local and blast-radius arguments untouched; the decision survives that, and this note exists so
  nobody mistakes #67's fate for this ADR's.
