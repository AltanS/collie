# 0141 — A push may say what the agent waits on, when the operator turns it on

- **Status:** Proposed
- **Date:** 2026-11-14
- **Shipped in:** pending
- **Amends:** nothing. It widens to a terminal pane, behind a setting that is off by default, what
  [ADR 0100](./0100-an-ask-travels-as-data-and-is-answered-by-id.md) already allows a durable
  program: its own words in front of the generic push, 60 and 120 characters, cleaned again.
- **Trail:** `bridge/waiting-words.ts` · `bridge/notifications.ts` (`said`, `wordsFor`) ·
  `bridge/index.ts` · `bridge/config-schema.ts` (`push_words`) · `docs/voice-and-push.md` ·
  `docs/security.md`

## Context

A push for a pane that needs you says "claude needs you" and where the pane sits. On a phone in a
pocket that is the least it can say: the operator has to open Collie to learn whether the agent wants
a yes to `git push`, an answer to a question, or a look at a plan, and a machine running several
agents sends several pushes that read the same.

The words exist. A Claude Code permission dialog is about a tool call the agent wrote to its session
log before it stopped, with Claude's own one-line description of a command, and an AskUserQuestion
call holds its question and options. The journal (`bridge/journal/`) already parses both into a
`ToolCall`, and the push path already knows how to carry a program's own words: a durable ask may set
a title and a line, which follow the pane's push name (ADR 0100).

They are kept off the push by rule, for the reason written at `single` in `notifications.ts`: a call's
words are the agent's, so they can hold a path, a command line or a secret, and a push shows on a
lock screen and crosses a third-party push service. That reason holds. What it does not settle is the
operator who has weighed it and wants the words anyway.

## Decision

**With `push_words` on, a push for a blocked pane says what the agent waits on, in the agent's words.**

1. **Off by default, and a host setting.** `[bridge] push_words` / `COLLIE_PUSH_WORDS`, read at start.
   No Settings switch: what may cross the push service is decided on the host's keyboard, as pairing
   and a speech key are.
2. **The words are the open call's, and only the agent's.** On each poll, a pane that is `blocked`
   and names its session has the tail of its journal read (64 KB, gated by a stat), and the newest
   call without a result in the agent's newest turn is worded: a question's text and its options, a
   command's description and the command (the command alone when it has no description), or the
   tool's name and the journal's one-line gist of its input. Nothing of Collie's own is added, so
   there is nothing to translate, and the title carries no code (ADR 0074).
3. **The same shape and limits as an ask's push words.** A title of 60 characters after the pane's
   push name, and a line of 120 as the body, each one line, cleaned when read and stripped of control
   and direction characters again by the coordinator. `COLLIE_REDACT` masks them with the rest of the
   push. A title alone keeps the place as the body.
4. **Read off the push's path.** The coordinator asks for the words when its alert fires, after the
   debounce. The poll has read the journal by then; a read that failed or found nothing leaves the
   push generic, and none of it can delay or stop a push.
5. **Local panes only.** A crew member's panes are pushed by the lead from the swept snapshot, which
   carries no journal, so they keep the generic push.

## Consequences

- With the setting on, a command line or a file path can show on the lock screen and pass through
  the browser's push service. That is the cost the operator opts into; the default keeps today's push.
- A durable ask is unchanged: it keeps its own words or the generic "Permission needed in" title.
- The journal is read a little more often while a pane waits, bounded by the stat gate and the tail.
- The wording is harness-neutral (it keys on the `ToolCall` shape), and is tested on Claude Code logs.

**What would justify revisiting:** a member sending its panes' words over the crew link, which is a
wire decision (CREW_PROTOCOL.md) and not taken here; or a per-device choice, which would need the
push to be rendered per device rather than once.
