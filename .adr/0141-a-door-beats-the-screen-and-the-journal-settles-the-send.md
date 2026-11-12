# 0141: a door beats the screen, and the journal settles the send

- **Status:** Proposed (2026-11-10), not built; for the maintainer to accept or turn down
- **Date:** 2026-11-10, after a throwaway PoC of pi 1.4.0 + `pi-sidebar-tui` 1.7.8, Hermes v0.23.0
  Ink, Herdr 0.9.5 and tmux 3.8 against a logging fake model
- **Shipped in:** pending
- **Trail:** the blind road, `herdr agent prompt` (herdr `src/app/api/agents.rs`) and the three phone
  relays resting on it, named in [ADR 0140](./0140-a-screen-collie-cannot-read-is-sent-to-by-the-probe-on-any-layout.md)
  · a Hermes plugin calling `ctx.inject_message`, proposed in the same arena and measured to fail
  (leg B) · launch-only protocols (`pi --mode rpc`, `hermes acp`, `codex app-server`) · Claude Code
  channels and Remote Control · a wrapper that owns the PTY (Happy, agentapi) ·
  `bridge/surface/protocol.ts` · `bridge/surface/queued.ts` · `bridge/journal/receipt-queue.ts` ·
  `bridge/journal/pi.ts` · `bridge/journal/hermes.ts` · `bridge/beacon/types.ts` · `cli/hooks.ts` ·
  [ADR 0024](./0024-a-beacon-is-a-hint-never-a-control-channel.md) ·
  [ADR 0103](./0103-the-wire-has-two-transports-a-private-socket-or-tls-with-a-token.md) ·
  [ADR 0117](./0117-a-steer-is-the-persons-choice-never-the-default.md) ·
  [ADR 0122](./0122-a-queued-message-is-a-card-until-the-journal-shows-it.md)

## Context

**Every send Collie makes today is typed into a terminal.** The Send Protocol finds the box, probes
it, reads the probe back and presses Enter. ADR 0140 makes that hold on any layout, at the price of a
confirm tap on every screen Collie cannot read. On pi with a sidebar and on Hermes's Ink front end
that is every send.

**Two agents offer a call into their own live session, and neither needs a key.** Each claim below
is marked *measured* (a PoC leg against a logging fake model) or *inferred* (read from source, not
run).

| Agent | The call | Measured |
| --- | --- | --- |
| pi 1.4.0 | An extension in the person's own pi calls `pi.sendUserMessage(text)` when idle and `deliverAs: "followUp"` when busy. | A1–A7, E: a desk draft stayed in the editor; one user turn with exactly the phone's text; a busy send ran as its own turn; `/model` open, the turn ran behind the picker and no key reached it; `/new` moved the session and the send followed. |
| Hermes v0.23.0 Ink | A second client of the Hermes gateway daemon calls `session.resume` then `prompt.submit`. | C1–C7: Ink stayed attached; a draft in the composer stayed; one user row with exactly the text; a busy send queued as its own FIFO turn; the same `input_id` replayed, with other text refused. |

**The road a plugin offers is not always the road that works.** A Hermes plugin's
`ctx.inject_message` loads in the gateway daemon, which never installs the TUI injector, so nothing
was delivered (leg B, *measured*). A door is what the agent's live session accepts, checked against
the real agent, not what its API reference lists.

**A pane's door can name the wrong session.** With two Hermes Ink panes on one gateway, Herdr
reported pane B's session for pane A and none for B, and a send to "A's session per Herdr" landed in
pane B (leg F, *measured*). The cause, Herdr's Hermes plugin running in the shared gateway with the
first pane's environment, is *inferred*. On pi, Herdr's `agent_session` equalled the inbox's own
`hello` (leg E, *measured*).

**What an agent answers is not what it did.** pi's `message_start` and Hermes's `prompt.receipt` say
the agent took a message. Neither says it is the phone's text, alone, in this session's log. Collie
already settles a queued send by its journal (ADR 0122): exactly one new user turn with exactly the
text. A pi `input` handler may rewrite a message, and a text-only arrival may merge with a queued one
(*inferred* from pi's `agent-session.js` and Hermes's `session_auto_continue.py`).

**A door that runs inside the agent is code in the person's agent.** The pi door is an extension in
`~/.pi/agent/extensions/`, loaded by every pi the person starts. The Hermes door installs nothing:
it is a client of a socket Hermes already serves.

## Decision (proposed)

**Send through the agent's own door where it has one. Type into the screen only where it has none.
Let the journal, never the door, say the send arrived.**

1. **A door is one seam: `preflight → submit → prove`.** It lives in `bridge/door/`, one
   implementation per harness, in a registry keyed by harness id. `preflight` finds the door and
   binds it to the pane, and touches nothing. `submit` hands over the text with the send's request
   id. `prove` is the journal rule in point 4. The seam is multiplexer-neutral: Herdr, tmux and
   zellij reach the same door.
2. **The door goes first; any refusal before `submit` falls back to the Send Protocol.** No door
   registered, no socket, a dead or mute listener, a binding that does not hold, an agent that says
   it cannot take a message now: each ends the door attempt with nothing sent, and the send goes on
   as ADR 0140 describes. It never falls back to the blind road. **Once `submit` may have reached
   the agent, there is no fallback**: an answer lost after the write leaves the receipt a card until
   the journal settles it, because typing the same text again could send it twice. Every receipt
   records `via` (the door's harness id, or `screen`).
3. **A door is bound to the pane and the session before it gets the text.**
   - pi: the inbox's `hello.sessionFile` must equal the multiplexer's `agent_session` on Herdr, or the
     beacon on tmux and zellij. Anything else refuses, and the pane takes the screen path.
   - Hermes: never by Herdr's `agent_session` alone (leg F). The pane binds to the one live session
     whose latest turn is on this pane's screen and on no other pane, the identity rule of the "Full
     reply" card. No such session, or more than one, refuses with "Which Hermes session is this pane
     showing? Nothing was sent.", and the pane takes the screen path with its confirm tap.
   - The binding is a hint in ADR 0024's sense: it picks the route and the journal to read. It never
     relaxes a gate on the screen path.
4. **The door's answer is a hint; the journal is the proof.** pi's `taken` or `queued` and Hermes's
   `prompt.receipt` may change what the phone says while it waits ("pi took it"). They never settle
   the receipt. The receipt settles `sent` when Collie's own journal reader shows exactly one new user
   turn whose text equals the sent text, written no earlier than 2 s before the send (ADR 0122). A
   turn that contains the text without equalling it settles as **merged or changed**, and the phone
   says so. No turn within ADR 0122's bound ends `unconfirmed`, as a queued send does today.
5. **A busy agent queues the send as its own turn.** pi's `followUp` and the Hermes gateway's FIFO
   queue, shown as ADR 0122's queued card. Never merged into a running turn. A steer only when the
   person chooses it (ADR 0117). A repeated request id answers `replayed` and runs nothing. **The
   multiplexer's `blocked` does not refuse a door send**: a door types no key, so a send can do what
   the person at the desk can, and only the agent's own refusal counts. ADR 0140's `blocked` refusal
   stays on the screen path.
6. **A door in the agent's process is the person's opt-in.** `collie inbox install pi` writes the
   extension with an ownership marker, `uninstall` removes only what it wrote, and `status` says
   whether a running pi has loaded it. The bridge never installs it on its own, and neither does
   `collie update`. A pi started before the install keeps the screen path until the person runs
   `/reload` or restarts it, and the verb says so. A door that installs nothing (the Hermes gateway
   client) needs no verb.
7. **A door's local socket follows the durable wire's rules** (ADR 0103): named by the beacon's
   marker digest (`bridge/beacon/types.ts`), mode 0600 in a 0700 folder, every path part walked with
   lstat before Collie connects. A new outbound connection, such as the Hermes gateway's loopback
   WebSocket, is named in an ADR of its own and in the security posture before it ships.

Not chosen:

- **The blind road**, for the reasons ADR 0140 gives.
- **The Hermes plugin's `inject_message`**, because leg B delivered nothing.
- **Launch-only protocols** (pi RPC, ACP, codex app-server): they start their own agent and cannot
  join the session the person started. They stay right for launcher rows.
- **Claude Code channels**: a development flag and a per-launch warning, and the text arrives as a
  tag, not one user turn.
- **Claude Remote Control**: it relays through claude.ai.
- **A wrapper that owns the PTY**: the person must launch through it, and it cannot join their pane.
- **The door's reply as proof**: it says the agent took a message, not that the log holds this text
  once.
- **A fallback after `submit`**: a second copy of the text is worse than an `unconfirmed` card.

## Consequences

- **pi and Hermes Ink send with no layout and no confirm tap** once their door binds. Drafts,
  pickers, sidebars and ticking clocks stop mattering, because no key is typed (A2, A7, C3).
- **A turn can run behind a menu.** In pi's `/model` picker the turn starts while the picker keeps
  focus (A7). That is safe, since nothing is typed, and the phone says it ran behind a menu.
- **Collie ships code that runs inside the person's agent.** The pi extension is Collie's to keep
  working across pi releases. When pi's extension API changes, the extension fails to load or its
  `hello` fails, and the pane falls back to the screen path rather than sending wrong.
- **Every other pane keeps the screen path**: Claude Code, Codex, unknown agents, a pi without the
  extension or not yet reloaded, and a Hermes pane that cannot be bound (a fresh session with no
  turn yet, or a reply that scrolled the latest turn off the grid).
- **The phone learns new outcomes**: taken, queued, ran behind a menu, merged or changed, and "the
  door refused, so the screen path was used". All go through `t()` in every dictionary.
- **The send route changes**, so the browser leg runs on Herdr and on herdr-core, with a new case: a
  draft at the desk, then a phone send.
- **This amends ADR 0140 in scope only**: ADR 0140 governs a pane with no door. On acceptance, 0139
  gains the `Amended in scope by 0140` pointer.
- **A send while the agent waits on the person queues behind that wait.** With an approval dialog
  open, the door's turn queues and runs after the person answers it at the desk.
- **A door's queued card follows the agent's own queue.** pi's inbox says which sends left its queue
  (`GET /queue`: pi settled a run with nothing pending), and the journal, read after that word, says
  whether each ran. One the journal does not show turns `returned` and offers Send and Discard, held
  to the box like any returned card. The box alone never returns a door's send: a draft with the same
  text is not the send come back. An inbox that says nothing keeps ADR 0122's bound.
- **Open:** whether a door's queued
  card and the screen path's queued card share one reducer; opencode's door (`prompt_async`, or
  the `/tui` endpoints) is not tested.
- **Revisit** when a harness's door answers `taken` and its journal disagrees in the cap's counts
  more than rarely: the proof then needs that harness's own witness, or the door goes.
