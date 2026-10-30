# Terminology

The words Collie uses, in plain words. Each entry is short and links to the page that covers it.
Where another tool uses a different word for the same thing, the entry says so.

## Collie (an instance)

One running bridge process. It serves one phone URL and watches one terminal, and it can show
durable agents beside it. A host can run more than one, each with its own port and state folder
([Multiple Collie instances on one host](deployment.md#multiple-collie-instances-on-one-host)).
In a crew, the instances of one host show as one machine
([A machine can run several Collies](crew.md#a-machine-can-run-several-collies)).

## Session

One agent conversation. A pane shows it, and Chat reads it from the harness
([Sessions](sessions.md)). tmux and zellij call their own top-level group a session too. Collie
shows that group as a [space](#space).

## Space

A group of tabs, with a folder. It is the top level on the phone. A Herdr workspace is a space, a
tmux session is a space, a zellij session is a space, and a [durable agent](#durable-agent) is a space.

## Tab

A group of panes. A Herdr tab is a tab, and a tmux window is a tab
([Terminals](multiplexers.md#what-changes-compared-with-herdr)).

## Pane

One thing you can open on the phone. In a terminal it is a pane with a screen. In a durable agent it is
one conversation, and it opens in Chat only.

On a large screen several panes show side by side ([Large screens](configure.md#large-screens)).

## Terminal (mux)

Herdr, the Herdr core (`herdr-core`), tmux, zellij, tuios or Tern, the program that holds your
shells and agents. Other tools call it a multiplexer, or a mux. You choose it with `COLLIE_MUX`
([Terminals](multiplexers.md#pointing-collie-at-a-multiplexer)).

The Herdr TUI (`herdr`) and the Herdr core (`herdr-core`) are two products. `hc` is the core's
command line, and herdr-app is the window that draws its terminals. One Collie drives one of them
([herdr-core notes](multiplexers.md#herdr-core-notes)).

## Durable agent

An agent that runs as its own process, with its own storage. It attaches to Collie over the durable
wire. You build one with the Durable SDK, or with any program that serves the wire. It lays out its
own spaces, tabs and panes. It is experimental, and you attach it with `collie durable attach`
([Durable agents](durable-agents.md)). A session is either a terminal session or a durable session.
The API and the code still call the channel `program`.

## Harness

The agent that runs in a pane: Claude Code, Codex, pi, OmO, or a durable agent
([Claude Code on your phone](claude-code-on-your-phone.md)).

## Crew

The lead plus its members. It gives you one phone URL for many machines
([Crews](crew.md#two-machines-one-crew)). One machine needs no crew to show a terminal and a
durable agent together.

## Lead

The Collie your phone talks to. It merges the lists of its members and relays their panes
([Crews](crew.md)).

## Member (peer)

One Collie that joined a crew. The two words mean the same thing. "Member" is the crew's word, and
"peer" is the word for a Collie that runs beside another one
([Crews](crew.md#how-a-crew-is-wired)).

## Question card (ask)

A question that a durable agent raises. The phone shows it as a card, and one tap answers it
once. Collie never answers for you ([Durable agents](durable-agents.md#what-the-phone-shows)).

## Belt

The action row above the composer. Its harness section holds the harness's own buttons
([Configure](configure.md#one-off-commands-and-their-history)).

## Starter

A row on the New page that makes a new pane in a durable agent
([Starters from a durable agent](configure.md#starters-from-a-durable-agent-experimental)).

## Source

The word `sources.json` uses for one durable agent entry. You meet it only in that file name and its
fields. Nothing on the phone says "source"; the phone says [durable agent](#durable-agent)
([Attach a durable agent](durable-agents.md#attach-a-durable-agent)).

## Cap

One thing a durable agent says it can do: `asks`, `starters`, `send`, `steer`, `abort`, `rename`, `close`,
`actions`, `history` or `reopen`. The phone draws a control only for a cap the durable agent named. The
push limits are also called caps, and they are a different thing
([Pushes from a durable agent](voice-and-push.md#pushes-from-a-durable-agent)).

## Hello

The first thing a durable agent tells Collie: the wire versions it speaks, its caps and its name. Collie
reads nothing more from a durable agent whose versions do not meet its own
([Versions](durable-agents.md#versions)). A crew link has a hello of its own, between a lead and
a member ([Crews](crew.md)).

## Epoch

A label a durable agent makes each time it starts. A position in a conversation only counts inside one
epoch. When the epoch changes, Collie reads the conversation again from the start
([Durable agents](durable-agents.md)).

## Receipt

The record of one thing a phone asked a durable agent to do: an answer, a send, a stop or a starter tap.
It holds the request id and the outcome, and it lets a retry replay and not run twice. Collie keeps
receipts in its state folder
([Where Collie keeps a durable agent's data](durable-agents.md#where-collie-keeps-a-durable-agents-data)).

A [walky talky](#walky-talky) message has a receipt too. It says whether the message is queued, typed
into the pane, waiting in the inbox or refused, and why ([Receipts](walky-talky.md#receipts)).

## Conversation

How the phone's Durable agents pages name a durable [session](#session). The conversation list
shows what waits on you first, then the other open ones, then the closed ones
([What the phone shows](durable-agents.md#what-the-phone-shows)).

## Durable agents section

The group on the dashboard that lists every durable agent, one row each. It moves above your spaces while
a question waits, and it shows nothing when no durable agent is attached
([What the phone shows](durable-agents.md#what-the-phone-shows)).

## Wire

The rules Collie and a durable agent use to talk: a hello, then snapshots, events and answers. There is
one version today, version 1. It runs over a private socket or over https with a token
([Versions](durable-agents.md#versions)).

## Walky talky

A short message from one agent session to another, or from you to a session. It works on any
harness and across a crew, and every message has an id and a [receipt](#receipt). The command is
`collie walky` ([Walky talky](walky-talky.md)). Across a crew a message goes through the lead, and the
lead tells the sender's machine how it ended.

## Nudge

The one line that an agent's message types into the target pane. It holds the sender's header and
the two commands that read and answer the message, and no body. The agent reads the body with
`collie walky inbox <id>`
([What the target pane receives](walky-talky.md#what-the-target-pane-receives)).

## Inbox

The messages kept for one pane, on the machine that owns the pane. A message waits there until the
pane reads it with `collie walky inbox`. It lands there when Collie could not type it, too
([Reply, read and check](walky-talky.md#reply-read-and-check)).

## Pane instance

One pane as Collie follows it, from the first time Collie sees it until it has been gone for 30
seconds. A terminal gives a closed pane's id to the next pane, so Collie gives each pane a token of
four characters too. A [walky talky](#walky-talky) address carries it after a `#`, for example
`local/w6:p3#k3f9`, and reaches that pane only. A new pane that takes the same pane id is a new
pane instance, with a new token and an empty [inbox](#inbox) ([Addresses](walky-talky.md#addresses)).
It is not a Collie instance: that word means one running bridge ([Collie (an instance)](#collie-an-instance)).
