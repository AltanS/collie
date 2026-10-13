# Glossary

The words Collie uses for its parts, in plain words. Each entry is short and links to the page that
covers the term, where one exists.

## Collie (an instance)

One running bridge process. It watches one backend and serves one phone URL. A host can run more
than one, each with its own port and state folder
([Multiple Collie instances on one host](deployment.md#multiple-collie-instances-on-one-host)).

## Mux (the backend)

What a Collie watches for your terminals: Herdr, tmux, zellij, tuios or tern. You set it once at
start with `COLLIE_MUX`, and one Collie watches one terminal mux
([Multiplexers](multiplexers.md#pointing-collie-at-a-multiplexer)). A durable program is not a
second mux to choose. You attach it as a [source](#source).

## Pane

One thing you can open on the phone. On Herdr it is a terminal with a screen. On a durable program it
is one conversation, and it opens in Chat only.

## Tab

A group of panes. On Herdr a tab is a window. On a durable program it is a list that the program
chose.

## Workspace (space)

A group of tabs, with a folder. On Herdr it is a project. On a durable program it is a top-level
group that the program chose.

## Session

Two things carry this name, and the page says which it means. In a Collie, a session is one place
that holds panes: a Herdr, tmux or zellij session, or an attached durable program. The session is
the thing, and a pane is one view of it. Separately, an agent keeps a record of its conversation,
and Chat reads that record from the harness ([Configure](configure.md)).

## Harness

The agent program that runs in a pane: Claude Code, Codex, pi, OmO, or a durable program
([Claude Code on your phone](claude-code-on-your-phone.md)).

## Peer / member

One Collie that joined a crew. The two words mean the same thing. "Member" is the crew's word, and
"peer" is the word for a Collie that runs beside another one ([Crews](crew.md#how-a-crew-is-wired)).

## Lead

The Collie your phone talks to. It merges the lists of its members and relays their panes
([Crews](crew.md)).

## Crew

The lead plus its members. It gives you one phone URL for many machines
([Crews](crew.md#two-machines-one-crew)). One machine needs no crew to show a terminal and a durable
program together: attach the program as a [source](#source).

## Program (durable)

A process built on the durable SDK. It owns its workspaces, tabs and panes, and it answers over the
wire. Collie shows it as a session ([Durable programs](durable-programs.md)).

## Source

One entry in `sources.json` that names a program and how to reach it, by socket or by URL and token.
`collie durable attach` writes it. Collie makes one session from each source
([Sessions and sources](durable-programs.md#sessions-and-sources)).

## Session card

The summary a session shows about itself: its name, whether it is a terminal or a program, its mux,
what it can do, whether it is local or remote, and whether it is ready, starting or unreachable. The
phone reads what a session can do from its card.

## Wire

The HTTP contract between a Collie and a durable program. It runs over a private socket, or over
HTTPS with a token ([durable notes](multiplexers.md#durable-notes)).

## Cap

One line in the program's hello that says what it can do. When a program declares a cap, the phone
draws the matching control ([What a program can do on the phone](durable-programs.md#what-a-program-can-do-on-the-phone)).

## Ask

A question the program raises. The phone shows it as a card, and one tap answers it once. Collie
never answers for you.

## Starter

A row on the New page that makes a new pane in the program
([Starters from a durable program](configure.md#starters-from-a-durable-program-experimental)).

## Belt

The action row above the composer. Its harness section holds the harness's own buttons
([Configure](configure.md#one-off-commands-and-their-history)).
