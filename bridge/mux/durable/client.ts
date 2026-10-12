// HOW THE DURABLE ADAPTER TALKS TO THE PROGRAM: HTTP/1.1 over one Unix socket (WIRE.md section 1).
//
// This is the only file that opens the socket. Two rules live here and nowhere else:
//
//  • THE PRIVACY CHECK. Before each connect the path is checked with `lstat`: it must be a socket,
//    owned by this process's own user, with no group or other permission bit. There is no token on
//    this wire, so a private socket is the whole gate. A path that fails is never dialled.
//  • THE BUDGETS. Every call has a time budget and a reply size cap. A reply past the cap is cut off
//    while it is still being read, so a program cannot make the bridge hold a huge body.
//
// The adapter depends on the narrow `DurableTransport` type, not on this class. A test can hand it
// another transport, and the conformance fixture dials a real socket through this one.

import { lstat as lstatFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { byteLength } from "./clean.ts";

/** The variable that names the socket. The program SHOULD read the same one. */
export const DURABLE_SOCKET_ENV = "COLLIE_DURABLE_SOCKET";

/** The `sun_path` limit of a Unix socket, in bytes. */
export const SOCKET_PATH_MAX_BYTES = 107;

/** Every path starts with this. It is a fixed name, not the version. */
const ROUTE_PREFIX = "/session/v1";

/** The refusal detail for a socket that is not private. */
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
 * What the adapter needs from a transport. `get` throws `DurableUnreachable` when it cannot ask.
 * `post` throws `DurableUnreachable` only when nothing was sent (no path, a socket that is not
 * private, a refused connect), and `DurableOutcomeUnknown` when the request may have left.
 */
export interface DurableTransport {
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

/** Which part of the privacy check a path failed. `doctor` names it; the adapter reports one word. */
export type SocketFault =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly message: string }
  | { readonly kind: "not-a-socket" }
  | { readonly kind: "no-uid" }
  | { readonly kind: "wrong-owner"; readonly owner: number; readonly uid: number }
  | { readonly kind: "open-mode"; readonly mode: number };

/**
 * Which check this path fails, or null when it may be dialled (WIRE.md section 1).
 *
 * It must be a socket (a symlink is not one, because this is `lstat`), owned by the adapter's own
 * uid, with no group or other bit. A platform with no uid cannot show the owner, so it fails closed.
 * A missing path is a different answer: nothing is listening yet, and that is not a privacy problem.
 */
export async function socketFault(path: string, probe: SocketProbe = SYSTEM_PROBE): Promise<SocketFault | null> {
  let facts: SocketFacts;
  try {
    facts = await probe.lstat(path);
  } catch (err) {
    const code = err instanceof Error && "code" in err ? err.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "unreadable", message: err instanceof Error ? err.message : String(err) };
  }
  if (!facts.isSocket()) return { kind: "not-a-socket" };
  const uid = probe.uid();
  if (uid === undefined) return { kind: "no-uid" };
  if (facts.uid !== uid) return { kind: "wrong-owner", owner: facts.uid, uid };
  if ((facts.mode & GROUP_AND_OTHER) !== 0) return { kind: "open-mode", mode: facts.mode & 0o777 };
  return null;
}

/** Why this path may not be dialled, as the one line the adapter reports, or null when it may. */
export async function socketAccessProblem(path: string, probe: SocketProbe = SYSTEM_PROBE): Promise<string | null> {
  const fault = await socketFault(path, probe);
  if (fault === null) return null;
  if (fault.kind === "missing") return `no socket at ${path}`;
  if (fault.kind === "unreadable") return `cannot check ${path}: ${fault.message}`;
  return SOCKET_NOT_PRIVATE;
}

// ── The socket client ─────────────────────────────────────────────────────────

/** Read a body into text, stopping as soon as it passes `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
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

/** One line for a failed connect or read. */
function describeFailure(err: Error, timeoutMs: number, timedOut: boolean): string {
  if (timedOut) return `no answer within ${String(timeoutMs)}ms`;
  const code = "code" in err ? err.code : undefined;
  if (code === "ConnectionRefused" || code === "ECONNREFUSED") return "connection refused";
  return err.message === "" ? "connection failed" : err.message;
}

/** The real transport: the privacy check, then one HTTP request on the Unix socket. */
export class DurableSocketClient implements DurableTransport {
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
