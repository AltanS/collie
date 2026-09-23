# 0064 — An update puts the phone in update mode: a locked app, a docked panel, seven steps, and a panel that never moves

- **Status:** Accepted
- **Date:** 2026-09-23
- **Amends:** [ADR 0044](./0044-the-update-screen-is-one-reducer-and-one-shared-poll.md), in scope. Its
  one reducer and one shared poll stand. What changes is what the reducer says: the end of a run,
  the phone's own step, and where the confirm lives.
- **Shipped in:** pending
- **Trail:** the four drawn options of 2026-09-23 (checklist, machine cards, focus, and "Locked app,
  docked panel", the one chosen) · ADR 0044's own rule "the end is announced by the toast, not by a
  panel the operator has to close" · the card's inline confirm (M20/07) · `lib/pwa.ts`'s reload on
  every controller swap · `web/src/lib/update-screen.ts` · `web/src/hooks/use-update-screen.ts` ·
  `web/src/components/update-screen.tsx` · `web/src/lib/update-ask.ts` ·
  `web/src/lib/update-ribbon.ts` (the claim) · `web/src/lib/pwa.ts` · `DESIGN.md` §6

## Context

A study of the update screen on 2026-09-23, after the 1.12.0 crew run (ADR 0062), found five faults.

1. **The sheet closed while the members still waited.** The reducer answered `hidden` once the lead's
   own record said `done`, whatever its members were doing, and fired "Crew updated" over them. The
   lead's run is not the update.
2. **Every row spun.** A row was `moving` whenever it was not settled, so a member waiting its turn
   spun beside the one that was working. The queue moves one machine at a time and the screen said
   the opposite.
3. **No step, no clock, no target.** The operator could not tell how far along the run was, for how
   long, or to which version.
4. **The claim died with the page.** "This device started it" was a module variable. The phone's own
   reload is part of an update, so the document that came back had no claim and showed nothing. And
   the done toast repeated on every load for ten minutes, because every load is a new document.
5. **The confirm moved the card.** It grew inside the Updates card, about 100px, under a thumb already
   on its way.

Altan was shown four ways to put the app under an update and chose option 4: the app stays in view
behind a veil and takes no tap, an amber band at the top says "Update mode · step N of 7" with a
clock and doubles as the progress bar, and a panel docked at the bottom walks seven steps (Check,
Build, Restart, Verify, Other machines, This phone, Done) with one row per machine and one for this
phone. Stepping the drawn option, he found a layout shift between "Members, one unreachable" and
"Phone downloading": the subtitle changed its line count and a row traded a second line of text for
a progress bar. His rule for the build: nothing in the panel moves between any two states.

## Decision

**A run this device started puts the phone in update mode, and the mode ends only on one of its
three end screens, each with "Back to the app".**

1. **Seven steps, and the lead's `done` is step 5, not the end.** The members are step 5 while one
   of them still moves; this phone is step 6; Done is step 7. The two other ends are Rolled back and
   Stuck (a run that stopped before it finished reads as Stuck's sibling). None of them ends on a
   toast. The done toast is gone; so is the ten-minute window that made it repeat.
2. **This phone reloads once, last.** While machines still move, update mode holds the reload guard
   (`UPDATE_MODE_HOLD`). While it is held, `lib/pwa.ts` does not run its 60 s worker check, and a
   controller swap (from another tab, say) is stamped at once but reloads only when the last hold
   clears. On step 6 the hold is released and the mode asks for the new app itself, once. This also
   stops a swap from eating a composer draft, which the old immediate reload did.
3. **The claim survives the reload.** `lib/update-ribbon.ts` keeps `{ startedAt, runId, target,
   peersOnly, bundleAtStart, skipped, lead, members, lastPhase }` in `sessionStorage` (this tab only)
   and reads it when the module loads, before React renders. A document that boots holding a claim
   opens the panel before its first read answers, on the step it last showed, with the rows it
   started with. A document running a different bundle than the one that tapped has reloaded onto the
   new app: that is how step 6 knows it is done. A claim older than three hours is thrown away.
4. **Only the active row animates.** A row has one of seven statuses: `active` (the one spinner),
   `queued` (still, dimmed), `offline` (the lead in its restart), `ok`, `failed`, `attention` and
   `skipped`. Motion honours `prefers-reduced-motion`.
5. **A member that needs you is asked about, once.** A member quiet for `PEER_UNREACHABLE_MS`, or
   waiting out its hourly limit (ADR 0062, "rate-limited, retries by HH:MM" in the row's detail slot),
   gets "Skip <name>" and "Keep trying" on the device that started the run. Skipping is a decision
   about the screen, not the run: the lead keeps trying, the mode stops waiting, and Done names the
   member and offers "Try <name> again". "Use the app anyway" appears only after a stall.
6. **The confirm is the mode's first screen.** The card's button ("Update all machines to X", or
   "Try <name> again" for one member) opens "Ready to start", and "Start update" there sends the
   `POST /api/update`. The card grows nothing.
7. **A device that did not start the run keeps its app.** It gets one line in the band above the
   header, "Update running, started on another device. <step>.", and "View" opens the same panel
   read-only.
8. **Nothing in the panel moves between two states.** Every box has a stated height: a one-line
   heading, a subtitle box that always holds two lines and clamps to two, rows of 52px each with a
   reserved line under the first, a note of two lines plus one 44px action row, and a footer of two
   44px rows. The panel's height is a function of the machine count only. The row count is the same
   in every state, "Ready to start" included, because the rows are the lead, the census and this
   phone from the first screen on. `e2e/update-screen.spec.ts` walks every state at 375x812 in
   Chromium and WebKit and holds each box to half a pixel of the first screen.

## Consequences

- **The phone is locked for longer.** Up to the end of step 6 rather than the lead's own `done`, and
  on a rate-limited member up to about 80 minutes (ADR 0062). The way out is "Skip <name>" for a
  member and "Use the app anyway" after a stall; neither cancels anything.
- **A swap deferred by a hold runs the old bundle under the new worker** until the hold clears. The
  new worker has already swept the old precache, so a lazily loaded chunk of the old bundle could
  fail in that window. Update mode avoids the window by not looking for a worker while it holds;
  a composer draft can still open it, which is the lesser fault than the reload that ate the draft.
  `sw.ts` keeps `skipWaiting()` on install: making the page decide when a waiting worker activates
  would change every install, not only an update's, and wants its own rehearsal.
- **"Started on another device" does not name the device.** The run record does not say who
  started it. Naming it needs the bridge to keep the starting device's pairing label with the run,
  which is its own change.
- **The panel's fixed heights are a second DESIGN.md §6 reservation.** Every occupant states its own
  box (truncate, clamp, fixed buttons), so nothing can grow, and the sizes were designed around, not
  measured. A longer translation clamps; it never pushes.
- **Revisit** if a crew grows past six machines as a common case: the rows scroll inside their box
  past six, which keeps the panel still but hides a row. The answer then is a different panel, not a
  taller one.
