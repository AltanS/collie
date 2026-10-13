# The durable wire, version 1

> **Experimental.** This wire may change in any minor release of Collie, and so may the version
> range the `durable` adapter speaks. Nothing outside this repository should depend on it yet. A
> program and a Collie that do not share a version get a named `incompatible`, so a mismatch is
> visible, not silent.

This document fixes the protocol between two parties:

- **The program.** A durable agent program, for example one built on Pi Durable. It owns its
  conversations, and it **listens**: on a private Unix socket on the peer's machine, or behind TLS
  at a URL the person deployed it to (section 1).
- **The adapter.** The `durable` mux adapter in a Collie peer (`COLLIE_MUX=durable`). It **dials**
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
| --- | --- | --- | --- |
| Peer setting | `COLLIE_DURABLE_SOCKET` | `COLLIE_DURABLE_URL` and `COLLIE_DURABLE_TOKEN` |
| Where the program runs | the peer's machine, as the same user | anywhere the person deployed it, for example a Cloudflare Worker with a Durable Object |
| The gate | a socket only this user can open | the token, compared in constant time |
| Descendant check | program-side, optional | does not exist |
| Read and write budgets | 1000 ms and 3000 ms | 5000 ms and 5000 ms |
| Census, watched and idle | 1 s and 3 s | 2 s and 10 s |

Setting both, or a URL without a token, is a config error: the peer starts, names the error once in
its log, and reports `unreachable` with the same line on every read.

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
  text, stop a turn and run a starter. There is nothing else to check: the descendant check of 1A
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
4. No overlap: the adapter calls nothing else. It reports `unreachable` with detail
   `incompatible: program speaks <min>..<max>, this Collie speaks 1..1`. It never shows an empty
   census for this case.
5. A call with a missing header (other than `hello`), a non-integer header, or a version outside
   the program's range gets **409** `{ "code": "incompatible", "range": { "min", "max" } }`. Never a
   5xx. `hello` with a header outside the range gets the same 409.
6. A **401** over the socket (1A) means the program asks for a token, which the socket does not
   carry. The adapter reports it as `incompatible` with detail `program asks for a token`. Over TLS
   (1B) a **401** or **403** means the program refused the token: `unreachable`, detail
   `token-refused`, before any version check (section 1B).
7. A `hello` without `service: "collie-durable"` is not a durable program: some other server
   listens at the path. The adapter calls nothing else and reports `unreachable` with detail
   `incompatible: not a durable program`.
8. A field is additive and optional. A reader MUST ignore a field it does not know. A new required
   field, a new meaning for an old field, or a removed field needs a new version.

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
| `POST /pane/:id/answer` | `AnswerRequest` | `AnswerReply` | 400 `bad-body`, 400 `bad-id`, 400 `bad-option`, 403 `caller-refused`, 404 `no-such-pane`, 409 `stale`, 409 `request-id-reused`, 409 `not-supported`, 413 `too-large`, 503 `starting` |
| `POST /pane/:id/send` | `SendRequest` | `ControlReply` | 400 `bad-body`, 400 `bad-id`, 403 `caller-refused`, 404 `no-such-pane`, 409 `stale`, 409 `request-id-reused`, 409 `not-supported`, 413 `too-large`, 503 `starting` |
| `POST /pane/:id/abort` | `AbortRequest` | `ControlReply` | 400 `bad-body`, 400 `bad-id`, 403 `caller-refused`, 404 `no-such-pane`, 409 `stale`, 409 `request-id-reused`, 409 `not-supported`, 413 `too-large`, 503 `starting` |
| `POST /starter/:id` | `StarterRequest` | `StarterReply` | 400 `bad-body`, 400 `bad-id`, 403 `caller-refused`, 404 `no-such-starter`, 409 `request-id-reused`, 409 `not-supported`, 413 `too-large`, 422 `starter-failed`, 503 `starting` |

Any other method or path answers 404 `not-found`.

Every pane in a `Snapshot` MAY carry `sessionId: string | null`: it is reserved for the
machine-scoped session id and is null until a later version defines it. The adapter reads it and
ignores it today.

### Error codes

Every error body is a `Problem` (section 4).

| Status | Code | Meaning | What the adapter does |
| --- | --- | --- | --- |
| 400 | `bad-json` | The body is not JSON. | A bug on the adapter side. Refused, not retried. |
| 400 | `bad-body` | A field is missing, has the wrong type, or is over its cap. `turnId` and `askId` both present, or both absent. | Same. |
| 400 | `bad-id` | An id in the body breaks the id rule (section 6). | Same. |
| 400 | `bad-option` | `optionId` is not one of the ask's options. | Same. |
| 400 | `bad-cursor` | `after` is not an integer ≥ 0, or `epoch` is missing. | Same. |
| 401 | (any) | Over the socket (1A): a program that wants a token, which the socket does not carry. Over TLS (1B): the token is missing or wrong. | 1A: `incompatible`, see section 2. 1B: `unreachable`, detail `token-refused`. |
| 403 | `caller-refused` | Over the socket (1A), on `answer`, `send`, `abort` and `starter`: the program decided the caller is itself or a process below it (the descendant check, section 1A). Nothing ran. | Refused, with a detail that names the code. Never retried. |
| 403 | (any) | Over TLS (1B): something in front of the program refused the caller, for example an access proxy. | `unreachable`, detail `token-refused`. |
| 404 | `not-found` | Unknown route. | Refused. |
| 404 | `no-such-pane` | The pane is not in the program's layout. | `gone`. |
| 404 | `no-such-starter` | The starter is not in the program's list. | Refused. |
| 409 | `incompatible` | Version outside the range. Carries `range`. | `unreachable`, detail `incompatible`. Never retried at the same version. |
| 409 | `stale` | The `turnId`, `askId` or ask `revision` is not current. Carries the current `turnId` and `askIds`, and `ask` for an answer. | Passed up as a stale refusal. The phone reloads. Never retried by the adapter. |
| 409 | `request-id-reused` | The `requestId` was already used for a different route, pane or starter. | Refused. |
| 409 | `not-supported` | The cap for this act is false, or this pane cannot take it (for example no send handler). | Refused. |
| 413 | `too-large` | The request body is over 64 KiB. | Refused. |
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
  /** Reserved for the machine-scoped session id (section 3). Null until a later version defines it. */
  sessionId?: string | null;
  /** Absolute. Falls back to the workspace `cwd`, then to "". */
  cwd?: string;
}

type PaneState = "working" | "waiting" | "idle";

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
  /** The only kind in version 1. A reader shows an ask of another kind as not answerable. */
  kind: "permission";
  /** The program's id for the tool call. The same across a restart. */
  toolCallId: string;
  /** Starts at 1. Rises when the program changes this ask in place. */
  revision: number;
  /** One line the card leads with, for example "write_note wants to write /tmp/notes.txt". */
  title: string;
  /** The item this ask belongs to, usually the tool item. The card sits under it. */
  itemId: string;
  /** At least one, at most 6. */
  options: Option[];
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
}

interface Option {
  /** Unique inside its ask. */
  id: string;
  label: string;
  effect: "allow" | "allow-always" | "deny" | "cancel";
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

/** An item with a known id replaces the earlier one (a tool changes status). Ids are unique per pane. */
type Item =
  | { id: string; ts?: string; kind: "user" | "reply" | "thinking" | "notice"; text: string }
  | { id: string; ts?: string; kind: "tool"; tool: ToolCall; status: ToolStatus };
// `ts`: ISO 8601 with a zone, for example "2026-10-12T09:30:00.000Z".

type ClosedBy = "phone" | "stopped";

type SessionEvent =
  | { type: "item"; item: Item }
  | { type: "remove"; id: string }
  /** A new open ask, or a known `id` with a higher `revision` that replaces it. */
  | { type: "ask"; ask: Ask }
  | { type: "ask-closed"; askId: string; by: ClosedBy; waitedMs?: number }
  | { type: "state"; state: PaneState }
  /** An input reached its end. `requestId` is present when the input came with one. */
  | { type: "settled"; inputId: string; requestId?: string; status: "answered" | "unanswered"; reason?: string }
  /** What follows replaces what the reader held for this pane (section 7.2). */
  | { type: "reset" }
  /** The history sent so far is complete. What follows is live. */
  | { type: "synced" };
// A reader ignores an event `type` it does not know.

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
  answer: { optionId: string; note?: string };
}

interface AnswerReply {
  /** "too-late": the ask id is not open on this pane (answered, stopped, or from before a restart). */
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

interface StarterRequest {
  requestId: string;
}

interface StarterReply {
  /** The new conversation's pane. It is in the next snapshot. */
  paneId: string;
  replayed?: true;
}

// ── errors ────────────────────────────────────────────────────────────────────

interface Problem {
  code: string;
  message?: string;
  /** With `incompatible`. */
  range?: ProtocolRange;
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
| `StarterRow.label` | 128 bytes | cut |
| `Option.label` | 128 bytes | cut |
| `Pane.harness` | 64 bytes | cut |
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
| Events per reply | 1000 (a reset reply: see 7.2) | the program stops early and sets `more` |
| Items in a reset view | 2000, the newest | the program leaves out the oldest and counts them in `trimmed` |
| Request body to the program | 65536 bytes | 413 `too-large` |
| `hello` reply | 16 KiB | the adapter refuses it: `unreachable`, detail `too-large` |
| `snapshot` reply | 4 MiB | same |
| `events` reply | 8 MiB | same. The program stops early and sets `more` to stay inside it. |
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
- An answer names `askId`, the `revision` the phone saw, and an `optionId`.
  - The ask id is not open on this pane: 200 `{ "result": "too-late" }`. This covers an ask already
    answered, one closed by a stop, and, for a program that mints a random id per raise, every id
    from before a restart.
  - The ask is open and `revision` is not its current one: 409 `stale`, with `ask` in its current
    form.
  - `optionId` is not one of the options: 400 `bad-option`.
  - Otherwise the program resolves the ask, closes it with `by: "phone"`, and answers
    `{ "result": "taken" }`. The tool then runs or is denied, as the option says.
- Only an answer on this route closes an ask with `by: "phone"`. The program MUST NOT answer its own
  ask through the wire.

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

### 7.6 Request ids

- The phone mints a `requestId` per intent (a UUID). The bridge writes its receipt first, then the
  adapter passes the id through unchanged.
- **Starter:** a repeat of a `requestId` that already succeeded MUST return the first
  `StarterReply` with `replayed: true` and run nothing. A failed start (422) stores nothing, so the
  same id may run again. A repeat that arrives while the first is still running waits for it and
  returns its result.
- **Answer, send, abort:** the program SHOULD do the same: a repeat returns the first reply with
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
  3000 ms for `answer`, `send` and `abort`; 30000 ms for `starter`. Over TLS (1B): 5000 ms for
  `hello`, `snapshot`, `events`, `answer`, `send` and `abort`, because a program that slept may wake
  cold; 30000 ms for `starter`. Each is a total deadline for the whole exchange,
  connect to last byte, and a reply is cut off the moment it passes its byte cap (section 6), so a
  program that trickles bytes or never stops cannot hold a read.

### 7.7 Starters

- `Snapshot.starters` lists what the program can start, as an id and a label each. A starter takes
  no input in version 1.
- `POST /starter/:id` runs one and answers the new pane's id. The pane MUST be in the snapshot the
  program serves after it answers.
- With `caps.starters` false: 409 `not-supported`.

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
- **More than one program per peer.** One socket path, or one URL, per peer.
- **Ask kinds other than `permission`**, and free-text answers beyond the optional `note`.
- **Starters that take input**, such as a folder or a prompt.
- **Creating, renaming or closing** workspaces, tabs or panes from Collie.

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
