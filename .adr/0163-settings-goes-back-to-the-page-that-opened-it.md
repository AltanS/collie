# 0163: Settings goes back to the page that opened it

- **Status:** Accepted (2026-11-20)
- **Date:** 2026-11-20
- **Amends in scope:** [ADR 0067](./0067-back-goes-up-one-level.md), the level tree's one parent for `/settings`
  (the Dashboard) and the "two dashboards" consequence that came with it.
- **Trail:** The operator's report of 2026-11-20 and his yes for every device, the phone included: Settings
  opened from a session, a Space, Crew, the Hill, New or Conversations, then its back arrow, landed on the
  Dashboard, while the browser's Back returned to the page. Roads turned down: keep the Dashboard as the
  only parent and accept "two dashboards" (the road ADR 0067 took), a `from` that Settings stores for
  itself outside `history.state`, and a second Settings arrow that always pops. Files:
  `web/src/lib/nav.ts` (`ancestorsOf`), `web/src/hooks/use-nav.ts` (`useNav`),
  `web/src/routes/settings.tsx`, `web/src/lib/nav.test.ts`, `web/src/hooks/use-nav.test.tsx`,
  `web/e2e/back-goes-up.spec.ts`

## Context

[ADR 0067](./0067-back-goes-up-one-level.md) rule 3 says an up steps back only when the entry behind is a
legitimate parent, and replaces onto the structural parent otherwise. The level tree gave `/settings` one
parent, the Dashboard. A Settings opened from anywhere else therefore failed the test, and its arrow
replaced the entry with the Dashboard. ADR 0067 named that as a cost ("the stack may hold two dashboards")
and called it rare.

It was not rare enough. The arrow and the browser's Back disagreed for every origin but the Dashboard:
Back returned to the page, the arrow went to a Dashboard the person had not been on. Rule 3 also promises
that the arrow and the swipe land on the same screen, and here they did not.

## Decision

**The parents of `/settings` are the screens that can open it, and the arrow steps back onto whichever did.**

- `ancestorsOf("/settings")` lists the Dashboard, any Space, any pane, Crew, the Hill, the New page and
  Conversations. Today the gear opens Settings from the Dashboard, from a Space and, on a large screen,
  from the sidebar beside a pane. The other four are listed because a screen there may open it and
  because a stale `from` naming one must still be a step up, not a push.
- **The arrow is unchanged.** It is still `nav.up(homePath(scope))`: a step back when `from` is a parent,
  a replace onto the Dashboard otherwise. With no `from` (a cold open) or with the router on its first
  entry, it goes to the Dashboard as before. Nothing is stored outside `history.state`.
- **A section round trip keeps the opener.** A section page is opened down from Settings, so its arrow
  steps back onto the Settings entry, and that entry still holds its own `from`. A section reached with no
  Settings behind it (the update ribbon on a pane opens Updates) is replaced by Settings, and `useNav`
  carries the section's `from` over because the opener is now a parent of Settings.
- **The browser's Back and the phone's back gesture are history pops.** The app maps them to nothing, so
  they already landed on the opener (ADR 0067 rule 6). After this record the arrow does too.
- A cold deep link to `/settings` is seeded with the Dashboard behind it (ADR 0067 rule 4, `parentChain`),
  which this record leaves as it was.

## Consequences

- **Settings is forward of the page it was opened from,** so after the arrow the next back goes up from
  that page, not into Settings. The "two dashboards" stack of ADR 0067 can still arise only from a Settings
  whose entry behind is not an opener (a section, a pane's history), and then it is a replace as before.
- **Crew, the Hill, New and Conversations show no gear today.** If one gains it, nothing else changes.
- **Revisit** if a screen that is not a legitimate parent of Settings gains a way into it; the arrow would
  then replace onto the Dashboard, and that screen belongs in this list.
