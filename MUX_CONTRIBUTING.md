# Adding a mux adapter

Collie drives a **multiplexer** — the thing that owns the panes. Herdr is the reference adapter;
tmux and zellij are the ones this seam was built for. This is how you add another.

A *harness* (claude, codex, pi, omp) is what runs **inside** a pane and has its own seam —
[`HARNESS_CONTRIBUTING.md`](./HARNESS_CONTRIBUTING.md). Don't cross them: a capability question is
never answered by a harness lookup, and a harness question is never answered by the mux name.

Read first: [`MUX_CONTRACT.md`](./MUX_CONTRACT.md) (the capability matrix — every cell cites the
probe that proved it), the port itself [`bridge/mux/types.ts`](./bridge/mux/types.ts), and
[ADR 0022](./.adr/0022-the-mux-seam-is-a-port-collie-owns.md) for why "just point the Herdr client at
it" is not an adapter.

## Architecture in one paragraph

An adapter is a [`MuxAdapter`](./bridge/mux/types.ts), registered by its own name in
[`bridge/mux/registry.ts`](./bridge/mux/registry.ts). Two of its methods are the **floor** —
`reachable()` and `snapshot()`; an adapter that cannot answer those has nothing for Collie to render.
Everything else is a **declared capability** ([`capabilities.ts`](./bridge/mux/capabilities.ts)): the
adapter says yes or no, and a route asks the capability, never the name. Three things the contract
owns outright and you do not get to redecide: the **refusal shape**
([`types.ts`](./bridge/mux/types.ts) — four reasons, and `unsupported` is not a failure), **identity**
([`identity.ts`](./bridge/mux/identity.ts) — five rules), and the **neutral key spelling**
([`keys.ts`](./bridge/mux/keys.ts) — `ctrl+c`, not `C-c` and not `"Ctrl c"`). Herdr's adapter
([`bridge/mux/herdr/`](./bridge/mux/herdr/)) is four files and is the shape to copy: `client.ts` is
the transport and the only file that knows the multiplexer's own wire, `adapter.ts` is the whole
translation, `keys.ts` and `events.ts` are the two tables.

If your multiplexer has no socket and its client is a **binary**, copy
[`bridge/mux/tmux/`](./bridge/mux/tmux/) instead — same split, one file more: `exec.ts` is the
subprocess seam (and the only place that spawns), `protocol.ts` is the argv it builds and the text it
parses, `watch.ts` owns the long-lived child, and `adapter.ts` is still the whole translation. The
seam being an interface is what lets the fixture drive it with a scripted exec.

## Probe first, declare second

**An unprobed cell is never declared supported.** Every `true` in your declaration must trace to a
verb you have run against a real multiplexer and watched work — that is what
[`MUX_CONTRACT.md`](./MUX_CONTRACT.md) is: the evidence, per cell, with the probe that produced it.
A capability declared aspirationally is worse than one declared absent, because absent degrades
visibly (M10/06) and a wrong `true` fails in the operator's hands.

Declare less than you can build. An adapter that reads and types is a real adapter; the contract is
what makes the rest addable later without a rewrite.

## What conformance demands

[`bridge/mux/conformance.ts`](./bridge/mux/conformance.ts) is the gate, and it answers four questions.
Each has burned this codebase before on some other axis:

1. **Is the declaration honest — in both directions?** Every capability you declare is exercised and
   must work. Every one you *don't* is **called**, and must answer the contract's `unsupported`
   naming itself — never throw, never succeed, never return an empty value that reads as success.
2. **Is identity stable?** A pane keeps its Collie id across a reconnect, an out-of-band rename and a
   restart of the multiplexer; two panes never collide; a dead pane's id is never reused
   ([`identity.ts`](./bridge/mux/identity.ts) rules 2–4). An id derived from a label, a title or a
   position fails here — and nothing above the adapter can repair a moving id.
3. **Are the semantics the contract's?** `styling:"strip"` really strips; a read echoes the pane it
   was asked for; `revision` moves when the pane's content does; a two-key batch arrives as two keys
   in order; a call aimed at a pane that has gone away answers **`gone`**, not `unreachable`.
4. **Does it degrade rather than lie?** A constant `revision` silently disables the race guard. A key
   listed in `unsupportedKeys` that gets sent anyway is worse than no list. `agentDetection`
   declared over a world of bare shells proves nothing.

Nothing in that file imports a test framework: a check returns its problems as strings, which is what
lets the same checks run in both layers below.

## Your deliverable: a fixture

You write **no test file**. The suite ([`conformance.test.ts`](./bridge/mux/conformance.test.ts))
iterates `MUX_ADAPTERS` and pairs each entry with its fixture, and it **fails an adapter that has
none**. So adding a multiplexer is exactly two lines plus your module:

1. your factory in [`bridge/mux/registry.ts`](./bridge/mux/registry.ts) → `MUX_ADAPTERS`
2. your fixture in [`bridge/mux/fixtures.ts`](./bridge/mux/fixtures.ts) → `MUX_CONFORMANCE_FIXTURES`

A fixture is a `MuxConformanceFixture`: `create()` hands back a **world** — your adapter built over an
*injected* transport, plus the perturbations no adapter can simulate from outside itself:

| World member | What it must do |
| --- | --- |
| `adapter` | your real adapter, over a fake transport — not a stub of the adapter |
| `writes()` | every write the transport saw, in order (literal text for `text`, one entry per key for `keys`) |
| `reconnect()` | the adapter's connection drops and comes back; the herd is untouched |
| `restartMux()` | the multiplexer **process** restarts with the same session — rebuild your records as fresh objects |
| `renameOutOfBand()` | someone renames a pane in the multiplexer's own UI, not through Collie |
| `changePane()` | the pane paints something new |
| `endPane()` | the pane's process ends and the multiplexer forgets it |
| `pokeTopology()` / `pokePane()` | announce a change on the event channel — **required if** you declare `pushTopologyEvents` / `pushPaneEvents` |
| `close()` | tear it down; idempotent |

A world is single-use (half the checks end by destroying something) and must start **non-trivial**:
at least three live panes across two spaces and two tabs, with a real agent pane when you declare
`agentDetection`, and a session ref when you declare `agentSessionRef`. A world of one bare shell lets
half the suite pass vacuously.

Herdr's is [`bridge/mux/herdr/fixture.ts`](./bridge/mux/herdr/fixture.ts) — an in-memory `HerdrRpc`
that answers exactly what the documented server answers, including its `pane_not_found` codes and its
always-false `truncated`. **A fake that is kinder than the real server proves nothing.** (The other
in-repo fake, [`bridge/pack/fake-herdr.ts`](./bridge/pack/fake-herdr.ts), is a real unix-socket
daemon; it exists because *its* subject is the pack transport. Conformance's subject is the adapter,
so its fake is state transitions rather than bytes — deterministic, and runnable anywhere.)

Keep your adapter injectable enough for this to be possible: depend on a **narrow structural type**
for your transport, not on a concrete class (`HerdrRpc` in
[`bridge/mux/herdr/client.ts`](./bridge/mux/herdr/client.ts) is a `Pick` of the real client, so it
cannot drift from it). Anything needing `Bun.serve`/`Bun.connect` is unit-untestable — see
[`CLAUDE.md`](./CLAUDE.md) § Tests.

## The two layers

- **Pure — the CI gate.** `bun test bridge/mux`. Runs with **no multiplexer installed**, against every
  registered adapter, through your fixture's fake transport. This is what has to be green.
- **Live — opt-in, and read-only by design.** `bun scripts/mux-probe.ts` runs only the checks that
  write nothing, against whatever is actually running on the box:

  ```sh
  bun scripts/mux-probe.ts                                     # every registered adapter
  COLLIE_MUX_ENDPOINT_TMUX=/tmp/tmux-1000/default \
    bun scripts/mux-probe.ts --mux tmux                        # tell it where yours listens
  ```

  It **skips loudly** when your multiplexer is absent — a skip prints why and is never counted as a
  pass. It never types into, renames or closes a live pane, and that is not a limitation to lift: a
  live pane is somebody's work session. What it adds is what a fake cannot — real escape sequences,
  real id shapes, real timing.

Run both. Then `bun run test` (the whole backend suite) and `SKIP_TESTS=1 bun run build` (lint +
both typechecks).

## Things that will bite you

- **The grid is already rendered.** Collie runs no terminal emulator and never will
  ([ADR 0008](./.adr/0008-collie-does-not-run-a-terminal-emulator.md)). If your multiplexer won't hand
  over a rendered screen carrying colour and nothing else, **decline `paneGrid`** — you don't get a VT
  parser written for you.
- **Host-local, always.** Nothing in the port takes a host and nothing may grow one. A remote machine
  is reached by talking to the Collie running on it, never by dialling its multiplexer across a
  machine boundary ([ADR 0011](./.adr/0011-the-pack-protocol-is-the-mux-driver-seam.md)).
- **A missing key is not a missing door.** One key your multiplexer can't send goes in
  `unsupportedKeys` (canonically spelled, or the suite rejects it) and is answered `refused`.
  `sendKeys` stays declared.
- **Scrollback is not history.** `gridScrollback` is untyped screen text. `agentSessionRef` is the
  agent's own log, which the journal axis reads and which knows turns and tools
  ([`bridge/journal/`](./bridge/journal/)). Never answer one with the other.
- **A batch is a sequence.** If one key in a batch can't be sent, send **none** of it — half a chord
  delivered leaves the pane somewhere the caller cannot reason about.
- **Herdr is the reference, not the specification.** Where the contract and a multiplexer disagree,
  that is a finding about the contract. Take it to the port, not to a special case in your adapter.
