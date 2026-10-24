# 0120: on a large screen, the pane screen is a sidebar beside a strip of panes

- **Status:** Proposed
- **Date:** 2026-10-24
- **Shipped in:** pending
- **Trail:** the playground's "Large screens" round (`web/src/playground/sections/wide-layout*.tsx` on
  the prototype branch) · `web/src/lib/wide-layout.ts` · `web/src/lib/wide-layout-store.ts` ·
  `web/src/lib/belt-intent.ts` · `web/src/components/wide-layout.tsx` ·
  `web/src/components/strip-column.tsx` · `web/src/components/app-header.tsx` (`useHeaderDock`) ·
  [ADR 0067](./0067-back-goes-up-one-level.md) ·
  [ADR 0073](./0073-a-live-session-is-a-bounded-window-on-the-existing-poll.md)

## Context

Collie is drawn for a phone held in one hand. On an unfolded Fold or a tablet the pane screen is the
phone's column, centred, with empty margins, and the only way to another pane is the switcher sheet.
Altan picked a layout in the playground round: a sidebar of panes beside a strip of panes, after the
niri window manager.

Two facts shaped the detection. A Galaxy Z Fold held flat open reports one viewport segment and the
posture `continuous`, so the fold APIs cannot tell it from a tablet. Viewport Segments ships only in
Chrome 138 and later, and Device Posture only in Chrome and Samsung Internet, with nothing in Safari
or Firefox. The window's width is known everywhere.

## Decision

1. **Three width classes, read from the window's width with two media queries.** Compact is below
   600px, medium is 600px to 899px, expanded is 900px and up. Below 600px nothing changes. The fold
   APIs are not read, for the reasons above.
2. **From 600px, and only on `pane/:paneId`, the screen is a sidebar beside a strip.** The sidebar is
   the switcher's own list (pins, Shells, Launch), raised on `--card`, 280px at medium and 320px at
   expanded. Its top row carries the Collie mark, the word ColliePWA and a toggle that closes it to a
   56px rail of icons with status marks. Open or closed is kept per device.
3. **The strip follows niri.** Each space keeps its own row of columns. A column has a width preset of
   1/2, 4/5 or Full of the strip, and columns never shrink to fit: the strip scrolls sideways and snaps
   to a column start, so it always begins with a whole column and only the right edge may cut one. A
   new column starts at 1/2. The space header moves to the space above or below, in the sidebar's
   order, by its buttons or a vertical swipe, and lands on that space's remembered pane.
4. **The route stays the truth.** The focused column is always the route's pane. A pane reached by a
   tap or a link that is not a column replaces the focused column; one that is a column takes the
   focus. Every act writes the layout and then moves sideways with `nav.side` (ADR 0067), so Back and
   a shared link mean what they meant before.
5. **A minimum pane width of 360px decides wide mode.** The strip is wide when its own width, measured
   beside the sidebar or the rail, holds two panes at the minimum. Out of wide mode every column is
   full width and there is no width control. In wide mode a column's width control skips any preset
   below the minimum and hides when only Full is left.
6. **One composer: every column has its belt, only the focused column has the reply box.** The focused
   column mounts the pane screen itself, with the one header docked at its top and the mark moved into
   the sidebar. Every other column draws its pane's header, a live read-only Chat (or its screen, by
   the device's own choice for that pane) on the existing poll, and the pane's own belt: the model tag,
   Stop, Keys, Tasks and the other pills the phone shows for that pane. The belt's Switch pill is not
   drawn from 600px, because the sidebar is the switcher; below 600px it stays.
7. **A belt tap in another column acts on that pane and gives it the focus.** The tap leaves its act
   for that pane's address (`lib/belt-intent.ts`) and moves sideways to the pane; the composer that
   mounts for it runs the act once, through the same handler and gates as a tap on its own belt. A
   pill that needs the composer (a dock, Type, a command) therefore finds it. Stop arms and confirms
   in the column, as on the phone, and only the confirmed Stop travels. An act not taken within five
   seconds lapses.
8. **Nothing page-level runs twice, and only the focused pane counts as opened.** The poll intent, the
   key listeners, the sheet pull and the sheets stay in the one pane screen. The other columns read
   with `seen: false` (a new option on `fetchChat` and `useChatWindow`, and the existing one on
   `fetchPane`).
9. **The layout is this device's and is keyed on the pane's full address.** Columns, widths and focus
   per space live in localStorage, keyed on the pane scope key and the space's machine, session and
   workspace. Nothing is written to a bridge and there is no request id. A column whose pane a live
   herd no longer lists is pruned; a herd from a saved copy prunes nothing.
10. **Phone gestures are deferred.** The playground's swipe, two-finger chord and joystick cards are
    not built. Below 600px the pane screen is the phone's as before.

## Consequences

The focused column is framed in `--ring` on all four sides while the strip shows more than one
column. Every column reserves the frame, so a focus change recolours and moves nothing. A column that
takes the focus grows its reply box over 200ms under the belt, so the belt rises instead of jumping,
and the transcript, pinned to its bottom, keeps its last line in sight. Under reduced motion both the
scroll and the box snap.

A pane screen mounted for each column was not an option: it would mean a composer per column, keys
that could reach the wrong pane, and every page-level effect once per column. The read-only columns
cost one read each on the existing poll, the same read the pane screen makes.

The new words are Open here, Open beside, Remove from view, the width labels and ColliePWA. Until the
next translate pass the other locales carry the English strings.

The switcher sheet inside the pane screen is still mounted on a large screen, closed, with no pill to
open it; the sidebar repeats its wiring. If the two drift, the sheet should take its list from the
sidebar's component.
