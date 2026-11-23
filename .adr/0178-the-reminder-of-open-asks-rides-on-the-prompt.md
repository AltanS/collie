# 0178: The reminder of open asks rides on the prompt

- **Status:** Proposed (2026-11-23), the lead's design for the second build on the dev lane; the owner looks at it
  there before it goes further.
- **Date:** 2026-11-23
- **Supersedes:** ADR 0177
- **Trail:** The Asks sync review of 2026-11-23 (the design note on the reminder, its section 3 "Skill text" and
  section 4 "Open risks"). Files: `cli/beacon-asks.ts` (`collie beacon asks`), `bridge/hill/remind.ts`
  (`AskRemindBook`), `bridge/hill/service.ts` (`askRemind`, `askEdge`, `typedAnswers`), `bridge/walky/socket.ts`
  (`ask.remind`, `ask.cancel` with `ids`), `bridge/index.ts` (the edge feed and the bridge's own message),
  `cli/hooks.ts` (the two new entries), `cli/doctor.ts` (`ask-reminder-claude`), `cli/ask.ts` (cancel with several
  ids; `keep` gone).

## Context

0177 held a Claude Code turn open at its end to show the agent its open asks, and the agent confirmed each one with
`collie walky keep`. That cost an extra model step per turn, lifted the pane to "working" with a timer, and asked the
agent to confirm what nothing had changed. The owner's rule stays: the list follows the work, and an ask that is no
longer true leaves by itself. The better moment is the start of a turn: the person's prompt is the one event that can
settle an ask, and the agent reads its open asks next to it at no extra step.

The facts this record relies on, from Claude Code's hooks reference (`code.claude.com/docs/en/hooks`, read
2026-11-23):

- `UserPromptSubmit` gets `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name` and `prompt`;
  the common fields include `agent_id` and `agent_type`. `SessionStart` gets a `source`: `startup`, `resume`,
  `clear`, `compact` or `fork`, and its matcher can filter on it.
- On exit 0, plain stdout of these two events is added as context. The JSON form is
  `{"hookSpecificOutput":{"hookEventName":...,"additionalContext":...}}`, at most 10,000 characters. "Neither
  channel produces a visible transcript entry": the text reaches the model wrapped as a system reminder.
- `decision: "block"` or exit 2 blocks the prompt. Output that starts with `{` and ends with `}` but does not parse is
  a non-blocking failure and is not added. With several hooks, "Claude receives all of the values".
- The timeout is in seconds. A hook that reaches it is cancelled and its output discarded. The hooks of one event run
  in parallel. The hooks of `SessionStart` at startup, resume and clear run in the background.
- `agent_id` names a subagent or an in-process teammate. The page does not say clearly whether these two events fire
  inside a subagent. `UserPromptSubmit` also fires for background subagent reports, scheduled tasks and messages from
  other sessions.

## Decision

**Collie's own groups for `UserPromptSubmit` and `SessionStart` get a second entry, `collie beacon asks`. It asks the
bridge for the session's open asks and prints them as context next to the prompt. The bridge decides; the hook
prints. Nothing is confirmed: an ask stays open until the person answers it or the agent closes it.**

1. **The hook prints nothing, or one JSON object with `hookSpecificOutput`, and always exits 0.** It never prints a
   `decision`, never blocks, never changes the prompt. Gates in order, each silent: the payload is not JSON; the event
   is neither of the two; the payload names an `agent_id`; a `SessionStart` whose source is not `clear`, `compact`,
   `resume` or `fork`; no multiplexer markers; no bridge answers a valid list. Its own limit is 1 s for the whole
   verb; the install writes `timeout: 3`. It walks the bridges on the machine and goes on after every answer that is
   not a valid list, 300 ms at most per bridge; it skips, with no socket call, a bridge whose Asks switch file is not
   on, and a prompt that opens with the WalkyTalky header. The bridge answers only the call's `session_id` when the
   pane's hook edges name it, and never an ask another conversation posted. The prompt text never leaves the
   process: the bridge gets its hash, salted with that bridge's send salt, as `beacon emit` hashes it for prompts.
2. **The text.** The full form: "Collie: your open asks.", each ask with its id and its question (hidden characters
   removed, cut to 60 characters), then how to close one with the binary the skill names, then "Still true: do
   nothing." The short form, the ids only: "Collie: open ask ak_1." or "Collie: open asks ak_1, ak_2." A list
   gets the full form when at least one of its asks is new to the session, which is one it was not shown in an
   earlier list; else the short form, so an ask that closed does not bring the full form back. After 20 short forms
   in a row the next is full again (the bridge cannot know a hook's output reached the model). One switch
   (`ASK_REMIND_SHORT_FORM`) turns the short form off: then every list is full. No answer of the person's is ever
   in it. The owner asked for this trim on 2026-11-23, because the first form cost too many tokens.
3. **When it speaks.** At every prompt of the pane's own session with open asks; at `compact`, `resume` and `fork`
   with the full list (the conversation came back without it); never at `startup`. It is silent for a prompt the
   bridge typed itself: when the bridge types an "Answers to your asks" message it records the hash of the typed
   text, with the formula the Send Protocol uses for prompt edges, and a prompt with that hash gets nothing, because
   that message lists the open asks itself.
4. **The marks** (`HillAsk.mark`, `confirmedAt`). A new ask is `fresh`. A prompt edge makes each open ask posted
   before it `unchecked`. The stop edge of a turn whose prompt got a hand-out makes the handed-out asks that are still
   open `carried`, with `confirmedAt` the stop's time. The hand-out and the prompt edge are paired by the salted
   prompt hash and by time (within 10 s), since both hooks run in parallel; with no hash there is no pairing, so
   nothing reads `carried` from a guess. A stop confirms once, and not while a newer hand-out waits unpaired. A start
   or end edge resets the pane's turn. A restart forgets the turns and never makes a `carried`.
5. **`/clear` closes the pane's asks.** Only a `SessionStart` with source exactly `clear`, from a pane the socket
   placed, once its hook edges name the call's new session id, moved to from the cleared one. Only the asks of that
   session (the address with its instance token) that the cleared conversation posted (or unstamped), open and not
   busy; each is withdrawn with the reason "conversation cleared". Then the next list is the full one.
6. **Closing.** `collie walky cancel <id>...` takes 1 to 5 ids with one flag for all (`--answered` or
   `--because`). One id goes as `id`, as an older bridge reads it; more go as `ids`, and the bridge answers one result
   per id, in order, so one bad id stops none. `collie walky keep` and `ask.keep` are gone.
7. **A crew member's session gets nothing.** Its bridge answers `ask.remind` with "none": the asks live on the lead,
   which never sees the member's turn edges. Its asks read `unchecked` on the lead from the post.
8. **Install and health.** `collie hooks install claude` writes the two entries beside the emitter and removes the
   `beacon check` entry of an older install; the person's own hooks in the same events keep their place and order.
   `hooks status` and `collie doctor` (`ask-reminder-claude`) give it one row; a missing entry or a leftover check
   counts as hooks behind, so `collie update` heals it. Uninstall removes all of Collie's.

**No new trust.** The text holds the agent's own question from the same session and Collie's fixed sentences. It
carries no answer, no body, no file and nothing of another session.

## Consequences

- Cost: one process start per prompt and per session start, and no model step. The tokens of the text only when the
  session has open asks: the full form once per ask (and after `compact`, `resume` and `fork`), then one line of
  ids, with the full form again after every 20 short ones.
- Codex and the other harnesses get no reminder. Their asks read `fresh` or `unchecked`, never `carried`.
- A running Claude reloads its hooks from the settings files, so an install reaches running sessions. One with hooks
  turned off gets no reminder.
- Not covered, from the design note's open risks:
  - Prompts from no person. `UserPromptSubmit` also fires for scheduled tasks, subagent reports and messages from
    other sessions; each gets the reminder. The growth in a `/loop` session is not measured yet.
  - Self-settled asks. An agent that settles an ask mid-turn, forgets the cancel and gets no new prompt leaves the
    ask reading `fresh` and stale. Nothing here catches it.
  - Crew members. The reminder does not reach a member's session, and its asks never read `carried`.
- Measured with real Claude Code sessions (Sonnet), 2026-11-23. The bar was 9 of 10 closed and no wrong close.
  - The full form on the prompt that settles the ask, on the dev lane: 10 of 10 closed; 10 prompts that settle
    nothing closed nothing.
  - The trimmed forms, in a closed lab (a hook that prints the text, a stand-in for `collie`, no skill text in the
    sessions): the full form once, then the short form. The prompt that settles the ask came on the first or the
    third short-form prompt: 10 of 10 closed, each with `walky cancel <id> --answered`; 10 prompts that settle nothing
    closed nothing; with two open asks only the settled one closed.
  - Tokens, equal on Sonnet and Opus: Claude Code's wrapper 16; the full form with one ask about 130 with the bare
    command name and about 150 with a 60-character path, about 35 more per further ask; the short form 39 with one
    id and 55 with two. These counts include the wrapper.
- Still to measure: whether the cache prefix holds, and that the context makes no visible transcript entry.

## What we tried before

- [0177](./0177-the-check-at-the-end-of-a-turn.md): the check at the end of a turn, a `Stop` hook that held the turn
  open and asked the agent to keep, replace or take back each ask. It cost a model step per turn and a lifted pane,
  and it asked for a confirmation that nothing had changed.
