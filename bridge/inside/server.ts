// The inside socket (M99 spec 01): HTTP with JSON over one Unix socket per bridge, `<stateDir>/inside/sock`.
//
// The bridge listens; parts dial (README decision 1: a Claude mod can only call out). WIRE.md beside this
// file is the protocol and the threat model. This module owns only the socket's life and the HTTP:
//
//  - The folder is made owner-only (0700) and must be a real directory this user owns: not a link, not
//    another user's. The socket is 0600. The folder mode is the real border: a process of another user
//    cannot reach the socket through it, whatever the socket's own mode is while it is created.
//  - A socket file left by a bridge that died is removed on start; one a live bridge answers on is left
//    alone, and this bridge then runs with no inside wire. Stop closes the socket and removes the file.
//  - Every body is capped (Bun refuses past BODY_MAX with 413; each route has its own cap below that).
//    A rate cap per part, and one for hellos, answers 429 past it.
//  - No body text is ever logged: a log line names a route, a kind, a short part id and a status.
//
// Several bridges on one machine each own their own socket under their own state dir, and each writes
// it into its hook target file (`bridge/beacon/hook-targets.ts`, field `inside`), which is how a part
// finds every one of them.

import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { HOST, type Host } from "../host.ts";
import type { InsideHub } from "./hub.ts";
import { BODY_MAX, HELLO_MAX, parseEvent, parseHello, parseNextQuery, WIRE_ROUTES, WIRE_VERSION } from "./wire.ts";

/** The socket's folder under the state dir. */
export const INSIDE_SUBDIR = "inside";

/** `<stateDir>/inside/sock`. */
export function insideSocketPath(stateDir: string): string {
  return join(stateDir, INSIDE_SUBDIR, "sock");
}

/** Requests one part may make per second, on average, and the burst above it. */
export const PART_RATE_PER_S = 20;
export const PART_RATE_BURST = 60;
/** Hellos the whole socket takes per second, and the burst. A reload or a bridge restart sends a few. */
export const HELLO_RATE_PER_S = 5;
export const HELLO_RATE_BURST = 30;
/** Requests the whole socket takes per second, any route, malformed ones included. */
export const ALL_RATE_PER_S = 200;
export const ALL_RATE_BURST = 400;
/** How often parts that stopped polling are swept. */
export const SWEEP_MS = 10_000;
/** Bun's idle limit for one request, in seconds (its default is 10). Above the longest `next` wait (25 s). */
const IDLE_TIMEOUT_S = 60;
/**
 * Server options with the idle limit added. Bun's types refuse `idleTimeout` beside `unix`, but Bun 1.4
 * honours it there, and `server.timeout(request, s)`, what the types allow, does nothing on a Unix socket:
 * with it alone Bun cut every long poll at its 10 s default, the part saw ECONNRESET, marked its link
 * down and said hello again, a new part id each time (M99, the browser leg). The long-poll test in
 * server.test.ts fails if Bun stops honouring it.
 */
function withIdleLimit<T extends object>(options: T): T {
  return Object.assign(options, { idleTimeout: IDLE_TIMEOUT_S });
}

/** A token bucket: `take()` is false past the rate. */
export class Bucket {
  private tokens: number;
  private at: number;
  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.at = now();
  }
  take(): boolean {
    const now = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.perSecond);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export interface InsideServerDeps {
  readonly socketPath: string;
  readonly hub: InsideHub;
  readonly host?: Host;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  /** This process's uid; the folder must be owned by it. Defaults to `process.getuid()`. */
  readonly uid?: number;
}

/** How long the start-up probe waits for a bridge that may already hold the socket. */
const PROBE_MS = 2000;

/**
 * Who holds a socket path: `live` (it answered), `dead` (nothing accepts: a socket file a dead bridge
 * left), or `unsure` (no answer in time, or another error). Only `dead` may be removed: a live bridge
 * that is slow to answer must never lose its socket to a second bridge.
 */
export async function holderOf(path: string): Promise<"live" | "dead" | "unsure"> {
  try {
    const response = await fetch("http://inside/v1/ping", { unix: path, signal: AbortSignal.timeout(PROBE_MS) });
    await response.body?.cancel();
    return "live";
  } catch (err) {
    // SAFETY: Bun's fetch rejects with an Error that carries the socket error code, when there is one.
    const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
    return code === "ECONNREFUSED" || code === "ENOENT" ? "dead" : "unsure";
  }
}

const reply = (status: number, body: string | null, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: body === null ? headers : { "content-type": "application/json", ...headers } });

export class InsideServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();
  private readonly helloBucket: Bucket;
  private readonly allBucket: Bucket;
  private readonly logged = new Map<string, number>();

  constructor(private readonly deps: InsideServerDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
    this.now = deps.now ?? Date.now;
    this.helloBucket = new Bucket(HELLO_RATE_PER_S, HELLO_RATE_BURST, this.now);
    this.allBucket = new Bucket(ALL_RATE_PER_S, ALL_RATE_BURST, this.now);
  }

  /** The socket path, while listening. */
  get listening(): boolean {
    return this.server !== null;
  }

  /** Listen. False when the folder is not safe, another live bridge owns the socket, or on Windows. */
  async start(): Promise<boolean> {
    const path = this.deps.socketPath;
    const dir = dirname(path);
    // The owner-only rule is a POSIX file mode; Windows keeps the screen path in 1.29.0 (decision 15).
    if ((this.deps.host ?? HOST).platform === "win32") {
      this.log("[inside] no socket: not built for Windows");
      return false;
    }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stats = lstatSync(dir);
      const uid = this.deps.uid ?? process.getuid?.();
      if (!stats.isDirectory() || (uid !== undefined && stats.uid !== uid)) {
        this.log(`[inside] no socket: ${dir} is not a folder this user owns`);
        return false;
      }
      chmodSync(dir, 0o700);
      if (existsSync(path)) {
        if (!lstatSync(path).isSocket()) {
          this.log(`[inside] no socket: ${path} exists and is not a socket`);
          return false;
        }
        const holder = await holderOf(path);
        if (holder !== "dead") {
          this.log(`[inside] no socket: ${holder === "live" ? "another bridge listens on" : "no clear answer from"} ${path}`);
          return false;
        }
        unlinkSync(path);
      }
      this.server = Bun.serve(
        withIdleLimit({
          unix: path,
          maxRequestBodySize: BODY_MAX,
          fetch: (request: Request) => this.handle(request),
        }),
      );
      chmodSync(path, 0o600);
      this.sweeper = setInterval(() => this.deps.hub.sweep(), SWEEP_MS);
      this.sweeper.unref?.();
      return true;
    } catch (err) {
      this.log(`[inside] no socket: ${err instanceof Error ? err.message : String(err)}`);
      this.server?.stop(true);
      this.server = null;
      return false;
    }
  }

  /** Close the socket and remove its file. Safe to call twice. */
  stop(): void {
    if (this.sweeper !== null) clearInterval(this.sweeper);
    this.sweeper = null;
    const server = this.server;
    this.server = null;
    if (server === null) return;
    void server.stop(true);
    try {
      if (existsSync(this.deps.socketPath) && lstatSync(this.deps.socketPath).isSocket()) unlinkSync(this.deps.socketPath);
    } catch {
      // A file left behind is removed by the next start.
    }
  }

  /** One request. Never throws: a fault answers 500 with no detail. */
  private async handle(request: Request): Promise<Response> {
    try {
      return await this.route(request);
    } catch (err) {
      this.once("error", `[inside] request failed: ${err instanceof Error ? err.name : "error"}`);
      return reply(500, JSON.stringify({ error: "internal" }));
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { method } = request;
    if (!this.allBucket.take()) return reply(429, JSON.stringify({ error: "slow down" }), { "retry-after": "1" });
    if (method === "GET" && url.pathname === "/v1/ping") return reply(200, JSON.stringify({ wire: WIRE_VERSION }));
    if (method === "POST" && url.pathname === WIRE_ROUTES.hello) {
      if (!this.helloBucket.take()) return reply(429, JSON.stringify({ error: "slow down" }), { "retry-after": "1" });
      const text = await request.text();
      if (text.length > HELLO_MAX) return reply(413, JSON.stringify({ error: "too large" }));
      const hello = parseHello(text);
      if (!hello.ok) {
        this.once(`hello:${hello.error}`, `[inside] hello refused: ${hello.error}`);
        return reply(400, JSON.stringify({ wire: WIRE_VERSION, error: hello.error }));
      }
      const answer = await this.deps.hub.hello(hello);
      return reply(answer.status, answer.body);
    }
    if (method === "POST" && url.pathname === WIRE_ROUTES.event) {
      const text = await request.text();
      const event = parseEvent(text);
      if (!event.ok) return reply(400, JSON.stringify({ error: event.error }));
      if (!this.bucketOf(event.part).take()) return reply(429, JSON.stringify({ error: "slow down" }), { "retry-after": "1" });
      const answer = this.deps.hub.event(event);
      return reply(answer.status, answer.body);
    }
    if (method === "GET" && url.pathname === WIRE_ROUTES.next) {
      const query = parseNextQuery(url);
      if (!query.ok) return reply(400, JSON.stringify({ error: query.error }));
      if (!this.bucketOf(query.part).take()) return reply(429, JSON.stringify({ error: "slow down" }), { "retry-after": "1" });
      const answer = await this.deps.hub.next(query, request.signal);
      if (answer.command !== undefined) this.log(`[inside] handed part=${query.part.slice(0, 6)} cmd=${answer.command.id} kind=${answer.command.kind}`);
      return reply(answer.status, answer.body);
    }
    return reply(404, JSON.stringify({ error: "no such route" }));
  }

  private bucketOf(part: string): Bucket {
    let bucket = this.buckets.get(part);
    if (bucket === undefined) {
      // A part id nobody bound still gets a bucket, so a flood of made-up ids is capped too; the map is
      // cleared past a size no real machine reaches.
      if (this.buckets.size > 1024) this.buckets.clear();
      bucket = new Bucket(PART_RATE_PER_S, PART_RATE_BURST, this.now);
      this.buckets.set(part, bucket);
    }
    return bucket;
  }

  /** A log line at most once a minute per key. */
  private once(key: string, line: string): void {
    const now = this.now();
    const last = this.logged.get(key);
    if (last !== undefined && now - last < 60_000) return;
    if (this.logged.size > 256) this.logged.clear();
    this.logged.set(key, now);
    this.log(line);
  }
}
