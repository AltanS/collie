# 0022 — The multiplexer is a port Collie owns, not a relocated Herdr client

Status: **Accepted** (2026-08-19)

Contract: [`MUX_CONTRACT.md`](../MUX_CONTRACT.md) · Code: [`bridge/mux/`](../bridge/mux/) ·
Related: [ADR 0011](./0011-the-pack-protocol-is-the-mux-driver-seam.md) (which named this seam and
kept federation above it) · [ADR 0008](./0008-collie-does-not-run-a-terminal-emulator.md) (why the
grid is declinable)

## Context

Collie is becoming multiplexer-agnostic: Herdr, tmux and zellij as three adapters behind one
contract. There is a cheaper route, it is obvious, and it has already been proposed in the adjacent
argument — **`bridge/herdr-client.ts` is the only module that knows socket method names, so make a
tmux driver answer to that same class and point the bridge at it.** No new interface, no capability
plumbing, one afternoon.

The repo makes the cheap route look almost done. `bridge/types.ts` already decoupled the domain from
the wire ("These are OUR types … the rest of the app talks in these terms"), and
`grep -rn 'workspace_id|agent_session|WirePane' web/src` finds nothing — no Herdr vocabulary reaches
the frontend at all. Half the seam exists, and it is the half usually missing.

The half that is missing is the interface. `HerdrClient` is a concrete class named as a type in five
bridge modules and about sixteen parameter positions, so "the driver" and "Herdr's client" are the
same noun. Three things follow, and they are why the cheap route fails.

**Herdr's shape is not neutral, it is one vendor's answer.** The exported surface —
`listWorkspaces`, `sessionSnapshot`, `readPane(paneId, source, lines, format)`, `sendPaneKeys` — is
shaped by what Herdr has: a workspace/tab/pane tree, a monotonic pane revision, a rendered read with
two formats, an agent-detection layer, and a session reference an agent named. A tmux driver
implementing that class must answer `listWorkspaces` with something, and there is nothing honest to
answer with. The failure mode is not a compile error; it is a plausible lie — a driver that returns
an empty array, and a UI that renders "no spaces" where the truth was "this multiplexer has no such
idea".

**Capabilities have nowhere to live on a client.** Once the driver is the client, "can this one give
me history" is answered by knowing which class was constructed, which is `if (mux === "herdr")` with
extra steps. The codebase already argues the other way at three separate lines — `env.ts:15` asks
what the runtime provides rather than sniffing it, `composer.tsx:363` takes the capability and never
the grammar, `nav-tray.tsx:75` makes repeat opt-in per button.

**Three multiplexers spell one keystroke three ways.** Herdr `ctrl+c`, tmux `C-c`, zellij
`"Ctrl c"` (all probed; see MUX_CONTRACT.md). Whoever owns the spelling owns the seam. If the
contract is Herdr's client, then Herdr's grammar is Collie's grammar, two adapters translate into a
third party's dialect, and every future key question is settled by what Herdr happens to accept.

The same argument settles the second-cheapest route, **making tmux speak Herdr's wire** behind a
shim: it buys the same coupling and adds a translation layer nobody will maintain. ADR 0011 already
rejected that reasoning across a machine boundary, on the ground that a Herdr-shaped wire "welds
Collie to Herdr forever". This is that argument one layer down.

## Decision

**Collie owns a multiplexer port, in Collie's vocabulary, and Herdr is one adapter behind it.**

- The port is [`bridge/mux/types.ts`](../bridge/mux/types.ts). It speaks pane, space, agent session
  and grid — never a wire name.
- Anything a multiplexer may lack is a **declared capability**
  ([`capabilities.ts`](../bridge/mux/capabilities.ts)), enumerated from the routes that consume it,
  and answered by **one refusal shape** in which `unsupported` is distinguishable from a failure.
  A route asks what an adapter can do; it never asks which adapter it has.
- **Identity and subscription semantics belong to the contract**, not the adapter: a pane id is
  stable across a reconnect and unique within a collie, and a watcher is told to re-read within the
  adapter's stated bound — which an adapter may keep by polling.
- **The contract owns the neutral key spelling**, and every adapter translates into its own.
- [`bridge/mux/registry.ts`](../bridge/mux/registry.ts) is the single site mapping a configured name
  to an adapter. It is **not** the harness registry and **not** the journal registry; the three axes
  never key off one another.
- The port is **host-local**. Nothing in it takes a host, and nothing in it may grow one — a remote
  machine is reached by talking to the Collie running on it (ADR 0011).

## Consequences

- **Herdr becomes the reference adapter, and its client keeps its own vocabulary.** The wire names
  stay inside `bridge/mux/herdr/`; no operator sees a change, and `bridge/solo-baseline.test.ts`
  passes unmodified or the refactor was not a refactor (M10/02).
- **The cost is a real one and it is paid in indirection**: a port, a declaration and a registry
  between the routes and the socket, plus a conformance suite to keep an adapter honest (M10/03).
  For a single-multiplexer app that would be overhead. It buys the second and third multiplexer.
- **Absent capabilities become a UI problem, which is the point** — the alternative was a button
  that fails. The rule is "hide the meaningless, explain the expected" (M10/06); Collie never blames
  itself for a multiplexer's limit, and never blames a multiplexer for a limit Collie chose.
- **A capability can be declared dishonestly**, and no type system catches it. Conformance calls
  every undeclared method and demands the refusal, and every declared one and demands it work.
- **The contract can be wrong**, and tmux will find it first (M10/04). A finding goes back to the
  contract and is re-verified against Herdr — it never becomes a special case inside an adapter.
- **What would justify revisiting this:** if tmux and zellij both fail to reach a useful adapter,
  the seam bought nothing and the port is indirection over a single implementation. That is a
  judgement to make with two adapters written, not before.
