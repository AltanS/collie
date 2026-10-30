// The local walky talky channel (M62 README, "The local channel"): `<stateDir>/walky/sock`, mode
// 0600 in a 0700 folder, served by the bridge, the pattern of bridge/surface/hold.ts. One JSON
// request line per connection, one JSON answer line, then the bridge closes it. The CLI carries no
// token: the socket's mode is the credential, as the hold socket's is.
//
// Requests (`v: 1`, plus `markers`: the raw multiplexer markers the CLI read from its environment):
//   send    { id, to, body, replyTo }   → { ok, receipts, target? }
//   inbox   { all, ack, id? }           → { ok, pane, messages }   (`id`: that one message)
//   who     {}                          → { ok, self, targets, note? }
//   status  { id }                      → { ok, receipts, message, elsewhere, deliveries?, totals? }
//   ack     { ids | null }              → { ok, acked }
//   cancel  { id }                      → { ok, results }   (M62 spec 03: the sender takes a held message back)
// A refusal is `{ ok: false, error }`. `not here` means the markers name no pane of this bridge, so
// the CLI asks the next bridge on the machine; a request this bridge cannot read answers the same when
// its markers name no pane here, else `bad request: <reason>` (refusals.ts). A send with no markers
// at all is refused: the operator sends from a paired device, never from this socket.

import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { once } from "node:events";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";

import type { BeaconMatcher } from "../beacon/decorate.ts";
import type { BeaconMarker } from "../beacon/types.ts";
import { HOST, type Host } from "../host.ts";
import { readWalkyRequest, WALKY_LINE_MAX, type WalkyRequest, type WalkyRequestRead } from "./parse.ts";
import type { WalkyDelivery, WalkyService } from "./service.ts";
import type { TakeBack } from "./deliver.ts";
import type { WalkyEntry, WalkyMessage, WalkyReceipt, WalkyTarget } from "./types.ts";

/** What the socket answers a send that names no pane. */
export const SEND_NEEDS_A_PANE = "run this inside a pane, or send from the phone";
/** What the socket answers a cancel that names no pane: an operator's message is cancelled on the phone. */
export const CANCEL_NEEDS_A_PANE = "run this inside the pane that sent it, or cancel from the phone";

/** The socket of one state dir. */
export function walkySocketPath(stateDir: string): string {
  return join(stateDir, "walky", "sock");
}

/** How long the server waits for the request line. */
export const REQUEST_LINE_MS = 2000;

/** The pane the markers name: a session and a pane id. The service then reads its instance. */
export interface PlacedPane {
  readonly session: string;
  readonly paneId: string;
}

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
export async function placeMarkers(markers: readonly BeaconMarker[], targets: readonly PlaceTarget[]): Promise<PlacedPane | null> {
  const hits: PlacedPane[] = [];
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
  | { readonly ok: true; readonly receipts: readonly WalkyReceipt[]; readonly target?: WalkyTarget }
  | {
      readonly ok: true;
      readonly receipts: readonly WalkyReceipt[];
      readonly message: WalkyMessage | null;
      readonly elsewhere: readonly string[];
      /** A scope send (M75): one line per delivery and the parent's totals. Absent for any other address. */
      readonly deliveries?: readonly WalkyDelivery[];
      readonly totals?: Readonly<Record<string, number>>;
    }
  | { readonly ok: true; readonly self: string | null; readonly targets: readonly WalkyTarget[]; readonly note?: string }
  | { readonly ok: true; readonly pane: string | null; readonly messages: readonly WalkyEntry[] }
  | { readonly ok: true; readonly acked: number }
  | { readonly ok: true; readonly results: readonly TakeBack[] };

/** Answer one parsed request. Exported for its test: the server only frames it. */
export async function answerRequest(service: WalkyService, request: WalkyRequest, targets: readonly PlaceTarget[]): Promise<WalkyAnswer> {
  const placed = request.markers.length === 0 ? null : await placeMarkers(request.markers, targets);
  if (request.markers.length > 0 && placed === null) return { ok: false, error: "not here" };
  const pane = placed === null ? null : service.paneAt(placed.session, placed.paneId);
  if (placed !== null && pane === null) return { ok: false, error: "not here" };
  switch (request.op) {
    case "send": {
      // The kind fails closed: a send names its pane, or it is not taken. An operator sends from a
      // paired device (`POST /api/walky`), which this socket cannot prove.
      if (pane === null) {
        service.noteRefusal("no pane");
        return { ok: false, error: SEND_NEEDS_A_PANE };
      }
      const answer = await service.send({ id: request.id, to: request.to, body: request.body, replyTo: request.replyTo }, { kind: "agent", pane });
      if (!answer.ok) return answer;
      return answer.target === undefined ? { ok: true, receipts: answer.receipts } : { ok: true, receipts: answer.receipts, target: answer.target };
    }
    case "who": {
      const self = pane === null ? null : service.addressOf(pane.paneId, pane.instance);
      const note = service.whoNote();
      return note === null ? { ok: true, self, targets: service.who() } : { ok: true, self, targets: service.who(), note };
    }
    case "status": {
      const { receipts, message, elsewhere, deliveries, totals } = service.status(request.id);
      if (deliveries === undefined || totals === undefined) return { ok: true, receipts, message, elsewhere };
      return { ok: true, receipts, message, elsewhere, deliveries, totals };
    }
    case "inbox": {
      if (request.id !== null) {
        // One message by id: the way an agent reads the body its nudge line named.
        const entry = service.one(request.id, pane);
        if (entry === null) return { ok: false, error: pane === null ? `no message ${request.id} on this machine` : `no message ${request.id} for this pane` };
        if (pane !== null && request.ack) service.ack(pane.session, pane.paneId, pane.instance, [entry.id]);
        return { ok: true, pane: pane === null ? null : service.addressOf(pane.paneId, pane.instance), messages: [entry] };
      }
      if (pane === null) {
        if (!request.all) return { ok: false, error: "needs a pane" };
        return { ok: true, pane: null, messages: service.newest() };
      }
      // The pane's current instance: a new session that took an old pane id reads its own inbox only.
      const messages = service.inbox(pane.session, pane.paneId, pane.instance, request.all);
      if (request.ack && !request.all) service.ack(pane.session, pane.paneId, pane.instance, messages.map((message) => message.id));
      return { ok: true, pane: service.addressOf(pane.paneId, pane.instance), messages };
    }
    case "ack":
      if (pane === null) return { ok: false, error: "needs a pane" };
      return { ok: true, acked: service.ack(pane.session, pane.paneId, pane.instance, request.ids) };
    case "cancel": {
      // The sender only (M62 spec 03): the pane the markers place must be the one that sent the message.
      if (pane === null) {
        service.noteRefusal("no pane");
        return { ok: false, error: CANCEL_NEEDS_A_PANE };
      }
      return service.cancel(request.id, { kind: "agent", pane });
    }
  }
}

/**
 * Answer a request this bridge cannot read (added 2026-10-30). Markers that name no pane here answer
 * `not here`, as a readable request's do: the CLI then asks the next bridge, which may be newer and the
 * pane's own. Several bridges of different releases share a machine (the release lane beside a dev
 * lane), and the CLI asks its own install's first. Anything else answers the reason, never the bare word.
 */
export async function answerUnread(service: WalkyService, read: Extract<WalkyRequestRead, { ok: false }>, targets: readonly PlaceTarget[]): Promise<WalkyAnswer> {
  if (read.markers.length === 0) return { ok: false, error: read.reason };
  const placed = await placeMarkers(read.markers, targets);
  if (placed === null || service.paneAt(placed.session, placed.paneId) === null) return { ok: false, error: "not here" };
  return { ok: false, error: read.reason };
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
      const read = readWalkyRequest(line);
      if (!read.ok) return this.reply(socket, await answerUnread(this.deps.service, read, this.deps.targets()));
      this.reply(socket, await answerRequest(this.deps.service, read.request, this.deps.targets()));
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
