# 0138: An app left alone draws no frame

- **Status:** Accepted
- **Date:** 2026-11-08
- **Shipped in:** pending
- **Trail:** issue #748 (Chrome's GPU process on a Xiaomi 15 Ultra passed HyperOS's 5000-fd limit while
  Collie was on screen, and the system force-stopped Chrome), which asked for an in-app "Reduce motion"
  setting · Altan, 2026-11-08: "we should just fix it, this is half baked" · the 48 s resting drift the
  mark contract used to define · `web/src/components/mark-contract.ts` (sealed copy of collie-brand
  `src/mark-contract.ts`) · `web/src/lib/page-hidden.ts` · `web/src/App.tsx` (`data-app-covered`) ·
  `web/src/index.css` · `web/e2e/idle-repaint.spec.ts`

## Context

A running CSS animation asks the browser for a new frame on every vsync, whatever its pace. The header
mark drifted at rest, one turn in 48 seconds, on 36 endless animations, so an app nobody touched drew 60
frames a second for as long as it was open. Headless Chromium measured 600 frames in 10 s on a resting
dashboard, and 70 paints plus 600 frames on a working pane. On the reporter's phone that load churned
graphics buffers until the system killed the browser. Android's "Remove animations" stopped it at once.

The issue asked for a per-device "Reduce motion" switch. That would leave the cost on by default for
everyone who does not know to look for it.

## Decision

1. **At rest the app runs no animation.** The mark holds still in rest and idle, in the pose its drawing
   has with no animation (the reduced-motion pose). A mark that leaves a live state finishes its lap
   first. This is the mark contract's rule, so it binds every character.
2. **Nothing nobody can see animates.** A hidden page (`data-page-hidden` on `<html>`) and the app under
   the idle lock or the update screen (`data-app-covered`) pause every animation.
3. **An endless indicator moves in steps.** One that runs for as long as an agent works uses a stepped
   timing, so it asks for a frame only when it changes (the status dot: 24 steps, about 13 frames a second).
4. **No backdrop blur covers a moving part.** A layer over content that animates is solid.
5. **No "Reduce motion" setting.** `prefers-reduced-motion` still wins, as it always did.

## Consequences

- The resting mark no longer shows life on its own. The colour of each state still carries the meaning,
  as it already did under reduced motion. A host that wants the drift passes `turn` (the website does).
- A short busy moment shows as one full lap, up to 1.8 s, not as a brief speed-up.
- Live mark states (loading, reconnecting, updating) still animate SVG children at full rate. Chromium
  composites them without a paint, and they are short, so they stay. Revisit if a live state becomes
  long-lived, or if a device shows the churn while one runs.
- `web/e2e/idle-repaint.spec.ts` fails if a resting mark or a resting dashboard runs any animation, or if
  a hidden page keeps one running. A new endless animation meets the rule there, not in review.

## Amendment 2026-11-09

Altan asked for the resting drift back ("without the performance hit"), and for the update's turn to
be calmer ("maybe 2-3 times the idle"). A pose ticker, a few seeks a second, was built and rejected on
the comparison page ("bead spinners all look bad"). What replaced it came from a trace, not a guess.

**What the old drift cost.** Headless Chromium at 3x, 10 s on the resting Collie mark alone: 60 frames,
60 main-thread frames, 120 paints, 81 ms of main-thread work a second. With only the ball's texture
roll paused (`cm-roll`, a texture that turns inside a `<mask>`): 60 frames, 0 main-thread frames,
0 paints, under 1 ms a second. Every other character's drift (glass, glass-front, kawaii, kawaii-tilt,
owl, sheep) already measured 0 main-thread frames and 0 paints: Chromium runs a transform on an SVG
child on the compositor. Pixel draws about 9 frames a second, stepped. So the main-thread cost was the
roll, and only the roll.

**Rule 1 now reads: a page left alone runs no animation.**

- The resting mark drifts, smooth, as plain CSS animations, while the page is in use: a touch, a key,
  a wheel or a scroll in the last `MARK_DRIFT.windowMs` (20 s). Then its rate falls to nothing over
  `MARK_DRIFT.easeMs` (2 s) and it holds where it is (`data-still`). The next input drifts on from the
  held pose. One reading for the page, shared by every mark, one timer that re-arms only when it fires.
- At the slow paces (`data-slow`: rest, idle, applying) the textures that turn inside a mask (`cm-roll`,
  `cm-rock`, `cm-wobble`) are paused, so a slow mark asks the main thread for nothing. The live states
  keep them: they are short.
- `applying` turns at a new calm pace, one turn in 20 s, always, on the compositor. It does not wait
  for input: a person waiting for an update wants to see it move.
- `MARK_DRIFT.mode = "always"` would drift for as long as the page is open: 0 main-thread work, but
  60 compositor frames a second, which is the GPU load this ADR is about. The default is `"in-use"`
  until Altan picks on the comparison page (10 is always, 11 is in use).
- Rule 2 holds unchanged: the `data-page-hidden` and `data-app-covered` rule in `index.css` pauses the
  drift too, and `prefers-reduced-motion` stops it.
- Every state change carries the phase, so nothing jumps, and the last lap is gone. A short busy moment
  reads as a brief speed-up of the drift, not as one full lap.
- `web/e2e/idle-repaint.spec.ts` now lets the window pass on a fake clock and then asks for no running
  animation, for every character, as before.

Measured on the comparison page (two marks, 10 s each, 3x): option 11 at rest, in use, 60 frames,
0 main-thread frames, 0 paints, 0.6 ms a second; rested, 0 frames. Applying, either option, 60 frames,
0 main-thread frames, 0 paints, about 2 ms a second (no timer, no script call in the trace).

## Amendment 2026-11-13

Altan ordered the character to move at all times, "not just after activity like scrolling", and asked for
a way to turn it off in a theme and in the app. This takes the choice the 2026-11-09 amendment left open
(`MARK_DRIFT.mode`, "always" or "in use") and takes it for "always", as a default a device or a theme can
leave.

- A resting mark drifts for as long as the page is visible, with no input needed. The app passes
  `drift="always"`, a prop the contract already has, so the sealed contract is unchanged
  (`web/src/lib/mark-motion.ts`, read by `BrandMark`). A hidden page, `pagehide` and
  `prefers-reduced-motion` hold it, whatever the switch says.
- The device's switch, "Character moves", sits under the list on the Character page and is stored in
  `collie:design:v1` as `markMoves`, both values. A theme may set `characterMotion` (`moves` or `still`,
  schema version 5). The device's own touched switch wins, an untouched one follows the worn theme, and
  no key means it moves. A theme may only switch the drift off: the look of the mark never changes.
- A live state (`loading`, `applying`, `reconnected`) and `idle` are drawn as before. The idle lock, the
  tour and the thumbnails of a theme list keep the contract's own rule (`in-use`).
- **The drift is drawn in steps, so "at all times" has a bound.** The first build drew it smooth: 60 frames
  a second for as long as the page is visible, the load this ADR exists to remove. A stepped timing
  function asks for a frame only when its value changes, so `index.css` gives a drifting mark `.mark-steps`
  (put on by `lib/mark-motion.ts`) and a `steps(10)` timing between the keyframe stops of the marks (a stop
  about every 0.8 s, so 12.5 steps a second; `steps(20)` for the four marks with half the stops; pixel is
  already stepped). The rule is app CSS, important because the sealed marks set `linear` in the `animation`
  shorthand, and names no class of a mark except the puppy faces' pearl twinkle, which is 4 steps a half
  swell. Only a mark that drifts at rest carries it; a live state turns smooth, as it is short. A step is
  about 0.14 CSS px at the header's 44 px, so it reads as slow motion, not as a stutter; 12 a second needed
  no second try at 20.
- Measured on 2026-11-13, headless Chromium 151, 390x844 at 3x, the resting dashboard with the mark in view,
  10 s, 3 runs (the same harness as 2026-11-09: a trace, `DrawFrame`, `BeginMainThreadFrame`, `Paint`),
  1-minute load 3.4 to 4.2 on the machine:

  | Mark at rest | Frames | Main-thread frames | Paints |
  | --- | ---: | ---: | ---: |
  | Switch off (held) | 0 | 0 | 0 |
  | Always, smooth (first build) | 597 to 600 | 3 to 4 | 6 |
  | Always, stepped (shipped) | 126 to 127 | 3 | 6 |

  The 3 main-thread frames and 6 paints are the near/far swaps of the beads (an opacity step on SVG
  children), the same in both drives. The puppy faces (5 s, load 8 to 10, so a rough figure): smooth 300
  frames, stepped 94.
- `web/e2e/idle-repaint.spec.ts` runs a resting dashboard with the default setting and asserts at most 16
  frames a second (96 in its 6 s window), at most 10 main-thread frames and 15 paints, which the stepped
  drive meets and the smooth one fails (360 frames); with the switch off it asserts 0 / 0 / 0. Other cases
  keep the switch off (`web/e2e/fixtures/still-mark.ts`) for speed; `web/e2e/mark-moves.spec.ts` holds the
  motion itself. The switch and the theme key remain the way out for a device that cannot afford even this
  (issue #748).
