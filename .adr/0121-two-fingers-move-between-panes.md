# 0121: two fingers move between panes, and text selection stays on

- **Status:** Accepted
- **Date:** 2026-10-24
- **Shipped in:** 1.24.0
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
   large screen the strip follows the URL (ADR 0120), so the gesture moves the focused column, and
   between spaces, with no code of its own there.
3. **Three methods, one device setting.** Settings > Appearance > Pane navigation, beside Large-screen
   layout: Two fingers (the default), Joystick, Off. It is stored per device with the hand, in the
   display prefs (`paneNav`), and read when a pane mounts.
   - **Two fingers.** Hold ONE finger on the reading area (the Chat stream or the terminal mirror; not
     a control inside it, the composer, the reply box, the belt or the Keys board), still, with up to
     24px of drift. A lone hold arms NOTHING, however long (below, "Text selection stays on"). The mode
     ARMS only when a SECOND finger lands while the first has been down and still for at least 300ms.
     The arm is a buzz (the haptics setting applies), the overlay, and the page held off (below). The
     second finger then swipes. A step is 40px of travel, or a flick faster than 0.4px per ms over the
     last 80ms and at least 15px long. The direction is the dominant axis, and a swipe within 40
     degrees of an axis counts its whole length; a more diagonal one counts its larger axis. One swipe
     is one step unless it travels twice the threshold. The second finger may lift and swipe again.
     **Commit:** the first finger lifts after the second has lifted, with at least one step taken.
     **Cancel, and nothing moves:** the first finger lifts with no step (a plain two-finger tap is
     this); the first finger lifts while the second is still down, mid-swipe; a third finger lands;
     a second finger lands before 300ms (a pinch, below); the first finger drifts past 24px; the
     first finger was moving faster than 0.15px per ms, or the browser took it for a scroll (an
     uncancelable `touchmove`), so the 300ms count from when it is still again, and a scroll past
     24px never arms; the hold STARTS within 24px of the left or right screen edge, the system
     back-gesture zones; `touchcancel` or a touch `pointercancel`.
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

**A lone hold arms nothing** (release counsel, 2026-10-25). The first build armed at 300ms on the hold
alone, with a buzz and the overlay, and yielded when the browser then started a selection; a person
who meant to select still saw a flash and felt a buzz first. Now a lone hold, however long, shows
nothing, buzzes nothing and prevents nothing: the browser's long-press selection and its long-press
menu are wholly intact. The arm comes only with the second finger, and a person who means to select
never puts one down.

## Held off only once the mode arms

For Two fingers from the second finger's landing (the arm), for the Joystick from its arm, to the
commit or the cancel, and nowhere else (`holdOffPage` in `hooks/use-pane-nav-gesture.ts`):

- any selection already started is cleared (`getSelection().removeAllRanges()`);
- the root takes `user-select: none`;
- `contextmenu` and `selectstart` are prevented;
- every `touchmove` is prevented, with non-passive listeners, so the page neither pinch-zooms nor
  scrolls under the mode.

The commit, the cancel, the browser's `touchcancel` and an unmount give all of it back, and the root's
own `user-select` is put back as it was.

**An armed touch never clicks.** From the arm until every finger of that touch sequence is up, even
after a cancel: the landing of each further finger and the `touchend` of each finger are prevented
(non-passive), so neither becomes a tap on what is under it, a belt pill, an Allow button or a link;
a click that still arrives within 400ms and 32px of where a finger lifted is swallowed in the capture
phase (`swallowsClick` in `lib/pane-nav-gesture.ts`); and `contextmenu` stays prevented for that
sequence only. The next touch sequence is the page's again.

**The first arm on a device shows a hint**: "Two-finger pane navigation. Hold one finger, swipe with
another. Turn it off in Settings." It stands in the floating notice group above the belt (the
composer's `floating` column, ADR 0061, DESIGN.md §11), so it moves nothing, until its x. The device
flag (`collie:pane-nav-hint:v1`, `lib/pane-nav-hint.ts`, kept at unpair) is spent at that first arm,
so a reload before the x does not show it again. The Joystick shows no hint: its handle is visible.

A lift is never lost. The touch events of a finger go to the node it landed on, and the Chat stream
can replace that node mid-touch; a detached node's `touchend` does not reach the document. So the
node is watched for the lift too, and every touch event checks the live touch list: a finger that is
gone from it cancels the gesture, so the mode never stays armed, or the page held off, with no finger
down. A touch that lands alone also clears a block left by a lost lift.

## Why a second finger within 300ms is a pinch

A pinch lands two fingers within a few tens of milliseconds. The prototype took a second finger within
150ms of the first as a "pinch-like start" and kept the hold going, so a pinch could arm the mode and
the zoom was lost. In the app any second finger before the first has been still for 300ms is a pinch:
the gesture cancels, nothing is prevented, and nothing arms again until every finger has lifted. So
pinch zoom works as it did.

## Accessibility

- **The Joystick is the single-pointer alternative** (WCAG 2.5.1, Pointer Gestures): every move Two
  fingers makes, the Joystick makes with one finger, and the switcher sheet (the Switch pill), the
  sidebar and the space header make with a tap.
- **TalkBack consumes two-finger swipes**, so with TalkBack on the gesture is expected to be inert (not tried), and the switcher
  (the Switch pill, or the sidebar on a large screen) remains the way. The overlay and the handle are
  `aria-hidden`; nothing a screen reader reaches changed.

## Consequences

Two fingers attaches four `touch*` listeners and a `pointercancel` and `contextmenu` listener to the
document while a pane screen is mounted, with `passive: false`, so the browser waits for the touch ones
before it starts a scroll from a touch. One capture `click` listener, the swallow of an armed lift's
click, is installed at the first Two fingers mount and kept for the page, because the commit remounts
the pane view before that click can arrive. At rest each returns at once. The joystick listens
on its handle only.

The joystick band costs 44px of the chrome block, and only on a device that chose Joystick.

The new strings are Pane navigation, its three options and hint, "pane {index} of {total}", and the
first-arm hint with its dismiss label (`paneNav.firstHint`, `paneNav.firstHint.dismissAria`). Until the
next translate pass the other locales carry the English strings.

## Known limits

- **Touch only.** A mouse, a trackpad and a keyboard have no gesture here; they keep the sidebar, the
  space header and the switcher.
- **The second-finger arm has run in Chromium multi-touch (CDP) only.** The Pixel check of this build
  is still to do. The earlier hold-to-arm build was tried on Android Chrome (Altan's Pixel). Not tried
  on iOS Safari, Samsung Internet or Firefox.
- **The phone-shaped browser leg cannot prove it.** The leg taps; it does not hold one finger and swipe
  another. The machine is a pure reducer with replayed pointer sequences
  (`lib/pane-nav-gesture.test.ts`), the hook has component tests with touch events
  (`components/pane-nav.test.tsx`), and one non-gating Playwright spec, `e2e/pane-nav.touch.spec.ts`,
  drives real Chromium multi-touch through CDP (`COLLIE_E2E_TOUCH=1`, Chromium phone only).
- **A selection made earlier is cleared when the mode arms.** The person chose the move by then.
- **On text, the browser's own long press may end the window.** If Chrome starts its long-press
  selection (at about 500ms) by taking the touch with a `touchcancel`, the gesture cancels there, so on
  text the second finger has to land between 300ms and that moment; on empty space the window stays
  open. Not yet checked on the Pixel.
- **A long press that already opened the browser's selection or menu** before the second finger lands
  is cleared and refused by the arm. The person put a second finger down, so the move wins.
- **A pinned pane or the activity order does not change the axes.** The sidebar can lead with pinned
  panes or run in activity order; the gesture walks the space sections in place order, as the space
  header does.
