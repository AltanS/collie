# Glossary

The words Collie uses for its parts, in plain words. Each entry is short and links to the page that
covers the term, where one exists.

## Collie (an instance)

One running bridge process. It watches one backend and serves one phone URL. A host can run more
than one, each with its own port and state folder
([Multiple Collie instances on one host](deployment.md#multiple-collie-instances-on-one-host)).

## Mux (the backend)

What a Collie watches: Herdr, tmux, zellij, tuios, tern, or a durable program. You set it once at
start with `COLLIE_MUX`, and one Collie watches one mux
([Multiplexers](multiplexers.md#pointing-collie-at-a-multiplexer)).

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

The agent's own record of its conversation, with the history. A pane shows a session. Chat reads the
session, and the harness keeps it ([Configure](configure.md)).

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

The lead plus its members. It gives you one phone URL for many machines or backends
([Crews](crew.md#two-machines-one-crew)).

## Program (durable)

A process built on the durable SDK. It owns its workspaces, tabs and panes, and it answers over the
wire ([Durable programs in your crew](durable-programs.md)).

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
