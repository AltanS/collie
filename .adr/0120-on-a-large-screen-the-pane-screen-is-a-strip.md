# 0120: on a large screen, the pane screen is a sidebar beside a strip of panes

- **Status:** Accepted
- **Date:** 2026-10-24
- **Shipped in:** 1.24.0
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
   600px, medium is 600px to 899px, expanded is 900px and up. Below 600px nothing changes. A window
   under 480px tall is compact at every width, so a phone held sideways keeps the phone layout. A
   Settings row, Large-screen layout, sets Auto (the default) or Off per device (`collie:wide-layout-mode:v1`);
   Off makes every width compact. The fold APIs are not read, for the reasons above.
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
    not built. (The chord and the joystick came later, on every width:
    [ADR 0121](./0121-two-fingers-move-between-panes.md).) Below 600px the pane screen is the phone's as before, except on a tabletop fold (see
    "Folded postures").

## Folded postures

Added 2026-10-24, on top of the width layout. A foldable held half open splits the screen at the fold,
and the layout splits with it. Nothing straddles the fold.

1. **Read from Viewport Segments, not from Device Posture alone.** Two segments one above the other
   (`vertical-viewport-segments: 2`) is TABLETOP; two side by side (`horizontal-viewport-segments: 2`)
   is BOOK. Device Posture's `folded` says the hinge is bent but not where the fold crosses the
   viewport, and the layout needs where. The geometry comes from the `viewport-segment-*` environment
   variables, each with a fallback. Only Chrome 138+ and Samsung Internet have the features. Safari,
   Firefox and the Apple foldable match neither query and get the width layout only.
2. **Tabletop, at every width.** The top segment holds the header and the Chat (from 600px the sidebar
   and the strip, each column with its Chat only). The bottom segment holds the focused pane's belt,
   anchored at its top edge, and the reply box, which fills the rest of the segment. While the soft
   keyboard is up the layout falls back to flat, because the keyboard covers the bottom segment. The
   switch changes attributes only and never remounts the pane view, so the field keeps its focus.
3. **Book, from 600px.** Two columns, one per segment, with the fold's width as a gutter between them:
   the focused column and its right neighbour, or its left one at the end. The sidebar shows as the
   rail without touching the stored choice, and the width presets rest until the screen is flat. One
   column alone stands in the right segment, beside the full sidebar in the left one.

Checked in Chromium 151 over CDP on 2026-10-24: `Emulation.setDisplayFeaturesOverride` with
`setDevicePostureOverride({type: "folded"})` changed nothing, while the deprecated `displayFeature`
and `devicePosture` parameters of `Emulation.setDeviceMetricsOverride` made both queries match and
the variables answer (book: segments at 0 and 460 for a 20px fold at 440; tabletop: the bottom
segment's top at 410).

## Consequences

The focused column is framed in `--pane-active` (a light sky; its own token, never a state) on all four sides while the strip shows more than one
column. Every column reserves the frame, so a focus change recolours and moves nothing. A column that
takes the focus grows its reply box over 200ms under the belt, so the belt rises instead of jumping,
and the transcript, pinned to its bottom, keeps its last line in sight. Under reduced motion both the
scroll and the box snap.

A pane screen mounted for each column was not an option: it would mean a composer per column, keys
that could reach the wrong pane, and every page-level effect once per column. The read-only columns
cost one read each on the existing poll, the same read the pane screen makes.

The new words are Open here, Open beside, Remove from view, the width labels, ColliePWA, Add a pane,
New agent and New space. Until the next translate pass the other locales carry the English strings.

The pane header has no Settings gear, so the sidebar's foot holds it, beside New space; the rail
stacks the two. A flat strip always ends with an add column after the last column: at least a pane
wide (360px), and as wide as the room the last column leaves, so a scroll or a swipe to the right
always lands on it and the last column can still rest at the left edge. It is a snap point but no
column: it never takes the focus or the frame, is not counted, and the focus that follows the view
never lands on it. Its sheet lists the space's panes the strip does not show, each with Open here,
which makes it the last column and focuses it, then New agent in this space and New agent in a new
space. A book has no add column. New space and the second New agent open the New page with no space
to start in; the first tells the page which space (`?beside=`), see Known limits.

The strip snaps to column starts (`scroll-snap-type: x mandatory`, `lib/strip-snap.ts`). Touch is the
browser's momentum and snap alone. A wheel or trackpad gesture that ends between two starts settles
on the nearer one (`hooks/use-strip-snap.ts`), and Shift with a vertical wheel scrolls the strip. After
a settle the focus follows the view, as in niri: a focused column the view no longer shows whole hands
the focus to the leftmost whole column. While the layout is mounted the page takes
`overscroll-behavior-x: none` and the strip `contain`, because desktop Chrome reads a sideways
overscroll as history back; below 600px the page keeps its own behaviour. Inside a column every
scroller passes its x overscroll on (`overscroll-x-auto`, important): the transcript list is
`overscroll-contain` on both axes for the phone, and that stopped a sideways wheel inside the column,
so the strip never scrolled.

The space header is the one bar for the space. It holds the space's tabs, with the pane view's own
handlers: a tab opens its first pane, its "+" opens a new tab the way the pane's tab row does, and a
long-press on a chip offers Rename and Close tab with the same gates (a read-only device and a saved copy
get the sheet's note instead). Closing the tab that holds the focused column moves the focus to a
neighbouring tab's pane with `nav.side`, and only a space with nothing left goes up to Home. So
in a strip the pane view drops what the large screen shows elsewhere: its tab row, its pane row and
the bar that folds them (the space header and the sidebar have them), and the space's name on its
header's second line. A column header keeps the pane's branch, machine and state. Below 600px the
pane view keeps all of it.

## Known limits

- **New agent in this space is a new tab, and the New page offers no worktree there.** The add column's
  sheet has two rows. "New agent in this space" opens the New page with `?beside=<pane>`: the launch route
  already takes a pane as `paneId` and then creates a tab in that pane's space (the switcher's launch used it
  first), so no bridge change was needed. The page then stays on that pane's machine, starts in that pane's
  folder, and shows no worktree switch, since a worktree is a space of its own. The request id and the
  receipt are the route's own. A starter ignores the pane and starts its own space. The pane that comes back
  opens beside the focused column through a note in memory (`lib/open-beside.ts`): it counts only for a
  pane the space did not hold when the sheet was left, and it expires after ten minutes. A reload on the
  New page loses the note, and the pane then replaces the focus as any arrival does. "New agent in a new
  space" stays the second row.
- **Permission, ask and held cards show in the focused column only.** Another column shows a blocked
  status dot, and a tap on it focuses that column, where the card stands.
- **Every stored column of the space mounts its own reader and belt.** There is no cap beyond the 24
  stored columns, so a space with many columns carries many readers.
- **Fold postures are on by default.** They are feature-detected by the viewport-segments media queries and
  proven in emulation only (below).
- **A theme file that sets `pane-active` is written as schema version 3.** A Collie older than this
  build refuses such a file with a message.
- **Wide mode is not covered by the browser leg, and no touch hardware has run it yet.** The leg is
  phone-shaped. Large-screen layout in Settings set to Off is the way back to the phone layout.
- **Folded postures are proven in emulation only.** Chromium's device-metrics override fired the segment
  queries and the env values; no half-open Fold or Flip has run the layout.
- **Snapping is checked in Chromium and WebKit by script, not on every device.** Touch relies on the
  browser's own snap.

The switcher sheet inside the pane screen is still mounted on a large screen, closed, with no pill to
open it; the sidebar repeats its wiring. If the two drift, the sheet should take its list from the
sidebar's component.
