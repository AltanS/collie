# 0082: Chat is the default view of an agent pane

- **Status:** Accepted
- **Date:** 2026-10-05
- **Shipped in:** pending
- **Relates to:** [ADR 0071](./0071-the-operator-may-ask-for-activity-order.md), whose shape (one
  standing per-device value, no per-pane override) the pane view follows. Nothing there is retracted.
- **Trail:** the 1.15.0 changelog line for Chat ("Terminal stays the default; the default flips in
  2.0", #316), which is the road this record turns away from · `web/src/lib/pane-view.ts` ·
  `web/src/hooks/use-dash-prefs.ts` · `web/src/components/agent-chat.tsx` ·
  `web/src/hooks/use-handover.ts`

## Context

1.15.0 shipped Chat behind an opt-in under Settings → Experiments, with the sentence that the default
flips in 2.0. The gate existed for two known holes on the day it shipped: Codex tool calls were not
drawn, and Hermes can lose a turn. The first closed inside 1.15.0 itself, when the journal reader
learned Codex's custom tool call. The second is still open and is a property of Hermes's own log, not
of Collie's reader ([ADR 0073](./0073-a-live-session-is-a-bounded-window-on-the-existing-poll.md),
Consequences).

On 2026-10-05 Altan decided to flip the default in 1.17.0 instead of waiting for 2.0. A session does
not need a terminal, and a gate that nobody opens only hides the screen the product is moving toward.

## Decision

**Chat is the default view of a pane that has an agent session, and the opt-in is gone.**

1. `DashPrefs.chatExperiment`, its setter and its Settings control are deleted. A stored
   `chatExperiment` is ignored on load, whatever it holds.
2. `paneView` stays the one per-device choice and defaults to `chat`. A device that chose Terminal
   keeps it. There is still no per-pane override.
3. Settings → Experiments keeps its machinery. `EXPERIMENTS` is empty, so the index row hides itself
   until the next experiment arrives.
4. A pane with no session keeps the terminal and its menu row says why, as before.
5. The handover from a shell to an agent is one sequence. The agent-start layer and the body swap used
   to run on separate clocks, so the body could change beside the animation. The layer now draws a
   phase (`covering`, `covered`, `revealing`) and the body changes only at `idle` or `covered`, which
   is under the cover. The reveal waits for the body that will show, with a cap of 1.5 seconds.

## Consequences

- The Hermes hole is now the first impression for a Hermes operator, not the price of opting in. The
  terminal is one tap away on the pane's ⋮ menu, and `docs/configure.md` names the hole under "Chat
  view".
- A device that never touched the setting moves from Terminal to Chat on update. That is the intended
  change, and the changelog says so under Changed.
- The pane-view value no longer reads as "what opting in hands you". Its default is what Collie shows.
- Revisit if a harness's journal gets a second hole of Hermes's kind, or if Chat's first paint proves
  slow enough on a crew member that Terminal should be the default there.
