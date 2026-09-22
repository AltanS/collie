# 0057 — The composer is one box

- **Status:** Accepted
- **Date:** 2026-09-22
- **Shipped in:** pending (target 1.12.0)
- **Trail:** `web/src/components/composer.tsx` · `web/src/components/ui/chat/chat-input.tsx` ·
  `web/src/components/actions-row.tsx` · `web/src/components/ui/anchored-menu.tsx` ·
  `DESIGN.md` §2, §6 · [ADR 0005](./0005-a-composed-key-queue-never-outlives-its-dock.md)

## Context

The composer's write surface was three shapes on one line. A bordered, rounded textarea; an attach
button positioned absolutely into that textarea's bottom-right corner, with a 44px strip of padding
(`pr-11`) reserved on the field so a long line could not run underneath it; and a round primary
action, mic on an empty box and Send once there was anything to send, floating beside the field in
a flex row. The focus mark belonged to the textarea alone, so focusing the composer lit the middle
shape of the three and left the other two unmarked.

Altan asked for "the shadcn chat prompt templates" on it. shadcn's June 2026 chat release ships no
input component. The pattern he was pointing at lives in the registry kits built on top of it,
prompt-kit's `prompt-input` (MIT, ibelick/prompt-kit) and Vercel's AI Elements: **one bordered,
rounded container holding the textarea on top and a toolbar row along the bottom**, secondary tools
left, the primary action right, and the focus ring on the container rather than on the field.

Taking the kit itself was the obvious move and is the one we decline. Both kits default to
**Enter sends**, which is the one key Collie cannot spend: the draft goes to a terminal, Enter is a
shell character, and Cmd/Ctrl+Enter is the submit here. Both also pull a headless primitive library
(Radix in prompt-kit, Base UI in AI Elements) and AI Elements pulls the `ai` package, for a
container, a row and a textarea this app already owns better versions of. The pattern is three
layout decisions. It is not a dependency.

## Decision

**The field, the attach control and the primary action are one bordered container with a toolbar
row. The pattern is ported by hand, with no new dependency, and every composer behaviour is
unchanged, the send key first among them.**

1. **One container owns the frame.** `rounded-xl border border-input bg-background`, and the focus
   mark is `focus-within`, so a caret anywhere inside marks the whole shape. It stays an OUTLINE
   (`outline-2 outline-offset-2`) rather than a ring, for the reason it already was one on the
   field: the border is unconditional and only its colour moves, so nothing resizes under the
   caret (DESIGN.md §2), and an outline sits outside the box rather than smearing into its border.
2. **The textarea inside draws nothing.** No border, no radius, no focus outline of its own. Two
   frames, one inside the other, is the shape this replaces. It keeps everything else exactly:
   `field-sizing-content`, the `min(10rem,30dvh)` keyboard-aware cap, `wrap-anywhere`,
   `autoCapitalize="none"`, the one-line clipped placeholder contract, the per-state placeholders,
   the IME composition handlers and the operator's draft face and size.
3. **The toolbar row is a row of its own**, `flex items-center justify-between gap-2 px-1.5
   pb-1.5`, inside the box and under the field. Attach on the left, with the same icon, the same
   `AnchoredMenu` picker, the same disabled rules and the same upload spinner. The primary action
   on the right, the same element and the same handlers in all four of its branches: type-anyway,
   really-send, mic, Send.
4. **`pr-11` is gone and nothing may reserve a strip in the field again.** The padding existed for
   the button that is no longer in there, and the 44px it held is typing area now. A control that
   wants room beside the draft takes the toolbar row.
5. **Both toolbar controls are drawn at 36px and buy the 44px floor back as hit area.** DESIGN.md
   §6 states the floor and sanctions this trade where drawn height is expensive. It is expensive
   here: the row stands inside the box, under the draft, so every pixel it takes is a pixel of
   mirror. `TOOLBAR_TAP_TARGET` in `composer.tsx` carries the arithmetic (36 + 4 + 4 = 44 in both
   axes, the reach staying inside the row's own 6px inset).
6. **The belt is not the toolbar and stays above the box.** Keys, Type, Quick, Agent and Display
   keep their own row and their docks are untouched. They open surfaces that fill half the
   viewport; the toolbar holds the two controls that act on the draft in front of you. Nothing
   else moves into the box.
7. **A locked composer recedes as a surface.** `bg-muted/40` on the container when the pane is
   gone, the device is read-only, the host is blocked or the multiplexer cannot type, with the
   placeholders and the disabled controls exactly as they were.

## Consequences

- **The send key is unchanged.** Cmd/Ctrl+Enter sends, a bare Enter is a newline, and both are now
  pinned by a test that reads `preventDefault` directly. That test did not exist before this
  change and is the first thing a future port of a kit's keymap would break.
- **Every other composer behaviour is unchanged**: drafts and their per-pane store, attachments and
  the host path the upload appends, paste-a-file, the destructive two-tap confirm, the mic swap on
  an empty box, "Type into terminal" and its armed strip, the terminal-draft preview with Take
  over, the read-only and locked placeholders, and the keyboard-aware height cap.
- **The attach picker anchors to the box, not to its button.** `AnchoredMenu` is `right-0
  min-w-44` against its anchor, and the button now stands at the LEFT end of the toolbar row, so
  anchoring it there would grow the panel off the left edge of the screen.
- **A long unbroken token has one more thing stopping it.** `wrap-anywhere` on the value is still
  required and still the fix at the source, but Send is no longer beside the field, so an uploaded
  host path cannot push it off the right edge even in principle.
- **No new dependency, and about 114 bytes on the web bundle** (954,998 to 955,112 in
  `dist/assets/index-*.js`).
- **Revisit** if a second secondary tool earns the box's left side, which is the point at which
  the row needs a rule about what may live there, or if the 36px faces read as too small in a real
  hand despite the 44px hit area.

## Amended 2026-09-22

The toolbar row cost a second row of height on a phone. An empty composer stood two rows tall,
the field's line on top and the two 36px buttons under it, and every pixel of that came out of the
mirror. The focus mark also drew two frames: the border turned ring-coloured, and the offset
outline drew a second line 2px outside it.

**The box keeps one row, with attach and the primary action inline, and one focus frame.** This
replaces decisions 1, 3 and 4 above where they differ; the rest stands.

1. **One row.** The box itself is the row, `flex items-end gap-1 p-1`: attach, the field
   (`flex-1 min-w-0`), the primary action. `items-end` keeps both buttons pinned to the bottom edge
   while a long draft grows the field up to its `min(10rem,30dvh)` cap. The toolbar row is gone.
2. **An empty composer is one button row tall.** The buttons stay 36px faces with the 44px hit area
   of `TOOLBAR_TAP_TARGET`. The box's `p-1` is exactly that 4px reach, so the box is 44px inside its
   border. The field centres one line against the buttons with `py-1.5` and `min-h-9`, and claims
   nothing taller.
3. **One focus frame.** On `focus-within` the border takes the ring colour and `ring-1 ring-ring`
   thickens it as a box-shadow, which costs no layout. No outline, no offset, no second line. The
   wrapper's `pt-1`, which only kept the old outline's 4px reach off the belt, is gone with it.
4. **A long unbroken token is stopped twice again.** Send is beside the field once more, so the
   field's `min-w-0` is what lets it be narrower than an uploaded host path asks, and
   `wrap-anywhere` on the value still stops the same thing at the source.
5. **Attach sits at the right, next to the primary action, as it did before the one-box change.**
   Altan preferred it there.

Everything else is unchanged: Ctrl/Cmd+Enter sends and a bare Enter is a newline, the locked look,
the picker anchored to the box, the mic, Send and confirm swap, the draft preview, IME and
paste-a-file.
