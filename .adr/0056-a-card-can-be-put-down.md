# 0056 — A lifted card can be put down

- **Status:** Accepted
- **Date:** 2026-09-22
- **Shipped in:** pending (target 1.12.0)
- **Trail:** `web/src/components/option-button.tsx` (`PromptPanel`) ·
  `web/src/components/raw-mirror.tsx` · `web/src/components/prompt-select-block.tsx` ·
  `web/src/components/wizard-block.tsx` · `web/src/components/multi-select-block.tsx` ·
  `web/src/components/preview-select-block.tsx` · `web/src/components/menu-block.tsx` ·
  `web/src/components/unread-dialog-block.tsx` · `web/src/components/ansi-output.tsx` ·
  [ADR 0053](./0053-an-unread-dialog-still-has-a-way-out.md) ·
  [ADR 0054](./0054-a-printed-scale-is-tappable.md)

## Context

Collie lifts six kinds of recognised terminal dialog into native cards (menu, prompt-select,
wizard, multi-select, preview-select, unread-dialog), all built on the shared `PromptPanel`
surface. Four of them — prompt-select, wizard, multi-select, preview-select — fully REPLACE the
screen region they were parsed from: the raw rows never render again once the card takes over.
Altan: "we should add a way to escape the component takeover."

Until now the only ways out of a component takeover were the Keys drawer (always live underneath —
`composer.tsx`'s `locked` never checks whether a dialog owns the screen), a blind second Send (the
deliberate override in ADR 0009 / ADR 0053), or the device-wide `rawTerminal` display preference,
which turns every grammar off on every pane at once. None of the three lets someone check the exact
screen one card replaced without leaving the card, or without giving up every other card on the
device.

## Decision

**Every lifted card carries a control that shows the terminal rows it replaced. The choice lasts as
long as that one dialog and is never stored. The device-wide `rawTerminal` preference stays exactly
as it was — the always-on version of the same idea, not superseded by this one.**

1. **The control lives on `PromptPanel`.** An optional prop, `raw?: StyledLine[]`, takes the
   block's own `lines` — every block kind already carries them. When present, a small ghost
   control appears: icon `SquareTerminal` (lucide-react), label "Terminal", `aria-label` "Show the
   terminal instead of this card". Tapping it swaps the panel's children for a shared
   `RawMirror({ lines })` (`web/src/components/raw-mirror.tsx`, extracted from the two inline
   mirrors this ADR removes — reusing `MIRROR_SPACE`, `MIRROR_INVERT`, `styleFor`, ADR 0002's
   colour space) plus one "Back to the card" control. `role="group"` and the panel's `aria-label`
   are unchanged in both states.
2. **The state is local and unpersisted.** `useState<boolean>` inside `PromptPanel`. React keeps
   the instance across polls because `ansi-output.tsx` renders each card kind as one conditional
   element at a fixed position, so the choice survives a re-render of the same dialog and resets
   the moment the dialog changes kind or disappears. No pref, no localStorage key.
3. **The four cards that fully replace their region get exactly this: nothing by default, the raw
   region on demand.** Prompt-select, wizard, multi-select (its checkbox phase — the review phase
   is a short confirm screen over answers already shown, and does not carry a second control) and
   preview-select pass `raw={lines}` straight through to their `PromptPanel`. Card mode shows only
   the card, as before; Terminal mode shows only the region it replaced.
4. **The two cards that already showed a mirror keep showing it — the control declutters, it does
   not reveal.** The unread-dialog card and the generic (footer-only) menu card render the whole
   region or the option region BY DEFAULT, unchanged from before this ADR — each for the same
   reason it always did (ADR 0053: the screen is the only thing the operator has to read when
   nothing else is understood; the generic menu's options and descriptions exist nowhere but the
   terminal text). Both still take `raw`, and both replace their inline, ad hoc `<pre>` with the
   same shared `RawMirror` — "one implementation" — but tapping Terminal on these two puts the
   card's own controls away (the key button; the arrows, chips and footer buttons) and leaves the
   identical mirror on screen with a "Back to the card" control, rather than revealing something
   that was hidden. A card cannot both need to show its region unconditionally for legibility and
   hide that region behind an opt-in tap; decluttering is the version of this feature that is true
   of both at once.
5. **ADR 0054's rule is unchanged.** The Effort card (a fully parsed printed scale) still shows no
   mirror in card mode — the chips already say everything the mirror could. Terminal mode shows the
   raw rows for it too, like any other card, because the escape hatch is not conditioned on how
   confident the card is, only on whether a region exists to show.
6. **Plumbing.** `raw={block.lines}` is threaded from each call site in `ansi-output.tsx` down to
   the six block components, each of which forwards its `lines` prop to its own `PromptPanel`.

## Consequences

- **The Keys drawer is still the only input path in terminal mode.** This ADR adds a way to LOOK at
  the region a card replaced; it adds no way to type into it beyond what already existed.
- **ADR 0054 is unchanged** — a printed scale still commits to its chips in card mode; it only
  gained the same way out every other card has.
- **The lab's button count grows by one per card kind** (two for the unread-dialog and generic-menu
  cards, since Back only exists once Terminal has been tapped, so the visible count in a screenshot
  is still one added control at a time). A regression check that counts buttons inside
  `[role=group]` needs updating; the new labels are "Terminal" (`aria-label` "Show the terminal
  instead of this card") and "Back to the card".
- **One more `useState` per rendered card**, scoped to the panel instance and gone the moment the
  dialog is. No new render path, no new poll cost — `RawMirror` reuses the exact mirror-rendering
  code the two decluttered cards already ran, just in one place instead of two.
- **Revisit** if a future card needs its OWN "put down" affordance that does not read as this one
  (a card whose replaced region is meaningfully bigger than `lines`, for instance), or if the
  decluttering behaviour for the unread-dialog and generic-menu cards proves confusing in practice
  (Terminal appearing to do nothing, because the rows were already on screen).
- **Counsel fix, same day:** the unread-dialog and generic-menu cards' control claimed "Show the
  terminal instead of this card" while only hiding buttons the mirror already showed, so
  `PromptPanel` gained `rawMode: "reveal" | "declutter"` (default `"reveal"`) and those two cards
  pass `"declutter"`, which renames the pair to "Put away" / "Show the buttons".
- **Counsel fix, same day:** tapping either control unmounted it and dropped focus to the page
  body, so the swap now moves focus onto whichever control replaces the tapped one.
