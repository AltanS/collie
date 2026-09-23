# 0068 — The dashboard's second tab is Focus, not Attention

- **Status:** Accepted
- **Date:** 2026-09-23
- **Shipped in:** pending
- **Amends:** [ADR 0066](./0066-the-dashboard-has-a-footer-panes-needs-you-changes.md), in scope. The
  footer, the filter, the corner mark's count/dot/nothing rule, the Changes tab and the per-device
  storage all stand. Only the second tab's name and icon change.
- **Trail:** the playground's `attention-icon` round, twelve numbered icons judged against the
  shipped `TabBar` at 375px (commit e6c408eb), option 10 (`CircleDot`) picked over option 12
  (`BellRing`, the icon ADR 0066 shipped) · `home.tabs.attention` → `home.tabs.focus` in all seven
  catalogs · `web/src/routes/home.tsx` · `web/src/lib/dash-view.ts` (`DashView`, `coerceDashView`) ·
  `web/src/hooks/use-dash-prefs.ts` (`dashView`)

## Context

ADR 0066 named the tab Attention and gave it `BellRing`. A bell that rings reads as a notification —
something just happened, look now — even in the tab's quiet state, where the only mark is a small
dot for a finished pane nobody has opened yet. The icon oversold the calm case, and it doubled up on
the red badge: a bell wearing a red count reads as two alerts stacked on each other.

The `attention-icon` playground round drew twelve candidates against the real `TabBar` at its
shipped size, in all three states the tab actually reaches: selected with the red count, unselected
with the red count, and unselected with only the quiet dot.

## Decision

**The tab is renamed Focus, and it wears `CircleDot`.**

1. **Focus, not Attention.** Attention still read as a demand — the same fault "Needs you" had, one
   layer up: a word that claims something always needs it, when the tab is just as often the quiet
   dot or nothing at all. Focus names where you look first, not what it is owed. The red count still
   marks the urgent case; the dot still marks unseen finished work; the word above them no longer
   argues with whichever one is showing, or with neither.
2. **`CircleDot` over `BellRing`.** A ringing bell reads as a notification inbox at rest, and doubly
   so once a badge sits on it. `CircleDot` reads as a place, a point you look at, in both marked
   states: the red count sits on it as something waiting there, and the quiet dot sits beside a mark
   that already looks like one, not like a second bell on top of a bell.
3. **The stored preference stays readable across the rename.** `dashView` in `collie:dash-prefs:v1`
   already stored the tab as `"needs"`, from before ADR 0066 renamed the on-screen label to Attention
   without renaming the stored value. `coerceDashView` now reads `"needs"` — and, in case any build
   ever wrote the label instead of the internal name, `"attention"` too — as `"focus"`. Only
   `"focus"` is ever written from here on.

## Consequences

- **Nothing else in ADR 0066 changes.** The filter (a workspace keeps only its urgent panes, order
  untouched, drops when empty), the corner mark's count/dot/nothing rule, the Changes tab and its
  5-second refresh, and the per-device storage are all untouched.
- **A pre-rename device keeps its chosen tab.** A stored `"needs"` (or a stray `"attention"`) opens
  Focus on the next load, not the Panes default.
- **The playground's `attention-icon` section keeps all twelve rows for the record**, option 10
  marked picked and option 12 (`BellRing`) marked as the icon it replaces.
