// collie-inbox v1
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

// Collie's inbox for pi: the agent's own door (ADR 0141). A phone send reaches the live session through
// `pi.sendUserMessage`, and no key is typed into the pane, so a draft the person left in pi's editor stays
// where it is and a picker that is open gets nothing.
//
// It listens on a private unix socket named by the pane, with two routes:
//
//   GET  /hello  who is here: the session file (the bridge binds a send to it), the pid, and the raw
//                multiplexer markers the socket is named by. All of it is a hint, never proof (ADR 0024).
//   POST /send   `{ text, requestId, steer? }`. `taken` when pi was idle and a turn starts, `queued` when
//                pi was busy and the text waits as its own follow-up turn, `steered` when the person
//                chose steer. A request id seen before answers what it answered then, with `replayed`,
//                and runs nothing. These answers are hints too: pi's journal settles the send.
//   GET  /queue  which sends pi took are still waiting (`pending`), and which have LEFT pi's queue
//                (`left`): pi settled its run with nothing queued, so each one ran or went back to the
//                editor (Escape or Stop puts queued messages back there). Which of the two is pi's
//                journal's to say, never this answer's: the bridge reads `left` beside the journal.
//
// THE SOCKET is `<XDG_STATE_HOME or ~/.local/state>/collie/inbox/<pane key>.sock`, the key being the digest
// that names the pane's beacon, beside Collie's hook-target registry (`bridge/beacon/paths.ts`
// `inboxSocketPath`): a place every bridge computes from the environment alone, whatever its own state dir. Mode 0600 in a
// 0700 folder that is this user's own and not a link; anything else opens no socket. Outside a
// multiplexer there is no pane to name, and nothing opens.
//
// It opens on `session_start` in pi's terminal UI only (not `--print`, `--mode json` or `rpc`), and closes
// on `session_shutdown`. A new, resumed, forked or reloaded session replaces this instance, and the socket
// with it. An older instance never removes a socket a newer one opened.
//
// SELF-CONTAINED by design: `collie inbox install pi` copies this one file into pi's extensions folder,
// where pi loads it with node's modules only. The marker table, the digest and the request-id rule are
// copies of Collie's own, and `collie-inbox.test.ts` pins each one to its original.

/** The inbox wire version `/hello` reports. */
export const INBOX_VERSION = 1;

/**
 * The largest `/send` body read, in bytes. A longer one is answered 413 and runs nothing. Collie sends up
 * to 64 Ki UTF-16 units (`SEND_MAX_TEXT`), which JSON in UTF-8 can carry in up to six bytes each.
 */
export const MAX_BODY_BYTES = 512 * 1024;

/** How many request ids are kept for replay. The oldest goes first. */
export const KEEP_REQUEST_IDS = 500;

/** A request id as the phone mints it: Collie's `REQUEST_ID` (`web/src/lib/surface/send.ts`). */
export const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The inboxes' folder: Collie's `INBOX_SUBDIR`. */
export const INBOX_SUBDIR = "inbox";

/** The longest socket path that fits `sun_path` everywhere (104 bytes on macOS, with its NUL). */
export const MAX_SOCKET_PATH_BYTES = 103;

/** What the name the socket is first bound under adds to the path: `-<4 hex>` (see `open`). */
const BIND_SUFFIX_BYTES = 5;

/** One multiplexer's pane identity, raw, as `collie beacon emit` records it (`BeaconMarker`). */
export type Marker = {
  readonly namespace: string;
  readonly scope: string;
  readonly pane: string;
};

/** Where each multiplexer puts the pane identity in the env: `cli/beacon.ts` `MUX_ENV_MARKERS`. */
const MUX_ENV_MARKERS: readonly { namespace: string; paneVar: string; scopeVar: string; scopeOf(raw: string): string }[] = [
  // `$TMUX` is `<socket path>,<server pid>,<session index>`; the scope is the socket path.
  { namespace: "tmux", paneVar: "TMUX_PANE", scopeVar: "TMUX", scopeOf: (raw) => raw.split(",")[0] ?? raw },
  { namespace: "tern", paneVar: "TERN_PANE", scopeVar: "TERN_PANE_SOCKET", scopeOf: (raw) => raw },
  { namespace: "zellij", paneVar: "ZELLIJ_PANE_ID", scopeVar: "ZELLIJ_SESSION_NAME", scopeOf: (raw) => raw },
  { namespace: "herdr", paneVar: "HERDR_PANE_ID", scopeVar: "HERDR_SOCKET_PATH", scopeOf: (raw) => raw },
  { namespace: "herdr-core", paneVar: "HC_TERMINAL_ID", scopeVar: "HC_TERMINAL_SOCKET", scopeOf: (raw) => raw },
];

type Env = Readonly<Record<string, string | undefined>>;

/** Every multiplexer this process is inside, as `readEnvMarkers` reads them. A missing scope skips one. */
export function markersOf(env: Env): Marker[] {
  const markers: Marker[] = [];
  for (const source of MUX_ENV_MARKERS) {
    const pane = env[source.paneVar]?.trim();
    const rawScope = env[source.scopeVar]?.trim();
    if (!pane || !rawScope) continue;
    const scope = source.scopeOf(rawScope).trim();
    if (scope === "") continue;
    markers.push({ namespace: source.namespace, scope, pane });
  }
  return markers;
}

/** The pane key: Collie's `beaconKey`, a digest of every marker in a canonical order. */
export function paneKey(markers: readonly Marker[]): string {
  const canonical = markers
    .map((marker) => [marker.namespace, marker.scope, marker.pane].join("\u0000"))
    .toSorted()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * This pane's inbox socket, or undefined when there is none to open: no multiplexer, or a path too long
 * for a unix socket. The folder is Collie's `inboxSocketPath`, beside its `hookTargetsDir`.
 */
export function socketPathOf(env: Env, home: string): string | undefined {
  const markers = markersOf(env);
  if (markers.length === 0) return undefined;
  const xdg = env.XDG_STATE_HOME?.trim() ?? "";
  const base = xdg !== "" && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
  const path = join(base, "collie", INBOX_SUBDIR, `${paneKey(markers)}.sock`);
  return Buffer.byteLength(path) + BIND_SUFFIX_BYTES <= MAX_SOCKET_PATH_BYTES ? path : undefined;
}

/** A session event's payload. Nothing in it is read: the context names the session. */
export interface SessionEvent {
  readonly reason?: string;
}

/** The part of pi's extension context this extension reads. */
export interface InboxContext {
  readonly mode?: string;
  isIdle(): boolean;
  /** Whether pi holds a steer or follow-up it has not delivered. Absent: no send is ever reported left. */
  hasPendingMessages?(): boolean;
  readonly sessionManager?: { getSessionFile?(): string | undefined };
}

/** The part of pi's extension API this extension uses. */
export interface InboxApi {
  on(event: "session_start" | "session_shutdown" | "agent_settled", handler: (event: SessionEvent, ctx: InboxContext | undefined) => Promise<void> | void): void;
  sendUserMessage(text: string, options: { deliverAs: "steer" | "followUp" }): void;
}

// THE PARSE BOUNDARY: a `/send` body is the one input this extension reads, and it is parsed here, once,
// the way Collie's `web/src/lib/json.ts` parses (a copy, as the file must stand alone).

/** Any value JSON can carry. */
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** A JSON object. */
type JsonObject = { [key: string]: JsonValue | undefined };

/** A value's own primitive tag: `[object String]`, `[object Object]`. A parsed document cannot spoof it. */
const tagOf = (value: JsonValue | undefined): string => Object.prototype.toString.call(value);

interface Reply {
  readonly status: number;
  readonly body: JsonObject;
}

const BAD_REQUEST: Reply = { status: 400, body: { code: "bad-request" } };

/** The fields of a `/send` body, or undefined when it is not one. */
function sendOf(raw: string): { text: string; requestId: string; steer: boolean } | undefined {
  let body: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction; there is nothing else it can return.
    body = JSON.parse(raw) as JsonValue;
  } catch {
    return undefined;
  }
  if (tagOf(body) !== "[object Object]") return undefined;
  // SAFETY: the tag check above passed, and `[object Object]` from a parsed document is a plain object.
  const { text, requestId, steer } = body as JsonObject;
  if (tagOf(text) !== "[object String]" || tagOf(requestId) !== "[object String]") return undefined;
  // SAFETY: both tags were checked just above: each value IS a string.
  const [message, id] = [text as string, requestId as string];
  if (message === "" || !REQUEST_ID.test(id)) return undefined;
  if (steer !== undefined && steer !== true && steer !== false) return undefined;
  return { text: message, requestId: id, steer: steer === true };
}

/** The session's file, or null when it has none (an in-memory session) or the context is gone. */
function sessionFileOf(ctx: InboxContext | undefined): string | null {
  try {
    return ctx?.sessionManager?.getSessionFile?.() ?? null;
  } catch {
    return null;
  }
}

/** The inode of the socket at `path`, or undefined when there is no socket there. */
function socketInode(path: string): number | undefined {
  try {
    const stat = lstatSync(path);
    return stat.isSocket() ? stat.ino : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hook the session events when this pi runs in a multiplexer pane, and answer whether it did. `env` and
 * `home` are the process's own in production.
 */
export function activate(pi: InboxApi, env: Env, home: string): boolean {
  const sock = socketPathOf(env, home);
  if (sock === undefined) return false;
  const markers = markersOf(env);
  let ctx: InboxContext | undefined;
  let server: Server | undefined;
  let opened: number | undefined;
  const answered = new Map<string, Reply>();
  // The sends pi took this session, by request id: `pending` until a settle with nothing queued, then `left`.
  const tracked = new Map<string, "pending" | "left">();

  // `deliverAs` is always passed: pi ignores it when idle and starts a turn, and requires it when busy,
  // so a turn that starts between `isIdle()` and the call still queues instead of throwing. `isIdle()`
  // picks only the answer.
  const deliver = (text: string, steer: boolean): Reply => {
    if (ctx === undefined) return { status: 409, body: { code: "no-session" } };
    try {
      const idle = ctx.isIdle();
      pi.sendUserMessage(text, { deliverAs: steer ? "steer" : "followUp" });
      return { status: 202, body: { state: idle ? "taken" : steer ? "steered" : "queued" } };
    } catch (err) {
      return { status: 409, body: { code: "not-taken", why: err instanceof Error ? err.message : String(err) } };
    }
  };

  const send = (raw: string): Reply => {
    const request = sendOf(raw);
    if (request === undefined) return BAD_REQUEST;
    const earlier = answered.get(request.requestId);
    if (earlier !== undefined) return { status: earlier.status, body: { ...earlier.body, replayed: true } };
    const reply = deliver(request.text, request.steer);
    // Only what pi took is kept: a refusal ran nothing, so the same id may be sent again.
    if (reply.status === 202) {
      answered.set(request.requestId, reply);
      const oldest = answered.keys().next();
      if (answered.size > KEEP_REQUEST_IDS && oldest.done !== true) answered.delete(oldest.value);
      // A `taken` send too: pi may have queued it after all, if a turn started between the two calls.
      tracked.set(request.requestId, "pending");
      const first = tracked.keys().next();
      if (tracked.size > KEEP_REQUEST_IDS && first.done !== true) tracked.delete(first.value);
    }
    return reply;
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const answer = ({ status, body }: Reply): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/queue") {
      const ids = (state: "pending" | "left") => [...tracked].flatMap(([id, now]) => (now === state ? [id] : []));
      answer({ status: 200, body: { pending: ids("pending"), left: ids("left") } });
      return;
    }
    if (req.method === "GET" && req.url === "/hello") {
      answer({ status: 200, body: { agent: "pi", inbox: INBOX_VERSION, pid: process.pid, sessionFile: sessionFileOf(ctx), markers } });
      return;
    }
    if (req.method !== "POST" || req.url !== "/send") {
      answer({ status: 404, body: { code: "not-found" } });
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      answer(bytes > MAX_BODY_BYTES ? { status: 413, body: { code: "too-large" } } : send(Buffer.concat(chunks).toString("utf8")));
    });
  };

  // The folder must be a real folder, this user's own; then it is made 0700 and the socket 0600. Any
  // failure opens no socket, and the bridge's preflight finds no door.
  //
  // The socket is bound under a name of its own and then renamed over the pane's name. Closing a unix
  // socket server unlinks the name it was BOUND under, so an older instance that closes after a newer
  // one opened unlinks only its own, long-gone bind name, never the newer socket.
  const open = async (): Promise<void> => {
    const bound = `${sock.slice(0, -".sock".length)}-${randomBytes(2).toString("hex")}.sock`;
    const next = createServer(handle);
    try {
      const dir = dirname(sock);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.()) return;
      chmodSync(dir, 0o700);
      await new Promise<void>((resolve, reject) => {
        next.once("error", reject);
        next.listen(bound, resolve);
      });
      chmodSync(bound, 0o600);
      renameSync(bound, sock);
      server = next;
      opened = socketInode(sock);
    } catch {
      next.close();
      rmSync(bound, { force: true });
    }
  };

  pi.on("session_start", (_event, next) => {
    if (next?.mode !== "tui") return undefined;
    ctx = next;
    return server === undefined ? open() : undefined;
  });

  // pi fires `agent_settled` once no queued continuation will run. With nothing pending then, every send
  // still pending has left the queue: it ran in this run, or Escape or Stop put it back in the editor.
  // While pi still holds something (a send that came in as the run settled), nothing is said.
  pi.on("agent_settled", (_event, next) => {
    const now = next ?? ctx;
    if (now === undefined || tracked.size === 0) return;
    let pending: boolean;
    try {
      pending = now.hasPendingMessages?.() ?? true;
    } catch {
      return;
    }
    if (pending) return;
    for (const [id, state] of tracked) if (state === "pending") tracked.set(id, "left");
  });

  pi.on("session_shutdown", () => {
    ctx = undefined;
    // A new instance knows none of these: the bridge hears no word, and the card waits for its bound.
    tracked.clear();
    server?.close();
    server = undefined;
    // Only the socket this instance opened: a newer instance may already be listening at the path.
    if (opened !== undefined && socketInode(sock) === opened) rmSync(sock, { force: true });
    opened = undefined;
  });
  return true;
}

export default function collieInbox(pi: InboxApi): void {
  activate(pi, process.env, homedir());
}
