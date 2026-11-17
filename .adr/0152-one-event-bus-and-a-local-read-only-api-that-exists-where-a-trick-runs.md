# 0152: One event bus, and a local read-only API that exists where a trick runs

- **Status:** Accepted (2026-11-17)
- **Date:** 2026-11-17
- **Trail:** the design review and the security read of 2026-11-17 (five advisors read it, all for
  it with changes). The roads argued for and turned down: a loopback HTTP API, so any HTTP client
  reaches it; the WalkyTalky socket carrying the API, to save a socket; an API that is on from the
  start, with no trick; a trick that serves a page or an answer on a port; a bare pane id as the
  session name. Files: `bridge/events/`, `bridge/api/` (`operations.ts`, `socket.ts`, `ids.ts`,
  `reads.ts`), `cli/api.ts`, `bridge/index.ts`, `docs/commands.md`

## Context

Tricks that react to the world (`on`, `watch`) and a way for a program on the machine to ask what
the sessions are doing have the same need: one place that says "a session changed". They also share
a danger. Whatever answers a program must not grow into something a trick, a web page or another
machine can steer. The phone's own routes are gated by pairing and cannot be reused: a script has no
paired device, and a Unix user can already read every screen through the multiplexer.

## Decision

1. **One bus, internal to the bridge.** `bridge/events/` holds the event bus and imports nothing
   from tricks or the API. The API and the trick runner are two thin listeners, and neither imports
   the other (`bridge/events/seam.test.ts`). What a trick gets in `trigger` and what the API answers
   for `events` are two wire shapes built from one bus event, each with its own contract test, so
   one can change without the other. The operation table (`bridge/api/operations.ts`) is internal
   too: the socket and `collie api` read it, and no operation exists outside it.
2. **An event holds ids and states, never text.** No screen text, question, option, folder path or
   title. A listener that wants content asks for it with a read. Delivery is at least once, per
   machine, with no order across sessions, so every listener must be safe against a repeat. A ring
   of 2048 events or one hour answers an old cursor with a `gap`, and an earlier bridge start with
   a `reset`, never a silent hole.
3. **A Unix socket of its own, `<state dir>/api/sock`, mode 0600 in a folder of mode 0700.** Not
   loopback HTTP: a page in a browser can reach loopback, and a Unix socket it cannot. Not the
   WalkyTalky socket and not the hooks socket: each of those can be switched off alone, and neither
   may widen or narrow what the other reaches.
4. **It is on while tricks are switched on, and only where tricks run.** The socket stands while
   tricks are switched on, on a bridge where tricks run (never on a crew peer or deputy that only
   follows its lead, never on Windows). When tricks go off, it is removed and every open wait ends.
   A bridge with tricks off has no socket, and `collie api` says so in one line. One function in
   the bridge decides it, so the rule has one place to change.
5. **Read only, and the table denies by default.** The one right of the local tier is `look`. Each
   row names its right, a row whose right was not granted answers `api.denied`, and a test walks
   the table. A second test fails when any operation can reach the code that answers an ask.
6. **The honest words.** The local API is a convenience for programs of the same Unix user, not a
   wall against them: they can already read and type through the multiplexer. It is closed to other
   users, other machines and browser pages, and it carries no token, as the file mode is the
   credential. The docs and the code headers say this and nothing stronger. One answer carries
   text an agent wrote: `hill.list` gives each card's title, cut to 120 characters.
7. **Session ids are opaque.** An id holds the machine and the pane's instance token and is copied
   from `sessions`. No operation takes a bare pane id. An id whose pane now holds another session is
   `session_replaced`, once Collie has seen the pane gone. The token is dropped only after the pane
   was out of sight for 30 seconds (`bridge/walky/instances.ts`), so a pane id reused inside that
   time can still answer the old id with the new screen. That is accepted for a read by the same
   user. **It blocks any send step and the remote tier**: before either, a reused pane must be
   refused at once, by ending the token when the pane is seen gone or by a second fact in the id.
8. **A trick never opens a port and never answers the network with free content.** This is final.
   A key for other machines, if it comes, is its own experimental setting with its own record.
9. **No operation changes what a person sees or types, and two reads do housekeeping.** `accounts`
   may run the agent's own status command behind the existing cache, and `hill.list` stamps the
   Hill's walky token at most every 10 seconds. Both do what the phone's own reads do.

## Not in this step, and each needs its own record

`send` (typing into a session), `control`, a trick right over the API, `mode = "serve"`, a "call"
trigger, the remote tier with a key, and the crew's lead merging its members' buses.

## Consequences

- A program cannot count on the API: a machine with no trick on has none. That is the price of rule
  4, and the CLI's one line and the docs say it. Setting up a trick only to get the API is the cost
  an operator pays today.
- Two wire shapes mean two small mappers and two contract tests. In return, a field a trick needs
  never reaches the API by accident, and the reverse.
- At-least-once delivery pushes the dedupe to every listener, and `gap` and `reset` push a re-read
  of `sessions` to every follower. Ids and states keep both cheap.
- A same-user program gets screens, secrets masked on a best-effort basis, from a socket with no
  prompt. The mask misses secret shapes Collie does not know. The docs say so.
- Revisit rule 4 when a named use needs the API with no trick on; its own setting, with a security
  read, is the road. Revisit rule 7 before any send. Revisit the two-mapper split only if a
  measured change had to be made twice and cost more than the leak it prevents.
