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

## Addendum — 2026-11-20: on a wide window a sheet is drawn as a centred dialog

The operator, on a desktop window, of the Attachment sheet (a 640px panel stuck to the bottom edge, its
grab handle, a small picture in it): "on desktop these sheets opening from the bottom need to be reworked,
they don't work on desktop". The bottom edge is where a phone's thumb is; on a desktop it is where the eye
is not, and a pull to close means nothing to a mouse.

**A sheet still holds a task and a modal still holds a decision.** What changes is only how the sheet is
drawn: on the `expanded` width class (ADR 0120) with the screen flat, `BottomSheet` stands in the middle
of the window in this shell's look, through the constants `ui/modal.tsx` exports (`MODAL_FRAME`,
`MODAL_PANEL_LOOK`, `MODAL_CENTER_ENTRANCE`, `MODAL_SCRIM`, `useModalRoom`): the scrim, four round
corners, a uniform border, the soft shadow, the small zoom in (none under reduced motion), centred in the
room above an on-screen keyboard. It keeps its title row, its close button and its `action` slot, and
loses the grab handle, the pull down to close and the pull-up peek. It is at most 82% of the window tall
and its body scrolls inside. `compact` and `medium`, and a foldable folded as a book or held as a
tabletop, keep the bottom sheet as it was: there the thumb is at the bottom edge, or the middle of the
window is the hinge. So does a sheet whose own fixed layer has no expanded room: the website and the
design reference draw the app in phone frames in the page, and a frame's transform holds the layer, so
the sheet measures that box in the layout phase and stays a bottom sheet in a phone. No frame sets
anything. The tour, a full-screen sheet on purpose, asks for the bottom sheet on every width
(`presentation="sheet"`). The component keeps its name.

- **One size word.** `size="viewer"` lets a sheet whose content is a picture or a document page
  (`ImageSheet`, `PagerSheet`) stand as wide as its picture, up to `min(92vw, 1200px)`, the picture
  fitted in the height left (`SHEET_PICTURE_FIT`) and never drawn past its own pixels. The pager's stage
  takes the viewer's whole room, so a page of another shape does not move Previous and Next.
- **A menu beside its button.** A sheet opened by a tap on a small button (the pane, tab and space
  menus, `anchor`) is drawn on a wide window as a menu beside that button: below it, flipped above when
  the room is short, 8px inside the window, in the same look, with no dimming, no entrance and no title
  row (`lib/menu-place.ts`; the reasons of `ui/anchored-menu.tsx`). The same sheet opened another way
  stays the centred dialog.
- **No second shell.** A sheet drawn as a dialog is not a modal and does not become one: a new task is
  still a sheet, a new blocking decision still uses `Modal`.
