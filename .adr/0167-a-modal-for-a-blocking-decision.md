# 0167: A modal for a blocking decision

- **Status:** Accepted (2026-11-20)
- **Date:** 2026-11-20
- **Trail:** The draft offers' trial of 2026-11-20. Its first round drew Add to it, Replace and Cancel
  as a `BottomSheet`, because DESIGN.md called the sheet "the app's only floating layer that holds a
  task". The operator looked on his phone and turned that road down: "this is a sheet/paper not a
  modal", and asked for bordered buttons and the draft that Replace deletes. Files:
  `web/src/components/ui/modal.tsx`, `web/src/components/actions-palette.tsx`,
  `web/src/components/send-offer-modal.tsx`, `DESIGN.md` (§1, the table)

## Context

The app had one floating layer for work, the bottom sheet: a sheet of rows that slides up, with a grab
handle and a drag down to close. It suits a task the person picks from a list. The Actions palette
(ADR 0165) needed something else, a panel at the top over a dimmed scrim, and drew its own shell in its
own file. The draft offers need a third thing: a choice that blocks the send until it is made, about a
text the person may lose. In a sheet the three choices read as menu rows on paper, not as a question.

## Decision

**A decision that blocks until it is answered is a modal: a panel over a dimmed scrim. A task is a
sheet. The palette and the draft offers share one shell, `ui/modal.tsx`.**

- **One shell.** `Modal` owns the scrim, the panel's look (`--card`, the house radius, a uniform border
  on all four sides, a soft shadow, never an accent edge), `role="dialog"` with `aria-modal`, Escape, the
  scrim tap (down and up on it), the focus in and back, the portal to `<body>`, and the room above the
  soft keyboard. The caller owns every word and the panel's size.
- **Two placements.** `top` for the palette, whose field keeps the keyboard up. `center` for a decision:
  centred in the visible height, and the focus moves to the panel, so a soft keyboard goes down.
- **The draft offers use it, centred.** A caution title, the draft the bridge read (ADR 0166), and one
  bordered button per choice with a line under its label. Every other offer set keeps the strip.
- **No second modal shell.** A new blocking decision uses `Modal`; a new list of things to do is a sheet.

## Consequences

- The palette moved onto the shell with no change in its look. Its panel now sits in a portal under
  `<body>`, takes `tabIndex={-1}`, and Escape closes it from anywhere on the page, not only from its field.
- A modal has no drag to close and no close button of its own; the scrim and Escape close it, and a
  caller that needs a close button draws one.
- Revisit if a decision needs more than one screen of content: that is a task, and a task is a sheet or
  a page.
