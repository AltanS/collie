# 0121: two fingers move between panes, and text selection stays on

- **Status:** Proposed
- **Date:** 2026-10-24
- **Shipped in:** pending
- **Trail:** M70 spec 03 · the playground's "Large screens" cards 5 and 6 and the "Pane navigation"
  card (`web/src/playground/sections/wide-layout*.ts(x)` on the prototype branch `feat/wide-layout`) ·
  `web/src/lib/pane-nav-gesture.ts` · `web/src/hooks/use-pane-nav-gesture.ts` ·
  `web/src/hooks/use-pane-nav-map.ts` · `web/src/components/pane-nav.tsx` ·
  `web/src/components/pane-nav-overlay.tsx` · `web/src/components/pane-nav-control.tsx` ·
  [ADR 0067](./0067-back-goes-up-one-level.md) ·
  [ADR 0120](./0120-on-a-large-screen-the-pane-screen-is-a-strip.md)

## Context

On a phone the only way to another pane is the switcher sheet: a pull or a tap on the Switch pill, a
look down a list, a tap on a row. ADR 0120 gave a large screen a sidebar and a space header, and it
deferred the phone gestures. Altan tried three of them in the playground on 2026-10-24 (a swipe on the
header, a two-finger chord and a thumb joystick) and picked the chord as the default and the joystick
as the alternative.

The reading area is where a person reads, scrolls, selects text to copy, and pinches to zoom. A
gesture that lives there must not take any of that away at rest.

## Decision

1. **The axes are niri's.** Left and right are the previous and next pane in the current space, in the
   switcher's and the sidebar's order (`spacesInOrder`, moved to `lib/wide-layout.ts` so the space
   header and the gesture share one order). Up and down are the previous and next space, in the order of
   the sidebar's space sections. A move into another space lands where the space header's up and down
   land (`landingOf`). The ends clamp: there is no wrap.
2. **A commit is `nav.side` to the target pane**, exactly as the space header's up and down are. On a
   large screen the strip follows the URL (ADR 0120), so the gesture moves the focus between columns
   and spaces with no code of its own there.
3. **Three methods, one device setting.** Settings > Appearance > Pane navigation, beside Large-screen
   layout: Two fingers (the default), Joystick, Off. It is stored per device with the hand, in the
   display prefs (`paneNav`), and read when a pane mounts.
   - **Two fingers.** Hold ONE finger on the reading area (the Chat stream or the terminal mirror; not
     a control inside it, the composer, the reply box, the belt or the Keys board) for 300ms, with up
     to 24px of drift. That arms the mode: a buzz (the haptics setting applies) and the overlay, and
     nothing else yet (below, "Text selection stays on"). A SECOND finger then swipes. A step is 40px of travel, or a flick faster than 0.4px per ms over the
     last 80ms and at least 15px long. The direction is the dominant axis, and a swipe within 40
     degrees of an axis counts its whole length. One swipe is one step unless it travels twice the
     threshold. The second finger may lift and swipe again. Lifting the FIRST finger commits after a
     step, or cancels with none.
   - **Joystick.** A 44px band just above the belt holds a short bar. Hold it 400ms (the shared hold
     look shows from 150ms) and the SAME finger drags: 48px a step, coming back reverses, the release
     commits, a release back at the start cancels. A quick drag up without the hold opens the
     switcher sheet, as the Switch pill's drag does. A tap does nothing.
   - **Off.** No gesture and no handle.
4. **The overlay shows only while the mode is armed.** At the top, the target pane's name, large, in
   the app face, with its status mark, and under it its space, its machine on a crew, and "pane i of
   n". Under that the map: every space a row and every pane a cell with its status mark, the target
   marked. Where the second finger first landed (for the joystick, above the handle) a fixed pad of four
   arrows: the last step's arrow filled in `--primary`, the others outlined and muted, a short pulse on
   each step and none under reduced motion. The pad carries no names and no status. The overlay is a
   floating layer (DESIGN.md §1 and §11): portalled, fixed, `z-40`, no pointer, `aria-hidden`.
5. **The gesture is an extra.** The switcher sheet, the sidebar and the space header's buttons stay the
   accessible way, and nothing a screen reader reaches changed. The handle is `aria-hidden`.

## Text selection stays on

The prototype turned text selection, the long-press menu and double-tap zoom off on the whole pane
body, always, because Android's own long-press selection starts at about the time the hold arms. In the
app that would cost copy by long press in the Chat and the mirror, which is a normal way to work.
Altan decided on 2026-10-24 to keep selection on, and restated it after review: the long press that
starts a selection must keep working. So nothing changes at rest: the reading area keeps its
`touch-action`, and a touch that never arms is left wholly to the browser.

The arm itself does not hold the page off either. The 300ms arm comes before the browser's own long
press (about 400 to 500ms), so a person who means to select would lose the selection to the arm. So
Two fingers arms in two steps:

1. **Ready.** The hold ends: the buzz and the overlay, and nothing else. The selection, the root's
   `user-select`, the long-press menu and the first finger's scroll stay the page's. If the browser now
   starts a selection (`selectstart`), opens its long-press menu (`contextmenu`), or takes the finger
   for a scroll (a `touchmove` it no longer lets a listener cancel), the gesture cancels and the
   browser wins. Neither event is prevented. The rest of that touch sequence is the browser's.
2. **Held off.** The second finger lands. Only now is the page held off (next section).

The Joystick's handle is `touch-none` and holds no text, so the Joystick holds the page off at its
arm.

## Held off only once the second finger lands

For Two fingers from the second finger's landing, for the Joystick from its arm, to the commit or the
cancel, and nowhere else (`holdOffPage` in `hooks/use-pane-nav-gesture.ts`):

- the selection is cleared (`getSelection().removeAllRanges()`);
- the root takes `user-select: none`;
- `contextmenu` and `selectstart` are prevented;
- every `touchmove` is prevented, with non-passive listeners, so the page neither pinch-zooms nor
  scrolls under the mode. This holds off one more case than the spec named (multi-touch moves only):
  a scroll that starts under the held finger would make the next moves uncancelable, and then a
  second finger could zoom the page after all;
- a second finger's `touchstart` and the first finger's `touchend` are prevented, so neither becomes
  a tap.

The commit, the cancel, the browser's `touchcancel` and an unmount give all of it back, and the root's
own `user-select` is put back as it was.

A lift is never lost. The touch events of a finger go to the node it landed on, and the Chat stream
can replace that node mid-touch; a detached node's `touchend` does not reach the document. So the
node is watched for the lift too, and every touch event checks the live touch list: a finger that is
gone from it cancels the gesture, so the mode never stays armed, or the page held off, with no finger
down. A touch that lands alone also clears a block left by a lost lift.

## Why a second finger within 300ms is a pinch

A pinch lands two fingers within a few tens of milliseconds. The prototype took a second finger within
150ms of the first as a "pinch-like start" and kept the hold going, so a pinch could arm the mode and
the zoom was lost. In the app the hold is 300ms, and any second finger before the arm is a pinch: the
gesture cancels, nothing is prevented, and nothing arms again until every finger has lifted. So pinch
zoom works as it did.

## Consequences

Two fingers attaches four `touch*` listeners to the document while a pane screen is mounted, with
`passive: false`, so the browser waits for them before it starts a scroll from a touch. At rest each
returns at once. The joystick listens on its handle only.

The joystick band costs 44px of the chrome block, and only on a device that chose Joystick.

The new strings are Pane navigation, its three options and hint, and "pane {index} of {total}". Until
the next translate pass the other locales carry the English strings.

## Known limits

- **Touch only.** A mouse, a trackpad and a keyboard have no gesture here; they keep the sidebar, the
  space header and the switcher.
- **The phone-shaped browser leg cannot prove it.** The leg taps; it does not hold one finger and swipe
  another. The machines and the hook have unit and component tests with touch events.
- **A long press to select still buzzes and shows the overlay first.** The arm comes at 300ms and the
  browser's selection at about 400 to 500ms, so for that moment the overlay shows; then the selection
  starts and the overlay leaves. The trade is a short flash for selection kept.
- **The yield relies on the browser's events.** It needs `selectstart` or `contextmenu` at the start
  of a long-press selection, or an uncancelable `touchmove` at the start of a scroll. Chrome on Android
  sends them; WebKit on iOS is untested on a device, and no iPhone has run it.
- **A selection made earlier is cleared when the second finger lands.** The person chose the move by
  then.
- **No touch hardware has run the app's build yet.** Altan chose from the playground prototype; the
  app's own build is checked by its tests only.
- **A pinned pane or the activity order does not change the axes.** The sidebar can lead with pinned
  panes or run in activity order; the gesture walks the space sections in place order, as the space
  header does.
