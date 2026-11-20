# 0162 — An adapter that reads raw VT keeps two stateless row transforms, and nothing more

- **Status:** Proposed
- **Date:** 2026-11-20
- **Amends in scope:** [ADR 0008](./0008-collie-does-not-run-a-terminal-emulator.md). ADR 0008 was argued
  for Herdr, whose `pane.read` hands back a grid it already rendered. Rex hands back VT text, so its
  adapter turns that text into rows. This record names how far that may go before it is an emulator.
- **Trail:** PR #814 (the Rex adapter, by dcvdiego), its review of 2026-11-20 and the counsel round that
  asked for this limit to be written down · Files: `bridge/mux/rex/protocol.ts` (`keepSgrOnly`),
  `bridge/mux/rex/protocol.test.ts`

## Context

`rex capture --format=vt` and `rex block call format` return the screen and the scrollback as VT
text. Rex has already applied the cursor motion, the clears and the scroll regions: each row arrives
as its own line, joined by `\r\n`, and opens with `ESC [ 0 m`. Two things are left in a row that are
not SGR. Rex writes a run of blank cells as a cursor-forward, `ESC [ n C`, and it keeps OSC 8
hyperlinks and other escapes.

So the Rex adapter does work that the Herdr adapter does not. Without a limit, the next fix of a
wrong row would be one more escape handled, and then one that keeps state from one row to the next.
That is the emulator ADR 0008 refused, built one escape at a time.

## Decision

**An adapter that reads raw VT applies two transforms to each row on its own, and nothing that keeps
state across rows.**

1. A cursor-forward becomes that many spaces, on the same row, bounded (four digits at most and never
   more than 1000 spaces; a longer count is dropped as an unknown escape).
2. Every escape that is not SGR is dropped, and so is every control byte but tab and newline, the
   8-bit forms included.

A row the two transforms cannot make right stays wrong on the phone, and the fix goes to the
multiplexer as an ask: a rendered-rows format, like Herdr's grid.

## Consequences

- The Rex mirror is as faithful as Rex's VT rows, and no more.
- A cursor move inside a row other than forward, a scroll region, or a clear that Rex leaves in the
  text would show wrong. None appeared in any probe on API revisions 18 and 19.
- A third adapter that reads raw VT takes the same two transforms, and the same limit.
