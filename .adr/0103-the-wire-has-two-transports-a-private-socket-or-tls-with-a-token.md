# 0103: the wire has two transports: a private socket, or TLS with a token

- **Status:** Accepted
- **Date:** 2026-10-13
- **Shipped in:** pending (1.21.0)
- **Amends in scope:** [ADR 0099](./0099-a-durable-program-is-a-mux-with-no-screen.md) points 3 and 4
- **Trail:** people who run their Pi Durable programs on Cloudflare Durable Objects and want them in
  the crew, asked for on 2026-10-13 · [ADR 0099](./0099-a-durable-program-is-a-mux-with-no-screen.md)
  points 3 ("the program listens, and the peer dials") and 4 ("there is no token") ·
  `bridge/mux/durable/WIRE.md` section 1 (the transport) and sections 2.6, 9 and 10.1 (the token
  that was taken out of the spike) · `bridge/mux/tern/adapter.ts` (the Tern socket in
  `$XDG_RUNTIME_DIR`, the precedent for "a private socket is the gate") ·
  `bridge/mux/durable/client.ts` · `bridge/mux/durable/http-client.ts` ·
  `bridge/mux/durable/transport.ts` · `bridge/mux/durable/adapter.ts` (`DURABLE_BUDGETS`) ·
  `cli/durable-findings.ts` · `bridge/config-schema.ts` ·
  `examples/durable-member-cloudflare/` (the deployed example)

## Context

ADR 0099 gave a durable program one way in: a Unix socket with mode 0600, owned by the user who runs
the peer. That gate needs no token, and it is the same gate as the Tern socket. It also means the
program runs on the peer's machine, as the same user.

Many people run their Pi Durable programs somewhere else. A Cloudflare Worker with a Durable Object
keeps a conversation's state in the object's own SQLite storage, wakes it on a request, and serves
it at a public `https://` address. Such a program has no socket on any machine a Collie runs on.
Under 0099 it has two bad routes into the crew:

- **Run a bridge program on a machine with a Collie** that relays between a local socket and the
  Worker. That is a second program to write, run and secure, and it holds the same credential this
  decision would put in the peer, one hop further away.
- **Stay out of the crew.** The person reads the conversation in some other client, and the phone
  never sees the question the tool is waiting on.

When the durable work was first framed on 2026-10-04, it ruled out any outward-facing endpoint. That
still holds for the peer: the peer opens no port. What changes is that the peer may now dial out to
a program the person deployed themselves.

## Decision

**The wire has two transports. A peer uses exactly one: the private socket of ADR 0099 (WIRE.md
1A), or HTTPS to a URL with a bearer token (1B). The bytes on the wire are the same on both.**

1. **Config.** `COLLIE_DURABLE_URL` and `COLLIE_DURABLE_TOKEN` are a pair. Exactly one of
   `COLLIE_DURABLE_SOCKET` or the pair may be set. Both set, a URL without a token, or a token
   without a URL is a config error. The peer still starts, names the error once in its boot line,
   and reports `unreachable` with the same line on every read. `collie doctor` names it in the
   `durable-env` row. The choice is made in one function (`transport.ts`), which the adapter, its
   boot line and `doctor` all call.
2. **The URL.** `https://` only, with one exception: `http://127.0.0.1:<port>` or
   `http://localhost:<port>`, with a port, for `wrangler dev` on the same machine. Any other
   `http://` is refused, and the refusal says the token would cross the network unencrypted. At most
   2048 bytes. No user name or password (a credential in a URL ends up in logs), no query and no
   fragment. An optional path prefix is kept, and the adapter appends `/session/v1/...`.
3. **The token.** At least 32 bytes after a trim, printable ASCII with no space. It is sent on every
   request as `Authorization: Bearer <token>`. It is never logged, never shown in `doctor` beyond
   "set, N bytes", and never put in an error. The client keeps it in an ES private field, so neither
   a log line nor an inspected object can print it. The peer stores nothing about it: it reads the
   environment.
4. **The client.** `DurableHttpClient` sits beside `DurableSocketClient` behind the same
   `DurableTransport` type. It has no path walk. It follows no redirect, so the token never reaches
   another host. The hello check (`service: "collie-durable"` and the version range) runs unchanged.
   A 401 or 403 is `unreachable` with detail `token-refused`, on a read or a write: nothing ran.
5. **The cost decides the cadence.** Every poll over HTTPS is a billed request; on Cloudflare one
   poll is one Worker request and one Durable Object request. The watch runs every 2 s while a phone
   watches and every 10 s otherwise (the socket keeps 1 s and 3 s). Reads and writes get 5000 ms,
   because a Durable Object that slept wakes cold. A program that is down or refuses the token is
   asked at most once every 10 s while its last read failed (down, starting, or refusing the token), so the bridge's fast poll never becomes a stream of billed
   refusals. The two rows sit in one table in the adapter, `DURABLE_BUDGETS`, with the cost written
   beside them.
6. **The hysteresis is the socket's.** A refused token is a transport failure: one after a good read
   keeps the last layout for that read, and the second in a row flips the peer to `unreachable`.
   Nothing about the socket's hysteresis is forked.
7. **The ETag survives a proxy.** A proxy that compresses a reply may weaken the ETag to `W/"..."`.
   The client hands the adapter the strong form, so the next `If-None-Match` is the program's own
   value. WIRE.md says the program MUST compare with `W/` stripped too.
8. **The trust story is written down per transport (WIRE.md section 1).** Under 1A the gate is the
   private socket and the descendant check is the program's option. Under 1B the program has a
   public URL and the token is the only gate. The program MUST check the token first, before the
   version, `hello` and `ready`, MUST compare it in constant time, and MUST refuse everything without
   it with a bare 401. The program-side descendant check does not exist under 1B. A program reached
   over 1B SHOULD NOT offer `allow-always`. The example program keeps Allow and Deny only.
9. **The version stays 1.** No route, body or field changes. A program that speaks 1A today speaks
   the same wire under 1B once it checks the token.

## Consequences

- A person can put a program that runs on Cloudflare, or on any host with a certificate, into the
  crew with two lines in the peer's `.env`. `examples/durable-member-cloudflare/` shows one.
- Anyone who holds the token acts as the phone: they can read every conversation, answer every
  question, send, stop and start. The token does not expire by itself. A program MAY take a second
  token while a rotation runs, so the person rotates without a lockout: the Cloudflare example takes
  `COLLIE_TOKEN` and, while it is set, `COLLIE_TOKEN_NEXT`, both hashed and compared in constant
  time. Set the next token on the program, set it in the peer and restart the peer, then move the
  value to `COLLIE_TOKEN` and unset `COLLIE_TOKEN_NEXT` (amended 2026-10-13).
- The example program reached over 1B refuses `allow-always` outright: its core is made with
  `allowAlways: false`, and an ask with such an option is a `TypeError` when the program raises it.
  The local example keeps the option for the socket, where the descendant check stands beside the
  socket's owner (amended 2026-10-13).
- The host sees the text. TLS ends at the host, and the conversations live in its storage.
- The bridge makes a third kind of outbound call: to the URL the operator configured. It is
  declined by setting nothing, as the speech provider's is.
- A write over HTTPS waits 5000 ms, the same as the crew's budget for a forwarded write. A lead that
  forwards a write to a peer on 1B may report its own `unknown` a moment before the peer would have.
  Both say the same thing to the phone, and the receipt makes "Try again" safe either way.
- A cold program behind 1B can take longer than 1000 ms to answer. Real cold starts were not
  measured when this was written. A program slower than 5000 ms shows as one dropped read, then as
  `unreachable`, never as an empty machine.
- An idle peer reads the program once per 10 s in total: 8,640 Durable Object requests a day, plus
  the Worker requests. Over HTTPS the watch is the only dialer. The bridge's own 12 s safety-net poll
  is answered from the watch's last good read while it is younger than the watch's cadence, and only
  the watch and a person's look (`refresh()`) start a read (amended 2026-10-13; the first text said
  every 5 to 6 seconds, because the safety-net poll dialled too). The docs recommend a paid plan for a
  program polled all day, and say why.
- Revisit this decision if a host needs a second header (an access proxy's service token) or a
  push channel. Both are additive to 1B, not changes to the wire.
