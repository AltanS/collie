# 0008 — Collie does not run a terminal emulator

Status: **Accepted** (2026-08-04)

## Context

"Render the pane properly, with a real terminal emulator" is the most re-proposed idea in this repo,
and it will be proposed again. [`ARCHITECTURE.md`](../ARCHITECTURE.md) §8 parked it against one
objection — raw ANSI frames need an emulator, and rendering those in the browser would breach §6's
"pane output is React text nodes only" boundary — which reads as *we would, if it were safe*. So it
came back in a form that is safe: a **headless** emulator in the bridge, rendering to a cell grid the
phone draws as text nodes. The boundary objection does not touch that version, and it deserves a real
answer rather than the same parking spot.

The answer is that the boundary was never the strongest objection. Three others are.

### The emulation already happened, one process upstream

`pane.read` does not return a byte stream. It returns **Herdr's rendered grid** — the screen as it
currently looks, one line per visual row at the pane's real width, with SGR reattached. Cursor motion,
screen clears and scroll regions have all been *applied* by the time Collie sees anything, which is
precisely why an SGR-only parser has been sufficient for a year.

Two measurements in [`HERDR_API.md`](../HERDR_API.md) show this directly rather than by assertion: an
alt-screen pane returns exactly the viewport and nothing behind it (no scrollback ring to read), and
`recent_unwrapped` is **byte-identical** to `recent` for Claude panes because the harness renderer has
already hard-wrapped the prose. Both facts only hold downstream of a renderer.

An emulator in the bridge would therefore re-emulate an already-emulated screen. That is not a
fidelity gain; it is a second renderer disagreeing with the first.

### The bug history it is proposed to fix is semantic, not graphical

The case for an emulator is usually assembled from the mirror's scar tissue. Each scar has a
documented root cause, and they do not point where the proposal points:

| Reported | Actual root cause | Fixed by an emulator? |
| --- | --- | --- |
| #5 — broken TUI tables, viewport blowout | Rendering and CSS at phone width | No |
| #53 — pans on nearly every line | Pane spawned at the desktop's column count; wrap-vs-column-faithful is a product choice, settled toward wrap in 0.21.0 | No — and a cell grid reopens it |
| #54 / #56 — send stalls under a tall statusline | `locateInputBox` — *which rows are the input box* ([ADR 0004](./0004-the-statusline-run-is-bounded.md)) | No — inference over content |
| #50 / #51 — dialogs fall through to the raw mirror | A wrapped option label; a shape no grammar had a rule for | No — inference over content |
| #23 — pane stuck narrow | Herdr applies pane geometry only while a desktop client is attached (upstream `herdr#1709`) | No — server-side PTY |

Every one is either geometry Collie does not own or a question about meaning. A TUI paints cells; it
does not paint structure. *Which rows are the input box* is not more answerable from a
better-rendered grid, because the grid never contained the answer.

### The grammars would not get simpler — but their safety net would break

The grammars are already position-agnostic. They consume `StyledLine[]` — final rendered rows — and
derive their columns from **text**: `preview-select.ts:161` locates its gutter with
`indexOf("Notes:")`, and `OPTION_LABEL_START` (`:109`) matches a numbered row by regex. Exactly one
detector in 1 766 lines reads styling at all — `wizard.ts:142` filters `s.bg !== undefined` to find
the current stepper chip, and says so in its header comment. Nothing in there is waiting for cells.

What an emulator *would* do is invalidate the corpus underneath them. **34 byte-faithful captures and
1 757 lines of Claude grammar tests** are pinned to `pane.read` output, and
[`HARNESS_CONTRIBUTING.md`](../HARNESS_CONTRIBUTING.md)'s Tier-2 bar rests on them. A second renderer
differs in exactly the ways captures are sensitive to — trailing blanks, blank-line normalisation — so
adoption means either normalising emulator output to byte-match `pane.read` (engineering with no
user-visible product) or re-capturing everything (discarding the spine to build the thing the spine
protects). This cost is invisible in the proposal and is the largest one in it.

### What it would actually buy, priced honestly

Two things. Neither requires an emulator to obtain.

- **Latency** (~2 s → live). Real, and felt every session. But staleness is a property of *how a read
  is requested*, not of what draws it: `pane.read` already returns a `revision`, the bridge already
  holds an `events.subscribe` stream, and pane reads are already 304-cached. A live-feeling mirror is
  a transport change to a contract that is probed, tested and cached today.
- **Cursor position** — the one signal the snapshot genuinely lacks, and the real prize.
  [ADR 0004](./0004-the-statusline-run-is-bounded.md) says in its own revisit clause that *established*
  box liveness would retire both the statusline bound and the scrollback-echo limitation it cannot
  fix. But an emulator is an extravagant way to acquire one field. Herdr has accepted two Collie
  issues already (`herdr#1709`, `herdr#2250`); an accepted upstream field lands cursor **inside** the
  existing contract, with no second renderer and no corpus migration.

### `control` is worse than not using it, and `observe` is unprobed

`control` accepts `terminal.resize` against the **shared** PTY and arbitrates with
one-controller-at-a-time semantics plus `--takeover`. Adopting it means Collie fights the person at
the desk, and "fixes" #23 for the phone by breaking the desktop. Collie already has every write path
it needs on the socket — `send_text` and `send_keys`, one-shot and stateless.

And `HERDR_API.md` verifies **nothing** about `observe`/`control`: not the frame format, not whether
cursor state is even in it, not multi-observer semantics, not a version floor. It is a CLI
child-process contract, not the socket. This repo's habit is to probe before building — the habit that
produced the `recent_unwrapped` correction and the bracketed-paste finding, both of which killed a
plausible theory.

## Decision

**Collie does not run a terminal emulator — not in the browser, not in the bridge. The mirror renders
the rows Herdr already rendered, and the client contract stays `StyledLine[]`.**

- **Client-side emulation (xterm.js and its relatives) is refused outright**, and not only on the XSS
  boundary. It replaces the entire styled-line pipeline — the [ADR 0002](./0002-invert-the-light-terminal-mirror.md)
  inversion, tappable links, find highlighting, the wrap default — with a large dependency writing DOM
  at the most attacker-influenced surface in the product.
- **Latency complaints route to transport.** If the mirror feels stale, the fix is how the client asks
  for a read, never what draws it.
- **Cursor and liveness are an upstream ask first.** File against Herdr's `pane.read` /
  `session.snapshot`; build nothing locally to synthesise what a field would give.
- **A cell-grid wire protocol is refused even inside a hypothetical emulator.** The phone shows ~50 of
  a ~200-column pane, so a column-faithful grid reopens the pan-vs-wrap question 0.21.0 settled toward
  wrap.

## Consequences

- **The mirror is exactly as faithful as Herdr's own render, and no more.** Where that render is wrong
  for a phone — #23's frozen geometry — Collie is wrong with it, and the fix is upstream. Accepted.
- **Dialogs will keep falling through to the raw mirror** when no grammar recognises them. Fall-through
  is the safe direction (real text, nothing wrongly tappable), and the capability ladder is built for
  the gap to be closed by a grammar — usually a contributor's, which is how #51 and #61 arrived.
- **ADR 0004's scrollback-echo limitation stands** until cursor arrives from upstream. It cannot be
  closed by inference, and this decision declines to close it by re-rendering.
- **The fixture corpus stays deliberately coupled to `pane.read` output.** That coupling is now a
  decision rather than an accident, and anything that would break it inherits the cost of re-capturing.
- **Herdr's `[theme]` and its own UI stay irrelevant to what Collie draws** — unchanged by this, but
  worth restating, since "use a real emulator" is sometimes proposed as the way to match the desktop's
  colours. It would not; see [ADR 0002](./0002-invert-the-light-terminal-mirror.md).

### What would justify revisiting

- **Herdr exposing cursor position** in `pane.read` or `session.snapshot`. This is the outcome to
  *pursue*, because it removes the strongest argument for an emulator without building one.
- **That ask being refused, plus measured evidence that inference is failing in the field** — ADR
  0004's echo precondition actually firing, or a real dialog only cursor can disambiguate. Then the
  shape is already constrained, and this ADR is superseded rather than amended: **read-only `observe`,
  bridge-side, open pane only, behind a flag, emitting today's `PaneReadResponse` plus a `cursor`
  field** so that no grammar and no fixture changes. Phase 0 is a probe written into `HERDR_API.md`;
  it does not begin before `bridge/server.ts` has the integration coverage it currently lacks, because
  a child-process stream would be the riskiest I/O the bridge has ever owned.
- **Latency staying bad after the transport work.** If a live-feeling mirror proves unreachable without
  frame streaming, that is a genuinely new fact and not a re-run of this argument.
