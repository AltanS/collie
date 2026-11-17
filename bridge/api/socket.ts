// THE LOCAL API SOCKET (M105 spec 03, decisions 13, 14, 16, 18, 20). `<stateDir>/api/sock`, mode 0600
// in a folder of mode 0700, served by the bridge. A program or a script on this machine lists the
// sessions, reads a screen and follows the events through it. Read only in this step: the ceiling is the
// level `read`, which holds `see` (operations.ts, spec 04 decision 1).
//
// WHO GETS AN ANSWER (spec 05, decisions 1 to 5, ADR 0155). A trick's own run, and nothing else. When the
// bridge starts a run of a trick that declares `access`, it mints a run token (bridge/tricks/run-tokens.ts)
// and hands it to the run in its facts on stdin. Every connection must open with `hello` naming that token
// (`args.token`). The socket asks the injected {@link RunTokenCheck} (`deps.tokens`, built in
// bridge/index.ts from the trick runner's table: this folder imports nothing of bridge/tricks) and binds the
// connection to the token: its trick id and its level, under the ceiling. Before a good `hello`, every
// line gets ONE error and the connection closes: `api.no_run_token` for any other operation and for a
// `hello` with no token, an unknown one or a dead one; `api.bad_request` for a line that is no request.
// A good `hello` must arrive within the line limit (2 s) of the connect, else the connection gets one
// `api.no_run_token` line and closes. A connection holds one token: a later `hello` must name the same one, and one that names another is
// refused with `api.bad_request` and closed. After `hello`, every request is admitted at the token's level
// (`admit`: `api.denied` for `read` on a `see` token), and the token is asked again at each request and
// at each answer, so a token that died (its run ended, its trick or tricks went off, the bridge stops)
// answers no more: `api.no_run_token`, and the connection closes. The connection keeps only the token's
// hash hex (`key`, from the table's `resolve`) and asks `alive(key)`; the raw token is compared once, in
// constant time, at `hello`, and never kept, logged or answered. And when a token dies, the table tells the
// socket at once (`endToken`, wired in bridge/index.ts): every connection bound to it answers its open
// requests with `api.no_run_token` and closes, so an `events` wait gives its slot back with the run.
//
// WHAT IT IS, IN HONEST WORDS (decision 16 of ADR 0152, as ADR 0155 changes it). The token keeps out a
// program that only finds THIS socket, and nothing more. It does not stop a program of the same Unix user: such a
// program can read every screen and type into every pane through the multiplexer's own socket, and can
// read another program's memory, the token in a run's memory included, and can read the owner-only
// `<stateDir>/local-secret`, though on the bridge's loopback door that key reads no screen or message text
// (bridge/local-key.ts `LOCAL_KEY_ROUTES`). The socket is closed to OTHER Unix
// users (the file mode and the folder mode), to other machines and to pages in a browser (no TCP port, no
// HTTP: a page can reach loopback HTTP, never a Unix socket). A connection is the unit its caps count by.
// Every `read` call leaves one log line: `[api] read by=trick:<id> session=<id> result=<ok or the error
// code>`, the trick named by the token, never by the caller's word; a read refused before a good `hello`
// leaves no line. It holds no screen text, label or
// path; the session id is logged only in its own `ses_` alphabet (anything else is `invalid`), so a caller
// cannot put a line break into the log.
//
// WHEN IT EXISTS (decision 14). While tricks are switched on, on a bridge where tricks run:
// bridge/index.ts calls `start` and `stop` as its one function `localApiWanted` says, and a
// bridge with no tricks folder never builds one. On Windows there is no socket in this release: tricks are
// gated there (`TricksService.gated`), the socket follows "tricks run here", so `start` is a no-op that logs
// once (see `open`). `start` and `stop` are idempotent and run one at a time, in the order called, so a quick on/off/on ends with
// ONE server on a socket file that is its own. `start` refuses a path that holds something other than a
// socket, and a socket another live process answers on; a dead socket left behind is unlinked. `stop`
// closes the server, answers every open request at once with `api.closing`, and closes every connection.
// The runtime unlinks the socket path inside the server's close, at once (socket.test.ts pins it), so
// the file is gone before the next `start` in the chain runs; `stop` unlinks it itself only when the
// runtime did not and the file is still the one this server made (same inode).
//
// THE WIRE. JSON lines over the socket. A connection is persistent and may carry several requests:
//   request  { "id"?: string (1..64), "op": string, "args"?: object }               one line
//   answer   { "id"?, "ok": true, ...fields }                                       one line
//            { "id"?, "ok": false, "error": { "code": "api.<...>", "message": "<next step>" } }
// Answers may come out of order (an `events` wait never holds up a `sessions` on the same connection);
// the `id`, echoed when the request carried a readable one, pairs them. A request line is at most
// 16 KiB and must end within 2 s of its first byte. A line that is not a readable request answers
// `api.bad_request` and the connection stays usable; a line past the cap, or one that does not end in
// time, answers `api.bad_request` and the connection closes (the framing is lost). At most 32
// connections are open; one more gets one `api.too_many_connections` line and is closed. One answer is
// at most 1 MiB serialized; a larger one becomes `api.answer_too_large`. At most 4 `events` waits are
// open per connection and 16 in all; one more answers `api.too_many_waits` at once. At most 8 requests
// are in flight on one connection, waits included; one more answers `api.too_many_requests` at once. At
// most 4 `read` operations (a screen read each; on tmux each starts a process the phone also needs) are
// in progress on the whole socket; one more answers `api.busy` at once, with a retry hint. A
// connection with no request in flight and no partial line for 5 minutes is closed, with no line, so
// an idle program does not hold one of the 32 places.
//
// THE STATED MEMORY BOUND (security read 1, item 1). A caller that sends and never reads must not make
// the bridge buffer without end. Each connection has a write budget of 2 MiB: the bytes the socket holds
// for it (`writableLength`). Above the budget the bridge stops reading that connection (`socket.pause()`,
// and no line already received is taken), so no new request starts there; it reads again once the
// caller has drained the socket below the budget. A connection that stays above the budget for 10 s is
// dropped. What one connection can hold is therefore the budget plus the answers of the at most 8
// requests already in flight when it paused (each at most 1 MiB, and at most 4 screen reads on the whole
// socket), and only for 10 s. All 32 connections together can so hold about 115 MB for 10 s. Only a
// program of the same user can do that, and it is accepted (security read 2).

import { once } from "node:events";
import { chmodSync, lstatSync, mkdirSync, unlinkSync, type Stats } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";

import { apiError, type ApiErrorDetail, type ErrorCode } from "../error-codes.ts";
import type { JsonObject } from "../json.ts";
import { asJsonObject, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";
import {
  ANSWER_MAX_BYTES,
  BUSY_RETRY_MS,
  CONNECTIONS_MAX,
  IDLE_MS,
  REQUEST_ID_MAX,
  REQUEST_LINE_MAX,
  REQUEST_LINE_MS,
  REQUESTS_PER_CONNECTION,
  SCREEN_READS_MAX,
  WAITS_PER_CONNECTION,
  WAITS_TOTAL,
  WRITE_BUFFER_MAX,
  WRITE_STALL_MS,
} from "./limits.ts";
import { admit, DECLARED, lowerOf, offeredOf, type OperationContext, type OperationTable, type OpResult, type Right, type TableRow } from "./operations.ts";

/** ` (trick:<id>)` for a log line of a connection bound to a run token, else nothing. */
function by(conn: Conn): string {
  return conn.bound === null ? "" : ` (trick:${conn.bound.trickId})`;
}

/** What a live run token stands for: the trick whose run holds it, the level its manifest declares, and the token's key. */
export interface RunTokenHolder {
  readonly trickId: string;
  readonly level: Right;
  /** The hex of the token's SHA-256: what the connection keeps in place of the token. */
  readonly key: string;
}

/**
 * The one way the socket asks about a run token (spec 05, decision 2): the trick runner's table, handed in
 * by bridge/index.ts. `resolve` answers the holder of a live token, or null for one that is unknown or dead;
 * it compares in constant time. `alive` asks again by the key `resolve` gave. The socket keeps no table of
 * its own; the table tells it a death through {@link ApiSocket.endToken}.
 */
export interface RunTokenCheck {
  resolve(token: string): RunTokenHolder | null;
  alive(key: string): boolean;
}

/** A connection's binding after a good `hello`: its token's key (never the token), and what that stood for then. */
interface Bound {
  readonly key: string;
  readonly trickId: string;
  readonly level: Right;
}

/** The local API socket of one state dir. */
export function apiSocketPath(stateDir: string): string {
  return join(stateDir, "api", "sock");
}

export interface ApiSocketDeps {
  readonly socketPath: string;
  readonly table: OperationTable;
  /** The ceiling of every caller of this socket: {@link LOCAL_TIER_RIGHTS}. A connection holds its token's level under it. */
  readonly granted: Right;
  /** The run tokens: a connection is answered only after its `hello` names a live one. */
  readonly tokens: RunTokenCheck;
  /** The host's platform (`HOST.platform` from bridge/host.ts at the edge); a test passes `"win32"` to see the gate. */
  readonly platform: NodeJS.Platform;
  readonly log?: (line: string) => void;
  /** How long one request line may take. Default {@link REQUEST_LINE_MS}; a test shortens it. */
  readonly lineMs?: number;
  /** How long an idle connection stays open. Default {@link IDLE_MS}; a test shortens it. */
  readonly idleMs?: number;
  /** How long a connection may stay above its write budget. Default {@link WRITE_STALL_MS}; a test shortens it. */
  readonly stallMs?: number;
  /** The uid that must own `<stateDir>/api`. Default `process.getuid()`; a test passes another to see the refusal. */
  readonly uid?: number;
}

/** How many connections and waits are open. */
export interface SocketCounts {
  readonly connections: number;
  readonly waits: number;
}

/** One started server and the socket file it made. */
interface Live {
  readonly server: Server;
  readonly ino: number;
}

/** One request being answered. */
interface Pending {
  readonly id: string | undefined;
  answered: boolean;
  /** Set for a `read` call: the session the caller asked for, as it may be logged. It is logged once, with the answer. */
  readSession?: string;
}

/** One open connection. */
interface Conn {
  readonly socket: Socket;
  readonly live: Live;
  readonly controller: AbortController;
  readonly pending: Set<Pending>;
  buffer: Buffer;
  timer: ReturnType<typeof setTimeout> | undefined;
  idle: ReturnType<typeof setTimeout> | undefined;
  waits: number;
  closed: boolean;
  /** Above its write budget: reading is paused (header, the memory bound). */
  paused: boolean;
  /** While paused: the check that resumes or, after the stall time, drops. */
  stall: ReturnType<typeof setInterval> | undefined;
  /** When the connection went above its budget. */
  overSince: number;
  /** While paused: the `drain` listener that resumes. */
  onDrain: (() => void) | undefined;
  /** The run token a good `hello` named, its trick and its level; null before one. */
  bound: Bound | null;
  /** Before a good `hello`: the deadline that closes the connection when none comes in time. */
  helloTimer: ReturnType<typeof setTimeout> | undefined;
}

const RESERVED = new Set(["id", "ok", "error"]);
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const NEWLINE = 0x0a;
const NOTHING = Buffer.alloc(0);
/** The operation that reads a screen: the one the socket-wide cap counts. */
const SCREEN_READ_OP = "read";
/** The operation that names the run token: the first on every connection. */
const HELLO_OP = "hello";

/** A session id as `ses_` and base64url characters, the only shape a log line may carry. */
const LOGGABLE_SESSION = /^ses_[A-Za-z0-9_-]{1,508}$/u;

/** The session a `read` asked for, for the log: the id when it has an id's alphabet, else `invalid`. */
function sessionForLog(args: JsonObject | undefined): string {
  const session = asJsonString(args?.session);
  return session !== undefined && LOGGABLE_SESSION.test(session) ? session : "invalid";
}

/** The error answer line's body. The message is the catalogue's sentence. */
function errorBody(code: ErrorCode, detail: ApiErrorDetail | undefined): JsonObject {
  return { code, message: apiError(code, detail).error };
}

export class ApiSocket {
  private live: Live | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly connections = new Set<Conn>();
  private waitsOpen = 0;
  private screenReads = 0;
  private windowsLogged = false;
  private readonly log: (line: string) => void;
  private readonly granted: Right;

  constructor(private readonly deps: ApiSocketDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
    this.granted = deps.granted;
  }

  /** Listen, after every start and stop called before. True when the socket stands. */
  start(): Promise<boolean> {
    return this.serial(() => this.open());
  }

  /** Close, after every start and stop called before. */
  stop(): Promise<void> {
    return this.serial(() => this.close());
  }

  /** Whether a server is started now. */
  running(): boolean {
    return this.live !== null;
  }

  /** How many connections and waits are open: for a test and a status line. */
  counts(): SocketCounts {
    return { connections: this.connections.size, waits: this.waitsOpen };
  }

  /**
   * A run token died (its run ended, its trick or tricks went off, the trick was removed, the bridge stops):
   * every connection bound to it answers each open request with `api.no_run_token` and closes, at once. Its
   * `events` waits abort with it and give their slots back. `key` is the token's hash hex.
   */
  endToken(key: string): void {
    for (const conn of this.connections) {
      if (conn.bound?.key !== key) continue;
      for (const pending of conn.pending) this.answer(conn, pending, { ok: false, code: "api.no_run_token" });
      this.drop(conn);
    }
  }

  /** The bytes waiting to be written, on the fullest connection: for a test. */
  bufferedMax(): number {
    let most = 0;
    for (const conn of this.connections) most = Math.max(most, conn.socket.writableLength);
    return most;
  }

  private serial<T>(step: () => Promise<T>): Promise<T> {
    const next = this.chain.then(step, step);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async open(): Promise<boolean> {
    if (this.live !== null) return true;
    const path = this.deps.socketPath;
    // No local API on Windows in this release (decision of 2026-11-17): the socket follows "tricks run here",
    // and tricks are closed there behind the gate (`TricksService.gated`, which also keeps `localApiWanted`
    // false). A Unix socket path is no Windows path either. Nothing is made on disk; the way back is to lift
    // the gate and give the API a Windows transport together.
    if (this.deps.platform === "win32") {
      if (!this.windowsLogged) this.log("[api] no socket: the local API needs a Unix socket on this host");
      this.windowsLogged = true;
      return false;
    }
    try {
      const refused = this.ownFolder(dirname(path));
      if (refused !== null) {
        this.log(`[api] no socket: ${refused}`);
        return false;
      }
      const held = lstatOrNull(path);
      if (held !== null) {
        if (!held.isSocket()) {
          this.log(`[api] no socket: ${path} exists and is not a socket`);
          return false;
        }
        if (await answers(path)) {
          this.log(`[api] no socket: another process listens on ${path}`);
          return false;
        }
        unlinkSync(path);
      }
      const server = createServer((socket) => this.accept(socket));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
          server.off("error", reject);
          resolve();
        });
      });
      chmodSync(path, 0o600);
      server.unref();
      this.live = { server, ino: lstatSync(path).ino };
      this.log(`[api] local API socket at ${path} (read only, experimental)`);
      return true;
    } catch (err) {
      this.log(`[api] no socket: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Make sure `<stateDir>/api` is this user's own folder, never followed through a link: created with mode
   * 0700 when absent; refused when it is a symlink, not a folder, or owned by another uid. Null when it is
   * fine, else why not.
   */
  private ownFolder(dir: string): string | null {
    const uid = this.deps.uid ?? process.getuid?.();
    let held = lstatOrNull(dir);
    if (held === null) {
      mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
      // Not recursive: a folder (or a link) that appeared since the lstat fails here, never followed.
      mkdirSync(dir, { mode: 0o700 });
      held = lstatOrNull(dir);
    }
    if (held === null) return `${dir} could not be made`;
    if (held.isSymbolicLink()) return `${dir} is a symbolic link`;
    if (!held.isDirectory()) return `${dir} is not a folder`;
    if (uid !== undefined && held.uid !== uid) return `${dir} is not owned by this user`;
    chmodSync(dir, 0o700);
    return null;
  }

  private async close(): Promise<void> {
    const live = this.live;
    this.live = null;
    if (live === null) return;
    const closed = new Promise<void>((resolve) => {
      live.server.close(() => resolve());
    });
    for (const conn of this.connections) {
      if (conn.live !== live) continue;
      for (const pending of conn.pending) this.answer(conn, pending, { ok: false, code: "api.closing" });
      this.drop(conn);
    }
    // The connections are ending; the server's close waits for them, never longer than a moment.
    await Promise.race([closed, delay(1000)]);
    const now = lstatOrNull(this.deps.socketPath);
    if (now !== null && now.isSocket() && now.ino === live.ino) {
      try {
        unlinkSync(this.deps.socketPath);
      } catch {
        // A socket file left behind is unlinked by the next start.
      }
    }
    this.log("[api] local API socket closed");
  }

  /** Whether `live` is still the started server and its file is still in place, the same inode. */
  private standing(live: Live): boolean {
    if (this.live !== live) return false;
    const now = lstatOrNull(this.deps.socketPath);
    return now !== null && now.isSocket() && now.ino === live.ino;
  }

  private accept(socket: Socket): void {
    socket.on("error", () => undefined);
    const live = this.live;
    if (live === null || this.connections.size >= CONNECTIONS_MAX) {
      const code: ErrorCode = live === null ? "api.closing" : "api.too_many_connections";
      const detail = live === null ? undefined : { max: CONNECTIONS_MAX };
      endWith(socket, `${JSON.stringify({ ok: false, error: errorBody(code, detail) })}\n`);
      return;
    }
    const conn: Conn = {
      socket,
      live,
      controller: new AbortController(),
      pending: new Set(),
      buffer: Buffer.alloc(0),
      timer: undefined,
      idle: undefined,
      waits: 0,
      closed: false,
      paused: false,
      stall: undefined,
      overSince: 0,
      onDrain: undefined,
      bound: null,
      helloTimer: undefined,
    };
    this.connections.add(conn);
    socket.on("close", () => this.forget(conn));
    socket.on("data", (chunk: Buffer) => this.receive(conn, chunk));
    this.idleCheck(conn);
    // A good `hello` must come within the line limit of the connect (spec 05): a caller with no token
    // cannot hold one of the 32 places for the idle time. It hears one `api.no_run_token` line, then the close.
    conn.helloTimer = setTimeout(() => {
      if (conn.closed || conn.bound !== null) return;
      this.write(conn, { ok: false, error: errorBody("api.no_run_token", undefined) });
      this.drop(conn);
    }, this.deps.lineMs ?? REQUEST_LINE_MS);
    conn.helloTimer.unref?.();
  }

  /** The connection is gone: its waits abort, its answers are dropped. */
  private forget(conn: Conn): void {
    if (!this.connections.delete(conn)) return;
    conn.closed = true;
    clearTimeout(conn.timer);
    clearTimeout(conn.idle);
    clearTimeout(conn.helloTimer);
    clearInterval(conn.stall);
    for (const pending of conn.pending) pending.answered = true;
    conn.pending.clear();
    conn.controller.abort();
  }

  /** End a connection: what was written is flushed, then it closes. */
  private drop(conn: Conn): void {
    this.forget(conn);
    endWith(conn.socket, "");
  }

  /** Arm the idle close when nothing is in flight and no line is partial; else disarm it. */
  private idleCheck(conn: Conn): void {
    clearTimeout(conn.idle);
    conn.idle = undefined;
    if (conn.closed || conn.pending.size > 0 || conn.buffer.length > 0) return;
    conn.idle = setTimeout(() => this.drop(conn), this.deps.idleMs ?? IDLE_MS);
    conn.idle.unref?.();
  }

  private receive(conn: Conn, chunk: Buffer): void {
    if (conn.closed) return;
    this.receiveLines(conn, chunk);
    this.idleCheck(conn);
  }

  private receiveLines(conn: Conn, chunk: Buffer): void {
    conn.buffer = conn.buffer.length === 0 ? chunk : Buffer.concat([conn.buffer, chunk]);
    let ended = false;
    // Over the write budget, no further line is taken: it waits in the buffer until the caller reads.
    for (let at = conn.buffer.indexOf(NEWLINE); at >= 0 && !conn.closed && !conn.paused; at = conn.buffer.indexOf(NEWLINE)) {
      const line = conn.buffer.subarray(0, at);
      conn.buffer = conn.buffer.subarray(at + 1);
      ended = true;
      if (line.length > REQUEST_LINE_MAX) return this.refuseFraming(conn, "the line is longer than 16 KiB");
      this.request(conn, line);
    }
    if (conn.closed) return;
    if (conn.paused) {
      // The line clock is the caller's, and it is the bridge that stopped reading: no clock while paused.
      clearTimeout(conn.timer);
      conn.timer = undefined;
      return;
    }
    if (conn.buffer.length > REQUEST_LINE_MAX) return this.refuseFraming(conn, "the line is longer than 16 KiB");
    if (conn.buffer.length === 0) {
      clearTimeout(conn.timer);
      conn.timer = undefined;
      return;
    }
    // A line's time runs from its first byte: a new partial line after a whole one starts the clock again.
    if (ended || conn.timer === undefined) {
      clearTimeout(conn.timer);
      conn.timer = setTimeout(() => this.refuseFraming(conn, "the line did not end in time"), this.deps.lineMs ?? REQUEST_LINE_MS);
      conn.timer.unref?.();
    }
  }

  /** The framing is lost: one error line, then the connection closes. */
  private refuseFraming(conn: Conn, reason: string): void {
    if (conn.closed) return;
    this.write(conn, { ok: false, error: errorBody("api.bad_request", { reason }) });
    this.drop(conn);
  }

  private request(conn: Conn, raw: Buffer): void {
    const pending: Pending = { id: undefined, answered: false };
    let text: string;
    try {
      text = UTF8.decode(raw);
    } catch {
      return this.refuse(conn, pending, badRequest("the line is not UTF-8"));
    }
    const body = parseJsonObject(text);
    if (body === undefined) return this.refuse(conn, pending, badRequest("the line is not a JSON object"));
    const id = asJsonString(body.id);
    if (body.id !== undefined && (id === undefined || id === "" || id.length > REQUEST_ID_MAX)) {
      return this.refuse(conn, pending, badRequest("id must be text of 1 to 64 characters"));
    }
    const read: Pending = { id, answered: false };
    if (Object.keys(body).some((key) => key !== "id" && key !== "op" && key !== "args")) return this.refuse(conn, read, badRequest("a request has only id, op and args"));
    const op = asJsonString(body.op);
    if (op === undefined || op === "") return this.refuse(conn, read, badRequest("op must be the name of an operation"));
    const args = body.args === undefined ? {} : asJsonObject(body.args);
    if (op === SCREEN_READ_OP) read.readSession = sessionForLog(args);
    if (args === undefined) return this.refuse(conn, read, badRequest("args must be a JSON object"));
    // The run token (spec 05, decision 3): `hello` binds the connection to one; nothing runs before that.
    if (op === HELLO_OP) {
      const refused = this.hello(conn, args);
      if (refused !== null) return this.refuse(conn, read, refused, true);
    }
    const bound = conn.bound;
    if (bound === null || !this.deps.tokens.alive(bound.key)) return this.refuse(conn, read, { ok: false, code: "api.no_run_token" }, true);
    const admitted = admit(this.deps.table, op, bound.level);
    if (!admitted.ok) return this.answer(conn, read, { ok: false, code: admitted.code });
    if (conn.pending.size >= REQUESTS_PER_CONNECTION) return this.answer(conn, read, { ok: false, code: "api.too_many_requests", detail: { max: REQUESTS_PER_CONNECTION } });
    const screen = admitted.row.name === SCREEN_READ_OP;
    if (screen && this.screenReads >= SCREEN_READS_MAX) return this.answer(conn, read, { ok: false, code: "api.busy", detail: { max: SCREEN_READS_MAX, retryMs: BUSY_RETRY_MS } });
    conn.pending.add(read);
    const ctx: OperationContext = {
      signal: conn.controller.signal,
      offered: offeredOf(this.deps.table, bound.level),
      standing: () => this.standing(conn.live),
      claimWait: () => (admitted.row.waits ? this.claimWait(conn) : null),
    };
    void this.run(conn, read, admitted.row, args, ctx, screen);
  }

  /**
   * A `hello`: bind the connection to the run token it names, or say why not (spec 05, decision 3). The token
   * is asked first, so a hello with no token, an unknown one or a dead one is `api.no_run_token`, whatever
   * else it carries (a helper of spec 04 sends `client` and no token, and hears that). Then the arguments
   * must be exactly the row's (`token`), and a connection already bound must name the same token.
   */
  private hello(conn: Conn, args: JsonObject): OpResult | null {
    const token = asJsonString(args.token);
    const holder = token === undefined ? null : this.deps.tokens.resolve(token);
    if (token === undefined || holder === null) return { ok: false, code: "api.no_run_token" };
    const parsed = DECLARED.hello.parse(args);
    if (!parsed.ok) return badRequest(parsed.reason);
    // Two keys compare as text: each is a hash, so the compare tells a caller nothing of a token.
    if (conn.bound !== null && conn.bound.key !== holder.key) return badRequest("a connection holds one run token");
    conn.bound = { key: holder.key, trickId: holder.trickId, level: lowerOf(holder.level, this.granted) };
    clearTimeout(conn.helloTimer);
    conn.helloTimer = undefined;
    return null;
  }

  /**
   * Answer a refusal. Before a good `hello` (or with `close`), the connection then closes: a caller with no
   * live token gets one line and no second try on the same connection.
   */
  private refuse(conn: Conn, pending: Pending, result: OpResult, close = false): void {
    this.answer(conn, pending, result);
    if (close || conn.bound === null) this.drop(conn);
  }

  /** Run one admitted row and answer it; a handler that throws answers `api.failed`. A screen read holds one of the socket's places while it runs. */
  private async run(conn: Conn, pending: Pending, row: TableRow, args: JsonObject, ctx: OperationContext, screen: boolean): Promise<void> {
    let result: OpResult;
    if (screen) this.screenReads += 1;
    try {
      result = await row.run(args, ctx);
    } catch (err) {
      this.log(`[api] ${row.name} failed${by(conn)}: ${err instanceof Error ? err.message : String(err)}`);
      result = { ok: false, code: "api.failed" };
    } finally {
      if (screen) this.screenReads -= 1;
    }
    // A token that died while the operation ran (its run ended, its trick or tricks went off) gets no answer
    // of substance: one refusal, and the connection closes (spec 05, decision 2).
    const bound = conn.bound;
    if (bound === null || !this.deps.tokens.alive(bound.key)) return this.refuse(conn, pending, { ok: false, code: "api.no_run_token" }, true);
    this.answer(conn, pending, result);
  }

  /**
   * The one log line of a `read` call, written with its first answer: the trick its run token names (spec 05,
   * decision 5), the session id and the outcome; never the screen, never the token. A read refused before a
   * good `hello` never ran and names nobody: it leaves no line, so a caller with no token cannot fill the log.
   */
  private logRead(conn: Conn, pending: Pending, result: OpResult): void {
    const session = pending.readSession;
    if (session === undefined) return;
    pending.readSession = undefined;
    if (conn.bound === null) return;
    this.log(`[api] read by=trick:${conn.bound.trickId} session=${session} result=${result.ok ? "ok" : result.code}`);
  }

  /** One wait slot, or null at the cap. The release gives it back once. */
  private claimWait(conn: Conn): (() => void) | null {
    if (conn.waits >= WAITS_PER_CONNECTION || this.waitsOpen >= WAITS_TOTAL) return null;
    conn.waits += 1;
    this.waitsOpen += 1;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      conn.waits -= 1;
      this.waitsOpen -= 1;
    };
  }

  /** Answer one request once, capped. A request already answered, or on a closed connection, is dropped. */
  private answer(conn: Conn, pending: Pending, result: OpResult): void {
    if (conn.pending.delete(pending)) this.idleCheck(conn);
    this.logRead(conn, pending, result);
    if (pending.answered || conn.closed) return;
    pending.answered = true;
    const line: JsonObject = {};
    if (pending.id !== undefined) line.id = pending.id;
    if (!result.ok) {
      line.ok = false;
      line.error = errorBody(result.code, result.detail);
      this.write(conn, line);
      return;
    }
    if (Object.keys(result.answer).some((key) => RESERVED.has(key))) {
      this.log("[api] an answer used a reserved field name");
      line.ok = false;
      line.error = errorBody("api.failed", undefined);
      this.write(conn, line);
      return;
    }
    line.ok = true;
    for (const [key, value] of Object.entries(result.answer)) line[key] = value;
    const text = JSON.stringify(line);
    if (Buffer.byteLength(text, "utf8") > ANSWER_MAX_BYTES) {
      const refused: JsonObject = {};
      if (pending.id !== undefined) refused.id = pending.id;
      refused.ok = false;
      refused.error = errorBody("api.answer_too_large", { maxBytes: ANSWER_MAX_BYTES });
      this.write(conn, refused);
      return;
    }
    this.send(conn, text);
  }

  private write(conn: Conn, line: JsonObject): void {
    this.send(conn, JSON.stringify(line));
  }

  /** Write one line, then hold the connection to its write budget (header, the memory bound). */
  private send(conn: Conn, text: string): void {
    const socket = conn.socket;
    if (socket.destroyed || !socket.writable) return;
    socket.write(`${text}\n`);
    if (conn.closed || conn.paused || socket.writableLength <= WRITE_BUFFER_MAX) return;
    conn.paused = true;
    conn.overSince = Date.now();
    clearTimeout(conn.timer);
    conn.timer = undefined;
    socket.pause();
    conn.onDrain = () => this.budgetCheck(conn);
    socket.on("drain", conn.onDrain);
    const stallMs = this.deps.stallMs ?? WRITE_STALL_MS;
    conn.stall = setInterval(() => this.budgetCheck(conn), Math.max(10, Math.min(1000, Math.floor(stallMs / 10))));
    conn.stall.unref?.();
  }

  /** While paused: below the budget, read again; above it for the stall time, drop the connection. */
  private budgetCheck(conn: Conn): void {
    if (conn.closed || !conn.paused) return;
    if (conn.socket.writableLength > WRITE_BUFFER_MAX) {
      if (Date.now() - conn.overSince < (this.deps.stallMs ?? WRITE_STALL_MS)) return;
      this.log(`[api] a connection${by(conn)} did not read its answers for too long; it is dropped`);
      this.forget(conn);
      conn.socket.destroy();
      return;
    }
    conn.paused = false;
    clearInterval(conn.stall);
    conn.stall = undefined;
    if (conn.onDrain !== undefined) conn.socket.off("drain", conn.onDrain);
    conn.onDrain = undefined;
    conn.socket.resume();
    // The lines that came while paused are taken now, in order.
    this.receive(conn, NOTHING);
  }
}

function badRequest(reason: string): OpResult {
  return { ok: false, code: "api.bad_request", detail: { reason } };
}

/** Write `text`, end, and destroy once flushed, or after a moment when the peer does not read. */
function endWith(socket: Socket, text: string): void {
  if (socket.destroyed) return;
  const timer = setTimeout(() => socket.destroy(), 1000);
  timer.unref?.();
  socket.end(text, () => {
    clearTimeout(timer);
    socket.destroy();
  });
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Whether something accepts on `path` within 200 ms: a live process already holds it. */
async function answers(path: string): Promise<boolean> {
  const conn = createConnection({ path });
  conn.on("error", () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((done) => {
    timer = setTimeout(() => done(false), 200);
  });
  const accepted = await Promise.race([once(conn, "connect").then(() => true, () => false), late]);
  clearTimeout(timer);
  conn.destroy();
  return accepted;
}
