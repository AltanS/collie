# 0054 — A printed scale is tappable

- **Status:** Accepted
- **Date:** 2026-09-22
- **Shipped in:** pending (target 1.12.0)
- **Trail:** `web/src/lib/harness/menu-model.ts` (`MenuLeftRight.values`, `menusSameIdentity`) ·
  `web/src/lib/harness/claude/effort.ts` · `web/src/components/menu-block.tsx` ·
  `web/src/fixtures/panes/claude--menu-effort-slider--w132.txt` ·
  [ADR 0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md) ·
  [ADR 0053](./0053-an-unread-dialog-still-has-a-way-out.md)

## Context

**The card named one level and hid the other five.** ADR 0053 gave Claude's `/effort` slider its
buttons back, and the Effort grammar reads the level the `▲` stands over. The card then rendered
`←  medium  →`: two arrows around the current value, which is all the `/model` picker's
`◐ Medium effort ←/→ to adjust` row ever offers.

That is the right shape for the picker and the wrong shape for the slider, because the slider prints
the whole scale. The mirror above the card shows it, and on a 132-column pane the mirror is cut off
on a phone. So the operator saw `medium` between two arrows and no way to learn that `high`,
`xhigh`, `max` and `ultracode` exist, let alone how many taps away they are. The information was on
the screen, the grammar had already parsed it, and the card threw it away.

**The grammar was already reading it.** `detectEffortRegion` splits the label row into ordered spans
and picks the one nearest the marker. Every other span was discarded at the last step. Carrying them
costs one `map` and no new parsing.

## Decision

**When a harness prints the whole scale an `←/→` row moves along, the card shows every value as a
tappable chip, and one tap sends the delta as repeated presses of the arrow key the footer named.**

1. `MenuLeftRight` gains `values?: string[]` — the ordered scale, left to right, exactly as the
   screen printed it on one row. An adapter sets it only when the screen printed the whole scale.
   When it is set, `label` is one of `values`. A screen that prints only its current value sets
   nothing and keeps the plain arrows, unchanged.
2. **A chip tap is arithmetic on arrow presses, never a new key.** Target index above the current
   one sends `Right` repeated by the difference; below it sends `Left`. ADR 0009 stays intact: the
   only keys that leave the card are the ones the footer advertised, and no digit is ever
   synthesised from a position. The tap carries the non-committal `nav` guard, because that is what
   the arrows it stands for carry.
3. **The scale is part of menu identity.** `menusSameIdentity` compares `values` alongside the verb.
   An arrow tap moves the marker along the scale and never rewrites the scale, so comparing it
   strengthens the guard rather than breaking the second tap in a row the way comparing `label`
   would. A screen whose scale differs is a different screen.
4. **A scale the card cannot stand on falls back to the arrows.** Fewer than two values, or a label
   that is not one of them, renders the old row. The card never guesses a position.

## Consequences

- **One tap replaces up to five.** Reaching `ultracode` from `low` was five taps on an arrow whose
  destination the operator could not see; it is now one tap on a named chip.
- **The delta is sent as one request.** `sendGuardedKeys` passes the array through to
  `POST /api/pane/:id/keys`, which forwards it to Herdr's `pane.send_keys` in one call with no
  length cap. So the guard runs once, against the screen the operator actually tapped.
- **A chip is marked, not resized.** The current chip changes colour and carries `aria-current`; no
  weight, padding or border width moves with that state, because the marker moving must not slide a
  chip under a thumb already on its way down (DESIGN.md §2).
- **The chips are the only thing on the card that is not one keystroke.** Everything else a menu
  offers is a single key. A tap that sends five is still non-committal, and the mirror above shows
  the result, but a future scale long enough to make that count unreasonable is the signal to
  revisit.
- **A second harness that prints a scale gets this for free**, and one that prints only its current
  value is not made worse. The field is optional on the neutral model, so no adapter is obliged.
- **Revisit** if a harness prints a scale whose arrows wrap around at the ends, where a delta is no
  longer the shortest path, or if a screen prints a scale it does not let the arrows walk.

> **Amended 2026-09-22:** the mirror above the chips is gone for a card of this shape. At 40 and 60
> columns Claude wraps the slider three ways at once, and the mirror the sentence above still
> described had become a horizontally-scrolled run of the wrapped fragments — the same scale the
> chips already show in full, printed twice, once broken. Altan's rule: if the card is already
> committing to the chips, it commits all the way. So `MenuBlock` now renders no mirror at all when
> the model carries a fully parsed scale (`nav.leftRight` with a non-empty `values` array and a
> `label` that is one of them) — only the title, the chips, and the footer's Confirm / this-session /
> Cancel buttons. The generic menu (`/model`, `/tasks`, `/resume`) parses no scale, so it is
> untouched: its body is unread structure the mirror is the only way to show, and it keeps the mirror
> exactly as this ADR first shipped it.
