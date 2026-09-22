# 0059 — A card docks above the belt

- **Status:** Accepted
- **Date:** 2026-09-22
- **Shipped in:** pending (target 1.12.0)
- **Trail:** `web/src/components/card-dock.tsx` · `web/src/components/ansi-output.tsx` ·
  `web/src/components/agent-chat.tsx` · `web/src/hooks/use-auto-scroll.ts` ·
  [ADR 0053](./0053-an-unread-dialog-still-has-a-way-out.md) ·
  [ADR 0056](./0056-a-card-can-be-put-down.md)

## Context

A lifted card (prompt-select, wizard, preview-select, multi-select, generic menu, unread-dialog,
and the completion popup) rendered inside `AnsiOutput`, directly after the mirror's `<pre>`, and so
inside `ChatMessageList`, the scroller that follows the tail. Its bottom edge was therefore a
function of three things the operator does not control: how much text stood above it, how many
trailing rows the screen carried, and where the scroller happened to be. On a short screen the
card floated mid-page. Altan: "the modals we're overtaking with are not always in the same spot at
the bottom, they start at different positions from bottom, this needs to be consistent."

## Decision

**Every lifted card renders in one slot: a dock in the pane view's column, below the mirror's
scroller and directly above the chrome block that holds the actions belt. It is outside every
scroller. Every card kind on every harness shares the same bottom edge.**

1. **One slot.** `CardDock` (`card-dock.tsx`) is a sibling of the mirror wrapper in
   `agent-chat.tsx`, between it and the bottom region. `AnsiOutput` draws raw blocks only and never
   a card. The dock sits outside zen's `Collapse` for the bottom region: the card is the pane's own
   dialog, not Collie's chrome, and zen hides only chrome.
2. **One build.** `AgentChat` builds the blocks once per `display` with `buildBlocks` and passes
   the same array to `AnsiOutput` (new `blocks` prop), to `CardDock`, and to the composer lock
   (`dialogPresent`, `dialogUnread`). That lock used to call the adapter a second time. The kinds
   are identical, because `buildBlocks` runs the unread-dialog post-pass itself and its
   native-mirror pass touches raw blocks only. `AnsiOutput` still builds its own blocks when no
   array is passed, for a standalone mirror.
3. **The card instance survives polls.** The dock renders its wrapper only while a card exists, and
   the card is one conditional element at a fixed position inside it, the same shape it had inside
   `AnsiOutput`. So ADR 0056's Terminal choice still lasts exactly as long as the dialog.
4. **Height.** The dock caps at `55dvh`, or `40dvh` with the soft keyboard up, and scrolls inside
   (`overflow-y-auto overscroll-contain`). A tall card (the `/model` mirror, a long `/resume` list,
   an unread-dialog card carrying the whole pane) never pushes the composer off the screen. The
   mirror keeps its own scroller. A card arriving or leaving resizes that scroller, and
   `useAutoScroll` re-pins the tail when it was following.
5. **Look.** The card keeps its `PromptPanel` chrome. The dock is `px-3 pt-2 pb-2` on the page
   background, with one uniform 1px top rule (`border-t border-border`): a docked sheet, not a
   second card. It carries the mirror's chosen face and its "tap to type" handler, so a tap on the
   card's terminal rows still focuses the composer, as it did inside the mirror.
6. **Nothing when there is no card.** No padding, no rule, no empty box.

## Consequences

- **Nothing comes between the card and the belt.** The agent's statusline strip and the agents
  footer both need a live input box with a statusline under it, and a card means there is none.
  The Keys, Quick and Display drawers open inside the composer, below the card.
- **Find still searches the mirror only.** A card's rows were never searchable text, and the dock
  does not change that.
- **ADR 0056 is amended in one place.** It says the instance survives because `ansi-output.tsx`
  renders the card at a fixed position. That position is now in `card-dock.tsx`; the reasoning is
  unchanged. `agent-chat.test.tsx` pins the survival across a poll.
- **A tall card now takes up to half the screen from the mirror**, where before it scrolled away
  with the text. That is the trade: the card is the thing the operator must answer, and the mirror
  above it still scrolls.
- **Revisit** if a card kind needs to stay in the text flow (a presentational block that belongs
  to the transcript, not to the screen's tail), or if the 55dvh cap proves too tall on a landscape
  phone.
