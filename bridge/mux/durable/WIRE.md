# The durable wire, version 1

> **Experimental.** This wire may change in any minor release of Collie, and so may the version
> range the `durable` adapter speaks. A program outside this repository may speak it, on its own or
> through the npm package `@colliepwa/durable-sdk` under the dist-tag `experimental`. The wire is
> experimental. Collie keeps durable agents as a feature, and ADR 0104's exit was withdrawn on 2026-10-28
> (amended 2026-10-28). A new version follows the version
> policy (section 2): Collie accepts the previous version for one minor release after it ships. A
> program and a Collie that do not share a version get a named `incompatible`, so a mismatch is
> visible, not silent.

This document fixes the protocol between two parties:

- **The program.** A durable agent program, for example one built on Pi Durable. It owns its
  conversations, and it **listens**: on a private Unix socket on the peer's machine, or behind TLS
  at a URL the person deployed it to (section 1).
- **The adapter.** The `durable` mux adapter in a Collie peer, one for each program: an entry of
  `sources.json`, or the one program of a durable-only peer (`COLLIE_MUX=durable`). It **dials**
  the program, and it maps what it reads onto the mux port (`bridge/mux/types.ts`).

The decisions behind it are in [ADR 0099](../../../.adr/0099-a-durable-program-is-a-mux-with-no-screen.md)
(the adapter), [ADR 0100](../../../.adr/0100-an-ask-travels-as-data-and-is-answered-by-id.md) (asks),
[ADR 0101](../../../.adr/0101-a-control-on-a-screenless-pane-names-the-turn-it-saw.md) (send and abort),
[ADR 0102](../../../.adr/0102-starters-are-launcher-rows.md) (starters) and
[ADR 0103](../../../.adr/0103-the-wire-has-two-transports-a-private-socket-or-tls-with-a-token.md)
(the two transports). This file is the wire
only. What the bridge does with the data after the adapter (the pane log, the push guard, the phone
routes) is not part of it.

The words MUST, SHOULD and MAY mean what RFC 2119 says.

## 1. Transport

The wire has two transports. A peer uses exactly one: the private socket (1A), or TLS with a bearer
token (1B). The bytes on the wire are the same on both: the routes, the bodies, the version header,
the ETag and every error code. Only how the program is reached, and who may reach it, differ.

| | 1A, a private socket | 1B, TLS with a bearer token |
| --- | --- | --- |
| Peer setting | `COLLIE_DURABLE_SOCKET` | `COLLIE_DURABLE_URL` and `COLLIE_DURABLE_TOKEN` |
| Where the program runs | the peer's machine, as the same user | anywhere the person deployed it, for example a Cloudflare Worker with a Durable Object |
| The gate | a socket only this user can open | the token, compared in constant time |
| Descendant check | program-side, optional | does not exist |
| Read and write budgets | 1000 ms and 3000 ms | 5000 ms and 5000 ms |
| Census, watched and idle | 1 s and 3 s | 2 s and 10 s |

Setting both, or a URL without a token, is a config error: the peer starts, names the error once in
its log, and reports `unreachable` with the same line on every read.

A Collie may run several programs at once, each one entry of its `sources.json` with its own transport
and its own session; nothing on this wire changes for that, and each program sees one caller.

### 1A. A private socket

The socket transport is Linux and macOS. Windows has no socket transport: a Windows peer that is given `COLLIE_DURABLE_SOCKET` dials nothing and reports `unreachable` with a detail that says so; use 1B there.

| Rule | Value |
| --- | --- |
| Socket | One Unix stream socket. No TCP. |
| Path | The adapter reads it from `COLLIE_DURABLE_SOCKET`. It MUST be absolute and at most 103 bytes, the smallest `sun_path` limit of the platforms Collie runs on, less its closing NUL. Unset, relative or too long: the adapter dials nothing and reports `unreachable` with a detail that names the variable. |
| Program config | The program SHOULD read the same variable to choose where it listens, so one value configures both sides. |
| Permissions | The program creates the socket with mode `0600`, in a directory with mode `0700`. It removes a stale socket file at the path before it listens, and removes its own on a clean exit. |
| Who may dial | Only the same user. Before each connect, the adapter walks the path from `/` down with `lstat` (the rules below). Any failure: the adapter does not connect, and reports `unreachable` with detail `socket-not-private: <check>`, where `<check>` names the part that failed, for example `the folder /run/x has mode 0755, not 0700`. |
| Authentication | None. No bearer token, no `Authorization` header. The 0600 socket is the gate. A token belongs to 1B only. |
| Framing | HTTP/1.1 over the socket. Any `Host` header. Every path starts with `/session/v1`. That prefix is a fixed name, not the version. |
| Bodies | JSON, UTF-8, `content-type: application/json`. A request body is one JSON object. An empty POST body reads as `{}`. |
| Version header | `X-Collie-Session: <n>`, a decimal integer. Required on every route except `GET /hello`. |
| Push | None. The adapter polls (ADR 0073). No WebSocket, no server-sent events. |

#### The path walk

A 0600 socket is not private when someone else can swap the folder it sits in. So the adapter checks
every part of the path, not only the socket:

1. **No symlink anywhere.** Every part of the path, the socket included, is read with `lstat`. A
   symlink is refused, even one that points to a good place.
2. **The socket's own folder** MUST be a real folder, owned by the adapter's uid, with mode exactly
   `0700`.
3. **Every folder above it** MUST be a real folder (no symlink) and MUST NOT be writable by group or
   other. Its owner is not checked: under a systemd user service with `PrivateTmp=yes`, root's
   folders such as `/` and `/run` show up as user 65534. A folder with the sticky bit, such as
   `/tmp`, is allowed above the socket's folder, never as that folder.
4. **The socket** MUST be a socket, owned by the adapter's uid, with no group or other permission
   bits.
5. **A platform with no uid** (Windows) fails closed: the adapter never dials.

#### What the socket does not protect against

The socket keeps out other users. It does not keep out the same user. Any process that runs as the
same user can open the socket, read every pane and answer an ask, and that includes a tool the agent
runs. Collie cannot tell such a process from itself.

The program owns that defence. It SHOULD refuse a caller that is its own descendant (it can read the
peer's credentials on the socket), or run the agent's tools in a sandbox that cannot reach the
socket. The descendant check is program-side and optional: the adapter does not run it and cannot
tell whether a program does. A program that refuses answers 403 `caller-refused` (section 3). An `allow-always` option is the grant that needs the most care: one answer from a hostile
tool would let every later call through without a question.

**A program on Node cannot run the descendant check.** The check reads the caller's process id off the
socket (`SO_PEERCRED`), and Node has no way to read it. The SDK's Node entry
(`@colliepwa/durable-sdk/node`, `packages/durable-sdk/src/node`) serves the same wire on the same
private socket without the check, and writes one line at start that says so. Such a program SHOULD run the agent's tools in a
sandbox that cannot reach the socket. Bun on Linux can read the caller, and the SDK's Bun entry runs
the check there.

### 1B. TLS with a bearer token

For a program the person deployed themselves, behind TLS, and that Collie dials out to. The program
has a public URL, so the token is the whole gate.

| Rule | Value |
| --- | --- |
| Connection | HTTPS. The adapter verifies the certificate as any client does; there is no switch to turn that off. |
| URL | The adapter reads it from `COLLIE_DURABLE_URL`. It MUST start with `https://`, with one exception: `http://127.0.0.1:<port>` or `http://localhost:<port>`, with a port, for a local test such as `wrangler dev`. Any other `http://` is refused with the reason. At most 2048 bytes. No user name or password, no query, no fragment. An optional path prefix is kept, and the adapter appends `/session/v1/...` to it. |
| Token | The adapter reads it from `COLLIE_DURABLE_TOKEN`. At least 32 bytes after a trim, printable ASCII with no space. It goes as `Authorization: Bearer <token>` on every request, `hello` included. The adapter never logs it, never shows it in `collie doctor` beyond "set, N bytes", and never puts it in an error. |
| Program check | The program MUST check the token before anything else: before the version, before `hello`, before `ready`. It MUST compare in constant time. A request without the token, or with another one, gets **401** `{ "code": "unauthorized" }` and nothing else: no range, no epoch, no route. Nothing runs. |
| Redirects | The adapter follows none. A 3xx is passed up as a status, so the token never reaches another host. |
| Framing, bodies, version header, push | As in 1A. Any HTTP version the host speaks. |
| ETag | A proxy that compresses a reply may weaken the ETag to `W/"<epoch>-<rev>"`. The adapter strips `W/` before it sends the tag back, and the program MUST compare `If-None-Match` with any `W/` stripped (section 7.1). |
| Refusal | A **401** or **403** is `unreachable` with detail `token-refused: the program answered <status>`, on a read or a write. Nothing ran. The hysteresis of section 8.8 applies, and a program that refuses is asked again at most once every 10 s. |

#### What the token does not protect against

- **Anyone who holds the token acts as the phone.** They can read every pane, answer every ask, send
  text, stop a turn, rename or close a workspace, a tab or a conversation and run a starter. There is nothing else to check: the descendant check of 1A
  needs the caller's credentials on a local socket, and a TLS connection from the internet has none,
  so under 1B it does not exist.
- **The host sees the text.** TLS ends at the host (on Cloudflare, at Cloudflare's edge). Transcripts,
  tool output and the program's own model key sit with the host.
- **A token does not expire by itself.** The person rotates it by deploying a new token to the
  program and setting the same value in the peer's `COLLIE_DURABLE_TOKEN`, then restarting the
  peer. A program MAY take a second token while a rotation runs, so the peer keeps working while it
  moves: the Cloudflare example takes `COLLIE_TOKEN` and, while it is set, `COLLIE_TOKEN_NEXT`, and
  compares both in constant time.
- **A public URL is billed when it is hit.** Requests with a wrong token still reach the host. A
  program SHOULD refuse them before it wakes any state.

A program reached over 1B SHOULD NOT offer `allow-always`: with the token as the only gate, one
answer from whoever holds it would let every later call through. The example program keeps Allow and
Deny only on both transports, and the Cloudflare example refuses the option outright: an ask that
carries it is a `TypeError` when the program raises it.

## 2. Version negotiation

1. The program speaks a range `{ min, max }`. This document is version **1**. A program that
   implements it reports `{ "min": 1, "max": 1 }`.
2. The adapter first calls `GET /hello` **without** the version header. `hello` always answers 200
   to that call, ready or not.
3. The adapter picks the highest version inside both ranges, and sends it in `X-Collie-Session` on
   every later call, including later `hello` calls.
4. No overlap: the adapter calls nothing else on the wire, except one telling `hello` (the version
   policy below). It reports `unreachable` with detail
   `incompatible: program speaks <min>..<max>, this Collie speaks 1..1`. It never shows an empty
   census for this case.
5. A call with a missing header (other than `hello`), a non-integer header, or a version outside
   the program's range gets **409** `{ "code": "incompatible", "range": { "min", "max" } }`. Never a
   5xx. `hello` with a header outside the range gets the same 409. When the header is an integer,
   the program SHOULD add `refusal`, a `VersionRefusal` (section 4) that names both ranges.
6. A **401** over the socket (1A) means the program asks for a token, which the socket does not
   carry. The adapter reports it as `incompatible` with detail `program asks for a token`. Over TLS
   (1B) a **401** or **403** means the program refused the token: `unreachable`, detail
   `token-refused`, before any version check (section 1B).
7. A `hello` without `service: "collie-durable"` is not a durable program: some other server
   listens at the path. The adapter calls nothing else and reports `unreachable` with detail
   `incompatible: not a durable program`.
8. **A receiver ignores unknown fields.** This is the one statement of the rule, for both sides and
   every shape: a reader MUST ignore a field, an event `type`, an item kind or a code it does not
   know, and every other section points here. A field is additive and optional. A new required
   field, a new meaning for an old field, or a removed field needs a new version.

### The version policy

Collie speaks one wire version, N, and accepts N-1 for one minor release after N ships. The minor
after that drops N-1. Today N is 1 and there is no N-1, so Collie speaks `1..1`.

| The program's range | What happens |
| --- | --- |
| contains N | N is spoken. |
| contains N-1 but not N, inside the minor after N shipped | N-1 is spoken. |
| contains neither | Refused, as below. |

A refusal is one object, the same on both sides:

```ts
interface VersionRefusal {
  code: "version";
  /** Collie's range, [N-1, N] (or [N, N] when it accepts no N-1). */
  collie: [number, number];
  /** The program's own range, [min, max]. */
  program: [number, number];
}
```

- **Collie's side.** The adapter writes one log line for each range it refuses, not one per poll, and
  keeps the refusal for the bridge. The pane list SHOULD show one notice row in place of the program's
  panes: `The durable agent speaks wire v<max>, this Collie speaks v<N>. Update Collie, or the agent's SDK.`, where `<max>` is the
  program's newest version.
- **The program's side.** Once per program epoch, the adapter sends one more `GET /hello`, this time with
  `X-Collie-Session: <N>`. The program answers it 409 `incompatible` (point 5), with `refusal`, and
  SHOULD write one line in its own log. A program that does not add `refusal` still gets the 409, so the
  telling `hello` is safe against every version 1 program. The adapter reads nothing from the reply.
- Nothing else changes: no snapshot, no event, no POST to a refused program.

The program checks in this order: version (409), then `hello`, then ready (503 `starting`), then
the route (404). Over TLS (1B) the token (401) comes before all of them.

## 3. Routes

All paths below sit under `/session/v1`. `:id` is one URL path segment, percent-encoded by the
adapter and decoded once by the program. Every route except `hello` answers **503**
`{ "code": "starting" }` while `ready` is false.

| Method and path | Request | 200 response | Errors |
| --- | --- | --- | --- |
| `GET /hello` | none; version header optional | `Hello` | 409 `incompatible` (header present and out of range) |
| `GET /snapshot` | optional `If-None-Match: <etag>` | `Snapshot`, with `ETag: "<epoch>-<rev>"`. **304** with the same `ETag` and no body when it matches. | 409 `incompatible`, 503 `starting` |
| `GET /pane/:id/events?after=N&epoch=E` | `after`: a cursor, integer ≥ 0. `epoch`: the epoch the cursor came from. Both required. | `EventsReply` | 400 `bad-cursor`, 404 `no-such-pane`, 409 `incompatible`, 503 `starting` |
| `POST /pane/:id/answer` | `AnswerRequest` | `AnswerReply` | 400 `bad-body`, 400 `bad-id`, 400 `bad-option`, 403 `caller-refused`, 404 `no-such-pane`, 409 `decided`, 409 `stale`, 409 `request-id-reused`, 409 `not-supported`, 413 `too-large`, 503 `starting` |
| `POST /pane/:id/send` | `SendRequest` | `ControlReply` | 400 `bad-body`, 400 `bad-id`, 403 `caller-refused`, 404 `no-such-pane`, 409 `stale`, 409 `request-id-reused`, 409 `not-supported`, 413 `too-large`, 503 `starting` |
| `POST /pane/:id/abort` | `AbortRequest` | `ControlReply` | 400 `bad-body`, 400 `bad-id`, 403 `caller-refused`, 404 `no-such-pane`, 409 `stale`, 409 `request-id-reused`, 409 `not-supported`, 413 `too-large`, 503 `starting` |
| `POST /pane/:id/action` | `ActionRequest` | `ControlReply` | 400 `bad-body`, 400 `bad-id`, 403 `caller-refused`, 404 `no-such-pane`, 404 `no-such-action`, 409 `stale`, 409 `request-id-reused`, 409 `not-supported`, 413 `too-large`, 422 `action-refused`, 503 `starting` |
| `POST /rename` | `RenameRequest` | `ControlReply` | 400 `bad-body`, 400 `bad-id`, 403 `caller-refused`, 404 `no-such-target`, 409 `request-id-reused`, 409 `not-supported`, 413 `too-large`, 422 `rename-refused`, 503 `starting` |
| `POST /close` | `CloseRequest` | `ControlReply` | 400 `bad-body`, 400 `bad-id`, 403 `caller-refused`, 404 `no-such-target`, 409 `request-id-reused`, 409 `not-supported`, 413 `too-large`, 422 `close-refused`, 503 `starting` |
| `POST /starter/:id` | `StarterRequest` | `StarterReply` | 400 `bad-body`, 400 `bad-id`, 403 `caller-refused`, 404 `no-such-starter`, 409 `request-id-reused`, 409 `not-supported`, 413 `too-large`, 422 `starter-failed`, 503 `starting` |
| `GET /conversations?after=C&limit=N` | `after`: the `next` of the page before, absent for the first page. `limit`: 1 to 100, default and most 100. | `ConversationsReply` | 400 `bad-cursor`, 409 `incompatible`, 409 `not-supported`, 503 `starting` |
| `GET /conversation/:id/items?after=C&limit=N` | `after` as above. `limit`: 1 to 1000, default and most 1000. | `ConversationItemsReply` | 400 `bad-cursor`, 404 `no-such-conversation`, 409 `incompatible`, 409 `not-supported`, 503 `starting` |
| `POST /reopen` | `ReopenRequest` | `ControlReply` | 400 `bad-body`, 400 `bad-id`, 403 `caller-refused`, 404 `no-such-target`, 409 `request-id-reused`, 409 `not-supported`, 413 `too-large`, 422 `reopen-refused`, 503 `starting` |

Any other method or path answers 404 `not-found`.

Every pane in a `Snapshot` MAY carry `sessionId: string | null`: the conversation id the program
serves the pane's history under (section 7.16). A program that cannot keep that id the same across a
restart sends null. The adapter names the pane's session `sessionId`, or the pane id when it is null,
absent or breaks the id rule, and the bridge keeps its own log of the pane under that name.

### Error codes

Every error body is a `Problem` (section 4).

| Status | Code | Meaning | What the adapter does |
| --- | --- | --- | --- |
| 400 | `bad-json` | The body is not JSON. | A bug on the adapter side. Refused, not retried. |
| 400 | `bad-body` | A field is missing, has the wrong type, or is over its cap. `turnId` and `askId` both present, or both absent. | Same. |
| 400 | `bad-id` | An id in the body breaks the id rule (section 6). | Same. |
| 400 | `bad-option` | `optionId` is not one of the ask's options. | Same. |
| 400 | `bad-cursor` | `after` is not an integer ≥ 0, or `epoch` is missing. On a history route (7.16): `after` is not a cursor the program gave, or `limit` is not a whole number from 1. | Same. |
| 401 | (any) | Over the socket (1A): a program that wants a token, which the socket does not carry. Over TLS (1B): the token is missing or wrong. | 1A: `incompatible`, see section 2. 1B: `unreachable`, detail `token-refused`. |
| 403 | `caller-refused` | Over the socket (1A), on `answer`, `send`, `abort`, `action`, `rename`, `close`, `reopen` and `starter`: the program decided the caller is itself or a process below it (the descendant check, section 1A). Nothing ran. | Refused, with a detail that names the code. Never retried. |
| 403 | (any) | Over TLS (1B): something in front of the program refused the caller, for example an access proxy. | `unreachable`, detail `token-refused`. |
| 404 | `not-found` | Unknown route. | Refused. |
| 404 | `no-such-pane` | The pane is not in the program's layout. | `gone`. |
| 404 | `no-such-target` | The workspace, tab or pane of a `rename` or a `close` is not in the program's layout. The conversation of a `reopen` is not one the program knows. | `gone`. |
| 404 | `no-such-conversation` | The conversation of a history read is not one the program knows (section 7.16). | `gone`. |
| 404 | `no-such-action` | The pane does not list this action (section 7.10). | Refused, with a detail that says the conversation has no such action. |
| 404 | `no-such-starter` | The starter is not in the program's list. | Refused. |
| 409 | `incompatible` | Version outside the range. Carries `range`, and `refusal` when the header was an integer (section 2). | `unreachable`, detail `incompatible`. Never retried at the same version. |
| 409 | `decided` | On `answer`: the ask was already decided, by the phone, by the program or by its `expiresAt` (section 7.3). Carries `outcome`, the first decision. Nothing ran. | Read as `too-late`. Never retried. |
| 409 | `stale` | The `turnId`, `askId` or ask `revision` is not current (for an `action`, the `turnId` when the request carried one). Carries the current `turnId` and `askIds`, and `ask` for an answer. | Passed up as a stale refusal. The phone reloads. Never retried by the adapter. |
| 409 | `request-id-reused` | The `requestId` was already used for a different route, pane, target or starter. | Refused. |
| 409 | `not-supported` | The cap for this act is false, or this pane cannot take it (for example no send handler). | Refused. |
| 413 | `too-large` | The request body is over 64 KiB. | Refused. |
| 422 | `rename-refused` | The program said no to this title for this target. Nothing changed and nothing was stored for the request id. | Refused, with the program's `message` when it sent one. The same request id may run again. |
| 422 | `action-refused` | The program said no to running this action now. Nothing changed and nothing was stored for the request id. | Refused, with the program's `message` when it sent one. The same request id may run again. |
| 422 | `close-refused` | The program said no to closing this target. Nothing changed and nothing was stored for the request id. | Refused, with the program's `message` when it sent one. The same request id may run again. |
| 422 | `reopen-refused` | The program said no to showing this conversation again. Nothing changed and nothing was stored for the request id. | Refused, with the program's `message` when it sent one. The same request id may run again. |
| 422 | `starter-failed` | The starter ran and failed. Carries `message`. Nothing was stored for the request id. | Refused, with the message. The same request id may run again. |
| 503 | `starting` | `ready` is false. | `unreachable`, detail `starting`. Asks `hello` again on the next poll. |
| 500 | `internal` | A bug in the program. | A read: `unreachable` for this poll. A POST: outcome unknown (section 7.6). |

## 4. Types

Every shape, in TypeScript. `string` is UTF-8 JSON text. Every number is a non-negative integer no
larger than 2^53 - 1, unless the comment says otherwise. A field marked `?` may be absent. A reader
MUST treat `null` the same as absent.

```ts
// ── hello ─────────────────────────────────────────────────────────────────────

interface ProtocolRange {
  min: number;
  max: number;
}

interface Hello {
  /** MUST be exactly "collie-durable". Absent or other: the adapter refuses the program (section 2). */
  service: "collie-durable";
  protocol: ProtocolRange;
  /** Display text only. Never an address and never an identity. */
  host: { name: string };
  /** New and random on every start of the program. At least 128 bits. Never reused. */
  epoch: string;
  /** False while the program lays out its panes after a start (section 8). */
  ready: boolean;
  caps: Caps;
}

/** What the program can do. An absent cap is false. */
interface Caps {
  asks?: boolean;      // it raises asks and takes answers
  starters?: boolean;  // it lists starters and runs them
  send?: boolean;      // it takes text
  steer?: boolean;     // it can steer text into a running turn (needs send)
  abort?: boolean;     // it can stop a running turn
  rename?: boolean;    // it takes a new title for a workspace or a tab (section 7.8)
  close?: boolean;     // it closes a workspace, a tab or a pane (section 7.9)
  actions?: boolean;   // it lists actions on a pane and runs one when asked (section 7.10)
  history?: boolean;   // it serves its conversations, open and closed, and their items (section 7.16)
  reopen?: boolean;    // it shows a closed conversation again when asked (section 7.16)
  terminal?: boolean;  // MUST be false or absent in version 1. The adapter ignores it.
}

// ── snapshot ──────────────────────────────────────────────────────────────────

interface Snapshot {
  /** Rises on every change a reader could see (section 7.1). Restarts with the epoch. */
  rev: number;
  epoch: string;
  /** In the program's own order. The adapter numbers spaces from this order, 1-based. */
  workspaces: Workspace[];
  /** In the program's own order. */
  tabs: Tab[];
  panes: Pane[];
  /** Empty or absent when `caps.starters` is false. */
  starters?: StarterRow[];
}

interface Workspace {
  id: string;
  title: string;
  /** Absolute. Ignored when not absolute. */
  cwd?: string;
}

interface Tab {
  /** Unique across the whole program, not only inside its workspace. */
  id: string;
  workspaceId: string;
  title: string;
}

interface Pane {
  /** The conversation id. The same across a restart of the program. */
  id: string;
  workspaceId: string;
  tabId: string;
  /** What the program calls this conversation. Not an operator label. */
  title: string;
  /** Advisory text only, for example "pi". It never selects a parser, a grammar or a journal. */
  harness: string;
  state: PaneState;
  /** Milliseconds since the Unix epoch. */
  lastActiveAt: number;
  /**
   * The newest turn of this pane: the one running now, or the last one that ran. A pane that has
   * never run still carries one, minted when the pane was made. It changes when a new turn starts.
   */
  turnId: string;
  /** Every open ask, oldest first. Empty when none. */
  openAsks: Ask[];
  /**
   * The conversation id the program serves this pane's history under (section 7.16), following the id rule.
   * Null when the program cannot keep it the same across a restart. Section 3 says how the adapter reads it.
   */
  sessionId?: string | null;
  /** Absolute. Falls back to the workspace `cwd`, then to "". */
  cwd?: string;
  /**
   * One line under the title, so a list of conversations reads at a glance (section 7.11). Trimmed, at
   * most 120 characters, no control character. A bad value reads as absent.
   */
  subtitle?: string;
  /**
   * A small mark next to the title: `{ count }` (an integer from 0 to 9999) or `{ text }` (at most 12
   * characters). Exactly one key. A bad value reads as absent (section 7.11).
   */
  badge?: { count: number } | { text: string };
  /**
   * How far a working conversation is: a list of steps, or a percent (section 7.12). A bad value reads
   * as absent. The phone draws it only while `state` is `working` or `waiting`.
   */
  progress?:
    | { kind: "steps"; steps: { label: string; state: "done" | "running" | "todo" }[] }
    | { kind: "percent"; value: number; label?: string };
  /**
   * The buttons the phone draws in the program's section of the belt, in this order (section 7.10). At most 4;
   * a longer list is cut to its first 4. Absent or empty: no buttons. Ignored unless `caps.actions` is true.
   */
  actions?: PaneAction[];
}

type PaneState = "working" | "waiting" | "idle";

/** One program-defined belt button. */
interface PaneAction {
  /** The id the phone sends back. Follows the id rule. Unique inside the pane: a repeated id is dropped. */
  id: string;
  /** 1 to 16 characters (code points), cleaned and cut. An action whose label is empty after cleaning is dropped. */
  label: string;
  /** One of the twelve names below. Any other value draws no icon. */
  icon?: ActionIcon;
  /** Running now: the phone shows a spinner and sends no tap. */
  busy?: boolean;
  /** Not available now: the phone dims the button and sends no tap. */
  disabled?: boolean;
}

type ActionIcon = "play" | "pause" | "check" | "x" | "refresh" | "archive" | "flag" | "star" | "send" | "note" | "search" | "more";

interface StarterRow {
  id: string;
  label: string;
}

// ── asks ──────────────────────────────────────────────────────────────────────

interface Ask {
  /**
   * At least 128 bits. SHOULD be derived from the pane and the tool call (section 6), so the same tool
   * call raised again after a restart has the same id. A random one is allowed.
   */
  id: string;
  /**
   * What the person is asked (section 7.14). A reader shows an ask of another kind as not answerable.
   * `permission` is the tool-call question of version 1. `choice`, `text` and `form` are the others.
   */
  kind: "permission" | "choice" | "text" | "form";
  /**
   * The program's id for what the ask is about. The same across a restart. For a `permission` it is the
   * tool call. For any other kind it is any id of the program's own that is stable across a restart, such
   * as the id of the step that asks. The adapter keys its one push per question on it (ADR 0100).
   */
  toolCallId: string;
  /** Starts at 1. Rises when the program changes this ask in place. */
  revision: number;
  /** One line the card leads with, for example "write_note wants to write /tmp/notes.txt". */
  title: string;
  /** The item this ask belongs to, usually the tool item. The card sits under it. */
  itemId: string;
  /**
   * A `permission`: at least one, at most 6, each with an `effect`. A `choice`: 1 to 8, none with an
   * `effect`. A `text` and a `form`: none, and the member may be left out.
   */
  options: Option[];
  /** A `choice` only: more than one option may be picked. Default false. */
  multiple?: boolean;
  /** A `text` only: the hint in the empty field. At most 60 characters. */
  placeholder?: string;
  /** A `text` only: the most characters the answer may have, 1 to 2000. Default 500. */
  maxLength?: number;
  /** A `form` only: 1 to 6 fields. */
  fields?: Field[];
  /** Longer text under the title. */
  reason?: string;
  /** The call itself, when the program wants it drawn. */
  tool?: ToolCall;
  /**
   * True when the title or the reason was shortened. The program MAY set it when it cut its own text.
   * The adapter also sets it when its cleaning changed either (section 6). The phone then says "Text
   * shortened" and offers no `allow-always` option, because the person cannot see the whole request.
   */
  cleaned?: true;
  /**
   * The words for a notification about this ask: a `title` of at most 60 characters and a `line` of at
   * most 120 (section 6). The bridge MAY use them and falls back to its own text. Each part is optional.
   */
  push?: { title?: string; line?: string };
  /**
   * ISO 8601 with a zone. Past it, the ask is decided by `timeout`: the program closes it, and a reader
   * that still holds it drops it on the next snapshot read (section 7.3). Absent: it waits for a person.
   * A value that is not a time reads as absent.
   */
  expiresAt?: string;
}

interface Option {
  /** Unique inside its ask. */
  id: string;
  label: string;
  /** On a `permission` option only. A `choice` option, and an option of a form field, has none. */
  effect?: "allow" | "allow-always" | "deny" | "cancel";
}

interface Field {
  /** Unique inside its ask. The key of the field's value in the answer. */
  id: string;
  label: string;
  kind: "text" | "choice" | "toggle";
  required?: boolean;
  /** A `choice` field: 1 to 8 options, none with an `effect`. A pick answers with the option's `id`. */
  options?: Option[];
  /** A `text` field: 1 to 2000 characters. Default 500. */
  maxLength?: number;
}

// ── items and events ──────────────────────────────────────────────────────────

interface ToolCall {
  kind: "other";
  name: string;
  /** One line: the arguments, shortened. */
  summary: string;
  output?: string;
}

type ToolStatus = "running" | "done" | "failed" | "denied";

/** An item with a known id replaces the earlier one (a tool changes status, a reply grows). Ids are unique per pane. */
type Item =
  /** `requestId`: the request id of the send that made this line, when the program knows it (section 7.15). */
  | { id: string; ts?: string; kind: "user"; text: string; requestId?: string }
  /** `partial`: the text is still growing, and the same id comes again (section 7.15). */
  | { id: string; ts?: string; kind: "reply" | "thinking" | "notice"; text: string; partial?: true }
  /** Rendered as markdown (section 7.13). */
  | { id: string; ts?: string; kind: "markdown"; text: string; partial?: true }
  /** A fenced code block. `lang` is a plain name such as "ts" or "c++". */
  | { id: string; ts?: string; kind: "code"; lang?: string; text: string }
  /** A link to an `https://` address. `label` is the words the phone shows for it. */
  | { id: string; ts?: string; kind: "link"; href: string; label?: string }
  | { id: string; ts?: string; kind: "tool"; tool: ToolCall; status: ToolStatus };
// `ts`: ISO 8601 with a zone, for example "2026-10-12T09:30:00.000Z".

/** `phone`: an answer on the answer route. `stopped`: anything else (a stop, the program, a timeout). */
type ClosedBy = "phone" | "stopped";

/** Who decided an ask (section 7.3). `phone` goes with `by: "phone"`; `program` and `timeout` with `by: "stopped"`. */
type DecidedBy = "phone" | "program" | "timeout";

/** The receipt of a decided ask: the first decision, who made it and when. */
interface AskOutcome {
  decidedBy: DecidedBy;
  /** ISO 8601. */
  decidedAt: string;
  /** A `permission` the phone answered: the option it took, and that option's effect. */
  optionId?: string;
  effect?: "allow" | "allow-always" | "deny" | "cancel";
}

type SessionEvent =
  | { type: "item"; item: Item }
  | { type: "remove"; id: string }
  /** A new open ask, or a known `id` with a higher `revision` that replaces it. */
  | { type: "ask"; ask: Ask }
  /** `decidedBy` and `decidedAt`: the receipt (section 7.3). An older program sends neither. */
  | { type: "ask-closed"; askId: string; by: ClosedBy; waitedMs?: number; decidedBy?: DecidedBy; decidedAt?: string }
  | { type: "state"; state: PaneState }
  /** An input reached its end. `requestId` is present when the input came with one. */
  | { type: "settled"; inputId: string; requestId?: string; status: "answered" | "unanswered"; reason?: string }
  /** What follows replaces what the reader held for this pane (section 7.2). */
  | { type: "reset" }
  /** The history sent so far is complete. What follows is live. */
  | { type: "synced" };
// An event `type` a reader does not know is ignored (section 2, point 8).

interface EventsReply {
  epoch: string;
  events: SessionEvent[];
  /** The cursor after the last event in `events`. Send it as the next `after`. */
  next: number;
  /** True when the caller's epoch was not current, or its cursor fell outside the tail (section 7.2). */
  reset?: boolean;
  /** True when more events are ready past `next`. Ask again at once. */
  more?: boolean;
  /** In a reset reply: how many older items were left out to keep inside the item cap. */
  trimmed?: number;
}

// ── requests and replies ──────────────────────────────────────────────────────

interface AnswerRequest {
  requestId: string;
  askId: string;
  /** The revision the phone saw. */
  revision: number;
  /**
   * Exactly one shape, by the kind of the ask (section 7.14): `optionId` for a `permission`, `optionIds`
   * for a `choice` (one id when it is not `multiple`), `text` for a `text` ask, `values` for a `form`.
   */
  answer:
    | { optionId: string; note?: string }
    | { optionIds: string[] }
    | { text: string }
    | { values: Record<string, string | string[] | boolean> };
}

interface AnswerReply {
  /**
   * "too-late": the ask id is not open on this pane and the program holds no outcome for it (stopped, or from
   * before a restart). An ask it decided and still remembers gets 409 `decided` instead (section 7.3).
   */
  result: "taken" | "too-late";
  /** This request id was seen before. Nothing ran a second time. */
  replayed?: true;
}

/** Exactly one of `turnId` and `askId`. */
interface SendRequest {
  requestId: string;
  text: string;
  /** When a turn is running: steer into it (true) or queue a follow-up (false, the default). When idle: no effect. */
  steer?: boolean;
  turnId?: string;
  askId?: string;
}

/** Exactly one of `turnId` and `askId`. */
interface AbortRequest {
  requestId: string;
  turnId?: string;
  askId?: string;
}

interface ControlReply {
  ok: true;
  replayed?: true;
}

/** A new title for a workspace or a tab. A pane's title is the conversation's, and is not renamed. */
interface RenameRequest {
  requestId: string;
  kind: "workspace" | "tab";
  /** The workspace id, or the tab id as the snapshot lists it. */
  id: string;
  /** Trimmed, 1 to 120 characters, no control character (section 7.8). */
  title: string;
}

/** Close a workspace, a tab or a pane. What "close" means (archive, delete, end) is the program's call. */
interface CloseRequest {
  requestId: string;
  kind: "pane" | "tab" | "workspace";
  /** The pane id, the tab id as the snapshot lists it, or the workspace id. */
  id: string;
}

/** Run one of a pane's actions. `turnId`, when sent, is the turn the phone saw. */
interface ActionRequest {
  requestId: string;
  /** One of the ids the pane lists. */
  actionId: string;
  turnId?: string;
}

/** Show a closed conversation again (section 7.16). */
interface ReopenRequest {
  requestId: string;
  /** A conversation id, as `ConversationRow.id` lists it. */
  id: string;
}

interface StarterRequest {
  requestId: string;
}

interface StarterReply {
  /** The new conversation's pane. It is in the next snapshot. */
  paneId: string;
  replayed?: true;
}

// ── history (section 7.16) ────────────────────────────────────────────────────

/** One conversation of the program's own record, open or closed. */
interface ConversationRow {
  /** The conversation id: the `sessionId` of the pane that shows it while it is open. */
  id: string;
  title: string;
  /** One line under the title, the same rule as `Pane.subtitle`. */
  subtitle?: string;
  /** Where the conversation is shown, or was, when the program places it. */
  workspaceId?: string;
  tabId?: string;
  /** ISO 8601. */
  startedAt: string;
  /** ISO 8601. Absent while the conversation is open. */
  endedAt?: string;
  /** Open while a pane in the layout shows it. */
  state: "open" | "closed";
  /** How many items `GET /conversation/:id/items` serves for it. */
  items: number;
}

/** Newest first. `next` absent: the last page. */
interface ConversationsReply {
  items: ConversationRow[];
  /** An opaque cursor: 1 to 512 bytes of printable ASCII, no space. */
  next?: string;
}

/** Oldest first. The same `Item` shapes as a pane's events. */
interface ConversationItemsReply {
  items: Item[];
  /** As above. */
  next?: string;
  /** True when `next` names a page of newer items. */
  more: boolean;
}

// ── errors ────────────────────────────────────────────────────────────────────

interface Problem {
  code: string;
  message?: string;
  /** With `incompatible`. */
  range?: ProtocolRange;
  /** With `incompatible`, when the version header was an integer (section 2). */
  refusal?: VersionRefusal;
  /** With `decided`: the first decision (section 7.3). */
  outcome?: AskOutcome;
  /** With `stale`: the pane's current turn and open ask ids. */
  turnId?: string;
  askIds?: string[];
  /** With `stale` on an answer, when the ask is still open: its current form. */
  ask?: Ask;
}
```

## 5. State mapping

The adapter maps each pane onto `MuxPane.status`, which is the `AgentStatus` that reaches the phone
on `PaneWire` (`idle | working | blocked | done | unknown`).

| What the adapter sees | Collie status | Notes |
| --- | --- | --- |
| `state: "working"` | `working` | |
| `state: "waiting"` | `blocked` | The program MUST report `waiting` while any ask is open. |
| `openAsks` is not empty, whatever `state` says | `blocked` | Asks win. A program that forgets `waiting` still shows as needing a person. |
| `state: "idle"` | `idle` | The bridge derives `done` from a `working` to `idle` change, as it does for every adapter. The program never sends `done`. |
| any other `state` string | `unknown` | |
| Socket missing, connect refused, `socket-not-private`, `token-refused`, or a read timed out | none: the adapter is `unreachable` | `reachable()` answers false and `snapshot()` throws, as the Tern adapter does. The crew shows the peer as unreachable. The bridge keeps the last state it logged. |
| `ready: false`, or 503 `starting` | none: `unreachable`, detail `starting` | Never an empty census. |
| No version overlap, 409 `incompatible`, or 401 | none: `unreachable`, detail `incompatible` | |

### How a snapshot becomes a mux snapshot

| `MuxPane` field | From |
| --- | --- |
| `paneId` | `Pane.id` |
| `spaceId`, `spaceLabel` | `Pane.workspaceId`, and that workspace's `title` |
| `spaceNumber` | the workspace's position in `Snapshot.workspaces`, 1-based |
| `tabId`, `tabLabel` | `Pane.tabId`, and that tab's `title`. `tabNamed` is never set: the program is not the operator. |
| `cwd` | `Pane.cwd`, else the workspace `cwd`, else `""` |
| `focused` | always false: no terminal shows a durable pane |
| `alive` | true while the pane is in the snapshot |
| `agent` | always `"durable"`. Never the `harness` string. |
| `status` | the state mapping above |
| `terminalTitle` | `Pane.title` |
| `subtitle`, `badge`, `progress` | `Pane.subtitle`, `Pane.badge`, `Pane.progress`, after cleaning (sections 7.11 and 7.12). Left out when absent. |
| `paneLabel` | never set |

A pane that leaves the snapshot is gone: a call to it answers `gone`. A tab or workspace with no
pane is still listed, as the program sent it.

## 6. Ids, strings and caps

### The id rule

Every id on the wire (workspace, tab, pane, item, ask, option, starter, turn, tool call, request,
and the epoch) MUST be 1 to 128 bytes, with no control character, no whitespace, and none of `/`,
`?` or `#`. This is the mux id rule (`bridge/mux/identity.ts`, `isValidMuxId`), because pane, space
and tab ids end up as one URL path segment. Ids are compared byte for byte, never cleaned and never
cut.

- An object in a reply whose id breaks the rule is **dropped** by the adapter, with everything that
  hangs from it (a pane with a bad `tabId` is dropped too).
- A request whose id breaks the rule gets 400 `bad-id` from the program. The adapter checks first
  and never sends one.

### Ask ids

A program SHOULD derive the ask id from the tool call it stands for, so an answer that crosses a
restart lands; the bridge's guard already keys on the tool call id (ADR 0100). The example SDK takes
SHA-256 over `<paneId>\n<toolCallId>` and keeps the first 32 hex characters. A program that mints a
random id per raise is still correct, and an answer to an id from before its restart is `too-late`.

### Push words

An ask MAY carry `push: { title?, line? }`: the words the program wants a notification about this ask to use.
The bridge MAY use them and falls back to its own text, so a program that sends none loses nothing. The
bridge puts the pane's own name in front of the title, and it sends a push only when its guard allows one
(ADR 0100), so these words change what a push says and never whether or how often it is sent.

### Cleaning

The adapter cleans every display string before anything else reads it. The program SHOULD send
strings that are already inside the caps; the adapter does not trust that it did.

1. Remove C0 controls (U+0000 to U+001F), DEL (U+007F) and C1 controls (U+0080 to U+009F). Multi-line
   fields keep `\n` and `\t`. Multi-line fields are item `text`, `ToolCall.output`, `ToolCall.summary`
   and `Ask.reason`. Every other string is single-line and keeps neither.
2. Remove the direction marks U+200E, U+200F and U+061C, and the direction overrides and isolates
   U+202A to U+202E and U+2066 to U+2069. Remove the zero-width characters U+200B to U+200D, the
   word joiner U+2060 and the byte order mark U+FEFF. Remove the tag characters U+E0000 to U+E007F,
   which can carry a whole invisible sentence.
3. Cut to the byte cap below, at the last whole code point that leaves room for `…` (3 bytes), and
   append `…`.

When cleaning changes an ask's `title` or `reason`, the adapter marks the ask `cleaned: true`
(section 4).

Every label a card or the belt shows is untrusted text from the program, and through it from the model:
the ask's `title`, each option's `label`, each field's `label` and each action's `label`. Each goes
through these steps and its cap below before any other code reads it. A button never shows blank: an
option or an action with no words left after cleaning is dropped, and a field with none is named by
its `id`.

The `harness` string is cleaned like the others and stays display text. It may match a name in the
open harness list, but it never picks a grammar, a parser or a journal adapter.

### Caps

Bytes are UTF-8 bytes. "Cut" means step 3 above. The adapter enforces every cap.

| Field or list | Cap | Over the cap |
| --- | --- | --- |
| Every id, and `epoch` | 128 bytes | dropped (see the id rule) |
| `Hello.host.name` | 64 bytes | cut |
| `Workspace.title`, `Tab.title`, `Pane.title` | 256 bytes | cut |
| `Ask.title` | 256 bytes | cut |
| `Ask.push.title` | 60 characters | cut; empty after cleaning reads as absent |
| `Ask.push.line` | 120 characters | cut; empty after cleaning reads as absent |
| `StarterRow.label` | 128 bytes | cut |
| `Option.label` (a `permission` or a `choice` option, and an option of a form field) | 128 bytes | cut; empty after cleaning drops the option |
| `Field.label` | 128 bytes | cut; empty after cleaning reads as the field's `id` |
| `PaneAction.label` | 16 characters | cut; empty after cleaning drops the action |
| `Pane.actions` | 4 entries | the first 4 kept |
| `Pane.harness` | 64 bytes | cut |
| `Item.text` of a `markdown` or `code` item | 32768 bytes (32 KiB), same rule as a reply's text | cut |
| `Item.lang` of a `code` item | 24 characters of letters, digits and `_ + # . -` | absent. The block stays. |
| `Item.href` of a `link` item | 2048 characters, `https://` only | the item is dropped |
| `Item.label` of a `link` item | 120 characters (code points), same rule as the subtitle | cut at a whole character with `…`. Nothing left: absent. |
| `Pane.subtitle` | 120 characters (code points), after cleaning and a trim | cut at a whole character with `…` as the 120th. Nothing left after cleaning: absent. |
| `Pane.badge.text` | 12 characters, same rule | cut the same way. Nothing left: the badge is absent. |
| `Pane.badge.count` | an integer from 0 to 9999 | absent (not clamped). |
| `Pane.progress.steps` | 12 steps | the steps past the 12th are left out |
| `Step.label`, `Pane.progress.label` | 60 characters (code points), same rule as the subtitle | cut at a whole character with `…`. A step with nothing left makes the progress absent. A percent label with nothing left is left out alone. |
| `Pane.progress.value` | a number from 0 to 100 | absent (not clamped). |
| `Workspace.cwd`, `Pane.cwd` | 4096 bytes, absolute | ignored, reads as absent |
| `Ask.reason` | 2048 bytes | cut |
| `ToolCall.name` | 128 bytes | cut |
| `ToolCall.summary` | 1024 bytes | cut |
| `ToolCall.output` | 16384 bytes | cut |
| Item `text` (user, reply, thinking, notice) | 65536 bytes | cut |
| Item `ts` | 40 bytes, ISO 8601 | ignored, reads as absent |
| `settled.reason` | 128 bytes | cut |
| `Problem.message` | 512 bytes | cut |
| `SendRequest.text` | 1 to 32768 bytes | the adapter refuses before it sends. The program answers 400 `bad-body`. |
| `AnswerRequest.answer.note` | 2048 bytes | same |
| Workspaces per snapshot | 64 | the adapter keeps the first 64 |
| Tabs per snapshot | 256 | the first 256 |
| Panes per snapshot | 256 | the first 256 |
| Open asks per pane | 50 | the oldest 50 |
| Options per ask | 6 | the first 6. An ask with none is shown as not answerable. |
| Starters per snapshot | 50 | the first 50 |
| Rows per `conversations` page | 100 | the reply is not read |
| Items per `items` page | 1000 | the reply is not read |
| A history cursor (`after`, `next`) | 512 bytes of printable ASCII, no space | 400 `bad-cursor`; a reply with one is not read |
| Events per reply | 1000 (a reset reply: see 7.2) | the program stops early and sets `more` |
| Items in a reset view | 2000, the newest | the program leaves out the oldest and counts them in `trimmed` |
| Request body to the program | 65536 bytes | 413 `too-large` |
| `hello` reply | 16 KiB | the adapter refuses it: `unreachable`, detail `too-large` |
| `snapshot` reply | 4 MiB | same |
| `events` reply | 8 MiB | same. The program stops early and sets `more` to stay inside it. |
| `conversations` reply | 1 MiB | same |
| `items` reply | 8 MiB | same. The program stops early and names `next` to stay inside it. |
| Any POST reply | 16 KiB | outcome unknown (section 7.6) |

## 7. Rules

### 7.1 Snapshot and polling

- `rev` MUST rise on every change a reader could see: a workspace, tab or pane added, removed or
  renamed; a state change; an ask opened, changed or closed; a new `turnId`; a starter added or
  removed; and every event appended to any pane.
- The `ETag` is `"<epoch>-<rev>"`. The adapter sends it back in `If-None-Match`. A 304 MUST cost the
  program next to nothing. The program MUST compare `If-None-Match` with any `W/` prefix stripped,
  because a proxy may weaken the tag on the way (section 1B); the adapter strips it too.
- The adapter reads a pane's events only when `rev` moved since its last read.
- The adapter waits at least 250 ms between two snapshot reads. Its census runs every 1 s while a
  phone watches and every 3 s otherwise over the socket, and every 2 s and 10 s over TLS, where each
  poll is a billed request. It states its slowest interval as its `topologyLatency` ceiling. It
  declares `pushTopologyEvents` and `pushPaneEvents` false.
- The snapshot is the truth for layout, state, `turnId` and open asks. Events are the history.

### 7.2 Events and the cursor

- Each pane has its own event log in the program. A cursor counts every event the pane has ever
  appended in this epoch. The program keeps a tail of the newest events, at most 1000.
- `after=N&epoch=E` with `E` current and `N` inside the tail: the events after `N`, oldest first,
  at most 1000 and at most 8 MiB. `next` is the cursor after the last one sent. `more: true` if it
  stopped early.
- `E` not current, `N` older than the tail, or `N` larger than the pane's count: a **reset reply**.
  `reset: true`, and `events` is this sequence: `reset`; then each item in its latest version, in
  order of first appearance, at most the newest 2000; then each open ask as an `ask` event, oldest
  first; then one `state`; then `synced`. `next` is the pane's current count.
  A plain reply holds at most 1000 events. A reset reply may hold more: up to the newest 2000
  items, every open ask, and the `reset`, `state` and `synced` events.
- A pane the adapter has never read: `after=0` and the current epoch.
- `reset` means: the cursor numbering started over, and what follows is the program's whole current
  view of this pane. The adapter upserts items by id. Whether an item missing from that view stays
  in the bridge's own log is the bridge's choice, not the wire's.
- An `ask` event with a known ask id and a higher `revision` replaces that ask. A lower or equal
  revision is ignored.

### 7.3 Asks and answers

- An ask is open from its `ask` event until its `ask-closed` event. While any ask is open, the pane
  state is `waiting`.
- An answer names `askId`, the `revision` the phone saw, and what the person chose: an `optionId`, or
  for the other kinds of ask what section 7.14 says.
  - The ask was decided and the program still holds its outcome: 409 `{ "code": "decided", "outcome" }`,
    with the first `AskOutcome`, whatever `revision` the answer names. A second tap, a second phone and a
    tap after the program decided all land here. Nothing runs.
  - The ask id is not open on this pane and the program holds no outcome: 200 `{ "result": "too-late" }`.
    This covers an ask closed by a stop, one whose outcome the program forgot, and, for a program that
    mints a random id per raise, every id from before a restart.
  - The ask is open and `revision` is not its current one: 409 `stale`, with `ask` in its current
    form.
  - `optionId` is not one of the options: 400 `bad-option`. The same code for an id in `optionIds` or
    in a choice field of a form that the ask does not offer (section 7.14).
  - Otherwise the program resolves the ask, closes it with `by: "phone"`, and answers
    `{ "result": "taken" }`. The tool then runs or is denied, as the option says.
- Only an answer on this route closes an ask with `by: "phone"`. The program MUST NOT answer its own
  ask through the wire.
- **The receipt.** Every `ask-closed` SHOULD carry `decidedBy` and `decidedAt`. `phone`: an answer on
  this route. `program`: the program decided the ask itself, for example in its own window, or closed it
  for its own reasons. `timeout`: the clock passed `expiresAt`. A stop of the turn closes as `program`.
  The adapter reads `by: "stopped"` with `decidedBy: "program"` or `"timeout"` as that word, so the phone
  can say "decided in the program" or "timed out" and not "stopped". Without a receipt it stays `stopped`.
- **Expiry.** An ask with `expiresAt` closes at that time with `by: "stopped"` and `decidedBy: "timeout"`.
  A program whose timers can sleep (a Worker) closes it no later than its next snapshot. The adapter
  does not wait for that: a held ask past its `expiresAt` leaves `openAsks` on the next snapshot read,
  a 304 included, so the pane stops reading `waiting` for it.
- **What a program remembers.** A program SHOULD keep the outcome of at least the last 500 decided asks
  per pane for as long as it runs, so a late tap gets `decided` and not `too-late`. After a restart it
  MAY have none.
- **The card is built from data.** A program SHOULD build a `permission` ask from the tool's name and a
  JSON view of its arguments, never from text the model wrote about the call: a model that wants a yes
  would describe the call kindly. The example SDK's `requireApproval(toolName, args, options)` does so.

### 7.4 Send and abort

- Both carry a `requestId` and exactly one of `turnId` and `askId`. Neither, or both: 400
  `bad-body`.
- `turnId` MUST equal the pane's current `turnId`. `askId` MUST be an open ask on this pane.
  Otherwise: 409 `stale`, with the current `turnId` and `askIds`. Nothing runs.
- The adapter makes the same check against its latest snapshot before it writes to the program.
  The program checks again, because the turn can move in between.
- `send` with `caps.send` false, or on a pane that takes no text: 409 `not-supported`. `steer: true`
  with `caps.steer` false: 409 `not-supported`.
- `send` with `steer: true` while a turn runs: the text joins that turn. With `steer` false or
  absent: it waits for the next turn. On an idle pane, `steer` changes nothing and the text starts
  a turn. The program passes `requestId` to its own input call when it can (for Pi Durable,
  `submit({ requestId })`).
- `send` and `abort` answer once the program has accepted the act, not when the turn ends.
- `abort` with `caps.abort` false: 409 `not-supported`. On a pane with nothing running, `abort`
  answers `{ "ok": true }` and does nothing.

### 7.5 A stop

When `abort` stops a run:

- The program appends **no item** for the stop. There is no "stopped" line in the history from the
  program.
- The input that was running settles as unanswered: the program appends
  `{ "type": "settled", "inputId": "...", "requestId": "...", "status": "unanswered", "reason": "aborted" }`.
  `requestId` is the one the input came with, when it had one.
- Every ask open on the pane closes with `by: "stopped"`.
- The pane state goes to `idle`.

The adapter MAY draw a `settled` event as a notice line. It MUST NOT wait for an item after an
abort.

A reply that was growing when the run stopped (section 7.15) stops where it is: the program writes
that item once more, with the text it had and no `partial`, so the phone drops its cursor. This is
the same item id, not a new item, and it is not a "stopped" line.

### 7.6 Request ids

- The phone mints a `requestId` per intent (a UUID). The bridge writes its receipt first, then the
  adapter passes the id through unchanged.
- **Starter:** a repeat of a `requestId` that already succeeded MUST return the first
  `StarterReply` with `replayed: true` and run nothing. A failed start (422) stores nothing, so the
  same id may run again. A repeat that arrives while the first is still running waits for it and
  returns its result.
- **Answer, send, abort, action, rename, close:** the program SHOULD do the same: a repeat returns the first reply with
  `replayed: true` and runs nothing. The bridge receipt is the main guard. This one covers a reply
  lost on the way.
- The same `requestId` on a different route, pane or starter: 409 `request-id-reused`.
- The program keeps at least the last 500 request ids of its epoch. It SHOULD keep them across a
  restart. A program that caps its memory MAY answer a repeat of an id it dropped with a 5xx, so the
  outcome stays unknown and nothing runs twice. The examples keep the newest 1000 per pane, the
  starters as one group, and answer a dropped id with 500 `receipt-dropped`.
- The adapter never retries a POST by itself. A POST that times out, drops the connection, or gets
  a 5xx has an **unknown outcome**. The adapter reports it so, and the phone offers "Try again" with
  the same request id (ADR 0091).
- **Maybe applied.** A retry after an unknown outcome that gets `too-late` (answer) or `stale`
  (answer, send, abort) cannot tell "the first try landed" from "something else closed it". The
  bridge answers the phone `{ "ok": false, "outcome": "maybe-applied" }` with status 200, and the
  phone says the act may have gone through. It never sends the act a third time.
- **The bridge's receipt is bound to its payload.** It stores a digest of what the request asked
  for (pane, ask, revision and option; or pane, turn or ask, and text; or the starter). The same
  `requestId` with a different digest gets 409 `refused`, reason `request-id-reused`, and nothing
  reaches the program. Two requests with the same id at once: the second waits for nothing and gets
  the same 409, so only one POST leaves the bridge. Receipts are kept 7 days and at most 1000 per
  store, newest first; a pending receipt younger than a day is never pruned. Each store is written
  to a temporary file and renamed over the old one.
- Timeouts in the adapter over the socket (1A): 1000 ms for `hello`, `snapshot` and `events`;
  3000 ms for `answer`, `send`, `abort`, `action`, `rename` and `close`; 30000 ms for `starter`. Over TLS (1B): 5000 ms for
  `hello`, `snapshot`, `events`, `answer`, `send`, `abort`, `action`, `rename` and `close`, because a program that slept may wake
  cold; 30000 ms for `starter`. Each is a total deadline for the whole exchange,
  connect to last byte, and a reply is cut off the moment it passes its byte cap (section 6), so a
  program that trickles bytes or never stops cannot hold a read.

### 7.7 Starters

- `Snapshot.starters` lists what the program can start, as an id and a label each. A starter takes
  no input in version 1.
- `POST /starter/:id` runs one and answers the new pane's id. The pane MUST be in the snapshot the
  program serves after it answers.
- With `caps.starters` false: 409 `not-supported`.

### 7.8 A rename

- `POST /rename` carries a `requestId`, a `kind` (`workspace` or `tab`), the `id` of that workspace
  or tab as the snapshot lists it, and a `title`. A pane is not renamed: its title is the
  conversation's, and the program sets it.
- The title is trimmed. It MUST be 1 to 120 characters (code points, not bytes) with no control
  character (C0, DEL, C1). Anything else, and a `kind` that is neither word: 400 `bad-body`. An `id`
  that breaks the id rule: 400 `bad-id`. The program still cleans and cuts the stored title to the
  field cap (section 6), like every other title.
- With `caps.rename` false: 409 `not-supported`. An `id` that names no workspace or no tab of that
  kind: 404 `no-such-target`.
- The program applies the title and raises `rev` (section 7.1) when the title changed, and the next
  snapshot carries it. It answers `{ "ok": true }` once the title is applied.
- The program MAY refuse a title it does not accept: 422 `rename-refused`, with a `message` when it
  has words for the person. Nothing changed. The same `requestId` may try again, as for a failed
  starter.
- The adapter checks the cap and the layout before it posts, and mints a UUID `requestId` for each
  rename (a rename has no pane log and no bridge receipt). It never retries the POST. Like every
  POST (section 7.6), a rename that times out, drops the connection or gets a 5xx has an unknown
  outcome, and the phone is told the rename may have been applied.
- A repeat of a `requestId` that already succeeded returns the first reply with `replayed: true`
  and changes nothing, as for the other POSTs (section 7.6). The same `requestId` for another kind,
  id or title: 409 `request-id-reused`.
- Collie draws the rename control for a tab through its tab capability (`renameTab`) and the one for a
  workspace through its space capability (`renameSpace`). The adapter declares both from `caps.rename`,
  so a program that takes renames gets a Rename row in the tab sheet and in the space sheet.

### 7.9 A close

- `POST /close` carries a `requestId`, a `kind` (`pane`, `tab` or `workspace`) and the `id` of that
  pane, tab (as the snapshot lists it) or workspace. A `kind` that is none of the three words: 400
  `bad-body`. An `id` that breaks the id rule: 400 `bad-id`.
- With `caps.close` false: 409 `not-supported`. An `id` that names no target of that kind: 404
  `no-such-target`.
- What "close" means is the program's call: archive the conversation, delete it, end its run. The
  program does what it means on its side, removes the target and everything inside it from its layout
  (a tab takes its panes, a workspace takes its tabs and their panes), and raises `rev` (section 7.1).
  The next snapshot no longer carries them.
- Every open ask on a pane that goes is closed with `by: "stopped"` (section 7.3), so no ask waits for
  an answer that cannot come. The pane's events are gone with it: `GET /pane/:id/events` answers 404
  `no-such-pane`.
- It answers `{ "ok": true }` once the target is gone. The program MAY refuse: 422 `close-refused`, with
  a `message` when it has words for the person. Nothing changed. The same `requestId` may try again, as
  for a failed rename.
- A repeat of a `requestId` that already succeeded returns the first reply with `replayed: true` and
  changes nothing (section 7.6). The same `requestId` for another kind or id: 409 `request-id-reused`.
- The adapter checks the cap and the layout before it posts, and mints a UUID `requestId` for each
  close. It never retries the POST. A close that times out, drops the connection or gets a 5xx has an
  unknown outcome, and the phone is told the close may have been applied.
- Collie draws its usual close controls for a pane (`closePane`) and a tab (`closeTab`). The adapter
  declares both from `caps.close`. The phone has no control that closes a workspace, so no capability
  is declared for it: a workspace close is on the wire for a client that sends one, and the phone
  never does.

### 7.10 Program actions

- With `caps.actions` true, a pane MAY list up to 4 `actions` in the snapshot (section 4, `PaneAction`). The
  phone draws them as buttons in the program's section of the belt, after Steer and Stop, in the order listed. A
  program changes a pane's buttons by changing the list and raising `rev` (section 7.1). With `caps.actions` false
  the list is ignored, and the phone draws none.
- The adapter cleans the list: an `id` that breaks the id rule, a repeated `id`, and a `label` that is empty after
  cleaning drop that action; the label is cut to 16 characters; an `icon` that is not one of the twelve names is
  dropped, and the button then draws no icon. `busy` and `disabled` are kept only when `true`.
- `POST /pane/:id/action` carries a `requestId`, the `actionId`, and OPTIONALLY the `turnId` the phone saw. A
  button belongs to the pane, not to a turn, so a program that does not care leaves the turn out of its own
  buttons' meaning; a phone that names the turn gets 409 `stale` when it has moved, with the current `turnId` and
  `askIds` as for a send (section 7.4). The phone names the newest turn it has.
- With `caps.actions` false: 409 `not-supported`. A pane that is not in the layout: 404 `no-such-pane`. An
  `actionId` the pane does not list: 404 `no-such-action`. The program answers `{ "ok": true }` once it has taken
  the act; it answers when it took it, not when the work behind the button ends.
- The program MAY refuse: 422 `action-refused`, with a `message` when it has words for the person. Nothing
  changed. The same `requestId` may try again, as for a failed rename. A program SHOULD refuse a tap on an action
  it lists as `busy` or `disabled`, because a phone may have drawn the list before the change.
- A repeat of a `requestId` that already succeeded returns the first reply with `replayed: true` and runs nothing
  (section 7.6). The same `requestId` for another pane, action or turn: 409 `request-id-reused`.
- The adapter checks the cap, the pane, that the pane lists the action, and the turn when one is named, before it
  posts. A name that is not current is refused there and the program is not asked. It then posts ONCE, never
  retries, and a tap that times out or gets a 5xx has an unknown outcome (section 7.6): the bridge keeps its
  receipt open, and "tap again" carries the same request id so the program's own memory answers `replayed`.
- Collie draws the buttons through its capability `programActions`, declared from `caps.actions`. The bridge
  route is `POST /api/pane/:id/action`, and it keeps the receipt the way send and abort do.

### 7.11 Subtitle and badge

- `Pane.subtitle` and `Pane.badge` are optional and additive: a program that sends neither is
  unchanged, and a reader that does not know them ignores them (section 2, point 8).
- The adapter cleans them as it cleans a title (section 6), but counts characters, not bytes. A
  subtitle is trimmed. A value of the wrong type, a `badge` with both `count` and `text` or with
  neither, a `count` that is not an integer from 0 to 9999, and a string with nothing left after
  cleaning read as absent. They are never refused, and they never drop the pane.
- A change of either is a change a reader could see, so `rev` rises (section 7.1). The example SDK
  raises it only when the value changes.
- The phone draws the subtitle under the pane's title in the muted text style, and the badge next to
  the title. They carry no state and no action. A count of 0 is a valid value, and the phone draws it
  as no mark.

### 7.12 Progress

- `Pane.progress` is optional and additive, like the subtitle and the badge (section 7.11). It is one of
  two shapes. `{ kind: "steps", steps }` holds 1 to 12 steps, each a `label` and a `state` of `done`,
  `running` or `todo`. `{ kind: "percent", value, label? }` holds a number from 0 to 100 and an optional
  label.
- The adapter cleans the labels as it cleans a subtitle (section 7.11). An unknown `kind`, no steps, a
  step with an unknown state or with no label left, a `value` outside 0 to 100 and a value that is not a
  number read as no progress at all, because half a progress would mislead. A `label` of the wrong type
  on a percent is left out and the percent stays. Progress is never refused, and it never drops the pane.
- The field is meaningful in any state, and the program owns clearing it. The phone draws it only while
  the pane is `working` or `waiting`, and draws nothing on an `idle` pane that still carries one.
- A change of it is a change a reader could see, so `rev` rises (section 7.1). The example SDK raises
  it only when the value changes.
- The phone draws a step list as the running step's label with "n of m" (the first `todo` step when none
  runs, and the last step when all are done), and a percent as a thin bar with its label.
- "Step n of m" counts the running step and the bar fills by the steps that are done, done / m, so the two
  agree while one step runs and a list with every step done fills to full; a percent fills `value` / 100.
  When every step is done, the pane header's line under the title shows the subtitle again.

### 7.13 Markdown, code and links in the thread

- An item may have the kind `markdown`, `code` or `link`, beside `user`, `reply`, `thinking`, `notice` and
  `tool`. All three are optional and additive: a program that sends none is unchanged, and an older
  adapter drops an item of a kind it does not know (section 2, point 8).
- `markdown` is text the phone renders as markdown: headings, lists, emphasis, code spans and links. It
  is the same renderer the phone uses for the log of any other agent, and it draws every string as text,
  never as markup. Raw HTML in the text is never rendered: the phone has no HTML path, so a tag shows as
  its own characters, and the adapter needs no strip of its own. `code` is a code block, and `lang` names its language when it has one. `link` is a
  line with a link in it; the phone shows `label`, or the address when there is no label. A markdown
  link inside a `markdown` item is a link like any other, and the phone opens only web addresses.
- Images and files are not items. An item of a kind the adapter does not know is dropped.
- A `link` whose `href` is not an `https://` address with a host, has a user or a password in it, has a
  space, a control character or an invisible character in it, or is longer than 2048 characters, is
  dropped. A `code` item whose `lang` is not a plain name keeps its block and loses the name. The
  strictness has a reason: the name goes behind a fence in markdown, and the address goes in a link.
- A dropped item is never an error. The adapter writes one log line for each pane in each epoch that
  says items were dropped, so a program that sends a bad one can be found without a flood in the log.
- Chat shows a code item as a fenced block. A line of code that starts with three backticks or three
  tildes gets an invisible character in front of it, because the markdown reader ends a block at any such
  line; the code is unchanged to the eye.

### 7.14 More kinds of ask

- `Ask.kind` is `permission`, `choice`, `text` or `form`. Every kind has the same `id`, `toolCallId`,
  `revision`, `title`, `itemId`, `reason` and `cleaned`, the same id rule, and the same lifecycle: open from
  its `ask` event to its `ask-closed`, answered once by id and revision, with a request id. The pane is
  `waiting` while any ask of any kind is open. Nothing else about an ask depends on its kind, so the
  adapter's push guard keys every kind the same way, one push per `(host, toolCallId)`.
- A `permission` is unchanged. Its answer is `{ optionId, note? }`, and `allow-always` is an option of a
  `permission` and of nothing else, because no other kind has an `effect`.
- A `choice` offers 1 to 8 options and answers `{ optionIds }`: a list of 1 to 8 distinct ids of the ask's
  options. With `multiple` false the list holds one id; the program answers 400 `bad-body` for more. An id
  the ask does not offer is 400 `bad-option`.
- A `text` ask answers `{ text }`: 1 to `maxLength` characters (default 500, at most 2000). The adapter
  refuses a text over 8000 bytes before it sends, which is 2000 characters at four bytes each. The program
  checks the ask's own `maxLength` and answers 400 `bad-body` for a text over it or an empty one.
- A `form` has 1 to 6 fields and answers `{ values }`: an object whose keys are field ids. A `text` field's
  value is a string of at most its `maxLength`. A `choice` field's value is one option id of that field. A
  `toggle` field's value is a boolean. A required field must have a value. A key that is no field, a value
  of the wrong type, a missing required field and a text over its `maxLength` are 400 `bad-body`; a pick
  the field does not offer is 400 `bad-option`. A list of ids is a legal value on the wire, for a program
  that builds a multiple choice field; this version's phone sends one id.
- The adapter cleans every string of an ask (section 6). A `placeholder` and a field `label` read as a
  title does: a field label is cut at 128 bytes, a placeholder at 60 characters. A `choice` option, a
  field, a field option or a repeated id that breaks a rule is dropped alone; a `maxLength` that is not a
  whole number from 1 to 2000 reads as the default. An ask of a kind the adapter does not know is listed
  and is not answerable.
- The adapter checks the id rule on every id in an answer, and the byte cap on every text, before it
  sends. It keeps no answer text: the receipt holds ids and a digest, so the same request id with another
  text is refused (`request-id-reused`) without the words being stored.

### 7.15 A reply that grows, and a line that is sent

- An item of kind `reply`, `thinking`, `notice` or `markdown` MAY carry `partial: true`. It says the text is
  still growing and the same id will come again. Only the value `true` counts; any other value reads as a
  finished text. `partial` on a `user`, `code`, `link` or `tool` item is ignored.
- A program that streams a reply writes the item with `partial: true` each time the text has grown, no more
  often than every 250 ms, and once more with the final text and no `partial`. Every write is an `item`
  event with the same `id`, so section 3 applies: the later one replaces the earlier one. The program MUST
  write the last version before the pane leaves `working`, whether the run ended, failed or was stopped
  (section 7.5). A reader that finds a `partial` item on a pane that is not `working` MAY draw it as finished.
- The reader keeps one turn per id. A replacement is an update to the turn that is already there, in the
  place it already holds, and it is never a new row. The bridge's own pane log writes a row per version
  that reached it, reads them back by id, and writes one row for the newest of several versions that arrive
  in one read. A reset view that does not list an item still `partial` in the log finishes that item once,
  as it stood, without `partial`: a reply the program was writing when it restarted will not be finished.
- Chat draws a `partial` item with a cursor at its end and no time. The cursor goes when the final version
  arrives. The cadence of the phone is not changed: a watched pane updates about once a second over the
  socket and once every two seconds over TLS (section 7.1), so a growing reply moves by that step.
- A `user` item MAY carry `requestId`: the request id of the `send` that made the line. The phone puts its
  own line on screen when the person sends, keyed by that id, and swaps it for the program's item when an
  item with the same `requestId` arrives. A program that does not know the id leaves it out; the phone then
  matches by the same text within 30 seconds. `requestId` follows the id rule (section 6). A program MAY
  write the `user` item first and add `requestId` in a later version of the same item.
- Both fields are additive: an older adapter ignores them and draws each version as a finished reply, and
  the final version replaces them all.

### 7.16 History

- History is the program's. A program that keeps its conversations (a Pi Durable program keeps every entry) serves
  them over two reads, `GET /conversations` and `GET /conversation/:id/items`, and sets `caps.history`. Without the
  cap both routes answer 409 `not-supported`. The reads change nothing, carry no request id, and need no
  descendant check.
- `conversations` lists every conversation the program keeps, open and closed, newest first, at most 100 a page.
  A conversation is `open` while a pane in the layout shows it; then its id is that pane's `sessionId`. A closed
  one is one the program closed (section 7.9) or one it no longer shows. `items` counts what the items route serves.
- `items` serves one conversation, open or closed alike, oldest first, at most 1000 items and 8 MiB a page, in the
  `Item` shapes of section 4. An ask that was answered or stopped is a `notice` (or the `tool` item it was for). The
  items are the whole record, not the tail a pane keeps (section 7.2): a reset or a compaction that hides older
  entries from the model hides none here. A conversation the program does not know: 404 `no-such-conversation`.
- Both routes page with an opaque cursor. `after` is the `next` the page before named; `next` absent is the last
  page. A cursor is 1 to 512 bytes of printable ASCII with no space, and only the program reads it. One the program
  never gave, or a `limit` that is not a whole number from 1: 400 `bad-cursor`. A `limit` over the cap is the cap.
- `POST /reopen` carries a `requestId` and the `id` of a conversation, and needs `caps.reopen`, else 409
  `not-supported`. The program shows the conversation again in its layout under the same pane id, raises `rev`,
  and answers `{ "ok": true }`; the next snapshot carries the pane. An open conversation answers `{ "ok": true }`
  and changes nothing. One the program does not know: 404 `no-such-target`. The program MAY refuse: 422
  `reopen-refused`, with a `message`. Nothing changed, and the same `requestId` may try again. A repeat of a
  `requestId` that succeeded returns the first reply with `replayed: true`; the same `requestId` for another id:
  409 `request-id-reused`.
- The adapter declares `programHistory` from `caps.history` and `reopenConversation` from `caps.reopen`, from the
  last good read, so both fail closed. It reads the history only when the phone asks for it, never on the poll. It
  mints a UUID `requestId` for each reopen and never retries the POST: an unknown outcome tells the phone the
  conversation may have been reopened.
- The bridge's log of a pane (`bridge/durable/log.ts`) is a cache of what it read for a live pane. Chat reads it.
  The read-only view of a closed conversation reads the program, never the log. The log keeps its caps (the newest
  2000 items or 8 MiB a pane, 256 MiB for the machine, oldest first, one line in the bridge's log per deleted file),
  and the events reader saves its cursor beside it, so a bridge restart goes on where it stopped (section 8).

## 8. Restart and epoch

1. Every start of the program makes a new random `epoch`, at least 128 bits, never reused. `rev`
   and every pane's event count start over with it.
2. Until the program has laid out its panes again (every conversation re-attached, every open ask
   raised again), `hello` says `ready: false` and every other route answers 503 `starting`. The
   adapter reports `unreachable` with detail `starting`. A program MUST NOT serve a half-empty
   layout as ready.
3. Pane ids stay the same across a restart, because a pane id is the conversation id. Workspace
   and tab ids SHOULD stay the same.
4. A program that derives its ask ids (section 6) raises the same ask id again after a restart; one
   that mints them at random raises a new one. Either way the `toolCallId` of a re-raised ask stays
   the same, and its `revision` starts at 1 again. The bridge treats a new ask id with a known
   `(host, toolCallId)` as the same question: shown, not pushed again (ADR 0100).
5. An answer to an ask id that is not open after the restart gets `too-late`. With derived ids an
   answer sent across the restart names the re-raised ask, which point 2 opens before `ready`, so it
   is taken and the tool runs once.
6. `turnId` MAY change across a restart. A control that names an old one gets 409 `stale`.
7. When the adapter sees a new epoch (in `hello` or in `Snapshot.epoch`), it keeps showing the
   panes it has until the new snapshot is read. Then it reads each pane's events with the **old**
   epoch and its old cursor, and gets a reset reply. A pane it never read starts at `after=0`.
   The bridge saves each pane's cursor beside its log, so after a restart of the BRIDGE the first read
   goes on from the saved cursor, on the epoch it holds, and reads nothing twice (section 7.16).
8. The adapter calls `hello` again after any failed connect, after a 503, and when it sees a new
   epoch. While the program is down, it tries once per poll interval and reports `unreachable`.
   Over TLS (1B) it tries at most once every 10 s while the last read failed, because each try is a
   billed request.
   **Hysteresis:** one failed read after a good one keeps the last snapshot for that poll. Two
   failures in a row flip the peer to `unreachable`. A refused token (1B) follows the same rule. A path that fails the walk (section 1A) is
   `unreachable` at once, with no grace.
9. Request id receipts SHOULD survive a restart (section 7.6).
10. Over the socket (1A), the program removes a stale socket file before it listens, so a crash
    leaves no dead path for the next start.

## 9. Out of scope in version 1

- **Plain TCP.** Over the network the transport is TLS (1B). Plain `http://` is allowed only to
  127.0.0.1 or localhost, for a local test.
- **Other users on the socket.** Over 1A the program and the peer run as the same user, with no
  token and no handshake. Over 1B the token is the only gate, and there is no other handshake: no
  client certificate, no second factor.
- **Other machines, except through 1B.** A program the person deployed behind TLS is reached over
  1B. Any other program on another machine is reached through the Collie on that machine.
- **Waking a program on purpose.** Over 1A a program that is not running is `unreachable`. Over 1B
  the host may start the program for a request (a Durable Object does), and the adapter neither
  knows nor relies on it: a new start is a new epoch (section 8).
- **Terminals.** No pane grid, no typed keys, no raw text. `caps.terminal` is false.
- **Push.** No stream from the program. The adapter polls.
- **More than one program per adapter.** One socket path, or one URL, per adapter. A Collie runs
  several programs as several adapters, one per entry of `sources.json` (section 1).
- **Ask kinds other than `permission`, `choice`, `text` and `form`** (section 7.14).
- **Starters that take input**, such as a folder or a prompt.
- **Creating** workspaces, tabs or panes, and **renaming a pane**, from Collie. Renaming a workspace or a tab is section 7.8, and closing is section 7.9.

## 10. Changes from the spike

The spike SDK and its stand-in lead spoke a draft of this wire. These changes bring it to this
document. The version number stays 1; the spike's shapes are not supported.

1. **The bearer token is gone from the socket.** No `Authorization` header, no 401, no `DM_TOKEN` on
   transport 1A. The check order there is version, `hello`, ready, route. A token came back later,
   for transport 1B only (ADR 0103): TLS required, at least 32 bytes, checked before everything else.
2. **Plain TCP is gone.** No `tcp:` listen spec. On 1A the program listens on a Unix socket, and
   SHOULD take its path from `COLLIE_DURABLE_SOCKET`. A program on the network is reached over TLS
   (1B), never over plain TCP.
3. **Every id follows the id rule** (1 to 128 bytes, no whitespace or control character, no `/`,
   `?` or `#`). The spike's tab ids are `<workspace>/<tab>`, which breaks it. Use another
   separator, for example `<workspace>:<tab>`.
4. **`Pane` gains `turnId`** (required) and an optional `cwd`.
5. **`Ask` gains `toolCallId`, `revision`, `title` and `itemId`**, all required. `toolItemId` is
   renamed `itemId`. `reason` and `tool` stay, optional. Asks are listed per pane as before.
6. **`answer` carries `requestId` and `revision`.** A revision that is not current gets 409
   `stale` with the current ask. A repeat request id returns the first result with `replayed`.
7. **`send` replaces `when` with `steer: boolean`,** and carries `requestId` and exactly one of
   `turnId` or `askId`. A stale one gets 409 `stale`. The text cap is 32768 bytes (the spike capped
   20000 UTF-16 units). `requestId` goes through to `submit({ requestId })`.
8. **`abort` carries `requestId` and exactly one of `turnId` or `askId`.** The spike's body was empty.
9. **`starter/:id` carries `requestId`.** A repeat with the same id returns the first `paneId` with
   `replayed: true` and runs nothing (the spike ran it again). A failure is 422 `starter-failed`,
   not 500.
10. **`Hello.caps`:** `send` is a boolean, and a new `steer` boolean replaces the `send` list.
    `terminal` stays false.
11. **`events` requires `epoch`.** A reply may stop early and set `more`. `next` is the cursor after
    the last event sent, not always the pane's total. A reset reply carries at most the newest 2000
    items and counts the rest in `trimmed`. The tail is at most 1000 events.
12. **A new `settled` event.** A stop writes no item: the spike's synthetic notice item
    (`sub:<id>`, "stopped") becomes a `settled` event with `status: "unanswered"` and
    `reason: "aborted"`.
13. **Error codes:** new `stale`, `request-id-reused`, `bad-id` and `starter-failed`. `ask-closed`
    is gone; a closed ask answers `too-late`.
14. **Caps are in bytes, per field** (section 6), not the guard's code point limits. The SDK
    SHOULD cut its own strings to these caps before it sends them; the adapter cuts again.
15. **The guard moves out of the wire.** The spike's lead-side guard (push and open caps) is the
    bridge's job now, keyed on `(host, toolCallId)`. The program sends every open ask, up to 50 per
    pane, oldest first. The guard caps pushes only: every open ask reaches the phone.
16. **`Hello` gains `service: "collie-durable"`** (required). A server at the path that does not
    say it is refused as `incompatible: not a durable program`. Added before version 1 shipped, so
    the version stays 1.
17. **The path cap is 103 bytes** (was 107), and the adapter walks the whole path (section 1A).
18. **`Ask` gains an optional `cleaned`** (section 4), and cleaning also removes zero-width and tag
    characters (section 6).
19. **`Caps` gains `rename`, and `POST /rename` is a route** (sections 3, 4 and 7.8), with the codes
    `no-such-target` and `rename-refused`. Added before version 1 shipped, so the version stays 1.
20. **`Caps` gains `close`, and `POST /close` is a route** (sections 3, 4 and 7.9), with the code
    `close-refused` (and `no-such-target`, shared with rename). Added before version 1 shipped, so
    the version stays 1.
21. **`Caps` gains `actions`, `Pane` gains `actions`, and `POST /pane/:id/action` is a route** (sections 3, 4 and
    7.10), with the codes `no-such-action` and `action-refused`. Added before version 1 shipped, so the version
    stays 1.
22. **`Ask` gains `push`** (sections 4 and 6): the program's own title and line for the push about the ask,
    within the existing push guard. Added before version 1 shipped, so the version stays 1.
23. **`Pane` gains an optional `subtitle` and `badge`** (sections 4, 6 and 7.11). Added before version 1
    shipped, so the version stays 1. An older adapter ignores both.
24. **`Pane` gains an optional `progress`** (sections 4, 6 and 7.12). Added before version 1 shipped, so
    the version stays 1. An older adapter ignores it.
25. **`Item` gains the kinds `markdown`, `code` and `link`** (sections 4, 6 and 7.13). Added before
    version 1 shipped, so the version stays 1. An older adapter drops an item of a kind it does not
    know.
26. **`Ask.kind` gains `choice`, `text` and `form`, and `AnswerRequest.answer` gains the shapes
    `{ optionIds }`, `{ text }` and `{ values }`** (sections 3, 4 and 7.14). `Option.effect` becomes
    optional (a `permission` still has it), and `Ask` gains `multiple`, `placeholder`, `maxLength` and
    `fields`. Added before version 1 shipped, so the version stays 1. An older adapter shows an ask of a
    kind it does not know as not answerable.
27. **`Caps` gains `history` and `reopen`, `GET /conversations`, `GET /conversation/:id/items` and `POST /reopen`
    are routes, and `Pane.sessionId` is no longer reserved** (sections 3, 4, 6 and 7.16), with the codes
    `no-such-conversation` and `reopen-refused`, and `bad-cursor` for a history cursor. The session id is the
    conversation id the program serves history under, or null. Additive, so the version stays 1: an older
    adapter ignores both caps and `sessionId`, and an older program never sets them.
28. **A version policy** (section 2): Collie speaks N and accepts N-1 for one minor. `Problem` gains an
    optional `refusal` (a `VersionRefusal`) on 409 `incompatible`, and a refused program gets one telling
    `hello` per epoch with Collie's version, which every version 1 program already answers 409.
    Additive, so the version stays 1.
29. **`Ask` gains an optional `expiresAt`** (sections 4 and 7.3). Past it the ask is decided by `timeout`.
    Additive: an older adapter ignores it and keeps the ask until the program closes it.
30. **`ask-closed` gains optional `decidedBy` and `decidedAt`** (sections 4 and 7.3): the receipt of a
    decision, `phone`, `program` or `timeout`. `by` keeps its two words, so an older adapter reads a close
    by the program or by the clock as `stopped`, as before.
31. **A new code, 409 `decided`, on `answer`** (sections 3 and 7.3), with `Problem.outcome`: a second answer to
    a decided ask gets the first outcome. An older adapter reads an unknown 409 as refused, and nothing ran,
    so no answer is lost or run twice.
32. **An option or an action with no label left after cleaning is dropped, and a field with none is named by
    its id** (section 6). Every label on a card goes through the cleaner and a cap. No shape changes.
33. **The descendant check runs only in the Bun entry of the SDK package** (`@colliepwa/durable-sdk`, on Linux,
    section 1A). A program on Node serves the same wire without it, and says so at start. No shape changes.

## Appendix: A host with no process

> **This appendix describes one host, the durable-harness host, and is a draft.** It is not part of version 1
> and changes nothing above: an adapter reads such a host with the rules of sections 1 to 9. It records how that
> host fills the wire when it has no process of its own (a function on Vercel, or one Node process that rebuilds
> its answer from a log on every request), and what it keeps in the log beyond what Pi Durable already keeps. A
> host with a process of its own does not use it. The core's seams for it are in
> `packages/durable-sdk/src/core/` (`journal.ts`, `Pane.seedAsk`, `ReceiptStore.claim`).

A host with no process starts nothing, so section 8 has nothing to hang on: there is no start to mint an epoch
at, and no memory that outlives a request. Every request builds the state it needs from the **World**, the
durable log, answers, and drops the state. One rule holds the whole design together: **every fact the phone can
see is in the World before the response is written**, so a state rebuilt after a request equals the state that
answered it. The core's tests check this for the memory store after every request of the protocol suite.

### A.1 Identity and the epoch

- **`epoch`** is a fact of the deployment's World and schema, never of a start. It is
  `options.epoch`, else the `COLLIE_EPOCH` variable, else a hash of the wire version, the mapper's schema version,
  the World's identity and the program's name. It MUST NOT be random on this host. It changes only when the
  meaning of a cursor changes (a new mapper schema, another World). Section 8 rule 1 reads, for this host: a host
  with no process start keeps one epoch per World and schema.
- **Why it matters.** The adapter re-greets, and reads each pane with its old epoch and old cursor, whenever the
  epoch changes (8.7 and 8.8). Two instances of one deployment MUST give one epoch, or the phone would reset
  every pane on every request that lands on the other instance.
- **`rev` and the events cursor.** A pane's cursor is the run's event count (every commit raises it, the throttled
  commit of a growing reply included), plus the number of journal records, plus the number of open asks whose
  `expiresAt` has passed with no record yet (so a timeout by the clock moves it too). All three only grow inside a
  run. The byte length of the live partial is NOT part of it: it falls to 0 at the end of every message, and the event
  count already moves with each partial. A read at exactly the pane's cursor, in the current epoch, gets no events and
  the same `next`; any other read gets the reset view (section 7.2) with the cursor as `next`. The host cannot replay
  the events between two cursors, so it never sends a tail. The snapshot's `rev` is 1, plus the sum of the open panes'
  cursors, plus the number of runs in every status, plus 2^32 for every finished run. A run that finishes takes its
  cursor out of the sum and adds 2^32, which is more than one cursor reaches, so the value never goes down when a run
  ends. A run that leaves the list (retention) lowers it; the docs say so. The adapter compares `epoch-rev` stamps and
  ETags for equality only, never for order (`bridge/mux/durable/events.ts`): a lower value is harmless by itself, but
  one that comes back to an earlier value would make it skip a read, which is why the value must not fall.
- **`turnId`** is `safeId` of a hash over the session id and one slot of the log: while the session works, the slot of
  the newest user entry before the first start of the oldest task that is not finished; when idle, the slot of the
  newest user entry. It is a fact of the log, so every instance computes the same. A follow-up the run takes in the
  middle starts a new turn once its entry lands.
- **`ready`** is true once the World has answered. A World error is 503 `starting` (but see A.3 for a short outage).
- **Panes.** One pane per run of the program's workflow whose status is not `completed`, `failed` or `cancelled`. A
  finished run is a closed conversation: it is in the history (section 7.16), not in the snapshot.

### A.2 The journal

The log of the harness keeps the conversation. It has no place for a question, an answer or a request id, so the
host keeps those in a **journal**: one stream of the World per run, named `<runId>_collie`. The run id is in the
name because some Worlds key a stream by name alone.

- **Format.** JSON lines, UTF-8, one record per line. A reader MUST split on newlines, never on chunk
  boundaries, and MUST ignore a line it cannot parse. A writer appends whole lines.
- **Order.** The order of the stream is the order of the records. A rule below that says "first" means first in the stream.

Four records. Every `at`, `openedAt` and `expiresAt` is ISO 8601 with a zone.

| Record | Fields | Meaning |
| --- | --- | --- |
| `ask` | `askId`, `toolCallId`, `argsHash`, `ask`, `openedAt`, `expiresAt?` | A question was raised. `ask` is the wire's `Ask` (section 4). `argsHash` is a hash of the tool call's arguments. |
| `answer` | `askId`, `revision`, `answer`, `requestId`, `nonce`, `at` | The phone answered. `nonce` is minted per attempt. |
| `expire` | `askId`, `at`, `decidedBy?` | The ask closed with no answer. `decidedBy` is `timeout` (the default) or `program` (a stop of the turn). |
| `receipt` | `phase`, `group`, `requestId`, `digest`, `reply?`, `nonce?`, `at` | A request id. `phase` is `pending` before the act, then `done` after it or `failed` when the act refused. Only a `done` carries `reply`. `nonce` is minted per `pending`, and its `done` or `failed` carries the same one. |

How a reader folds them (`foldJournal` in the core is the reference, and is pure):

1. The first `ask` record of an id stands. Its text, options and `expiresAt` are fixed from then on; a second one is ignored.
2. The first terminal record (`answer` or `expire`) of an id wins, whatever its `revision`. A later one is ignored.
3. An `ask` record after a terminal record of the same id is ignored: the ask is decided and never opens.
4. An ask with no terminal record is open. A reader closes an open ask whose `expiresAt` has passed as decided by
   `timeout`, at exactly `expiresAt`, so every instance says the same. The host MAY append the `expire` record
   itself when its own timer fires; the reader does not wait for it.
5. A `receipt` with `phase: "done"` closes the `pending` of its request id when the digest is the same. The first
   `pending` of an id stands; a `pending` after a `done` is ignored.
6. A `receipt` with `phase: "failed"` removes the standing `pending` of its request id when the nonce is the same.
   The id is free again, as on the memory path, which keeps no failure (section 7.6). A `failed` with another nonce
   changes nothing.
7. A line that does not parse, or whose fields do not fit its tag, is ignored, and so is a record with an unknown tag.

**The ask id** is derived from the pane id and the tool call id (section 6), so a rerun of the same tool call
finds its own record and goes on under the same id with the original `expiresAt`. A rerun that asks about other
arguments (a different `argsHash`) is not the same question and MUST be denied, not matched to the old answer.

**An answer.** The host checks the revision against the open ask, then appends an `answer` record with a fresh
`nonce`, then **reads the journal back**. It answers `taken` only when the winning record of that ask is its own
(same `nonce`). When another record won, it answers 409 `decided` with that record's outcome (section 7.3). It
never answers `taken` from what it wrote alone, because two instances can append at once and the stream decides.

**Request ids** follow section 7.6 through the same stream. A request first appends a `receipt` `pending` with a fresh
`nonce` and reads the journal back: it runs the act only when the standing `pending` is its own. It then appends the
`done` with the reply, or a `failed` when the act refused (a stale turn, a send that is not allowed now). Request ids
are kept per run, so the same id on two panes is not seen as reused. A repeat of an id with a `done` gets the first reply with `replayed: true`. A repeat
whose `pending` has no `done` yet is another instance's act in flight: it waits up to the write timeout, then answers 500
`receipt-dropped` (an unknown outcome, section 7.6) and never runs the act again. A different digest under the same id is 409
`request-id-reused`. A flush that fails after the act is a 5xx with no `done`.

**Redaction.** The tool's arguments in an `ask` record are the redacted text the socket path shows, from the same
ask policy (`toAskSpec` in the core), and never the raw arguments. The journal is as readable as the World, so it
holds nothing the card would not show.

**A stop.** When the host stops a turn, it appends an `expire` record with `decidedBy: "program"` for every ask that
is still open, so no question is left waiting for a turn that is gone.

**The guard.** The hook that raises the ask lives in the program's process, which can be taken over, crash, or be
resumed on another machine at any point. It is therefore rerun-first: on every run of a risky call it reads the
journal, appends the `ask` only when there is none for this call, and polls the journal (1 s, doubling to 5 s) until a
terminal record closes the ask. It lets the call run only on an `answer` whose option has the effect `allow`, for the
same `argsHash`. `allow-always` is never offered behind a token (section 1B). Anything else blocks the call: a deny, an
`expire`, other arguments, and a process that lost the session (Pi's `StorageFenced`), which is checked before every
read, so a fenced process that sees an answer still does not run the tool. The hook appends the `expire` record of a
timeout itself, on its own timer, at `expiresAt`.

### A.3 The route

- **Transport 1B.** A bearer token, at least 32 bytes, from the environment. Each compare is over the SHA-256
  digests of the two tokens, so it takes the same time whatever the guess. A second token may be accepted during a
  rotation. A missing or wrong token is a bare 401 `unauthorized` with `WWW-Authenticate: Bearer`, before anything
  is read from the World.
- **Load per route.** Hello reads that the World answers. The snapshot reads the runs list and the journal of each
  open run. A pane's routes read that run and its journal. History reads the runs it lists. Nothing is kept between
  two requests but the last good answer to each GET (below).
- **Caps.** `asks`, `send`, `abort` and `history`. `steer`, `rename`, `close`, `reopen`, `actions` and `starters` are
  false: the host has no store of its own for titles, closes or starters, and a taken-over session cannot be steered.
  A send is taken only while the pane is idle (`canSend` is false while it works or waits); otherwise 409
  `not-supported`. A stop takes the session over, aborts the root conversation and closes its open asks as above.
- **A short outage.** A GET that the World cannot answer is answered from the last good answer of this instance to
  the same GET, for up to 5 s, ETag included. After that it is 503 `starting`, and hello says `ready: false`.
- **Versions.** The route checks the installed `durable-harness` and the World's spec version at its first request.
  On any other than the tested ones every request is 500 with one line that names both.
