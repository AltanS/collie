# Terminology

The words Collie uses, in plain words. Each entry is short and links to the page that covers it.
Where another tool uses a different word for the same thing, the entry says so.

## Collie (an instance)

One running bridge process. It serves one phone URL and watches one terminal, and it can show
programs beside it. A host can run more than one, each with its own port and state folder
([Multiple Collie instances on one host](deployment.md#multiple-collie-instances-on-one-host)).

## Session

One agent conversation. A pane shows it, and Chat reads it from the harness
([Sessions](sessions.md)). tmux and zellij call their own top-level group a session too. Collie
shows that group as a [space](#space).

## Space

A group of tabs, with a folder. It is the top level on the phone. A Herdr workspace is a space, a
tmux session is a space, a zellij session is a space, and a [program](#program) is a space.

## Tab

A group of panes. A Herdr tab is a tab, and a tmux window is a tab
([Terminals](multiplexers.md#what-changes-compared-with-herdr)).

## Pane

One thing you can open on the phone. In a terminal it is a pane with a screen. In a program it is
one conversation, and it opens in Chat only.

## Terminal (mux)

Herdr, tmux, zellij, tuios or Tern, the program that holds your shells and agents. Other tools call
it a multiplexer, or a mux. You choose it with `COLLIE_MUX`
([Terminals](multiplexers.md#pointing-collie-at-a-multiplexer)).

## Program

A long-running agent program built on the durable SDK. It lays out its own spaces, tabs and panes
and answers over a wire. It is experimental, and you attach it with `collie durable attach`
([Programs](durable-programs.md)).

## Harness

The agent that runs in a pane: Claude Code, Codex, pi, OmO, or a program
([Claude Code on your phone](claude-code-on-your-phone.md)).

## Crew

The lead plus its members. It gives you one phone URL for many machines
([Crews](crew.md#two-machines-one-crew)). One machine needs no crew to show a terminal and a
program together.

## Lead

The Collie your phone talks to. It merges the lists of its members and relays their panes
([Crews](crew.md)).

## Member (peer)

One Collie that joined a crew. The two words mean the same thing. "Member" is the crew's word, and
"peer" is the word for a Collie that runs beside another one
([Crews](crew.md#how-a-crew-is-wired)).

## Question card (ask)

A question that a program raises. The phone shows it as a card, and one tap answers it
once. Collie never answers for you ([Programs](durable-programs.md#what-the-phone-shows)).

## Belt

The action row above the composer. Its harness section holds the harness's own buttons
([Configure](configure.md#one-off-commands-and-their-history)).

## Starter

A row on the New page that makes a new pane in a program
([Starters from a durable program](configure.md#starters-from-a-durable-program-experimental)).

## Source

The word `sources.json` uses for one program entry. You meet it only in that file name and its
fields. Nothing on the phone says "source"; the phone says [program](#program)
([Attach a program](durable-programs.md#attach-a-program)).

## Cap

One thing a program says it can do: `asks`, `starters`, `send`, `steer`, `abort`, `rename`, `close`,
`actions`, `history` or `reopen`. The phone draws a control only for a cap the program named. The
push limits are also called caps, and they are a different thing
([Pushes from a program](voice-and-push.md#pushes-from-a-program)).

## Hello

The first thing a program tells Collie: the wire versions it speaks, its caps and its name. Collie
reads nothing more from a program whose versions do not meet its own
([Versions](durable-programs.md#versions)). A crew link has a hello of its own, between a lead and
a member ([Crews](crew.md)).

## Epoch

A label a program makes each time it starts. A position in a conversation only counts inside one
epoch. When the epoch changes, Collie reads the conversation again from the start
([Programs](durable-programs.md)).

## Receipt

The record of one thing a phone asked a program to do: an answer, a send, a stop or a starter tap.
It holds the request id and the outcome, and it lets a retry replay and not run twice. Collie keeps
receipts in its state folder
([Where Collie keeps a program's data](durable-programs.md#where-collie-keeps-a-programs-data)).

## Conversation

How the phone's Programs pages name a [session](#session) of a program. The conversation list
shows what waits on you first, then the other open ones, then the closed ones
([What the phone shows](durable-programs.md#what-the-phone-shows)).

## Programs section

The group on the dashboard that lists every program, one row each. It moves above your spaces while
a question waits, and it shows nothing when no program is attached
([What the phone shows](durable-programs.md#what-the-phone-shows)).

## Wire

The rules Collie and a program use to talk: a hello, then snapshots, events and answers. There is
one version today, version 1. It runs over a private socket or over https with a token
([Versions](durable-programs.md#versions)).
