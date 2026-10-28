# 0104: a program is a session

- **Status:** Accepted
- **Date:** 2026-10-13
- **Shipped in:** 1.22.0
- **Amends in scope:** [ADR 0099](./0099-a-durable-program-is-a-mux-with-no-screen.md), the rule
  that one Collie watches one mux
- **Trail:** the second small Collie that a durable program needed under 0099, and a review of that
  design by four advisors on 2026-10-13, which agreed that it is where an outside builder drops off ·
  `bridge/sessions.ts` (the session registry) · `bridge/mux/registry.ts` (the factory) · `bridge/mux/durable/` ·
  `bridge/config.ts` · `cli/durable-attach.ts` · `docs/durable-programs.md` ·
  [ADR 0011](./0011-the-pack-protocol-is-the-mux-driver-seam.md) ·
  [ADR 0022](./0022-the-mux-seam-is-a-port-collie-owns.md) ·
  [ADR 0100](./0100-an-ask-travels-as-data-and-is-answered-by-id.md) ·
  [ADR 0103](./0103-the-wire-has-two-transports-a-private-socket-or-tls-with-a-token.md)

## Context

ADR 0099 made a durable program a mux with no screen. A Collie drives one mux, so a durable program
got a Collie of its own, joined to the crew of the Collie that drives Herdr. That works. It also asks
a builder to start a second service, give it a port and a state folder, and join it to a crew, only
to see one program on a phone that already shows their terminals.

The four advisors agreed on the cost. Every step before the first question card is a place to stop,
and the second small Collie is the largest one. They also agreed that the design is honest only if
leaving it is cheap.

Sizing found that the exit is already in the code. Each session in the registry has its own adapter,
engine and poller, and the phone already addresses everything as (host, session, pane). The one rule
in the way is that every session in an instance uses the same mux. Lifting that rule is smaller than
the crew machinery the second Collie needs.

## Decision

**A durable program is a session of the Collie that the person already runs. The session is the
thing, and a pane is one view of it.**

The public docs call a session's place a terminal or a program and keep the word session for one agent conversation; the code name `SessionCard` stays.

1. **Sources.** The programs a Collie shows are listed in `sources.json`, in the instance's config
   folder beside `.env`, mode 0600. Each entry has a `name` (lower case letters, digits and hyphens,
   at most 32, unique, and never the name of a terminal session), a `kind` of `durable`, and exactly
   one of `socket` or `url`. A `url` entry has a `token`. `collie durable attach`, `detach` and
   `list` write and read the file. A verb that only writes the file restarts nothing; the person
   restarts, or gives `--restart`.
2. **Sessions.** The primary session and the discovered Herdr sessions stay as they are. Each source
   becomes one more session, with the source's name as its id, built by the same factory with the
   durable adapter. A pane is still addressed by (host, session, pane). A durable pane id is the
   program's conversation id, which is unique inside its session.
3. **The session card.** Every session in the snapshot carries a card: its name, whether it is a
   terminal or a program, its mux, what it can do, whether it is local or remote, whether it is
   ready, starting or unreachable, and whether it is experimental. `GET /api/config?session=<name>`
   answers that session's capabilities. Without `session` it answers the primary's, as it does today,
   for one minor release. The phone reads capabilities per (host, session), never per instance.
4. **Disk.** A program's cache lives under `durable/<source>/` in the state folder, one file per
   conversation. The ask guard key and the ask push tag include the session, so two programs can use
   the same tool call id.
5. **The old form stays.** `COLLIE_MUX=durable` with the socket, or the URL and the token, still runs
   an instance that drives only a program, for a Windows host or a hosted program with no terminal.
   Its source is named `default`.
6. **The five terminal muxes keep their behavior to the byte.** A change that must touch a terminal
   path says so in its commit message.

## The exit

The exit was withdrawn on 2026-10-28. Durable agents are a feature Collie keeps, by Altan's decision. No outside
signal is required and no date replaces the old one. The first text set a condition: a public repository that speaks the
wire, or an outside issue or discussion about a durable program, by the 1.24.0 release. It was written so that leaving
would be cheap, and that still holds: sources stay a file and a registry rule, so a retirement removes an adapter and a
verb, not a model. (amended 2026-10-28)

If the feature is ever retired, a person who attached a program gets notice first. A `sources.json` entry is ignored
with one log line for one minor release before the code moves to `experiments/`. The program's own socket
keeps working for the program itself. The npm package
`@colliepwa/durable-sdk` is deprecated with `npm deprecate`, naming the last Collie version that speaks the wire,
and is never unpublished ([ADR 0105](./0105-the-durable-sdk-is-an-npm-package.md#the-exit) already says
deprecated, not deleted). The docs pages, the site page, the homepage block and the footer link go in one
commit per repository.

## Consequences

- A builder installs one thing. The quickstart is a program, one `attach`, and a card on the phone.
  There is no second Collie and no crew for the local case.
- A crew still works for a program on another machine. A peer carries its sessions in its hello as
  cards, and a lead that is too old to read them ignores them.
- The instance has one more config file to keep private. A source with a token holds the credential
  in the file, so the file is mode 0600, and no verb prints it.
- A program that is slow or down makes only its own session `unreachable`. The terminal sessions
  are not held up by it, because each session has its own poller.
- The wire stays experimental. This decision does not make it stable, and it does not publish the SDK;
  [ADR 0105](./0105-the-durable-sdk-is-an-npm-package.md) does, under the dist-tag `experimental`.
- Revisit this decision if a second kind of source (a hook, a local
  socket for a coding agent) needs a field that `kind` and `name` cannot carry. (amended 2026-10-28: the exit no longer fires)
