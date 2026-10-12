// HOW THE DURABLE ADAPTER TALKS TO THE PROGRAM: HTTP/1.1 over one Unix socket (WIRE.md section 1A).
//
// This is the only file that opens the socket. The other transport, HTTPS with a bearer token
// (WIRE.md section 1B, ADR 0103), is `http-client.ts`; it shares the budgets below. Two rules live
// here and nowhere else:
//
//  • THE PRIVACY CHECK. Before each connect the whole path is checked with `lstat`, from the root
//    down: no symlink anywhere, the socket's folder this user's own with mode 0700, every folder above
//    it a real folder that group and others cannot write to (a sticky folder such as /tmp is allowed
//    above the parent; the owner of those folders is not checked), and the socket owned by this user with no group or other bit. There
//    is no token on the socket, so a private socket is the whole gate. A path that fails is never
//    dialled, and the refusal names the check.
//  • THE BUDGETS. Every call has a time budget and a reply size cap. A reply past the cap is cut off
//    while it is still being read, so a program cannot make the bridge hold a huge body.
//
// The adapter depends on the narrow `DurableTransport` type, not on this class. A test can hand it
// another transport, and the conformance fixture dials a real socket through this one.

import { lstat as lstatFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { byteLength } from "./clean.ts";

/** The variable that names the socket. The program SHOULD read the same one. */
export const DURABLE_SOCKET_ENV = "COLLIE_DURABLE_SOCKET";

/**
 * The longest socket path, in bytes. Linux allows 107, macOS 103; the smaller one holds on both, so a
 * path that works on one host works on the other.
 */
export const SOCKET_PATH_MAX_BYTES = 103;

/** Every path starts with this. It is a fixed name, not the version. */
export const ROUTE_PREFIX = "/session/v1";

/** The start of the refusal detail for a socket that is not private. The failed check follows it. */
export const SOCKET_NOT_PRIVATE = "socket-not-private";

/** The refusal detail for a reply past its size cap. */
export const REPLY_TOO_LARGE = "too-large";

/** The program could not be asked. `detail` is the one line the adapter reports. */
export class DurableUnreachable extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "DurableUnreachable";
  }
}

/** What the program answered. The body is text, because the cap is on bytes before any parsing. */
export interface DurableReply {
  readonly status: number;
  readonly etag: string | null;
  readonly text: string;
}

/** One GET. `path` is the part after `/session/v1`. `version` is the `X-Collie-Session` value. */
export interface DurableGet {
  readonly path: string;
  readonly version: number | null;
  readonly ifNoneMatch: string | null;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

/** One POST. `body` is the JSON object the route takes; the caller has checked every field. */
export interface DurablePost {
  readonly path: string;
  readonly version: number;
  readonly body: object;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

/**
 * A POST that may have reached the program, with no answer to say what it did: a timeout, a
 * dropped connection, or a reply past its cap (WIRE.md section 7.6). Never retried here.
 */
export class DurableOutcomeUnknown extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "DurableOutcomeUnknown";
  }
}

/**
 * Which way a transport reaches the program (ADR 0103). `socket` is the private Unix socket of
 * WIRE.md section 1A. `https` is TLS with a bearer token, section 1B; the loopback `http://` that
 * `wrangler dev` serves counts as `https` too, because it stands in for the deployed program.
 */
export type DurableTransportKind = "socket" | "https";

/**
 * What the adapter needs from a transport. `get` throws `DurableUnreachable` when it cannot ask.
 * `post` throws `DurableUnreachable` only when nothing was sent (no path, a socket that is not
 * private, a refused connect, a refused token), and `DurableOutcomeUnknown` when the request may
 * have left. `kind` picks the adapter's budgets and poll cadence; absent reads as `socket`.
 */
export interface DurableTransport {
  readonly kind?: DurableTransportKind;
  get(request: DurableGet): Promise<DurableReply>;
  post(request: DurablePost): Promise<DurableReply>;
}

// ── The path ──────────────────────────────────────────────────────────────────

/** The socket path, or the reason there is none. The reason names the variable. */
export type SocketPath =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly detail: string };

/** Check the configured path: set, absolute, and short enough for `sun_path`. Nothing is dialled. */
export function resolveSocketPath(configured: string | undefined): SocketPath {
  const path = (configured ?? "").trim();
  if (path === "") return { ok: false, detail: `${DURABLE_SOCKET_ENV} is not set` };
  if (!isAbsolute(path)) return { ok: false, detail: `${DURABLE_SOCKET_ENV} must be an absolute path` };
  if (byteLength(path) > SOCKET_PATH_MAX_BYTES) {
    return { ok: false, detail: `${DURABLE_SOCKET_ENV} is longer than ${String(SOCKET_PATH_MAX_BYTES)} bytes` };
  }
  return { ok: true, path };
}

// ── The privacy check ─────────────────────────────────────────────────────────

/** The part of `lstat` the check reads. A test can supply its own. */
export interface SocketFacts {
  isSocket(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly uid: number;
  readonly mode: number;
}

/** The two things the check asks of the system. Both can be replaced in a test. */
export interface SocketProbe {
  lstat(path: string): Promise<SocketFacts>;
  /** This process's user id, or undefined on a platform with none. */
  uid(): number | undefined;
}

export const SYSTEM_PROBE: SocketProbe = {
  lstat: (path) => lstatFile(path),
  uid: () => process.getuid?.(),
};

/** Group and other permission bits. */
const GROUP_AND_OTHER = 0o077;

/** Group and other write bits. */
const GROUP_OR_OTHER_WRITE = 0o022;

/** The sticky bit: in a directory, only a file's owner may remove or rename it. */
const STICKY = 0o1000;

/** The mode the socket's own directory must have: the owner only. */
const PRIVATE_DIR_MODE = 0o700;

/** Which part of the privacy check a path failed. `doctor` names it; the adapter reports it in one line. */
export type SocketFault =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly message: string }
  | { readonly kind: "no-uid" }
  | { readonly kind: "symlink"; readonly path: string }
  | { readonly kind: "not-a-directory"; readonly path: string }
  | { readonly kind: "parent-wrong-owner"; readonly path: string; readonly owner: number; readonly uid: number }
  | { readonly kind: "parent-open-mode"; readonly path: string; readonly mode: number }
  | { readonly kind: "ancestor-open-mode"; readonly path: string; readonly mode: number }
  | { readonly kind: "not-a-socket" }
  | { readonly kind: "wrong-owner"; readonly owner: number; readonly uid: number }
  | { readonly kind: "open-mode"; readonly mode: number };

/** Every directory above `path`, from the root down to its direct parent. */
function ancestorsOf(path: string): string[] {
  const chain: string[] = [];
  let dir = dirname(path);
  for (;;) {
    chain.unshift(dir);
    const up = dirname(dir);
    if (up === dir) return chain;
    dir = up;
  }
}

/** `lstat`, with a missing path and an unreadable one told apart. */
async function factsOf(path: string, probe: SocketProbe): Promise<SocketFacts | SocketFault> {
  try {
    return await probe.lstat(path);
  } catch (err) {
    const code = err instanceof Error && "code" in err ? err.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "unreadable", message: err instanceof Error ? err.message : String(err) };
  }
}

function isFault(value: SocketFacts | SocketFault): value is SocketFault {
  return "kind" in value;
}

/**
 * What is wrong with one directory on the way to the socket, or null when it is fine.
 *
 * The direct parent is where the program makes the socket, so it must be this user's own, mode 0700:
 * a parent another user can write to lets them swap the socket for their own between this check and
 * the connect. Every other ancestor must be a real directory that group and others cannot write to,
 * except a sticky one such as `/tmp`, where nobody can rename what they do not own. Its owner is not
 * checked: under a systemd user service with `PrivateTmp=yes` the root-owned `/`, `/run` and
 * `/run/user` show up as user 65534, and a swap needs write access, which this rule already denies.
 * The sticky exception holds for an ancestor only, never for the parent.
 */
function directoryFault(path: string, facts: SocketFacts, parent: boolean, uid: number): SocketFault | null {
  if (facts.isSymbolicLink()) return { kind: "symlink", path };
  if (!facts.isDirectory()) return { kind: "not-a-directory", path };
  const mode = facts.mode & 0o7777;
  if (parent) {
    if (facts.uid !== uid) return { kind: "parent-wrong-owner", path, owner: facts.uid, uid };
    if ((mode & 0o777) !== PRIVATE_DIR_MODE) return { kind: "parent-open-mode", path, mode: mode & 0o777 };
    return null;
  }
  if ((mode & GROUP_OR_OTHER_WRITE) !== 0 && (mode & STICKY) === 0) return { kind: "ancestor-open-mode", path, mode: mode & 0o777 };
  return null;
}

/**
 * Which check this path fails, or null when it may be dialled (WIRE.md section 1A).
 *
 * The whole path is checked with `lstat`, from the root down, so no link is ever followed: a symlink
 * anywhere in it is refused. Every ancestor directory passes {@link directoryFault}, and the socket
 * itself must be a socket owned by the adapter's own uid with no group or other bit. A platform with
 * no uid cannot show an owner, so it fails closed before anything is read. A missing path is a
 * different answer: nothing is listening yet, and that is not a privacy problem.
 */
export async function socketFault(path: string, probe: SocketProbe = SYSTEM_PROBE): Promise<SocketFault | null> {
  const uid = probe.uid();
  if (uid === undefined) return { kind: "no-uid" };
  const chain = ancestorsOf(path);
  for (const [index, dir] of chain.entries()) {
    const facts = await factsOf(dir, probe);
    if (isFault(facts)) return facts;
    const fault = directoryFault(dir, facts, index === chain.length - 1, uid);
    if (fault !== null) return fault;
  }
  const facts = await factsOf(path, probe);
  if (isFault(facts)) return facts;
  if (facts.isSymbolicLink()) return { kind: "symlink", path };
  if (!facts.isSocket()) return { kind: "not-a-socket" };
  if (facts.uid !== uid) return { kind: "wrong-owner", owner: facts.uid, uid };
  if ((facts.mode & GROUP_AND_OTHER) !== 0) return { kind: "open-mode", mode: facts.mode & 0o777 };
  return null;
}

/** An octal mode as `0755`. */
export function octal(mode: number): string {
  return mode.toString(8).padStart(4, "0");
}

/** One line naming the privacy check a path failed. The adapter puts it after `socket-not-private: `. */
export function describeFault(fault: SocketFault): string {
  switch (fault.kind) {
    case "missing":
      return "nothing is at the path";
    case "unreadable":
      return `the path cannot be checked: ${fault.message}`;
    case "no-uid":
      return "this platform shows no file owner";
    case "symlink":
      return `${fault.path} is a symlink`;
    case "not-a-directory":
      return `${fault.path} is not a directory`;
    case "parent-wrong-owner":
      return `the socket's folder ${fault.path} belongs to user ${String(fault.owner)}, not to ${String(fault.uid)}`;
    case "parent-open-mode":
      return `the socket's folder ${fault.path} has mode ${octal(fault.mode)}, not 0700`;
    case "ancestor-open-mode":
      return `${fault.path} has mode ${octal(fault.mode)}, so group or others can write to it`;
    case "not-a-socket":
      return "the path is not a socket";
    case "wrong-owner":
      return `the socket belongs to user ${String(fault.owner)}, not to ${String(fault.uid)}`;
    case "open-mode":
      return `the socket has mode ${octal(fault.mode)}, not 0600`;
  }
}

/**
 * Why this path may not be dialled, as the one line the adapter reports, or null when it may. A
 * privacy fault reads `socket-not-private: <the check that failed>`.
 */
export async function socketAccessProblem(path: string, probe: SocketProbe = SYSTEM_PROBE): Promise<string | null> {
  const fault = await socketFault(path, probe);
  if (fault === null) return null;
  if (fault.kind === "missing") return `no socket at ${path}`;
  if (fault.kind === "unreadable") return `cannot check ${path}: ${fault.message}`;
  return `${SOCKET_NOT_PRIVATE}: ${describeFault(fault)}`;
}

// ── The socket client ─────────────────────────────────────────────────────────

/** Read a body into text, stopping as soon as it passes `maxBytes`. Shared with `http-client.ts`. */
export async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel();
    throw new DurableUnreachable(REPLY_TOO_LARGE);
  }
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      void reader.cancel();
      throw new DurableUnreachable(REPLY_TOO_LARGE);
    }
    chunks.push(part.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Whether a failed fetch never reached the program: the connect itself failed. */
function neverConnected(err: Error, timedOut: boolean): boolean {
  if (timedOut) return false;
  const code = "code" in err ? err.code : undefined;
  return code === "ConnectionRefused" || code === "ECONNREFUSED" || code === "ENOENT" || code === "FailedToOpenSocket";
}

/** One line for a failed connect or read. Shared with `http-client.ts`. */
export function describeFailure(err: Error, timeoutMs: number, timedOut: boolean): string {
  if (timedOut) return `no answer within ${String(timeoutMs)}ms`;
  const code = "code" in err ? err.code : undefined;
  if (code === "ConnectionRefused" || code === "ECONNREFUSED") return "connection refused";
  return err.message === "" ? "connection failed" : err.message;
}

/** The real transport: the privacy check, then one HTTP request on the Unix socket. */
export class DurableSocketClient implements DurableTransport {
  readonly kind = "socket";

  constructor(
    private readonly configured: string | undefined,
    private readonly probe: SocketProbe = SYSTEM_PROBE,
  ) {}

  async get(request: DurableGet): Promise<DurableReply> {
    const resolved = resolveSocketPath(this.configured);
    if (!resolved.ok) throw new DurableUnreachable(resolved.detail);
    const problem = await socketAccessProblem(resolved.path, this.probe);
    if (problem !== null) throw new DurableUnreachable(problem);

    const headers = new Headers({ accept: "application/json" });
    if (request.version !== null) headers.set("x-collie-session", String(request.version));
    if (request.ifNoneMatch !== null) headers.set("if-none-match", request.ifNoneMatch);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
    try {
      const response = await fetch(`http://localhost${ROUTE_PREFIX}${request.path}`, {
        unix: resolved.path,
        headers,
        signal: controller.signal,
        redirect: "manual",
      });
      const text = await readCapped(response, request.maxBytes);
      return { status: response.status, etag: response.headers.get("etag"), text };
    } catch (err) {
      if (err instanceof DurableUnreachable) throw err;
      const failure = err instanceof Error ? err : new Error(String(err));
      throw new DurableUnreachable(describeFailure(failure, request.timeoutMs, timedOut));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One POST. The privacy check runs first, as for a read. Nothing is retried: a POST whose fate is
   * not known is `DurableOutcomeUnknown`, and the caller decides what the person is told.
   */
  async post(request: DurablePost): Promise<DurableReply> {
    const resolved = resolveSocketPath(this.configured);
    if (!resolved.ok) throw new DurableUnreachable(resolved.detail);
    const problem = await socketAccessProblem(resolved.path, this.probe);
    if (problem !== null) throw new DurableUnreachable(problem);

    const headers = new Headers({
      accept: "application/json",
      "content-type": "application/json",
      "x-collie-session": String(request.version),
    });
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`http://localhost${ROUTE_PREFIX}${request.path}`, {
        method: "POST",
        unix: resolved.path,
        headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (err) {
      clearTimeout(timer);
      const failure = err instanceof Error ? err : new Error(String(err));
      const detail = describeFailure(failure, request.timeoutMs, timedOut);
      if (neverConnected(failure, timedOut)) throw new DurableUnreachable(detail);
      throw new DurableOutcomeUnknown(detail);
    }
    try {
      const text = await readCapped(response, request.maxBytes);
      return { status: response.status, etag: response.headers.get("etag"), text };
    } catch (err) {
      // The program answered, and the answer could not be read whole. Its status alone does not say
      // what ran, so the outcome is unknown.
      const detail = err instanceof DurableUnreachable ? err.detail : describeFailure(err instanceof Error ? err : new Error(String(err)), request.timeoutMs, timedOut);
      throw new DurableOutcomeUnknown(detail);
    } finally {
      clearTimeout(timer);
    }
  }
}
