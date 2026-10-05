# 0082: Chat is the default view of an agent pane

- **Status:** Accepted
- **Date:** 2026-10-05
- **Shipped in:** pending
- **Relates to:** [ADR 0071](./0071-the-operator-may-ask-for-activity-order.md), whose shape (one
  standing per-device value, no per-pane override) the pane view follows. Nothing there is retracted.
- **Trail:** the 1.15.0 changelog line for Chat ("Terminal stays the default; the default flips in
  2.0", #316), which is the road this record turns away from · `web/src/lib/pane-view.ts` ·
  `web/src/hooks/use-dash-prefs.ts` · `web/src/components/agent-chat.tsx` ·
  `web/src/hooks/use-handover.ts` · `web/src/lib/chat-gate.ts` · `web/src/hooks/use-pane-start.ts`

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

**Chat is the default view of an agent pane, and the opt-in is gone.**

1. `DashPrefs.chatExperiment`, its setter and its Settings control are deleted. A stored
   `chatExperiment` is ignored on load, whatever it holds.
2. `paneView` stays the one per-device choice and defaults to `chat`. A device that chose Terminal
   keeps it. There is still no per-pane override.
3. Settings → Experiments keeps its machinery. `EXPERIMENTS` is empty, so the index row hides itself
   until the next experiment arrives.
4. On a device that chose Chat, an agent pane of a harness that can draw Chat draws it from the first
   frame, even before a session or a log exists. One rule decides the body
   (`web/src/lib/chat-gate.ts`, amended 2026-10-05 in the 1.17.0 review):
   - A pane whose session reads draws Chat.
   - A pane with nothing to read yet, that this view saw start or first saw idle, draws Chat with one
     quiet line, "Send a message to start". It never says "no transcript file" while the pane is new.
   - Such a pane falls back to the terminal once it has worked for 15 seconds (`CHAT_GRACE_MS`) with
     no session or no readable log. Worked means its status left idle, or the operator sent a prompt
     from this device. The terminal then shows the existing line for the missing session or log, and
     the ⋮ row says why.
   - A pane first seen already busy, done or unknown, with nothing to read, keeps the terminal at
     once, as before.
   - The fallback is one quiet swap and is not sticky: a session or log that arrives later takes the
     pane back to Chat.

   This replaced "a pane with no session keeps the terminal and its menu row says why". A device
   that chose Terminal sees no change.
5. The handover from a shell to an agent is one sequence. The agent-start layer and the body swap used
   to run on separate clocks, so the body could change beside the animation. The layer now draws a
   phase (`covering`, `covered`, `revealing`) and the body changes only at `idle` or `covered`, which
   is under the cover. The handover ends when its animation ends. It waits for no session and no
   journal answer: the rule in point 4 names the body at once, so the reveal uncovers the body that
   stays. (Until the 1.17.0 review the rest waited for the body to be ready, with a cap of 1.5
   seconds, and for Codex and pi that wait ended on the terminal, so Chat arrived later with no
   cover.)

## Consequences

- The Hermes hole is now the first impression for a Hermes operator, not the price of opting in. The
  terminal is one tap away on the pane's ⋮ menu, and `docs/configure.md` names the hole under "Chat
  view".
- A device that never touched the setting moves from Terminal to Chat on update. That is the intended
  change, and the changelog says so under Changed.
- The pane-view value no longer reads as "what opting in hands you". Its default is what Collie shows.
- Codex reports its session to Herdr only when its first prompt is submitted
  (`REPORTS_SESSION_ON_FIRST_PROMPT`, `bridge/journal/registry.ts`). A fresh Codex pane therefore has
  no session, and under the old point 4 it showed the terminal and popped to Chat after the first
  prompt with no cover. Under the new rule it draws Chat with the start line from the first frame.
- pi reports its session at start but writes its log file only after its first assistant message, so
  the chat route answers `no-log` until then. Under the old rule the reveal uncovered "No transcript
  file was found for this pane's session yet". Under the new rule a new pi pane says how to begin, and
  only a pane that has worked past the grace with no file says the file is missing.
- A broken or missing hook now costs a new pane 15 seconds of an empty Chat once it starts working,
  then the terminal and the hint. That is the price of drawing Chat before the session is known.
- A pane first seen idle with no session reads as new, so a pane with a broken hook that finished its
  work long ago also shows the start line until it works again. Herdr 0.9 reports a finished agent as
  idle, so nothing on the pane tells the two apart.
- Revisit if a harness's journal gets a second hole of Hermes's kind, or if Chat's first paint proves
  slow enough on a crew member that Terminal should be the default there.
