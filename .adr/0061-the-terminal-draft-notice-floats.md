# 0061 — The terminal draft notice floats

- **Status:** Accepted
- **Date:** 2026-09-22
- **Shipped in:** pending (target 1.12.0)
- **Trail:** `web/src/components/terminal-draft-preview.tsx` · `web/src/components/composer.tsx` ·
  `web/src/components/agent-chat.tsx` · `DESIGN.md` §1, §2 ·
  [ADR 0059](./0059-a-card-docks-above-the-belt.md)

## Context

When the operator types in the terminal itself, the text on the input line is a draft the phone did
not write. The composer shows it as a notice, "Draft in terminal", with Take over. That notice was an
in-flow strip under the belt, inside a `Collapse`. So each time a draft stranded or cleared on the
host, the footer grew or shrank, and the belt, the field and the mirror's tail all moved. The notice
also had no dismiss: it was honest state, so it stayed while the host line held text. Altan: "when
I'm typing in the terminal the phone UI is showing the draft in terminal and take over stuff. this
completely messes with the UI as it shifts the layout. move it above the belt, maybe a transparent
overlay, give it the option to x away".

## Decision

**The notice leaves the layout. It floats over the bottom edge of the mirror and an x hides it until
that draft is gone.**

1. **Where.** The pane view keeps an absolutely positioned slot as the last child of the mirror
   wrapper (`relative`), pinned to its bottom edge, full width minus the `px-3` gutter. The mirror
   wrapper ends where the card dock begins when a card is docked, else where the bottom region
   begins, so the notice sits just above the dock or just above the belt. The composer portals the
   notice into that slot. A composer mounted alone floats it above its own top edge instead.
2. **Nothing moves.** The slot is absolute, so the notice covers the mirror's last rows and changes
   the height of nothing: not the scroller, not the dock, not the belt, not the field. There is no
   `Collapse` around it, because DESIGN.md §1 governs surfaces in flow and this one is not. The slot
   is `pointer-events-none`, so a touch on its empty part reaches the mirror; the notice is
   `pointer-events-auto`.
3. **Look.** A translucent surface (`bg-background/85 backdrop-blur-sm`), one uniform 1px border,
   rounded, `shadow-md` (lighter than the popovers' `shadow-lg`), small text, the draft clamped to
   two lines.
4. **The x.** `Dismiss the terminal draft notice`, 44px hit area. It hides the notice until the
   terminal draft becomes empty, meaning the host line is cleared or sent. A later non-empty draft
   shows it again. Changing the draft text while dismissed keeps it hidden. The dismissal is per
   pane, in memory only: a pane switch resets it and nothing stores it.
5. **Take over is unchanged.** It copies the live draft into the composer, marks it handled and
   hides the notice, exactly as before.

## Consequences

- **The notice can cover the mirror's last rows and the jump-to-bottom button.** That is the price
  of not moving anything, and the x is the way to see under it.
- **The footer's in-flow strips are now all phone-side conditions** (the sent preview, the password
  notice, the armed modes, the draft-too-long line). A notice about the host's own line is not one
  of them.
- **The notice's surface moved from `bg-background/85` to `bg-card/95`.** Dark `--background` is
  byte-identical to the mirror's own fill (`components/mirror-space.ts`), so the original
  translucent ground read as almost the same black as the terminal text behind it. `--card` is the
  app's raised-chrome surface, a real step off `--background` in both themes, so the notice uses it
  to read apart from the terminal.

## Addendum — 2026-10-18: the held-send card floats in the same slot

Status is unchanged: **Accepted**. Nothing above this line is rewritten. This addendum puts a second
card in the slot and says how the two share it.

**The held sends were the same fault.** The sends the bridge holds for a pane (M56 spec 15) drew as
one in-flow row each, inside a `Collapse`, directly above the composer's box. Each held send grew the
footer, so the belt, the field and the mirror's tail moved, and a queue of three moved them three
times. Altan, 2026-10-18: the queued messages above the input box shift the layout, and with more
than one queued message they should be collapsed. The choice was a floating card in the same slot as
the draft notice, which holds no space, over a reserved strip or a smaller in-flow row.

1. **One card, in the same place.** `HeldCard` (`composer-held.tsx`) is portalled into the slot when
   the pane view gives one, else floated above the composer's own top edge (`absolute inset-x-3
   bottom-full z-20 mb-2`). The wrapper is `pointer-events-none` and the card `pointer-events-auto`.
   There is no `Collapse` around it, for the reason in point 2 above: it is absolute, so it changes
   the height of nothing, and a row arriving or leaving moves no neighbour.
2. **Two cards, one column.** The slot held one notice. It now holds a column with a small gap: the
   held card on top, and the draft notice or the offline note nearest the belt. The terminal draft
   still wins over the offline note. Both cards float, so a card arriving or leaving moves neither the
   belt nor the other card's bottom edge.
3. **Look.** The notice's ground (`bg-card/95`, `backdrop-blur-sm`, `shadow-md`, small text) under the
   queue's own dashed `border-status-working/40` edge (`QUEUED_FLOAT` in `queued-block.ts`), so it
   reads apart from the terminal and still says "mine, not sent yet". One uniform border, no left
   accent.
4. **One row shows whole.** Label, its buttons, its text clamped to three lines, as before.
5. **Two or more collapse.** The head is a count ("3 queued. Sends when the turn ends.") when every
   row is held, else the first row's own label. A Show all toggle sits at its right, with the first
   row's text under it, clamped to two lines, and no per-row button: a Cancel on a count would not say
   which row it cancels. Show all lists every row as a single row, oldest first, in a list capped at
   `max-h-[45dvh]` that scrolls inside the card. The open state is per pane and in memory: the
   composer keys the card by pane, and the card collapses again when the rows drop to one or none.
   Show all stays on a crew member's pane and on a locked composer, because it is a view and not an act
   on the queue; the row buttons stay gated by `canAct` as before.

**Consequences.**

- **The card covers more of the mirror's last rows while a queue exists.** A collapsed queue is about
  as tall as one single row, whatever its length, and an open list can take up to 45dvh. That is the
  price of moving nothing, and Show less is the way to see under it. With the draft notice also due
  the column is taller still.
- **The cap is `dvh`, the viewport the soft keyboard leaves.** With the keyboard up an open list
  shrinks with it instead of reaching above the mirror region. The list scrolls and Show less is in
  the head, so nothing is lost.
- **The composer's in-flow strips are now all phone-side conditions again.** The held sends are
  host-and-bridge facts, so they left that list the way the draft notice did.

**What would reopen this:** an open list that clips at the top of the mirror on a short screen, or a
third card wanting the same slot. Then the column needs a height budget of its own rather than a
`vh` cap per card.

## Addendum - 2026-11-01: the bodies end above the floating cards

Status is unchanged: **Accepted**. Nothing above this line is rewritten. This addendum takes back the
price both consequences named: a floating card no longer covers rows the reader cannot reach.

**The covered tail could not be read.** Scrolled to the bottom, the last line of a reply sat under the
draft notice, and the only way to read it was the x, which also hides the notice. The cards still
float and still move nothing in the footer: not the dock, not the belt, not the field.

1. **The pane view measures the slot.** `useFloatingClear` reads the slot's height while a card is in
   it, and 0 while it is empty, and follows it as cards come, go and grow.
2. **Both bodies end that much lower.** `ChatMessageList` takes the height as `clearBottom` and ends the
   list with a spacer that tall, so a reader at the tail sees the last line just above the cards. The
   list keeps following the tail, so when a card comes the text rises above it, and when it goes the
   text comes back down. "Jump to latest" moves up by the same height and sits above the cards.

**Consequences.**

- **The text under the cards moves when a card comes or goes**, and when the draft notice grows from
  one line to two. The footer still does not, which is what this ADR is about.
- **A reader scrolled away from the tail is not moved.** The spacer only changes where the list ends.
