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
