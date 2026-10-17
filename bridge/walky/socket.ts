// The local walky talky channel (M62 README, "The local channel"): `<stateDir>/walky/sock`, mode
// 0600 in a 0700 folder, served by the bridge, the pattern of bridge/surface/hold.ts. One JSON
// request line per connection, one JSON answer line, then the bridge closes it. The CLI carries no
// token: the socket's mode is the credential, as the hold socket's is.
//
// Requests (`v: 1`, plus `markers`: the raw multiplexer markers the CLI read from its environment):
//   send    { id, to, body, replyTo }   → { ok, receipts }
//   inbox   { all, ack }                → { ok, pane, messages }
//   who     {}                          → { ok, self, targets }
//   status  { id }                      → { ok, receipts, message }
//   ack     { ids | null }              → { ok, acked }
// A refusal is `{ ok: false, error }`. `not here` means the markers name no pane of this bridge, so
// the CLI asks the next bridge on the machine. No markers at all means the operator: kind `operator`,
// label `cli`.

import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { once } from "node:events";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";

import type { BeaconMatcher } from "../beacon/decorate.ts";
import type { BeaconMarker } from "../beacon/types.ts";
import { HOST, type Host } from "../host.ts";
import type { SenderPane } from "./deliver.ts";
import { parseWalkyRequest, WALKY_LINE_MAX, type WalkyRequest } from "./parse.ts";
import type { WalkyService } from "./service.ts";
import type { WalkyEntry, WalkyMessage, WalkyReceipt, WalkyTarget } from "./types.ts";

/** The socket of one state dir. */
export function walkySocketPath(stateDir: string): string {
  return join(stateDir, "walky", "sock");
}

/** How long the server waits for the request line. */
export const REQUEST_LINE_MS = 2000;

/** One terminal session, as the socket places a marker on it (an edge target's three fields). */
export interface PlaceTarget {
  readonly session: string;
  readonly matcher: BeaconMatcher;
  paneIds(): readonly string[];
}

/**
 * The one pane the markers name, across every session, or null. Exactly one pane must match, as an
 * edge is placed (bridge/surface/edges.ts `placeEdge`), without the pid check: the CLI is not the
 * agent's process, and a local process could lie about its pane anyway (decision 4).
 */
export async function placeMarkers(markers: readonly BeaconMarker[], targets: readonly PlaceTarget[]): Promise<SenderPane | null> {
  const hits: SenderPane[] = [];
  for (const target of targets) {
    const own = markers.filter((marker) => marker.namespace === target.matcher.namespace);
    if (own.length === 0) continue;
    const scope = await target.matcher.scope().catch(() => null);
    if (scope === null) continue;
    for (const paneId of target.paneIds()) {
      if (own.some((marker) => target.matcher.matches({ paneId }, marker, scope))) hits.push({ session: target.session, paneId });
    }
  }
  return hits.length === 1 ? hits[0]! : null;
}

export interface WalkyServerDeps {
  readonly socketPath: string;
  readonly host?: Host;
  readonly service: WalkyService;
  targets(): readonly PlaceTarget[];
  readonly log?: (line: string) => void;
}

/** What one request is answered with. */
export type WalkyAnswer =
  | { readonly ok: false; readonly error: string }
  | { readonly ok: true; readonly receipts: readonly WalkyReceipt[] }
  | { readonly ok: true; readonly receipts: readonly WalkyReceipt[]; readonly message: WalkyMessage | null }
  | { readonly ok: true; readonly self: string | null; readonly targets: readonly WalkyTarget[] }
  | { readonly ok: true; readonly pane: string | null; readonly messages: readonly WalkyEntry[] }
  | { readonly ok: true; readonly acked: number };

/** Answer one parsed request. Exported for its test: the server only frames it. */
export async function answerRequest(service: WalkyService, request: WalkyRequest, targets: readonly PlaceTarget[]): Promise<WalkyAnswer> {
  const placed = request.markers.length === 0 ? null : await placeMarkers(request.markers, targets);
  if (request.markers.length > 0 && placed === null) return { ok: false, error: "not here" };
  const pane = placed === null ? null : service.paneAt(placed.session, placed.paneId);
  if (placed !== null && pane === null) return { ok: false, error: "not here" };
  switch (request.op) {
    case "send": {
      const sender = pane === null ? { kind: "operator" as const, label: "cli" } : { kind: "agent" as const, pane };
      const answer = await service.send({ id: request.id, to: request.to, body: request.body, replyTo: request.replyTo }, sender);
      return answer.ok ? { ok: true, receipts: answer.receipts } : answer;
    }
    case "who":
      return { ok: true, self: pane === null ? null : service.addressOf(pane.paneId), targets: service.who() };
    case "status": {
      const { receipts, message } = service.status(request.id);
      return { ok: true, receipts, message };
    }
    case "inbox": {
      if (pane === null) {
        if (!request.all) return { ok: false, error: "needs a pane" };
        return { ok: true, pane: null, messages: service.newest() };
      }
      const messages = service.inbox(pane.session, pane.paneId, request.all);
      if (request.ack) service.ack(pane.session, pane.paneId, messages.map((message) => message.id));
      return { ok: true, pane: service.addressOf(pane.paneId), messages };
    }
    case "ack":
      if (pane === null) return { ok: false, error: "needs a pane" };
      return { ok: true, acked: service.ack(pane.session, pane.paneId, request.ids) };
  }
}

export class WalkyServer {
  private server: Server | null = null;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: WalkyServerDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** Listen. False on Windows, when another live bridge holds the path, or when it cannot be made safe. */
  async start(): Promise<boolean> {
    const path = this.deps.socketPath;
    const dir = dirname(path);
    if ((this.deps.host ?? HOST).platform === "win32") {
      this.log("[walky] no socket: walky talky needs a Unix socket on this host");
      return false;
    }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      if (existsSync(path)) {
        if (!lstatSync(path).isSocket()) {
          this.log(`[walky] no socket: ${path} exists and is not a socket`);
          return false;
        }
        if (await answers(path)) {
          this.log(`[walky] no socket: another bridge listens on ${path}`);
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
      this.server = server;
      return true;
    } catch (err) {
      this.log(`[walky] no socket: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  stop(): void {
    const server = this.server;
    this.server = null;
    if (server === null) return;
    server.close();
    try {
      if (existsSync(this.deps.socketPath) && lstatSync(this.deps.socketPath).isSocket()) unlinkSync(this.deps.socketPath);
    } catch {
      // A socket file left behind is unlinked by the next start.
    }
  }

  /** One connection: one request line, one answer line. Never throws. */
  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    let taken = false;
    const timer = setTimeout(() => {
      if (!taken) socket.destroy();
    }, REQUEST_LINE_MS);
    timer.unref?.();
    socket.on("error", () => undefined);
    socket.on("data", (chunk: string) => {
      if (taken) return;
      buffer += chunk;
      const at = buffer.indexOf("\n");
      if (at < 0) {
        if (buffer.length > WALKY_LINE_MAX) {
          taken = true;
          clearTimeout(timer);
          this.reply(socket, { ok: false, error: "too long" });
        }
        return;
      }
      taken = true;
      clearTimeout(timer);
      void this.route(socket, buffer.slice(0, at));
    });
  }

  private reply(socket: Socket, answer: WalkyAnswer): void {
    if (socket.destroyed || !socket.writable) return;
    socket.end(`${JSON.stringify(answer)}\n`);
  }

  private async route(socket: Socket, line: string): Promise<void> {
    try {
      const request = parseWalkyRequest(line);
      if (request === null) return this.reply(socket, { ok: false, error: "bad request" });
      this.reply(socket, await answerRequest(this.deps.service, request, this.deps.targets()));
    } catch (err) {
      this.log(`[walky] request failed: ${err instanceof Error ? err.message : String(err)}`);
      this.reply(socket, { ok: false, error: "failed" });
    }
  }
}

/** Whether something accepts on `path` within 200 ms: a live bridge already holds it. */
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
