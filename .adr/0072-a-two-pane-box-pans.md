# 0072 — A two-pane box pans

- **Status:** Accepted
- **Amended in scope by:** [ADR 0076](./0076-the-omp-resume-picker-is-lifted-and-every-omp-modal-has-a-way-out.md):
  omp's `/model` picker now renders inside the unread-dialog card, whose mirror pans the whole pane
  as one, so no table run claims it any more. The anchor rule and everything else below stand.
- **Date:** 2026-09-30
- **Changes:** the anchor alphabet of `web/src/lib/table-run.ts`, which until now refused a T-piece.
  [ADR 0008](./0008-collie-does-not-run-a-terminal-emulator.md) and
  [ADR 0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md) are untouched: nothing here
  emulates a terminal and nothing here synthesises a key.
- **Trail:** [discussion #301](https://github.com/AltanS/collie/discussions/301) ·
  `web/src/lib/table-run.ts` · `web/src/lib/rule-glyphs.ts` · `web/src/lib/blocks.ts` (`FRAME_ROW`) ·
  `web/src/fixtures/panes/claude--workflow-view.txt`

## Context

`table-run.ts` groups a table's rows into one horizontal scroller so a wide table can be panned on a
phone while the prose around it keeps wrapping. It anchors on a row that proves a column boundary
exists, and until now that had to be a CROSS: `├───┼───┤`.

The reasoning was that only a table draws a `┼`. That is true, and it was the wrong test. A two-pane
box does not draw a cross anywhere. Its divider meets the lid at `┬` and the floor at `┴`, so the rule
refused every two-pane box there is.

**Refusing a box does not leave it wrapping, which is what the old rule assumed.** `FRAME_ROW` in
`blocks.ts` matches any row whose first and last glyph are frame edges and marks it `noWrap`, so every
`│ … │` row of a refused box is CLIPPED instead. On a phone that means the box's second pane is not
merely awkward, it is unreachable. Three screens were in that state:

- **Claude Code's dynamic-workflow view**, reported in discussion #301. The phases sit in the left
  pane and the running agents in the right one. The reporter's screenshots show a band of stacked
  rules and `· 74…` cut off the right edge, which is exactly what clipping every row of a 226-column
  box onto a 45-column screen looks like.
- **omp's `/model` picker.** The vendors are in the left pane and the model names in the right one, so
  the phone could see the categories and never the models.
- **omp's welcome splash.** The logo on the left, Tips / LSP servers / Recent sessions on the right.

The old rule's own comment named the last two as the reason for the exclusion. It read them as a
false positive. They are the feature.

## Decision

**A frame row carrying any COLUMN junction anchors a table run: a cross, or a vertical tee.**

`BOX_COLUMN_JUNCTION_GLYPH_CLASS` is the anchor alphabet now. `BOX_CROSS_GLYPH_CLASS` is deleted; its
reasoning survives in the comment on the class that replaced it.

1. **A side tee is still not an anchor.** `├ ┤ ╞ ╡` end a frame row without dividing it, so a
   single-column chrome box, Claude's own input box among them, still has no column boundary anywhere
   and still wraps.
2. **The three rules that keep the anchor honest are unchanged**, and they are what the old rule was
   leaning on a rare glyph to do for it. The anchor row must be a PURE frame row, so a sentence with
   a tee in it is not one. Every one of the anchor's offsets must be held on every member row, so a
   run cannot grow past its own box. And a run of one row is discarded, so a lone tee claims nothing.
3. **The blast radius was measured before the change, not argued.** Across all 355 committed captures
   a tee anchor claims exactly two more screens, omp's splash and omp's `/model` picker. The corpus
   gate at the foot of `table-run.test.ts` lists every claim by name, so a third cannot arrive
   unnoticed.
4. **This is a RENDER decision and touches nothing else.** `tableRuns` is called in one place,
   `ansi-output.tsx`, at render, and only while Wrap is on. No grammar, no detector and no send guard
   reads it, which is why ADR 0009's rule about menus does not reach it: panning a menu emits no key.

## Consequences

- **The reported screen works.** `claude--workflow-view.txt` was captured for this ADR and is in the
  corpus gate, so the fix has a regression pin on the actual screen that was broken.
- **omp's `/model` picker pans, and it is the one claimed screen that is also a MENU the operator
  drives.** Panning right can carry its `❯` off screen until they pan back. That is the cost, it is
  accepted, and it is smaller than the present state, where the model names cannot be read at all.
- **A headerless box table still wraps**, as it did before. It draws no junction anywhere, so nothing
  anchors. That was the old rule's stated cheap failure and it is still the cheap failure.
- **A two-pane box inside a table run is one scroller**, so its two panes pan together rather than
  independently. A box is one object and that is the honest reading of it.

## Revisit

- **If a claimed screen turns out to be worse panned than clipped.** The corpus gate names every one,
  so the question is always answerable against a list rather than against a memory.
- If a harness draws a two-pane box whose panes must scroll independently. One scroller is the
  simplification here, and it is the first thing that would have to go.
