# 0155: The local API answers a run token

- **Status:** Accepted (2026-11-17)
- **Date:** 2026-11-17
- **Trail:** M105 spec 05, from the counsel on Edge build 5 (2026-11-17, five advisors,
  `experiments/counsel-1.29.0-edge5/RESULTS.md` in the workspace): with tricks on, every program of
  the person, every agent included, could run `collie api read` and read every session's screen.
  They proposed a socket that stands only while a trick needs it; Altan turned that road down ("this
  sounds error prone") and asked instead that only tricks get an answer. Roads turned down: a socket
  that opens per run, the file mode as the only credential (0152 item 6), a token in the
  environment or on the command line, and a reader for a person's own scripts in this release.
  Files: `bridge/tricks/run-tokens.ts`, `bridge/tricks/service.ts` (`runOnce`, `resolveRunToken`),
  `bridge/api/socket.ts` (`RunTokenCheck`, `hello`), `bridge/api/operations.ts` (`HelloArgs`,
  `lowerOf`), `bridge/index.ts`, `cli/trick-kit/trick.ts` (helper v8), `cli/api.ts`,
  `docs/commands.md`, `docs/tricks-reference.md`

## Context

[ADR 0152](./0152-one-event-bus-and-a-local-read-only-api-that-exists-where-a-trick-runs.md) made
the local API a Unix socket that stands while tricks are switched on (item 4), and called it a
convenience for programs of the same Unix user, with the file mode as its only credential (item 6).
[ADR 0154](./0154-the-api-rights-are-one-ordered-vocabulary-and-a-trick-declares-its-level.md) let
a trick declare its level, held by the helper and not by the bridge (item 4), and kept a token per
run for `send` (item 5). So any program that found the socket read at `read`, whatever the tricks
declared. A program of the same user can read panes through the multiplexer anyway; the counsel's
point was that Collie should not hand every agent a screen reader with no trick asking for it.

## Decision

1. **When the socket stands does not change.** 0152 item 4 stands: tricks switched on, on a bridge
   where tricks run. What changes is who gets an answer.
2. **A run token per run.** When the bridge starts a run of a trick whose approved manifest
   declares `access` `see` or `read`, and the socket stands, it makes 32 random bytes (base64url) for
   that run and puts them in the facts on stdin as `api.token`. Never in the environment, on a
   command line, on disk, in a log line, in an answer of the API or on the phone's wire. A trick
   with `access = "none"` gets no token and no socket path.
3. **The bridge holds the table:** token to trick id, level and run, kept as the token's SHA-256 and
   compared in constant time. At most one live token per run. A token dies when its run ends (any
   outcome, a throw included), when its trick is switched off or removed, when tricks are switched
   off, and at bridge stop. The table lives with the trick runner; the socket asks it through one
   narrow function, so `bridge/api/` still imports nothing of `bridge/tricks/`.
4. **Every connection opens with `hello` and the token, within 2 s of the connect.** No token, an
   unknown one, a dead one or no `hello` in time gets one error, `api.no_run_token`, and the connection closes. Nothing runs before a good
   `hello`. A connection holds one token; a `hello` with another is refused and closed. The token is
   asked again at every request and every answer, so a run that ended reads no more.
5. **The level is the bridge's.** A connection holds its token's level under the local ceiling
   `read`; a `see` token is refused `read` with `api.denied`. This changes 0154 item 4 for the API:
   the helper's refusal before the dial stays, as a clear error, and the bridge checks the same
   level. It also changes 0154 item 5: a token per run comes now, for `see` and `read`.
6. **The log names the trick from the token.** A read's log line is `by=trick:<id>`. The caller's
   own `client` word of `hello` is dropped: not an argument any more. A helper of the old shape
   that sends it, and no token, hears `api.no_run_token`, not a bad request.
7. **`collie api` reads nothing in this release.** By hand it prints one line, that the local API
   answers a trick's own run, and exits 3. The command and its help stay, experimental. A reader for
   a person's own scripts comes with the program key (M105 step three), a key a person makes on
   purpose, never by lifting this rule.
8. **The honest words change 0152 item 6.** The token keeps out a program that only finds the
   socket. A program that runs as you can still read a pane through the multiplexer itself, and can
   read another program's memory, a trick's token included. Collie does not stop that, and no text
   calls the token a wall. The file mode and the folder mode still close the socket to other users.

## Consequences

- An agent or a script of the person no longer gets a screen reader by finding THIS socket. That is
  all the token closes. A program of the same user still reads screens in other ways: through the
  multiplexer itself, or by taking a live trick's token out of that run's memory. The owner-only
  `local-secret` file is no longer one of them: the bridge's loopback door answers that key only on
  the routes marked in `LOCAL_KEY_ROUTES` (bridge/local-key.ts), and the snapshot and the tricks list
  answer it a view with the CLI's fields and no screen or message text. A script that read panes with
  it sends a paired device's token (`COLLIE_TOKEN`). The docs say all of this.
- `collie trick check --run` runs outside the bridge with fixture facts and gets no token, so its
  `t.api` answers "off". Minting a token for it would need a door any program of the user could
  knock on the same way, which is what item 4 closes.
- A token lives as long as its run, so a run that holds a connection open for its whole time reads
  for that time. The run's own limits (time, size, the kill at tricks off) bound it.
- Revisit item 7 with the program key. Revisit item 3's ceiling only with `send`, in its own record.
