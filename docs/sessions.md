# Sessions

A **session** is one agent conversation: you ask, the agent works, and a question may wait on you.
Collie shows each session on your phone in a pane. Chat reads the session from the agent's own
record, so you can read it and answer it from your phone. The terminal view is one more way
to look at the same pane.

tmux and zellij call their own top-level group a session. Collie shows it as a space. This page
uses "session" only for the conversation.

## Where sessions come from

Sessions come from two places:

- **A terminal.** Herdr, tmux, zellij, tuios or Tern holds your shells, and an agent runs in one of
  them. Collie reads the panes from it and finds the agent's session. This is how most people use
  Collie. [Terminals](multiplexers.md) says how to point Collie at yours.
- **A durable agent.** One that you wrote or run has no screen, and each of its
  conversations is a session with Chat and nothing else. This is experimental.
  [Durable agents](durable-agents.md) has the steps.

## What the phone shows

Your phone has one URL. Under it, each terminal workspace is a **space**, and each durable agent is a
space with its own name. A space holds tabs, and a tab holds panes. A pane shows one session. A
durable agent appears in its own Durable agents section, with its name, its runtime and an Experimental badge,
the count of its open conversations, and how many of them wait on you. The section moves above
your spaces when a question waits.

A terminal space draws exactly what it always drew. A durable agent space opens on its list of
conversations, and a control appears only when that durable agent says it can do it.

The words are in [Terminology](terminology.md).

## One machine, or several

One Collie carries a terminal and durable agents together. A machine with Herdr and a durable agent needs no
second Collie and no crew. Both appear under the same URL.

Several machines need a crew. A crew puts every machine's Collie behind one lead and one URL
([Crews](crew.md)). A machine in the crew can carry its own terminal and its own durable agents.
