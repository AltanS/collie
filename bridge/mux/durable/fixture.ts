// THE DURABLE CONFORMANCE FIXTURE, AND THE FAKE PROGRAM BEHIND IT.
//
// `FakeDurableProgram` is a small stand-in for a durable agent program. It listens on a real Unix
// socket (mode 0600, in a directory with mode 0700) and answers `hello` and `snapshot` from the JSON
// in `fixtures/`, following WIRE.md: the version check first, then `hello`, then `ready`, then the
// route. It is a real server on purpose. The privacy check, the HTTP client, the size cap and the
// timeout are all part of the adapter, and a fake transport would skip every one of them.
//
// The shapes follow WIRE.md, not the spike they were first taken from: ids use `:` between a
// workspace and a tab, every pane carries a `turnId`, every ask carries a `toolCallId`, a
// `revision`, a `title` and an `itemId`, and `caps.send` is a boolean.
//
// A fake that is kinder than the real program proves nothing. This one refuses what WIRE.md says a
// program refuses: a missing or out-of-range version is a 409, `ready: false` is a 503 on every route
// but `hello`, and an unknown route is a 404.
//
// It takes `POST /pane/:id/send` and `/abort` as WIRE.md 7.4 and 7.5 describe them: exactly one of
// `turnId` and `askId`, a stale name refused with the current turn and asks, the caps checked, a
// repeat of a request id answered `replayed`. A send to an idle pane starts a new turn; an abort of a
// running one appends no item, settles the input as unanswered with the reason `aborted`, closes the
// open asks `by: "stopped"` and leaves the pane idle.
//
// It also serves `GET /pane/:id/events` as WIRE.md 7.2 describes it. Each pane has an event log
// whose cursor counts every event appended in this epoch, a tail of the newest events (1000, or what
// a test sets), and a model of the pane's current view (its items by id, its open asks, its state).
// A read inside the tail gets a plain reply, at most `eventsPerReply` events with `more` set when it
// stopped early. A stale epoch, a cursor older than the tail, or a cursor past the count gets a reset
// reply: `reset`, then each item in its latest version (the newest `viewItemCap`, the rest counted in
// `trimmed`), then each open ask, then one `state`, then `synced`.
//
// IT ALSO SERVES OVER HTTP (WIRE.md section 1B, ADR 0103). `startHttp` listens on 127.0.0.1 with
// `Bun.serve` and checks `Authorization: Bearer <token>` before anything else, as the outer Worker of
// a deployed program does: wrong or missing, 401 `unauthorized`, and nothing else runs. The compare
// is constant-time. The fake records only whether the header matched, never the value, so no token
// reaches a test's output. With `weakEtag` it answers `W/"<epoch>-<rev>"`, as a compressing proxy
// would, and in both modes it compares `If-None-Match` with any `W/` stripped, as section 7.1 asks.
//
// The 250 ms floor between snapshot reads is real in the adapter. The conformance world therefore
// runs it on `FakeDurableClock`, and every change the world makes moves that clock past the floor, so
// the next read is a real read. A test of the floor itself uses the clock directly.

import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "../../json.ts";
import { HOST } from "../../host.ts";
import { ensureOwnerOnlyDir, isOwnerOnly, privateRoot } from "../../owner-only.ts";
import { isRequestId } from "../../worktree-receipts.ts";
import type { MuxConformanceFixture, MuxConformanceWorld } from "../conformance.ts";
import { DURABLE_BUDGETS, DURABLE_MUX, DurableMux, MIN_SNAPSHOT_GAP_MS, type DurableClock } from "./adapter.ts";
import { DurableSocketClient, type DurableGet, type DurablePost, type DurableReply, type DurableTransport } from "./client.ts";
import { DurableHttpClient } from "./http-client.ts";
import recordedHello from "./fixtures/hello.json";
import recordedSnapshot from "./fixtures/snapshot.json";
import {
  parseAnswerPost,
  parseControlPost,
  parseEvents,
  type DurableAsk,
  type DurablePane,
  type DurableStarter,
  type DurableTab,
  type DurableWorkspace,
  type ProtocolRange,
} from "./protocol.ts";

// ── The documents ─────────────────────────────────────────────────────────────

/** A `hello` document as the fake serves it. `epoch`, `ready` and `protocol` come from the fake's state. */
export interface FakeHello {
  /** `collie-durable` for a durable program. A test removes or changes it to play a wrong socket. */
  service?: string;
  host: { name: string };
  caps: {
    asks?: boolean;
    starters?: boolean;
    send?: boolean;
    steer?: boolean;
    abort?: boolean;
    terminal?: boolean;
  };
}

/** A `snapshot` document as the fake serves it. `rev` and `epoch` come from the fake's state. */
export interface FakeSnapshot {
  workspaces: DurableWorkspace[];
  tabs: DurableTab[];
  panes: DurablePane[];
  starters: DurableStarter[];
}

/** The recorded `hello`, as a fresh copy. */
export function helloFixture(): FakeHello {
  const copy: FakeHello = JSON.parse(JSON.stringify(recordedHello));
  return copy;
}

/** The recorded `snapshot`, as a fresh copy. */
export function snapshotFixture(): FakeSnapshot {
  const copy: FakeSnapshot = JSON.parse(JSON.stringify(recordedSnapshot));
  return copy;
}

// ── Hostile text, for the tests ───────────────────────────────────────────────

/** What a hostile program might send: direction marks, controls and an escape, then a long tail. */
export function hostileText(label: string, tail = 5000): string {
  return `${label}${String.fromCodePoint(0x202e, 0x200f, 0x0000, 0x0007, 0x001b)}[31m${"x".repeat(tail)}`;
}

/** Whether `text` still carries a control character or a direction mark. */
export function hasHostileChars(text: string): boolean {
  for (const symbol of text) {
    const codePoint = symbol.codePointAt(0) ?? 0;
    const control = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    const direction =
      codePoint === 0x200e || codePoint === 0x200f || codePoint === 0x061c || (codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069);
    if (control || direction) return true;
  }
  return false;
}

// ── The clock ─────────────────────────────────────────────────────────────────

/** A clock that moves only when told, and whose `sleep` moves it. Nothing here waits on real time. */
export class FakeDurableClock implements DurableClock {
  private time = 1_000_000;

  now(): number {
    return this.time;
  }

  sleep(ms: number): Promise<void> {
    this.time += ms;
    return Promise.resolve();
  }

  advance(ms: number): void {
    this.time += ms;
  }
}

// ── The program ───────────────────────────────────────────────────────────────

/** One event as a program writes it on the wire: a `type` and what that type carries. */
export type FakeEvent = JsonObject & { readonly type: string };

/** An event reply as the fake serves it. */
interface EventsDoc {
  epoch: string;
  events: FakeEvent[];
  next: number;
  reset?: true;
  more?: true;
  trimmed?: number;
}

/** What the fake keeps of one pane's conversation. */
interface PaneModel {
  /** Every event appended in this epoch. A restart empties it. */
  log: FakeEvent[];
  /** Each item in its latest version, in order of first appearance. Survives a restart. */
  items: Map<string, FakeEvent>;
  asks: Map<string, FakeEvent>;
  state: string | null;
}

/** One request the fake saw. */
export interface FakeRequest {
  readonly method: string;
  /** The path without the query. */
  readonly path: string;
  /** The query, with its `?`, or an empty string. */
  readonly search: string;
  readonly version: string | null;
  readonly ifNoneMatch: string | null;
  /** The body of a POST, as text. Null for a GET. */
  readonly body: string | null;
  /** Whether an `Authorization` header came, and whether it was the bearer token. Never the value. */
  readonly bearer: "none" | "match" | "other";
}

/** One answer the fake took and resolved (WIRE.md section 7.3). */
export interface FakeAnswer {
  readonly paneId: string;
  readonly askId: string;
  readonly toolCallId: string;
  readonly optionId: string;
  readonly requestId: string;
}

/** One send the fake took (WIRE.md section 7.4). A replay is not one. */
export interface FakeSend {
  readonly paneId: string;
  readonly requestId: string;
  readonly text: string;
  readonly steer: boolean;
  readonly turnId: string | null;
  readonly askId: string | null;
}

/** One abort the fake took (WIRE.md sections 7.4 and 7.5). A replay is not one. */
export interface FakeAbort {
  readonly paneId: string;
  readonly requestId: string;
  readonly turnId: string | null;
  readonly askId: string | null;
  /** Whether something was running, so the abort stopped it. */
  readonly stopped: boolean;
}

/** A way for a test to answer a route its own way. Returns nothing to let the fake answer. */
export type FakeOverride = (path: string) => Response | Promise<Response> | undefined;

function randomEpoch(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
}

/** What `hello` answers. */
export interface HelloDoc extends FakeHello {
  protocol: ProtocolRange;
  epoch: string;
  ready: boolean;
}

/** What `snapshot` answers. */
export interface SnapshotDoc extends FakeSnapshot {
  rev: number;
  epoch: string;
}

/** What an error answers. */
export interface ProblemDoc {
  code: string;
  message?: string;
  range?: ProtocolRange;
  turnId?: string;
  askIds?: string[];
  ask?: DurableAsk;
}

/** What a start answers. */
export interface StarterReplyDoc {
  paneId: string;
  replayed?: true;
}

/** One start that really ran, as the fake saw it. A replay is not one. */
export interface FakeStart {
  readonly starterId: string;
  readonly requestId: string;
  readonly paneId: string;
}

/** What an answer answers. */
export interface AnswerDoc {
  result: "taken" | "too-late";
  replayed?: true;
}

/** What a send or an abort answers. */
export interface ControlDoc {
  ok: true;
  replayed?: true;
}

function reply(
  status: number,
  body: HelloDoc | SnapshotDoc | ProblemDoc | EventsDoc | StarterReplyDoc | AnswerDoc | ControlDoc,
  etag?: string,
): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (etag !== undefined) headers.set("etag", etag);
  return new Response(JSON.stringify(body), { status, headers });
}

/** The mode WIRE.md section 1A asks of the socket: the owner only. */
const PRIVATE_SOCKET_MODE = 0o600;

export class FakeDurableProgram {
  hello: FakeHello = helloFixture();
  snapshot: FakeSnapshot = snapshotFixture();
  epoch = "e4b1c7a09d3f5e826b7a1c0d94f3e582";
  rev = 12;
  ready = true;
  /** The version range the program reports, and enforces on every versioned call. */
  range: ProtocolRange = { min: 1, max: 1 };
  /** When true, every route answers 401, as a program that still asks for a token would. */
  asksForToken = false;
  /** When true, the snapshot's ETag is weak (`W/"..."`), as a proxy that compressed it would send. */
  weakEtag = false;
  override: FakeOverride | null = null;
  readonly requests: FakeRequest[] = [];
  /** How many of a pane's newest events the program keeps (WIRE.md 7.2 says at most 1000). */
  tailLimit = 1000;
  /** Most events in one plain reply. A test lowers it to make the program say `more`. */
  eventsPerReply = 1000;
  /** Most items in a reset view. A test lowers it to make the program count `trimmed`. */
  viewItemCap = 2000;

  private readonly models = new Map<string, PaneModel>();

  /** Every start that ran. A repeat of a request id that already succeeded is not added (WIRE.md 7.6). */
  readonly starts: FakeStart[] = [];
  /** When set, the next starts fail with 422 `starter-failed` and this message, and store nothing. */
  starterFailure: string | null = null;

  private readonly startedByRequest = new Map<string, FakeStart>();

  /** Every answer the fake resolved, in order. A replay is not a second entry. */
  readonly answers: FakeAnswer[] = [];
  /** The first reply per request id, and the pane it was for (WIRE.md section 7.6). */
  private readonly answered = new Map<string, { paneId: string; reply: AnswerDoc }>();

  /** Every send the fake took, in order. A replay is not a second entry. */
  readonly sends: FakeSend[] = [];
  /** Every abort the fake took, in order. A replay is not a second entry. */
  readonly aborts: FakeAbort[] = [];
  /** The route and pane per request id a send or abort took (WIRE.md section 7.6). */
  private readonly controlled = new Map<string, { act: "send" | "abort"; paneId: string }>();
  /** The input running on a pane, from the send that started it. */
  private readonly running = new Map<string, { inputId: string; requestId: string }>();
  private turnsMinted = 0;

  private server: ReturnType<typeof Bun.serve> | null = null;
  /** The TCP port over HTTP, kept so a dropped listener comes back on the same URL. */
  private port = 0;

  private constructor(
    readonly socketPath: string,
    private readonly dir: string | null,
    /** The SHA-256 of the bearer token over HTTP; null on the socket, which takes no token. */
    private tokenDigest: Buffer | null,
    /** The token itself, kept only so {@link wire} can hand a client for it. Null on the socket. */
    private token: string | null = null,
  ) {}

  /** Over HTTP, take another token from now on, as a program redeployed with a new secret does. */
  rotateToken(token: string): void {
    if (this.tokenDigest === null) throw new Error("a program on the socket takes no token");
    this.tokenDigest = digest(token);
    this.token = token;
  }

  /** Start a program on a fresh socket under the temp directory. */
  static async start(): Promise<FakeDurableProgram> {
    // `mkdtemp` makes the directory mode 0700.
    const dir = mkdtempSync(join(tmpdir(), "collie-durable-"));
    const program = new FakeDurableProgram(join(dir, "s.sock"), dir, null);
    program.listen();
    return program;
  }

  /** Start a program over HTTP on 127.0.0.1, on a free port, that takes only this bearer token. */
  static async startHttp(token: string): Promise<FakeDurableProgram> {
    const program = new FakeDurableProgram("", null, digest(token), token);
    program.listen();
    return program;
  }

  /**
   * Start a program for a test about the WIRE (controls, asks, answers, events, receipts), not about the
   * socket. On Linux and macOS it is the private socket, as in {@link start}. Windows has no socket
   * transport, so there it listens on 127.0.0.1 and {@link wire} dials it, with the adapter still on the
   * socket's budgets and cadence. `loopback` forces that form on any platform, which is how the Linux
   * gate proves the Windows form (`COLLIE_TEST_LOOPBACK=1`).
   */
  static async startWire(loopback: boolean = wireOverLoopback()): Promise<FakeDurableProgram> {
    return loopback ? FakeDurableProgram.startHttp(testToken()) : FakeDurableProgram.start();
  }

  /** One GET straight at the program, whichever way it listens. `route` starts at `/session/v1`. */
  rawGet(route: string, headers: Record<string, string> = {}): Promise<Response> {
    if (this.token === null) return fetch(`http://localhost${route}`, { unix: this.socketPath, headers });
    return fetch(`${this.url}${route}`, { headers: { ...headers, authorization: `Bearer ${this.token}` } });
  }

  /** The transport a {@link startWire} program is dialled with. The adapter sees `kind: "socket"` in both forms. */
  wire(): DurableTransport {
    if (this.token === null) return new DurableSocketClient(this.socketPath);
    return new LoopbackWireClient(new DurableHttpClient(this.url, this.token));
  }

  /** The base URL over HTTP. Empty on the socket. */
  get url(): string {
    return this.tokenDigest === null ? "" : `http://127.0.0.1:${String(this.port)}`;
  }

  private listen(): void {
    if (this.tokenDigest !== null) {
      this.server = Bun.serve({ hostname: "127.0.0.1", port: this.port, fetch: (request) => this.handle(request) });
      this.port = this.server.port ?? 0;
      return;
    }
    this.server = Bun.serve({ unix: this.socketPath, fetch: (request) => this.handle(request) });
    // The listener creates the socket with the process umask. A program must create it private.
    chmodSync(this.socketPath, PRIVATE_SOCKET_MODE);
  }

  /** Stop listening, then listen again on the same path or port. The state is untouched. */
  async dropConnections(): Promise<void> {
    await this.server?.stop(true);
    if (this.tokenDigest === null) rmSync(this.socketPath, { force: true });
    this.listen();
  }

  /** How the request's `Authorization` header compares with the token, in constant time. */
  private bearerOf(request: Request): FakeRequest["bearer"] {
    const header = request.headers.get("authorization");
    if (header === null) return "none";
    if (this.tokenDigest === null || !header.startsWith("Bearer ")) return "other";
    return timingSafeEqual(digest(header.slice("Bearer ".length)), this.tokenDigest) ? "match" : "other";
  }

  /**
   * The program restarts: a new epoch, and `rev` and every event cursor start over. Pane ids and the
   * conversations stay, as WIRE.md section 8 says.
   */
  restart(options: { ready: boolean } = { ready: true }): void {
    this.epoch = randomEpoch();
    this.rev = 1;
    this.ready = options.ready;
    for (const model of this.models.values()) model.log = [];
  }

  private model(paneId: string): PaneModel {
    let model = this.models.get(paneId);
    if (model === undefined) {
      model = { log: [], items: new Map(), asks: new Map(), state: null };
      this.models.set(paneId, model);
    }
    return model;
  }

  /** Append one event to a pane: it enters the log, changes the model, and `rev` rises. */
  appendEvent(paneId: string, event: FakeEvent): void {
    const model = this.model(paneId);
    model.log.push(event);
    // What the event means for the pane's current view is read the way the adapter reads it, so a
    // malformed event changes nothing here, as it changes nothing in the adapter.
    const parsed = parseEvents(JSON.stringify({ epoch: this.epoch, next: 0, events: [event] }));
    const known = parsed.ok ? parsed.value.events[0] : undefined;
    if (known?.type === "item") model.items.set(known.item.id, event);
    if (known?.type === "remove") model.items.delete(known.id);
    if (known?.type === "ask") model.asks.set(known.ask.id, event);
    if (known?.type === "ask-closed") model.asks.delete(known.askId);
    if (known?.type === "state") model.state = known.state;
    this.touch();
  }

  /** How many events the pane has appended in this epoch: the cursor after the last one. */
  eventCount(paneId: string): number {
    return this.model(paneId).log.length;
  }

  /** Something a reader could see changed. */
  touch(): void {
    this.rev += 1;
  }

  renameTab(tabId: string, title: string): void {
    this.snapshot.tabs = this.snapshot.tabs.map((tab) => (tab.id === tabId ? { ...tab, title } : tab));
    this.touch();
  }

  retitlePane(paneId: string, title: string): void {
    this.snapshot.panes = this.snapshot.panes.map((pane) => (pane.id === paneId ? { ...pane, title } : pane));
    this.touch();
  }

  setState(paneId: string, state: string): void {
    this.snapshot.panes = this.snapshot.panes.map((pane) => (pane.id === paneId ? { ...pane, state } : pane));
    this.touch();
  }

  /** Raise one ask on a pane: the pane waits, and `rev` moves. */
  raiseAsk(paneId: string, ask: DurableAsk): void {
    this.snapshot.panes = this.snapshot.panes.map((pane) =>
      pane.id === paneId ? { ...pane, state: "waiting", openAsks: [...pane.openAsks, ask] } : pane,
    );
    this.touch();
  }

  /** The asks open on a pane right now. */
  asksOf(paneId: string): readonly DurableAsk[] {
    return this.snapshot.panes.find((pane) => pane.id === paneId)?.openAsks ?? [];
  }

  /**
   * The program restarts and raises every open ask again under a new id, with the same tool call id
   * and `revision` back at 1 (WIRE.md section 8.4). Its request id memory is lost, as a program that
   * keeps none would lose it.
   */
  restartReasking(): void {
    this.restart();
    this.answered.clear();
    this.controlled.clear();
    this.snapshot.panes = this.snapshot.panes.map((pane) => ({
      ...pane,
      openAsks: pane.openAsks.map((ask) => ({ ...ask, id: `${ask.id}-after-${this.epoch.slice(0, 8)}`, revision: 1 })),
    }));
  }

  removePane(paneId: string): void {
    this.snapshot.panes = this.snapshot.panes.filter((pane) => pane.id !== paneId);
    this.touch();
  }

  /** The hello document the program serves right now. */
  currentHello(): HelloDoc {
    return {
      service: this.hello.service,
      protocol: this.range,
      host: this.hello.host,
      epoch: this.epoch,
      ready: this.ready,
      caps: this.hello.caps,
    };
  }

  /** The snapshot document the program serves right now. */
  currentSnapshot(): SnapshotDoc {
    // The recorded file carries its own `rev` and `epoch`. The program's live state wins.
    return { ...this.snapshot, rev: this.rev, epoch: this.epoch };
  }

  private etag(): string {
    return `"${this.epoch}-${String(this.rev)}"`;
  }

  /** The ETag as it goes on the wire: weak when a test plays a compressing proxy. */
  private sentEtag(): string {
    return this.weakEtag ? `W/${this.etag()}` : this.etag();
  }

  /** The version check of WIRE.md section 2. A header outside the range is a 409, never a 5xx. */
  private versionProblem(header: string | null, isHello: boolean): Response | null {
    if (header === null) {
      return isHello ? null : reply(409, { code: "incompatible", range: this.range });
    }
    const version = Number(header);
    const inside = Number.isInteger(version) && version >= this.range.min && version <= this.range.max;
    return inside ? null : reply(409, { code: "incompatible", range: this.range });
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const version = request.headers.get("x-collie-session");
    const ifNoneMatch = request.headers.get("if-none-match");
    const body = request.method === "POST" ? await request.text() : null;
    const bearer = this.bearerOf(request);
    this.requests.push({ method: request.method, path: url.pathname, search: url.search, version, ifNoneMatch, body, bearer });

    // Over HTTP the token comes first, before the version and before any route, so a caller
    // without it learns nothing (WIRE.md section 1B).
    if (this.tokenDigest !== null && bearer !== "match") return reply(401, { code: "unauthorized" });
    const taken = await this.override?.(url.pathname);
    if (taken !== undefined) return taken;

    if (this.asksForToken) return reply(401, { code: "unauthorized" });
    const prefix = "/session/v1";
    if (!url.pathname.startsWith(`${prefix}/`)) return reply(404, { code: "not-found" });
    const route = url.pathname.slice(prefix.length);

    const wrongVersion = this.versionProblem(version, route === "/hello");
    if (wrongVersion !== null) return wrongVersion;
    if (request.method === "GET" && route === "/hello") return reply(200, this.currentHello());
    if (!this.ready) return reply(503, { code: "starting" });
    if (request.method === "GET" && route === "/snapshot") {
      // A weak `If-None-Match` is the same tag: compare with `W/` stripped (WIRE.md section 7.1).
      const asked = ifNoneMatch?.startsWith("W/") === true ? ifNoneMatch.slice(2) : ifNoneMatch;
      if (asked === this.etag()) return new Response(null, { status: 304, headers: { etag: this.sentEtag() } });
      return reply(200, this.currentSnapshot(), this.sentEtag());
    }
    const events = /^\/pane\/([^/]+)\/events$/.exec(route);
    if (request.method === "GET" && events !== null) {
      return this.eventsReply(decodeURIComponent(events[1] ?? ""), url.searchParams);
    }
    const starter = /^\/starter\/([^/]+)$/u.exec(route);
    if (request.method === "POST" && starter !== null) return this.handleStarter(decodeURIComponent(starter[1] ?? ""), body ?? "");
    const answerRoute = /^\/pane\/([^/]+)\/answer$/.exec(route);
    if (request.method === "POST" && answerRoute !== null) return this.answer(decodeURIComponent(answerRoute[1] ?? ""), body ?? "");
    const controlRoute = /^\/pane\/([^/]+)\/(send|abort)$/.exec(route);
    if (request.method === "POST" && controlRoute !== null) {
      const act = controlRoute[2] === "send" ? "send" : "abort";
      return this.control(act, decodeURIComponent(controlRoute[1] ?? ""), body ?? "");
    }
    return reply(404, { code: "not-found" });
  }

  /** WIRE.md 7.2: a plain read inside the tail, or a reset reply. */
  private eventsReply(paneId: string, query: URLSearchParams): Response {
    const afterText = query.get("after");
    const epoch = query.get("epoch");
    const after = afterText !== null && /^\d+$/.test(afterText) ? Number(afterText) : null;
    if (after === null || epoch === null || epoch === "") return reply(400, { code: "bad-cursor" });
    if (!this.snapshot.panes.some((pane) => pane.id === paneId)) return reply(404, { code: "no-such-pane" });

    const model = this.model(paneId);
    const count = model.log.length;
    const tailStart = Math.max(0, count - this.tailLimit);
    if (epoch === this.epoch && after >= tailStart && after <= count) {
      const slice = model.log.slice(after, after + this.eventsPerReply);
      const next = after + slice.length;
      const doc: EventsDoc = { epoch: this.epoch, events: slice, next };
      if (next < count) doc.more = true;
      return reply(200, doc);
    }

    const items = [...model.items.values()];
    const shown = items.slice(Math.max(0, items.length - this.viewItemCap));
    const paneState = this.snapshot.panes.find((pane) => pane.id === paneId)?.state ?? "idle";
    const doc: EventsDoc = {
      epoch: this.epoch,
      events: [
        { type: "reset" },
        ...shown,
        ...model.asks.values(),
        { type: "state", state: model.state ?? paneState },
        { type: "synced" },
      ],
      next: count,
      reset: true,
    };
    if (shown.length < items.length) doc.trimmed = items.length - shown.length;
    return reply(200, doc);
  }

  /**
   * `POST /starter/:id` (WIRE.md sections 3 and 7.6). A repeat of a request id that already succeeded
   * answers the first pane with `replayed: true` and runs nothing. A failure is 422 and stores
   * nothing. The same id for another starter is 409 `request-id-reused`.
   */
  private handleStarter(starterId: string, text: string): Response {
    if (this.hello.caps.starters !== true) return reply(409, { code: "not-supported" });
    let body: { requestId?: JsonValue } | null;
    try {
      body = JSON.parse(text);
    } catch {
      return reply(400, { code: "bad-json" });
    }
    // The tests mint UUIDs, as the phone does.
    const requestId = body?.requestId;
    if (!isRequestId(requestId)) return reply(400, { code: "bad-body" });
    if (!this.snapshot.starters.some((starter) => starter.id === starterId)) return reply(404, { code: "no-such-starter" });

    const earlier = this.startedByRequest.get(requestId);
    if (earlier !== undefined) {
      if (earlier.starterId !== starterId) return reply(409, { code: "request-id-reused" });
      return reply(200, { paneId: earlier.paneId, replayed: true });
    }
    if (this.starterFailure !== null) return reply(422, { code: "starter-failed", message: this.starterFailure });

    const paneId = `conv-${String(this.snapshot.panes.length + 1).padStart(2, "0")}-${requestId.slice(0, 8)}`;
    const workspace = this.snapshot.workspaces[0];
    const tab = this.snapshot.tabs.find((candidate) => candidate.workspaceId === workspace?.id);
    if (workspace === undefined || tab === undefined) return reply(422, { code: "starter-failed", message: "no workspace to start in" });
    this.snapshot.panes = [
      ...this.snapshot.panes,
      {
        id: paneId,
        workspaceId: workspace.id,
        tabId: tab.id,
        title: this.snapshot.starters.find((starter) => starter.id === starterId)?.label ?? starterId,
        harness: "pi",
        state: "idle",
        lastActiveAt: Date.now(),
        turnId: `turn-${paneId}`,
        openAsks: [],
      },
    ];
    this.touch();
    const start: FakeStart = { starterId, requestId, paneId };
    this.startedByRequest.set(requestId, start);
    this.starts.push(start);
    return reply(200, { paneId });
  }

  /** `POST /pane/:id/answer`, as WIRE.md section 7.3 says a program answers it. */
  private answer(paneId: string, text: string): Response {
    const post = parseAnswerPost(text);
    if (post === "bad-json") return reply(400, { code: "bad-json" });
    if (post === null) return reply(400, { code: "bad-body" });
    const { requestId, askId, revision, optionId } = post;
    const pane = this.snapshot.panes.find((candidate) => candidate.id === paneId);
    if (pane === undefined) return reply(404, { code: "no-such-pane" });
    const earlier = this.answered.get(requestId);
    if (earlier !== undefined) {
      if (earlier.paneId !== paneId) return reply(409, { code: "request-id-reused" });
      return reply(200, { ...earlier.reply, replayed: true });
    }
    const ask = pane.openAsks.find((open) => open.id === askId);
    let answer: AnswerDoc;
    if (ask === undefined) {
      answer = { result: "too-late" };
    } else if (ask.revision !== revision) {
      return reply(409, { code: "stale", turnId: pane.turnId, askIds: pane.openAsks.map((open) => open.id), ask });
    } else if (!ask.options.some((option) => option.id === optionId)) {
      return reply(400, { code: "bad-option" });
    } else {
      // Resolved: the ask closes with `by: "phone"`, and the pane waits only while another is open.
      this.answers.push({ paneId, askId, toolCallId: ask.toolCallId, optionId, requestId });
      const left = pane.openAsks.filter((open) => open.id !== askId);
      this.snapshot.panes = this.snapshot.panes.map((candidate) =>
        candidate.id === paneId ? { ...candidate, openAsks: left, state: left.length > 0 ? "waiting" : "working" } : candidate,
      );
      this.touch();
      answer = { result: "taken" };
    }
    this.answered.set(requestId, { paneId, reply: answer });
    return reply(200, answer);
  }

  /**
   * `POST /pane/:id/send` and `/abort`, as WIRE.md section 7.4 says a program answers them: the body,
   * then the pane, then the request id memory, then the caps, then the name.
   */
  private control(act: "send" | "abort", paneId: string, text: string): Response {
    const post = parseControlPost(text, act);
    if (post === "bad-json") return reply(400, { code: "bad-json" });
    if (post === null) return reply(400, { code: "bad-body" });
    const pane = this.snapshot.panes.find((candidate) => candidate.id === paneId);
    if (pane === undefined) return reply(404, { code: "no-such-pane" });
    const earlier = this.controlled.get(post.requestId);
    if (earlier !== undefined) {
      if (earlier.act !== act || earlier.paneId !== paneId) return reply(409, { code: "request-id-reused" });
      return reply(200, { ok: true, replayed: true });
    }
    const caps = this.hello.caps;
    const able = act === "abort" ? caps.abort === true : caps.send === true && (!post.steer || caps.steer === true);
    if (!able) return reply(409, { code: "not-supported" });
    const current = post.turnId !== null ? post.turnId === pane.turnId : pane.openAsks.some((ask) => ask.id === post.askId);
    if (!current) return reply(409, { code: "stale", turnId: pane.turnId, askIds: pane.openAsks.map((ask) => ask.id) });

    this.controlled.set(post.requestId, { act, paneId });
    if (act === "send") this.takeSend(pane, post.requestId, post.text, post.steer, post.turnId, post.askId);
    else this.takeAbort(pane, post.requestId, post.turnId, post.askId);
    return reply(200, { ok: true });
  }

  private updatePane(paneId: string, change: Partial<DurablePane>): void {
    this.snapshot.panes = this.snapshot.panes.map((pane) => (pane.id === paneId ? { ...pane, ...change } : pane));
    this.touch();
  }

  /** A send: an idle pane starts a new turn; a running one takes a steer now, or a follow-up later. */
  private takeSend(pane: DurablePane, requestId: string, text: string, steer: boolean, turnId: string | null, askId: string | null): void {
    this.sends.push({ paneId: pane.id, requestId, text, steer, turnId, askId });
    const busy = pane.state === "working" || pane.state === "waiting";
    if (busy && !steer) return;
    this.appendEvent(pane.id, { type: "item", item: { id: `user-${requestId}`, kind: "user", text } });
    if (busy) return;
    this.turnsMinted += 1;
    this.running.set(pane.id, { inputId: `input-${requestId}`, requestId });
    this.updatePane(pane.id, { turnId: `turn-${pane.id}-${String(this.turnsMinted)}`, state: "working" });
    this.appendEvent(pane.id, { type: "state", state: "working" });
  }

  /**
   * An abort (WIRE.md section 7.5): no item; the running input settles as unanswered with the reason
   * `aborted`; every open ask closes `by: "stopped"`; the pane goes idle. Nothing running: nothing.
   */
  private takeAbort(pane: DurablePane, requestId: string, turnId: string | null, askId: string | null): void {
    const busy = pane.state === "working" || pane.state === "waiting" || pane.openAsks.length > 0;
    this.aborts.push({ paneId: pane.id, requestId, turnId, askId, stopped: busy });
    if (!busy) return;
    const input = this.running.get(pane.id);
    this.running.delete(pane.id);
    const settled: FakeEvent = { type: "settled", inputId: input?.inputId ?? `input-${pane.turnId}`, status: "unanswered", reason: "aborted" };
    this.appendEvent(pane.id, input === undefined ? settled : { ...settled, requestId: input.requestId });
    for (const ask of pane.openAsks) this.appendEvent(pane.id, { type: "ask-closed", askId: ask.id, by: "stopped" });
    this.updatePane(pane.id, { openAsks: [], state: "idle" });
    this.appendEvent(pane.id, { type: "state", state: "idle" });
  }

  /** Stop listening and remove the socket and its directory. Idempotent. */
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    await server?.stop(true);
    if (this.dir !== null) rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * Make a test folder private to this user on every host: mode 0700 on POSIX, an owner-only access list
 * on Windows (M43 spec 04), which the files made inside it inherit. NTFS has no 0600 to read back.
 */
export function privateTestDir(dir: string): string {
  ensureOwnerOnlyDir(dir, HOST, { root: privateRoot("state"), repair: true });
  return dir;
}

/** Whether a file the bridge wrote is private to this user: mode 0600 on POSIX, the access list on Windows. */
export function isPrivateFile(path: string): boolean {
  return isOwnerOnly(path, HOST).state === "private";
}

/** Whether wire tests dial a loopback port: always on Windows, and on request elsewhere. */
export function wireOverLoopback(platform: NodeJS.Platform = HOST.platform, env: DurableEnvLike = process.env): boolean {
  return platform === "win32" || env.COLLIE_TEST_LOOPBACK === "1";
}

/**
 * Skip a test that is about the socket itself (its mode, its path, the environment variable that names
 * it, a program that asks for a token on it). Windows has no socket transport, so these cannot run
 * there; `COLLIE_TEST_LOOPBACK=1` skips them on Linux too, which is how the Windows form is proven.
 */
export const SOCKET_ONLY_SKIP = wireOverLoopback();

type DurableEnvLike = Readonly<Record<string, string | undefined>>;

/**
 * The HTTP client wearing the socket's `kind`, so the adapter keeps the socket's budgets and poll
 * cadence while the bytes cross 127.0.0.1. A test about the wire does not care which pipe carries it.
 */
class LoopbackWireClient implements DurableTransport {
  readonly kind = "socket";
  constructor(private readonly inner: DurableHttpClient) {}
  get(request: DurableGet): Promise<DurableReply> {
    return this.inner.get(request);
  }
  post(request: DurablePost): Promise<DurableReply> {
    return this.inner.post(request);
  }
}

/** A token's SHA-256, so two tokens of any length compare in constant time. */
function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** A fresh random token for a test: 32 random bytes as 64 hex characters, never written anywhere. */
export function testToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}

// ── The conformance world ─────────────────────────────────────────────────────

/** Move the clock past the floor, so the adapter's next read is a real read. */
const PAST_THE_FLOOR_MS = MIN_SNAPSHOT_GAP_MS + 50;

/**
 * Over HTTPS the watch is the only dialer (adapter.ts): a good read is served again until the watch's idle
 * cadence has passed, which is also the adapter's declared `topologyLatency`. A change the world makes is
 * therefore seen one idle census later, so the https world moves its clock that far.
 */
const ONE_IDLE_CENSUS_MS = DURABLE_BUDGETS.https.idlePollMs;

/**
 * A durable world: the real adapter over the real socket client, dialling a fake program that holds
 * five conversations in two workspaces and three tabs.
 *
 * `focusOutOfBand` is absent on purpose. A durable conversation has no terminal for anyone to focus,
 * so the world cannot move focus, and the suite then demands that no pane is ever reported focused.
 */
export async function durableWorld(): Promise<MuxConformanceWorld> {
  const program = await FakeDurableProgram.startWire();
  const clock = new FakeDurableClock();
  const adapter = new DurableMux(program.wire(), clock);
  const change = (act: () => void): Promise<void> => {
    act();
    clock.advance(PAST_THE_FLOOR_MS);
    return Promise.resolve();
  };
  return {
    adapter,
    // A durable pane takes no typed text and no keys, so nothing is ever written.
    writes: () => [],
    reconnect: async () => {
      await program.dropConnections();
      clock.advance(PAST_THE_FLOOR_MS);
    },
    restartMux: () => change(() => program.restart()),
    renameOutOfBand: (paneId, label) => change(() => program.retitlePane(paneId, label)),
    setProgramTitle: (paneId, title) => change(() => program.retitlePane(paneId, title)),
    changePane: (paneId) => change(() => program.setState(paneId, "working")),
    endPane: (paneId) => change(() => program.removePane(paneId)),
    // A tab renamed in the program's own layout, announced to no one.
    pokeTopologyOutOfBand: () => change(() => program.renameTab("ws-notes:research", "renamed in the program")),
    close: () => program.close(),
  };
}

export const durableConformanceFixture: MuxConformanceFixture = {
  mux: DURABLE_MUX,
  create: durableWorld,
};

/**
 * The same world over the second transport: the real adapter over the real HTTP client, with a
 * bearer token, dialling the fake program on 127.0.0.1 (WIRE.md section 1B). Same program, same
 * bytes, so the suite proves the adapter does not depend on which transport it has.
 */
export async function durableHttpWorld(): Promise<MuxConformanceWorld> {
  const token = testToken();
  const program = await FakeDurableProgram.startHttp(token);
  const clock = new FakeDurableClock();
  const adapter = new DurableMux(new DurableHttpClient(program.url, token), clock);
  const change = (act: () => void): Promise<void> => {
    act();
    clock.advance(ONE_IDLE_CENSUS_MS);
    return Promise.resolve();
  };
  return {
    adapter,
    writes: () => [],
    reconnect: async () => {
      await program.dropConnections();
      clock.advance(ONE_IDLE_CENSUS_MS);
    },
    restartMux: () => change(() => program.restart()),
    renameOutOfBand: (paneId, label) => change(() => program.retitlePane(paneId, label)),
    setProgramTitle: (paneId, title) => change(() => program.retitlePane(paneId, title)),
    changePane: (paneId) => change(() => program.setState(paneId, "working")),
    endPane: (paneId) => change(() => program.removePane(paneId)),
    pokeTopologyOutOfBand: () => change(() => program.renameTab("ws-notes:research", "renamed in the program")),
    close: () => program.close(),
  };
}

export const durableHttpConformanceFixture: MuxConformanceFixture = {
  mux: DURABLE_MUX,
  variant: "https with a bearer token",
  create: durableHttpWorld,
};
