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
be calmer ("maybe 2-3 times the idle"). Rule 1 now reads: **at rest no animation runs.** The mark's
animations are still there in `rest` and `applying`, but paused (`data-ticked`), and one ticker per
page seeks them forward `MARK_POSES.perSecond` times a second (the mark contract, sealed from
collie-brand). The browser draws that many frames, not 60: 4 a second until Altan picks the rate on
the comparison page. `applying` turns at a new calm pace, one turn in 20 s, in poses too. `idle` holds
the pose it is in.

- The ticker is one timer, never a `requestAnimationFrame` loop, and it stops on rule 2's own terms:
  it reads `data-page-hidden` and `data-app-covered` (the contract's `MARK_HOLD`, pinned against
  `index.css` by `mark-ticker.test.ts`), the document's visibility and `prefers-reduced-motion`.
- The last lap is gone: every state change carries the phase, so nothing jumps. A short busy moment
  now reads as a brief speed-up of the drift, not as one full lap.
- Rule 4 holds with a smaller cost: a blur over the header mark would redraw a few times a second.
- `loading` and `reconnected` stay running animations at the live pace, as the consequences above say.
