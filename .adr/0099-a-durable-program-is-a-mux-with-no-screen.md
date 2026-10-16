# 0099: a durable program is a mux with no screen

- **Status:** Accepted
- **Date:** 2026-10-12
- **Shipped in:** pending (1.21.0)
- **Amended in scope by:** [ADR 0103](./0103-the-wire-has-two-transports-a-private-socket-or-tls-with-a-token.md),
  points 3 and 4: a program the person deployed behind TLS is reached at a URL with a bearer token
- **Amended in scope by:** [ADR 0104](./0104-a-program-is-a-session.md): a program can also be a
  session of the Collie that drives the terminal mux, with no second Collie
- **Trail:** a durable agent program (Pi Durable) that owns its conversations, has no terminal, and
  wanted a way into the crew · `bridge/mux/types.ts` (`snapshot`, `watch`) ·
  `bridge/mux/capabilities.ts` · `bridge/mux/registry.ts` (`MUX_ADAPTERS`) ·
  `bridge/mux/tern/adapter.ts` and `bridge/mux/tern/exec.ts` (the adapter that already dials a local
  socket) · `MUX_CONTRACT.md` · `CREW_PROTOCOL.md` · `web/src/lib/chat-gate.ts` ·
  [ADR 0008](./0008-collie-does-not-run-a-terminal-emulator.md) ·
  [ADR 0011](./0011-the-pack-protocol-is-the-mux-driver-seam.md) ·
  [ADR 0022](./0022-the-mux-seam-is-a-port-collie-owns.md) ·
  [ADR 0073](./0073-a-live-session-is-a-bounded-window-on-the-existing-poll.md) ·
  [ADR 0082](./0082-chat-is-the-default-view-of-an-agent-pane.md) ·
  [ADR 0100](./0100-an-ask-travels-as-data-and-is-answered-by-id.md) ·
  [ADR 0101](./0101-a-control-on-a-screenless-pane-names-the-turn-it-saw.md) ·
  [ADR 0102](./0102-starters-are-launcher-rows.md) ·
  `examples/durable-member/` (the example program and its SDK)

## Context

A durable agent program keeps its own conversations. It runs as a plain process, with no terminal
and no multiplexer. Each conversation has a stable id, a list of items, and sometimes a tool call
that waits for a person. The owner of such a program wants to see those conversations on the phone
beside the panes from Herdr, tmux and zellij, and to answer from there.

Today every pane in Collie comes from a multiplexer, and a multiplexer has a screen. A program with
no screen has two bad routes into the crew.

- **Fake a terminal.** The program would paint its state as text so the screen reader can parse it.
  That adds a pty and a text grammar to a program that already holds the state as data. ADR 0008
  closed off the terminal emulator for the same reason.
- **Add a new role to the crew.** A third kind of member would need its own protocol, its own
  merge, and a version bump for every old lead. The crew already has one kind of member, a Collie
  that fronts a multiplexer (ADR 0011).

The mux port (ADR 0022) is the seam that already exists. It speaks pane, space and agent session,
and it lets an adapter declare what it lacks. A pane without a screen is a case that port was built
to hold, and the Tern adapter already shows a second kind of adapter that dials a local socket.

## Decision

**A durable program is a mux adapter with no screen. It sits behind the mux port, as one more
adapter in the registry, and the crew is unchanged.**

1. **The adapter is named `durable`.** A peer runs with `COLLIE_MUX=durable`. Its snapshot is the
   program's workspaces, tabs and panes. A pane id is the program's conversation id, and it stays
   the same across a restart of the program.
2. **It declares what it lacks.** `paneGrid`, `typeText`, `sendKeys`, `createTab` and `createSpace`
   are false, and so are the worktree capabilities. Every route that needs one answers with the
   one refusal shape of ADR 0022. The adapter declares only what it can do, and the conformance
   suite checks that claim.
3. **The program listens, and the peer dials.** The program owns a Unix socket with mode 0600. The
   peer reads its path from `COLLIE_DURABLE_SOCKET` and connects. The reasons:
   - The adapter keeps the shape of the port, which has `snapshot()` and `watch()`, read by polling
     under ADR 0073.
   - Restart behaviour stays with the process that restarts. The program says `ready` and an
     `epoch`, and the peer follows.
   - Collie manages no socket directory and no stale socket files. One program per peer is one
     config line.

   ADR 0103 adds a second way to dial: HTTPS to a URL the person deployed the program to.
4. **There is no token.** A socket with mode 0600, owned by the user who runs the peer, is the
   gate. It is the same gate as the Tern socket in `$XDG_RUNTIME_DIR`. A program run by a different
   user is out of scope. Because a private socket in a folder someone else can write is not
   private, the adapter checks the whole path before each connect: no symlink, the socket's folder
   owned by the user with mode 0700, every folder above it a real folder that is not open
   for group or other writes (its owner is not checked, because a user service with a private
   `/tmp` sees root's folders as another user). The path is at most 103 bytes. The hello carries
   `service: "collie-durable"`, so a different server at the path is refused by name. This holds for
   the socket; ADR 0103 adds a token for a program reached over TLS, where the token is the gate.
5. **The wire is host-local, versioned by range, additive-optional, and experimental.** The hello
   message carries the lowest and highest version each side speaks, and the peer uses the highest
   both know. A new field is optional, and a reader ignores one it does not know. The wire document
   ships with the adapter and says it is experimental. The program's SDK ships inside
   `examples/durable-member/` as example code, unpublished and with no package, until a second
   user exists.
6. **Not ready is not empty.** Until the program says `ready`, every route that needs it answers
   503 and the adapter reports `unreachable`. It never reports an empty census. A changed `epoch`
   resets the event cursor.
7. **The bridge cleans every string from the socket.** Titles, item text, `cwd`, `harness` and
   option labels pass through one function that strips controls, the direction marks, the
   zero-width characters and the tag characters, and applies a byte cap. An ask whose title or
   reason was changed by it is marked `cleaned`, and the phone offers no `allow-always` on it. A reply body has a byte cap. The `harness` string is checked
   against the open harness list or shown as plain text. It never picks a screen grammar.
8. **The bridge keeps a log.** Items from the program go into an append-only log per pane in the
   state dir. A `durable` journal adapter reads that log, so Chat and History work as for any
   other harness, and they survive a pane the program has closed.
9. **A pane without a grid is Chat only.** When `paneGrid` is false the Terminal view is hidden,
   and Chat is the only view. The "fall back to the terminal" rule in `chat-gate.ts` does not apply,
   because there is no terminal to fall back to.
10. **One peer, one mux.** A durable program needs its own peer next to a Herdr one. A bridge that
    drives two multiplexers is a larger change and is not part of this one.
11. **The crew protocol does not change.** `CREW_PROTOCOL_VERSION` stays 2. The lead tags the host
    on the merged census as it does for any peer. Anything this adds to the phone API is additive.
12. **A rename is a cap on the wire.** The program owns its layout, so a workspace or a tab is
    renamed only when the program says it takes one: `caps.rename` in the hello, and one route,
    `POST /rename`, with a request id and a refusal of its own (422 `rename-refused`). The adapter
    declares the tab capability `renameTab` from that cap, as it declares `steerTurn`, `abortTurn`
    and `starters` from theirs, so the phone draws its usual rename control with no durable special
    case. A pane is not renamed: its title is the conversation's. `renamePane` stays undeclared.
    A workspace is renamed through a new capability, `renameSpace` (an optional method of the port,
    `POST /api/space/:id/rename`), which only a durable program declares, from the same `caps.rename`.
    The phone draws a Rename row in a new space sheet for it. Added to version 1 before the wire
    shipped, so there is no version 2.
13. **A close is a cap on the wire.** The same rule as a rename: the program owns its layout, so a
    conversation or a tab is closed only when the program says it closes one, `caps.close` in the
    hello and one route, `POST /close`, with a request id and a refusal of its own (422
    `close-refused`). What a close means (archive, delete, end) is the program's call; it removes the
    target and what is inside it, and every open ask on those panes closes as `stopped`, so nothing
    answers itself. The adapter declares the existing `closePane` and `closeTab` from that cap, so the
    phone draws its usual close controls with no durable special case. A workspace close is on the wire
    but has no capability, because the phone has no control for it. Added to version 1 before the wire
    shipped, so there is no version 2.
14. **Program actions are a cap on the wire.** A program lists up to four buttons per conversation
    (`actions` on the pane, with a label of at most 16 characters and one of twelve icon names), and a
    tap is `POST /pane/:id/action` with a request id, the action id and, when the phone has one, the
    turn it saw. The cap is `caps.actions`, and the adapter declares a new capability, `programActions`,
    from it. The route is a third act of ADR 0101's controls, so it has the same receipt, the same
    replay, the same unknown-outcome rule and the same `stale` refusal, and the adapter hands it to
    `controlTurn` as an `action` control. The phone draws the buttons in the durable section of the
    belt, after Steer and Stop. Added to version 1 before the wire shipped, so there is no version 2.
15. **History is the program's, and the session id is its conversation id (M53 spec 11, 2026-10-13).** A
    program that keeps its conversations serves them: `caps.history`, `GET /conversations` and
    `GET /conversation/:id/items`, open and closed, paged by an opaque cursor. `caps.reopen` and
    `POST /reopen` show a closed one again under the same pane id. `Pane.sessionId` is no longer reserved:
    it is the conversation id the program serves history under, or null when the program cannot keep it
    the same across a restart, and the adapter names the pane's session `sessionId ?? pane.id`. The log
    of point 8 keeps that name and becomes a cache: Chat on a live pane still reads it, the read-only view
    of a closed conversation reads the program, and the events reader saves its cursor beside the log, so
    a bridge restart reads nothing twice. The adapter declares `programHistory` and `reopenConversation`
    from the two caps. Additive, so the version stays 1.

## Consequences

- The phone shows a durable conversation in the merged list beside the panes of other machines. It
  opens as Chat. It has no Terminal view, no typed keys and no new-tab button.
- The mux port gains one adapter and no new concept. If the port cannot express a pane without a
  screen without touching every other adapter, this decision is wrong and the work stops.
- An old lead, one older than this decision, merges a `durable` peer and lists its panes. Measured
  on 2026-10-12 against a lead from before this branch. Nothing crashes and nothing is blank, but
  the page is half right:
  - The ask is invisible. `asks` and `turnId` pass through the merged snapshot, but the old web
    bundle draws no card. The only sign is "needs you". The tool call shows as a collapsed "1 other
    step", with no Allow or Deny. ADR 0100 says what the answer route does.
  - Terminal view is still offered. It opens empty, and the page polls `GET /api/pane/:id?lines=600`
    about every two seconds. Each poll gets a 502, "durable read failed". The choice sticks per pane.
  - The actions sheet footer says "Saved copy. Reconnect to make changes." while the bridge is
    connected. The composer, Keys, Type, Quick, attach and mic are disabled.
  - Pane actions are cut to Conversation history, Terminal view, Pane settings and Pin to top.
    The workspace section has no "+" button. The agent badge is the generic "DU".
  - The crew page shows the peer as reachable. `crew status` prints the version skew warning.
  The fix is to update the lead first.
- A program that cannot be reached shows as unreachable with its last known state, not as a machine
  with nothing in it.
- Strings from the program are untrusted, as screen text is. The cleaning function is the single
  place that decides what reaches the page.
- The state dir gains one log per pane. It is written only for a `durable` peer.
- Same-user-only is a real limit. A program that runs as another user, or on another machine, does
  not fit. A remote program is reached through the Collie on its machine, as every machine is
  (ADR 0011). Revisit this decision when a second program, written by someone else, finds the wire
  too narrow.
