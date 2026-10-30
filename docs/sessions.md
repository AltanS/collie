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

## List the sessions from a terminal

`collie sessions` prints every agent session the running Collie sees, one row each. It reads this
Collie's own snapshot and changes nothing.

```text
$ collie sessions
MEMBER   MUX         SEAT         HARNESS                 STATE    SESSION  ACTIVE
bluefin  herdr       collie (t1)  claude claude-opus-5-5  blocked  yes      3m
bluefin  herdr       docs (t2)    codex gpt-9             working  yes      2h
bluefin  durable     -            desk                    working  yes      1m
lab      herdr-core  api (p9)     claude                  idle     yes      12m

4 sessions: 1 blocked, 2 working, 1 idle
```

- **MEMBER** is the machine in the crew, by its name, or by its id when it has no name. Rows are sorted by member, then workspace.
- **MUX** is the terminal program that holds the pane. A durable agent shows its own program. Every other row shows the program the lead reads from that machine. It shows `-` where Collie has no name for it, for example for a member on an older build.
- **SEAT** is the workspace and the pane. A durable agent has no pane, so it shows `-`.
- **HARNESS** is the agent program, with its model when Collie knows it. A durable agent shows its own name.
- **STATE** is what the agent is doing: `working`, `blocked`, `idle`, `done` or `unknown`.
- **SESSION** says `yes` when Collie knows the agent's session, so Chat can read it, and `no` when it does not.
- **ACTIVE** is the time since you last opened or drove the pane from Collie.

Run it on the lead to see the whole crew. On a member it lists that member's own panes, and the
last line says so.

| Flag | What it does |
| ---- | ------------ |
| `--state <state>` | Keep one state, for example `blocked`. |
| `--member <member>` | Keep one member, by its id or its name. |
| `--all` | Add the panes that hold no agent, such as a plain shell. |
| `--json` | Print `{ "rows": [...] }`. Each row has the snapshot's own fields, such as `paneId`, `host`, `agent`, `status`, `cwd`, `workspaceLabel`, `hasSession`, `lastActiveAt` and `model`, and the columns above as `member` (the id), `memberName` (the name the table shows), `mux`, `seat`, `harness`, `state`, `session` and `active`. |

With no Collie running the command prints one line and exits 1. If Collie refuses the read, it
prints the same advice as `collie doctor` and exits 1.
