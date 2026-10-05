# 0071 — The operator may ask for activity order

- **Status:** Accepted
- **Amends:** [ADR 0063](./0063-a-pane-keeps-its-place-when-its-state-changes.md), which reserved
  exactly this case. ADR 0063 stands in full; this ADR walks through the one door it left open, and
  narrows it on the way.
- **Date:** 2026-09-30
- **Shipped in:** 1.15.0
- **Trail:** `web/src/lib/pane-order.ts` · `web/src/components/pane-order-toggle.tsx` ·
  `web/src/components/pane-order-control.tsx` · `web/src/components/agent-sidebar.tsx` ·
  `web/src/hooks/use-dash-prefs.ts` · `web/src/hooks/use-frozen-ranks.ts` ·
  `web/src/components/agent-list.tsx` · DESIGN.md §2

## Context

ADR 0063 took status out of every list, because a row that moves while its state changes is a row
the thumb misses, and on the pane switcher a wrong tap opens another terminal. It closed with one
sentence naming what would be allowed to reopen it:

> **Revisit only with a surface that sorts by urgency on the operator's own request**, a toggle the
> operator taps and watches. A list that re-sorts itself on a poll is the fault this closes.

The request that arrived is adjacent to that sentence and not identical to it. The operator asked the
pane switcher for an order by ACTIVITY, not by urgency, and asked for it as a standing setting rather
than a per-visit toggle. Two things had to be decided rather than assumed.

**Activity is not urgency.** Urgency asks "does a human have to act here", and ADR 0063 point 3 keeps
it a mark: the row's alarm edge, the heading's dot, and one summary line on top. Activity asks "when
did anything last happen here", which is the question you have when you want the pane you were just
in, or the one that finished while you were reading another. It is a different question with a
different answer, and the switcher is where it is asked, because that sheet exists to get you
somewhere else.

**A standing setting sounds like the fault, and is not, if the reading is frozen.** "Until I change
it" describes how long the CHOICE lasts. It says nothing about how often the list re-reads the clock.
Those are two decisions, and collapsing them is what would have re-opened ADR 0063: an order that is
permanent AND re-read on every poll is a list that re-sorts itself under a moving thumb, which is the
exact incident ADR 0063 documents.

## Decision

**The operator may ask a pane list to run by activity. Place stays the default, and the list reads
the clock once per opening, never on a poll.**

1. **Place is the default, and nothing chooses activity for anybody.** The stored value is coerced to
   `place` for anything unrecognised, so an install that has never been told otherwise is
   byte-identical to before. Every existing order test passes unchanged, which is the proof.
2. **One value, two places to change it.** The switcher's own toggle and Settings → Appearance write
   the same per-device preference (`DashPrefs.paneOrder`). A person who taps it inside a pane can
   find it again where settings live, and there is no second copy to drift.
3. **The reading is frozen while the list is on screen.** `activityRanks` takes one reading of
   `max(lastActiveAt, lastSeenAt)` when the list opens; `inRankOrder` draws from that reading until
   the operator taps the toggle. A pane that finishes a turn while the sheet is up repaints where it
   stands. The sheet unmounts on close, so the next opening is a fresh reading by construction.
4. **A pane that appears after the reading ranks LAST, never first.** It is genuinely the newest, and
   the top is exactly where it must not go: every row already drawn would shift down by one. It
   keeps place order among the other unknowns, so it is still reachable.
5. **Activity reads the later of the two clocks.** The agent's last status transition and the last
   time the operator opened or drove the pane. The ledger already reads them that way
   (`bridge/activity.ts` prunes on the same `Math.max`), and it is the only reading that works for a
   bare shell, which has no agent and therefore no transitions.
6. **Activity order is ONE list.** The workspace sections and the Shells fold give way together, so
   a shell used a minute ago can outrank an agent nobody has opened all day. A workspace heading
   cannot answer the question activity order asks.
7. **A pin still outranks the sort.** Pinned leads the sheet in both orders (ADR 0070). The pin says
   which group; the order says how the rows inside it run.
8. **Nothing else in ADR 0063 moves.** The bridge still sends place order, every other surface still
   recomputes it, urgency is still a mark with one place to go, and no list sorts by status at all.

## Cache order

Cache is the third order, and it asks a question with a deadline in it: "which of these am I about to
pay to rebuild". A prompt cache expires on its own clock whether or not anyone is looking, so the pane
to go to next is often neither the one just left nor the one shouting. Every rule above holds for it
unchanged. Place is still the default, the reading is still frozen while the list is on screen, a
window ticking down cannot pull a row out from under a thumb, and a pin still leads. It ranks by the
soonest `expiresAt`. A pane with nothing left to lose ranks last, in place order: no reading, an
`unknown` one, a reading already `cold`, one with no expiry, or an expiry more than `COLD_GRACE_MS`
past, the same edge the chip reads, so a row and its own chip never disagree. The heading reads
"Going cold first".

## Consequences

- **Activity order degrades to place order rather than to noise.** A bridge older than the one that
  added the two timestamps sends neither, every pane reads `0`, and the whole herd stays in the
  order the multiplexer has it in.
- **In activity order the Shells fold is gone**, and its long tail is not missed: the thirty stale
  shells it protected against are precisely what sinks to the bottom once the newest rows lead.
- **An operator in activity order can see a list that is a few seconds stale.** That is the price of
  point 3, and it is the right way round: a stale row you tap is the row you meant, and a fresh row
  that arrived under your thumb is not.
- **A second surface may take the setting later** (the dashboard is the obvious one) without a new
  decision, because the preference is global and the ordering module is not the switcher's. The
  dashboard took it in 1.17.0, below.

## Revisit

- **If a list ever re-sorts itself on a poll**, in either order. That is ADR 0063's fault and this
  ADR does not license it.
- If activity turns out to be the order most operators want on arrival. The default is a decision
  about newcomers, not a statement that place is better, and it can be re-taken on evidence.

## The dashboard takes the setting (1.17.0)

The consequence above named the dashboard as the obvious second surface, and it needs no new decision
beyond the three rules below. `AgentList` reads the same `DashPrefs.paneOrder` the switcher and
Settings write, and Place is the dashboard as it was, byte for byte.

1. **Activity and Cache are ONE flat list under one heading** ("Newest first", "Going cold first"),
   as on the switcher. The workspace headings and the per-heading "+" are absent in the ranked modes,
   because a rank crosses every workspace and a heading cannot answer a question asked across all of
   them. The workspace strip stays, chips and all. Pinned still leads and is ranked inside itself
   (point 7). Each row names its workspace on line 2 (`space > tab`), the way the switcher's row
   does, since no heading above it does. Bare shells are ranked in the same list, as in point 6.
2. **The filters run first and never sort.** Focus, isolate, hide and hidden machines decide WHICH
   rows are shown, and the ranking then orders what is left. The reading is taken over the whole herd,
   so a filter changing never needs a new reading.
3. **The freeze is one hook for both surfaces** (`useFrozenRanks`). On the dashboard the clock is read
   on mount, when the order changes, when the operator taps the segment already selected, and when
   the document becomes visible again, because a dashboard left in a background tab is stale by hours
   and returning to it is opening it again. It is never read on a poll. A pane the reading does not
   know ranks last (point 4). A reading taken over an empty herd is no reading, so the first poll
   that brings panes takes the first one. The switcher gained the tap-on-the-selected-segment reread
   from the same hook.

The toggle is the compact one, in the top controls row beside the status summary, drawn on Panes and
Focus. The Changes tab orders nothing, so it draws no toggle, and the row keeps its height so a tab
switch moves neither the strip nor that row. The summary line's tap, in a ranked order,
jumps to the first urgent row in display order. Nothing here changes ADR 0063: no list is ordered by
status, and urgency is still a mark with one place to go.
