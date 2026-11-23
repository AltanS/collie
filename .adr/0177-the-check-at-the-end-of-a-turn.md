# 0177: At the end of a turn the agent sees its open asks once, and the bridge decides when

- **Status:** Proposed (2026-11-23), the lead's design for the first build on the dev lane; the owner looks at it
  there before it goes further
- **Date:** 2026-11-23
- **Trail:** The Asks lab of 2026-11-22 (the plan of the test agent for the check at the end of a turn) and the owner's
  rule for the feature: "it works alongside the work im doing, and syncs. so if i dont feel like using it today, it
  shouldnt show me 20 stale cards". Files: `cli/ask-check.ts` (`collie beacon check`), `bridge/hill/check.ts`
  (`AskCheckBook`), `bridge/hill/service.ts` (`askCheck`, `askKeep`), `bridge/walky/socket.ts` (`ask.check`,
  `ask.keep`), `bridge/state-engine.ts` (`liftChecks`), `cli/hooks.ts` (the second `Stop` entry), `cli/ask.ts`
  (`collie walky keep`), `cli/doctor.ts` (`ask-check-claude`).

## Context

An ask (0176) stays open across turns. A question that the work answered, or that changed, stays on the phone as it
was posted until the agent takes it back, and an agent forgets its own asks between turns. The owner wants the list to
follow the work: an ask that is no longer true must leave by itself, and one that is still true must say so.

Claude Code can hold a turn open at its end. The facts this record relies on, from Claude Code's hooks reference
(`code.claude.com/docs/en/hooks.md`, read 2026-11-23):

- A `Stop` hook runs when the main agent has finished responding. It does not run when the person interrupts the turn,
  and an API error fires `StopFailure` instead.
- Its input has `stop_hook_active`, `true` "when Claude Code is already continuing as a result of a stop hook", plus
  `last_assistant_message`, `background_tasks` and `session_crons`. Claude Code also ends the turn after eight stop
  hook continuations in a row.
- `{"decision": "block", "reason": "..."}` printed on exit 0 keeps Claude from stopping; the reason is its next
  instruction. Stdout counts as that JSON only when it holds the one object and nothing else.
- A subagent's end fires `SubagentStop` (with `agent_id` and `agent_type`), not `Stop`; `agent_id` names the subagent
  or in-process teammate a hook fires in.
- The hooks of one event run in parallel. A command hook that reaches its `timeout` is cancelled and its output
  discarded, so it renders no decision.

## Decision

**A second entry in Collie's own `Stop` group runs `collie beacon check`. The bridge decides, the hook prints. The
agent keeps (`collie walky keep <id>`), replaces, or takes back each listed ask.**

1. **The hook prints nothing, or one block line, and always exits 0.** Gates in order, each silent: `stop_hook_active`
   is anything but absent or `false`; the event is not `Stop`, or the payload names an `agent_id`; no multiplexer
   markers; no bridge answers; the answer is anything but `check`. It has its own limit of 3 s, under the 10 s the
   install writes, and after it prints nothing.
2. **The bridge decides (`ask.check`), in one synchronous call**, so two hook processes of one stop cannot both get
   `check`. It answers `check` only when the Hill is on here (a crew member answers `none`: its asks are on the lead),
   the session has open asks, the bridge knows the turn, no check ran in it, the brake allows it, and an open ask was
   neither posted, kept nor replaced in it. Only those asks are listed, at most five, oldest first. Every error is
   `none`.
3. **The turn is the pane's last `prompt` hook edge** (`UserPromptSubmit` through `beacon emit`), its `at` the key and
   the start. A pane with no prompt edge since the bridge started gets no check. An `end` edge forgets it.
4. **The brake.** A check after which the session ran no ask verb (`keep`, `ask`, `ask --replaces`, `cancel`) before
   its next turn is ignored. The next check then comes 2 turns later, then 4, then 8, and stays at 8; checks the agent
   answers come every turn. Any ask verb resets it. In memory: a restart forgives.
5. **`collie walky keep <id>...` (`ask.keep`) sets `ask.confirmedAt` to now**, on 1 to 5 open asks of the session, all
   or none; an id that is not one is refused by name. A replace sets `confirmedAt` on the new ask to its post time. A
   crew member refuses keep in this build: the crew wire carries no keep.
6. **The pane reads as working while its check runs.** The `Stop` that started it wrote an idle beacon and a stop edge,
   and the check's turn has no prompt. When the bridge answers `check` it lifts the pane: the state engine reads an
   idle or done pane as `working` until the stop edge of the check's own turn (the second stop after the answer, or
   the first when the starting stop arrived before it), a prompt, a start or an end edge, or 2 minutes. A `blocked`
   pane is never lowered. The book pokes the session's engine when a lift starts or ends: with a healthy event
   stream the engine polls on events, and neither an answer nor a placed edge is one.
7. **The text** lists each ask with its id, its question (control characters removed, cut to 90 characters) and its
   age, then the four ways to answer it with the binary the skill names, then "Did your reply or your notes leave a
   question to your operator? Send it as an ask." and "Then stop. Write no other text." Under 1,200 bytes for five
   asks. No answer of the person's is ever in it: an answered ask is closed.
8. **Install and health.** `collie hooks install claude` writes the check beside the emitter in the one `Stop` group of
   Collie's own; the group is rebuilt on every run, so an older install gains it, a current one changes no bytes, and
   the person's own `Stop` hooks keep their place. `hooks status --check` counts a file without the check as behind,
   so `collie update` heals it. `hooks status` and `collie doctor` (`ask-check-claude`) give it one row. Uninstall
   removes it with the rest.

## Consequences

- A session with no open asks pays one process start at the end of a turn, and no model call. A session with open
  asks pays one short extra step on a warm cache, once per turn at most, less when the agent lets checks pass.
- No check after a turn the person interrupted, after a refused permission, or on a harness other than Claude Code.
  Their asks show as not checked (no `confirmedAt`).
- A running Claude reloads its hooks from the settings files, so an install reaches running sessions; one with hooks
  turned off (`disableAllHooks`) gets no check.
- The block shows in Claude Code's transcript as a stop hook's reason, and the agent's short step in the pane.
- Between the starting stop and the check's answer the pane may read idle for one poll (on the rig, under half a
  second).
