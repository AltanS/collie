# The durable wire (experimental)

> **Experimental.** The wire may change, or the feature may be removed, in a later minor release.
> [Versions and the telling hello](#versions-and-the-telling-hello) says how a change reaches you.

The durable wire is how Collie talks to a durable agent. This page explains it for a builder who writes a
durable agent without the SDK, or wants to know what the SDK does. The exact rules are in
[`WIRE.md`](../bridge/mux/durable/WIRE.md), and where this page and that file differ, `WIRE.md` is
right. [The durable SDK](durable-sdk.md) speaks all of it for you.

## What travels

Collie dials and the durable agent listens, and every exchange is one HTTP request with a JSON body.

The durable agent listens on a private Unix socket, or behind TLS at a URL ([Transports](#transports)).
Collie polls it: there is no push, no WebSocket and no stream. Every path starts with `/session/v1`,
which is a fixed name, not the version. Every call but the first `hello` carries the version in the
header `X-Collie-Session`. A request body is one JSON object of at most 64 KiB, and an empty POST
body reads as `{}`.

| method and path | what it does | reply limit |
| --- | --- | --- |
| `GET /hello` | The durable agent's name, version range, epoch, readiness and caps | 16 KiB |
| `GET /snapshot` | The layout: workspaces, tabs, panes with their state, turn and open asks, and starters. Carries an ETag, and answers 304 when nothing changed | 4 MiB |
| `GET /pane/:id/events?after=N&epoch=E` | The pane's events after a cursor | 8 MiB |
| `POST /pane/:id/answer` | An answer to an ask | 16 KiB |
| `POST /pane/:id/send` | Text for the pane, to steer the running turn or wait for the next | 16 KiB |
| `POST /pane/:id/abort` | Stop the running turn | 16 KiB |
| `POST /pane/:id/action` | A tap on one of the pane's belt buttons | 16 KiB |
| `POST /rename` | A new title for a workspace or a tab | 16 KiB |
| `POST /close` | Close a pane, a tab or a workspace | 16 KiB |
| `POST /starter/:id` | Run a starter. The reply names the new pane | 16 KiB |
| `GET /conversations?after=C&limit=N` | The durable agent's conversations, open and closed, newest first | 1 MiB |
| `GET /conversation/:id/items?after=C&limit=N` | One conversation's items, oldest first | 8 MiB |
| `POST /reopen` | Show a closed conversation again | 16 KiB |

Every error is a JSON body with a `code`, such as 409 `stale` or 404 `no-such-pane`. Any other path
answers 404 `not-found`. A reply over its limit is not read, and a POST whose reply is cut has an
unknown outcome ([Request ids](#request-ids)).

## Hello and epoch

`hello` says who the durable agent is, and the epoch says which start of it Collie is talking to.

| field of `hello` | what it holds |
| --- | --- |
| `service` | Exactly `collie-durable`. Without it Collie reads the durable agent as some other server and calls nothing else |
| `protocol` | The range of wire versions the durable agent speaks, `{ min, max }`. Today `{ min: 1, max: 1 }` |
| `host.name` | The durable agent's own name, display text only, at most 64 bytes |
| `epoch` | New and random on every start of the durable agent, at least 128 bits, never reused |
| `ready` | False while the durable agent lays out its panes after a start |
| `caps` | What the durable agent can do, each a boolean. An absent cap is false |

Collie first calls `hello` without the version header, picks the highest version both sides speak,
and sends it on every later call. While `ready` is false, every route but `hello` answers 503
`starting`, and the phone shows the durable agent as starting. A durable agent sets `ready` only once every
conversation is shown again and every open ask raised again, so a restart never shows half a layout.

The snapshot's ETag is `"<epoch>-<rev>"`. `rev` rises on every change a reader could see, so a 304
costs the durable agent next to nothing. A new epoch tells Collie the durable agent restarted. Collie keeps
showing the panes it has until it reads the new snapshot. It then reads each pane with its old
cursor and gets the pane's whole current view in one reply.

One failed read after a good one keeps the last snapshot for that poll. Two failures in a row show
the durable agent as unreachable. A socket path that fails the privacy walk is unreachable at once.

## Asks and answers

An ask is a question card, and it is open from the durable agent's `ask` event until its `ask-closed`.

| state | who sets it | what the phone shows |
| --- | --- | --- |
| Open | The durable agent raises the ask. The pane reads `waiting` while any ask is open | A card under "Needs your answer", with the durable agent's name, and the time left when the ask has `expiresAt` |
| Changed | The durable agent changes the ask in place, and its `revision` rises | The card redraws. A tap on the old form gets 409 `stale`, and the card says "This ask changed. Read it again, then tap an answer." |
| Taken | The phone answers, and the durable agent closes the ask with `by: "phone"` | The card goes, and the tool runs or is denied as the option says |
| Decided in the durable agent | The durable agent closes the ask itself, `decidedBy: "program"`. A stop of the turn counts | A line in Chat that starts "Decided in the durable agent", with the ask's title |
| Timed out | The clock passes `expiresAt`, `decidedBy: "timeout"` | A line in Chat that starts "Timed out before an answer", with the ask's title |

A tap that comes after the decision gets 409 `decided` with the first outcome, and nothing runs. The
card then says who decided first: "Decided in the durable agent.", "Timed out before an answer.", or, after
another tap, "Already answered. This card goes away on the next update." An ask the durable agent does not
know any more answers 200 `too-late`. The card then says "Not taken. The question may show again in a
moment.", because after a restart the durable agent may raise it again under the same id.

| rule | why |
| --- | --- |
| The ask id is a hash of the pane id and the tool call id | The same tool call raised after a restart has the same id, so an answer sent across the restart lands |
| A `permission` card is built from the tool's name and its arguments, never from the model's words | A model that wants a yes would describe the call kindly |
| A durable agent behind TLS should offer no `allow-always` | The token is the only gate, so one answer from whoever holds it would let every later call through |
| The phone offers no `allow-always` on a card whose words were cut or cleaned, or that names no tool | The person cannot see what the grant covers |
| `expiresAt` is ISO 8601 with a zone | Past it the ask is decided by `timeout`, and a snapshot no longer lists it as open |
| The durable agent keeps the outcome of at least its last 500 decided asks per pane | A late tap gets `decided` and the first outcome, not a plain `too-late` |

An ask is one of four kinds: `permission`, `choice`, `text` or `form`. Each has its own answer shape,
listed with the SDK's [Questions](durable-sdk.md#questions).

### Request ids

Every act from the phone has a request id, so it runs at most once.

The phone mints one request id per intent, and Collie writes its own receipt before it passes the id
on. The durable agent keeps at least the last 500 ids of its epoch. A repeat of a finished id gets the first
reply again with `replayed: true` and runs nothing. The same id with another payload gets 409
`request-id-reused`.

Collie never retries a POST by itself. A POST that times out, loses its connection or gets a 5xx has
an unknown outcome. For an answer, the card then says "Not sure the answer arrived. Try again sends
it once more.", and Try again sends the same request id, so the durable agent's memory answers a repeat.

A retry that finds the ask closed or the turn moved cannot tell whether the first try landed. Collie
then answers the phone "maybe applied", the card says "May already be applied. Check the chat.", and
the act is never sent a third time.

## Transports

A durable agent uses one of two transports: a private socket on Collie's machine, or TLS with a token.

The bytes are the same on both: the routes, the bodies, the version header, the ETag and the error
codes. Only who may reach the durable agent differs.

| over the socket | the rule |
| --- | --- |
| Path | Absolute, at most 103 bytes. Both sides read it from `COLLIE_DURABLE_SOCKET` |
| Modes | The socket is mode `0600`, in a folder with mode `0700`. The durable agent removes a stale socket file before it listens |
| The path walk | Before each connect, Collie checks every part of the path with `lstat`. No part is a symlink. The socket's folder is yours with mode `0700`. No folder above it is writable by group or other, except a sticky one such as `/tmp`. The socket is yours, with no group or other permission |
| A failed walk | Collie does not connect, and shows the durable agent as unreachable with `socket-not-private` and the part that failed |
| Token | None. The private socket is the gate |
| Who can act | Any process of your user. The durable agent may refuse its own descendants with 403 `caller-refused` |
| Timeouts | 1000 ms for `hello`, `snapshot` and `events`. 3000 ms for an answer, send, stop, action, rename or close. 30000 ms for a starter |
| How often Collie asks | Every 1 s while a phone watches, else every 3 s. A durable agent that is down is asked once per poll |
| Systems | Linux and macOS. Windows has no socket transport |

| over TLS | the rule |
| --- | --- |
| URL | `https://`, or `http://127.0.0.1:<port>` or `http://localhost:<port>` for a local test. At most 2048 bytes, no user name or password, no query, no fragment. Collie adds `/session/v1` to it |
| Token | At least 32 bytes, printable ASCII with no space. Collie sends `Authorization: Bearer <token>` on every request, `hello` included |
| The durable agent's check | The token first, before the version, `hello` and `ready`, compared in constant time. A missing or wrong token gets a bare 401 `{ "code": "unauthorized" }` and nothing else |
| Redirects | Collie follows none. A 3xx is passed up as a status, so the token never reaches another host |
| ETag | A proxy that compresses a reply may weaken the tag to `W/"<epoch>-<rev>"`. Both sides compare it with the `W/` stripped |
| A refusal | A 401 or 403 shows the durable agent as unreachable with `token-refused` |
| Timeouts | 5000 ms for every read and write, because a durable agent that slept may wake cold. 30000 ms for a starter |
| How often Collie asks | Every 2 s while a phone watches, else every 10 s. A durable agent that is down or refused is asked at most once every 10 s |

Each timeout is a deadline for the whole exchange, from connect to the last byte. Over TLS every
poll is a request your host may bill, a 304 included.

## Limits

Collie cuts or refuses anything past these limits, so a durable agent that stays inside them loses nothing.

| what | limit |
| --- | --- |
| Workspaces per snapshot | 64 |
| Tabs per snapshot | 256 |
| Panes per snapshot | 256 |
| Open asks per pane | 50, the oldest first |
| Options of a `permission` | 6 |
| Options of a `choice`, and of a choice field | 8 |
| Fields of a `form` | 6 |
| Starters per snapshot | 50 |
| Belt buttons per pane | 4, a label of 16 characters |
| An id | 1 to 128 bytes, no control character, no whitespace, none of `/`, `?` or `#` |
| A request body | 64 KiB, else 413 `too-large` |
| Replies | `hello` 16 KiB, `snapshot` 4 MiB, `events` 8 MiB, `conversations` 1 MiB, `items` 8 MiB, a POST 16 KiB |
| Events per reply | 1000. A reader that fell behind gets the current view, at most the newest 2000 items |
| Text of a `user`, `reply`, `thinking` or `notice` item | 64 KiB |
| Text of a `markdown` or `code` item | 32 KiB |
| Text the phone sends | 32 KiB |
| A `link` item | `https://` only, at most 2048 characters |
| A history page | 100 conversations, or 1000 items |
| A history cursor | 512 bytes of printable ASCII, no space |

A string over its limit is cut, and its controls and invisible characters are removed. A list over its
limit keeps its first entries. A history page over its limit is not read at all.

## Versions and the telling hello

Today there is one wire version, 1, and Collie speaks `1..1`.

When version 2 ships, Collie will accept version 1 for one minor release after it, and the minor after
that drops it. A reader ignores a field, an event type, an item kind or a code it does not know. A
field added inside version 1, such as `expiresAt` or `decidedBy`, is optional. A new required field,
a new meaning for an old field, or a removed field needs a new version.

An ask of a kind the phone does not know shows as one it cannot answer from the phone, with no
buttons.

When the two ranges do not meet, Collie reads nothing more from the durable agent. Once per epoch of the
durable agent it sends one more `hello`, this time with its own version, so the durable agent can log the
mismatch on its side. The durable agent answers 409 `incompatible` with a `refusal` that names both ranges.
This is the telling hello.

Collie writes one line in its log for each range it refuses, and `collie doctor` shows both ranges.
The durable agent's home on the phone says the same sentence, for example
"The durable agent speaks wire v2, this Collie speaks v1. Update Collie, or the agent's SDK." Update the older side.

## Where the exact rules are

[`WIRE.md`](../bridge/mux/durable/WIRE.md) is the contract, with every shape, code and rule.

A host with no process of its own, such as a function on Vercel, fills the wire from a log on every
request. Its rules for the epoch, the ask journal and the route are the appendix "A host with no process"
at the end of `WIRE.md`. The appendix is a draft and is not part of version 1.

The decisions behind it are records in the repository:

| record | what it decides |
| --- | --- |
| [ADR 0099](../.adr/0099-a-durable-program-is-a-mux-with-no-screen.md) | A durable agent is a multiplexer with no screen |
| [ADR 0100](../.adr/0100-an-ask-travels-as-data-and-is-answered-by-id.md) | An ask travels as data and is answered by id |
| [ADR 0101](../.adr/0101-a-control-on-a-screenless-pane-names-the-turn-it-saw.md) | Send and stop name the turn the phone saw |
| [ADR 0102](../.adr/0102-starters-are-launcher-rows.md) | Starters are rows on the New page |
| [ADR 0103](../.adr/0103-the-wire-has-two-transports-a-private-socket-or-tls-with-a-token.md) | The two transports |
| [ADR 0104](../.adr/0104-a-program-is-a-session.md) | A durable agent is a session, and the exit |
| [ADR 0105](../.adr/0105-the-durable-sdk-is-an-npm-package.md) | The SDK is an npm package |
