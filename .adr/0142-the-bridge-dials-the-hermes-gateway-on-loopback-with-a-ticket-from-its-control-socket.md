# 0142: the bridge dials the Hermes gateway on loopback, with a ticket from its control socket

- **Status:** Proposed (2026-11-12), not built; for the maintainer to accept or turn down
- **Date:** 2026-11-12, after the arena's leg C against Hermes v0.23.0 Ink and its gateway daemon
- **Shipped in:** pending
- **Trail:** spawning Hermes's own `ui-tui/scripts/gateway_bootstrap.py` to do the peer check ·
  reading the listener's uid through Bun FFI (`SO_PEERCRED` / `LOCAL_PEERCRED`) · one connection held
  open for every send · `client.capabilities {server_requests: true}` · a Hermes plugin calling
  `ctx.inject_message` (measured to fail, ADR 0141) ·
  [ADR 0029](./0029-speech-to-text-is-a-provider-seam-collie-owns.md) ·
  [ADR 0103](./0103-the-wire-has-two-transports-a-private-socket-or-tls-with-a-token.md) ·
  [ADR 0141](./0141-a-door-beats-the-screen-and-the-journal-settles-the-send.md)

## Context

**ADR 0141 sends through an agent's own door, and Hermes's door is its gateway.** Hermes's Ink
front end is a client of a gateway daemon that the person's own Hermes runs. A second client can
attach to the person's live session and submit one user turn: Ink stays attached, a draft in its
composer stays, and the turn lands once with exactly the text (leg C, checks 1 to 7, measured).

**That client is a new outbound call.** The security posture in `CLAUDE.md` names every call the
bridge makes of its own: the update check, the Whistle model, the math pack, the theme registry,
and the durable peer when it is configured. A call that is not named there is a regression, even
on loopback. The pi door is not one: pi's inbox is a Unix socket in the bridge's own state folder,
bound by the person's own extension (ADR 0141).

**The wire, as Ink speaks it.** The gateway's control socket, `$HERMES_HOME/gateway.sock`, answers
`identify` with the gateway's state, its capabilities, an `instance_id`, a loopback `api_origin`
and the served profiles. Its `session-ticket` verb mints a single-use ticket, 30 seconds long, and
only for a peer with the same uid. The ticket opens `ws://<api_origin>/api/ws` with the
subprotocols `hermes-gateway-v1` and `hermes-gateway-ticket.<ticket>`. The gateway refuses a
non-loopback peer and any `Origin` header.

**Hermes's own client checks the control socket's listener uid.** Collie's bridge cannot do that
the way Hermes does: `node:net` exposes no peer credentials, and running Hermes's Python helper
would make the bridge spawn a child for content, which the posture forbids.

## Decision (proposed)

**The bridge may dial the Hermes gateway on loopback, one connection per phone send, and only
with a ticket from a control socket it has checked in its own process.**

1. **It is one named outbound call, and doing nothing declines it.** It happens only when a phone
   send goes to a pane whose door is Hermes's. No gateway running means no control socket, so the
   door is absent (ADR 0141): the send takes the screen path and the receipt names no door. Nothing
   is installed and nothing is configured. The call carries the phone's text and a session id to
   the person's own Hermes on the same host, and nothing else.
2. **The control socket is the trust boundary, and it is checked in the bridge's own process.**
   Before the first byte, the bridge walks the socket's path: `lstat` on every part, no symbolic
   link anywhere, no folder writable by group or other, and the socket owned by the bridge's uid
   with no group or other permission. This is the durable wire's path walk (ADR 0103) with one
   relaxation: `$HERMES_HOME` may be 0755, as Hermes creates it, because no other user can write
   there and so nobody can swap the socket. The ticket is minted only for the same uid, so the
   WebSocket is as private as the socket it came from. No child is spawned for the check.
3. **The WebSocket goes to loopback only.** `api_origin` from `identify` must name `127.0.0.1` or
   `::1` as a literal. Any other host, a name that needs resolving included, is refused before the
   dial. The bridge sends no `Origin` header, and it closes the connection unless the gateway echoes
   `hermes-gateway-v1`.
4. **The door calls four methods and asks for nothing more.** An `interactive` ticket also grants
   approve, respond and control, and no narrower purpose exists. So the door is bounded by what it
   calls: `session.resume`, `prompt.submit`, `prompt.receipt` and `session.detach`, nothing else.
   It never sends `client.capabilities {server_requests: true}`, so the gateway never hands it a
   question or an approval. Those stay the person's, at the desk or on the phone's own ask path.
5. **One connection per send.** The bridge connects, attaches, submits, detaches with no end
   reason, and closes with 1000. A held connection would count as an attached client and keep an
   idle gateway alive (`--idle-exit`). Every `input_id` starts with `collie-`, because the door and
   Ink act as the same principal and share one id space per session.
6. **The door needs the canonical gateway.** It goes ahead only when `identify` reports
   `runtime_protocol` 1 and the capability `session-authority-v1`. An older Hermes, or a gateway
   that does not answer in time, is a door that is absent or refused under ADR 0141's rules, never
   a reason to type blind.

## Consequences

- `CLAUDE.md`'s posture paragraph names this call beside the durable peer: conditional, declined by
  doing nothing, loopback only, and no child.
- `bridge/door/hermes.ts` carries the four rules as tests against a fake gateway: a non-loopback
  `api_origin` is refused with no dial, a link or a group-writable folder in the socket's path is
  refused with no write, the method list is closed, and every connection ends after one send.
- Binding a pane to a Hermes session stays ADR 0141's business. The gateway's session list is not a
  binding: with two Ink panes on one gateway, the session must be the one whose latest turn is on
  this pane's screen and on no other.
- Reading the listener's uid through Bun FFI stays open. It is the exact check Hermes makes, and it
  could replace the path walk later without changing this decision.
- If Hermes moves the gateway off loopback, or drops the control socket's ticket, the door refuses
  and the send takes the screen path, as it does today.
