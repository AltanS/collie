# 0069 — A row glides into its header

- **Status:** Accepted
- **Date:** 2026-09-23
- **Shipped in:** pending
- **Trail:** the operator, 2026-09-23: "if we do one, we should do it right" — asked for the tap
  into the Changes screen to feel native, then asked for the same on a pane row once the first one
  landed · `web/src/lib/glide.ts` · `web/src/lib/pane-prefetch.ts` ·
  `web/e2e/changes-glide.spec.ts` · `web/e2e/pane-glide.spec.ts` · commits `1a8a60a8` (the Changes
  tab pair), `e93f5ed3` (the engine, reverse on the arrow), `c5f0d891` (the `pane` pair)

## Context

The operator asked for a tap that carries a row's own identity into the screen it opens, the way
a native app's shared-element transition does, rather than a slide that treats the two screens as
unrelated. The first cut only did this one way, forward, for one pair (the dashboard's Changes tab
row into the workspace Changes header), built as its own small module. When the operator asked for
the reverse too, and then for the same treatment on a pane row, the one-off would have become two
near-identical ad hoc transitions with their own bugs. The line the operator drew was "if we do
one, we should do it right": one engine, both directions, used everywhere a row is really the same
thing as the header it opens.

## Decision

**One engine, `web/src/lib/glide.ts`, drives every glide; a glide is a same-document view
transition started by hand, never React Router's `viewTransition` flag.** The router flag stays
off for good (`screen-transition.tsx`, `router.tsx`): the router remembers every path it has once
animated and replays a phantom transition on the next revalidation of it, which a polled screen
hits constantly. `glide.ts` instead calls `document.startViewTransition` itself, once, around one
navigation; the router never learns a transition happened, so nothing is remembered and a poll
never replays it.

**Two pairs today, both declared in `GLIDE_PAIRS`:**

- `changes` — a dashboard Changes tab row (`workspace-changes-list.tsx`) and the header of
  `/space/:id/changes` (`routes/changes.tsx`). The parts that fly: the label and the count line.
- `pane` — a pane row on the dashboard's Panes and Focus lists, or in a space, and the pane
  screen's header identity (`agent-chat.tsx`). The parts: the status dot, the agent's tile, the
  name. The host chip never flies: the row's meta cluster (host, session, cache) and the header's
  (host, cache) are not the same shape, and a chip flying alone would split whichever cluster it
  landed in.

**Forward is the tap on the origin row (`glideForward`); reverse is the in-app back arrow, and
nothing else (`glideBack`).** Both wrap the navigation itself, run inside the transition's update
callback — the "before" picture is taken the moment `startViewTransition` is called, so the DOM
must not move before then, and a mark set before `navigate()` and read on the next location change
would arrive too late, since a POP can commit before the browser's next frame. An unmarked POP —
the phone's own back, the iOS edge swipe — gets no transition at all and plays its own animation
alone, which is the boundary ADR 0067 already drew between the arrow's step-back and every other
way to leave a screen.

**The landing must be real, or the move crossfades.** On the way back the origin row is looked up
by its key in the arrived screen, after scroll memory has restored the scroller. No row, or a row
not wholly on screen — inside the viewport and inside every clipping ancestor — and the move
carries no names on the arriving side (`html.glide-crossfade`): the leaving side was already named
before the landing could be known, so an old part with no new twin simply fades out in place, with
the header around it.

**Reduced motion, or no `startViewTransition` (Safari before 18), takes plain navigation.** The
`ScreenTransition` slide, which the app already plays on every route change, stays exactly what it
was for that move — a glide is additive, never a replacement gate.

**A glide owns its move.** While one is in flight, `glideOwnsMove` reports true for the pathname it
lands on, both ways, and `ScreenTransition` reads it to keep its own slide off for that navigation.
The slide is not deleted; it is the fallback for every move a glide does not own, and it is what
plays when a glide is skipped (see below).

**Parts fly; everything else crossfades.** Each named part gets its `view-transition-name` inline
on exactly one element at a time — the leaving one until the "before" picture is taken, then the
arriving one — and every name comes off when the transition ends or is skipped. The header row and
the screen wrapper carry their own names (`glide-header`, `glide-screen`) for the transition's
life, so the rest of each screen — the mirror, the composer, the belt, the Changes list — rides
along as one crossfaded picture with no part of its own. `:root` stays unnamed, as `index.css`
requires; timing is shared by two tokens on `<html>`, `--glide-duration` (250ms) and `--glide-ease`
(ease-out), so a new pair needs no timing decision of its own.

**A glide in flight is skipped, not queued, when another navigation starts.** A second glide call,
or any location change that is not the glide's own landing, ends the transition in flight at once
(`supersede`); the navigation that interrupted it still runs, just without the motion. The overlay
takes no pointer events, so nothing under it is blocked while it plays.

**No frozen screen: a destination that waits on data is waited for before the transition starts,
never during it.** The browser paints nothing while the update callback runs, so a destination
whose route loader awaits a network read would otherwise hold the old screen on the glass for the
whole read. The `pane` pair's tap goes through `glideForwardWhenReady` instead of `glideForward`:
it starts the pane read on the row's `pointerdown` (`lib/pane-prefetch.ts`), about a tap's length
before the `click`, keyed per host/session/pane/scrollback-lines, consumed once by the loader and
fresh for 2s so a finger that rested and scrolled away never answers a later tap; the prefetch does
not mark the pane seen; the loader sends that read itself once the screen is up. The tap waits at
most `READY_WAIT_MS` (120ms) for the read to land — the most a tap may cost on top of what it cost
before the glide existed — and opens the pane the plain way, with the slide, if it is not in by
then. The `changes` pair needs no such wait: both its screens read the snapshot the root loader
already holds.

**Frames stop only for the new screen's render, not for its data.** Measured with the read already
in: the screen is frozen from the transition's start to its "ready" state for roughly 55-98ms in
Chromium and about 202ms in WebKit — render time alone, since `arrived()` resolves as soon as the
destination's landing selector appears in the DOM. Measured through the dev bridge rather than the
stub: a local pane's own read answers in about 1ms; a peer pane's, crossing the crew link, answers
in 66-530ms. A peer pane is therefore the common case that falls back to the plain slide — its read
is usually still out past `READY_WAIT_MS`.

**Adding a pair** needs: an entry in `GLIDE_PAIRS` (the parts, and the two pathname matchers); on
the origin element, `data-glide-origin="<id>"` and `data-glide-key="<key>"`, the key being the
destination's own href (`spaceChangesPath`, `panePath`) so neither screen needs shared state to
agree on it; on the destination container, `data-glide-destination="<id>"`; on each part, on both
sides, `data-glide="<part>"`; the tap wired to `glideForward` or `glideForwardWhenReady`; the back
arrow wired to `glideBack`, only where its up target is the pair's origin screen; any pair-specific
CSS under `html.glide-<id>` in `index.css`, since timing itself needs nothing pair-specific.

## Consequences

- **Peer panes often fall back to the slide**, since a crew read crossing the link is usually
  slower than `READY_WAIT_MS`. That is the tradeoff stated above, not a bug: the alternative is a
  frozen screen for however long the peer takes to answer.
- **The router learns nothing.** Because the transition is hand-started and the `viewTransition`
  flag stays off, a glide is invisible to React Router's own transition bookkeeping; a poll,
  a revalidation, or a second navigation to the same path never replays one on its own.
- **A pair costs one loader wait, at most, and only where the destination's loader awaits the
  network.** The `changes` pair pays nothing extra because its data is already in hand; a future
  pair whose destination loads fresh needs its own prefetch-on-`pointerdown` module, following
  `pane-prefetch.ts`'s shape, or it inherits the pane pair's 120ms cap unearned.
- **A part that flies must exist on both sides with the same shape**, or the browser's own
  view-transition machinery silently drops it from the animation (no error, just no motion for that
  part). The host chip is deliberately left out of both pairs for exactly this reason.
- **Revisit** if Safari's view-transition implementation misbehaves in a way Chromium's does not —
  today it is only slower, not incorrect — or if pane render time grows past the point where the
  55-202ms frozen window becomes noticeable on its own, independent of the network wait.
