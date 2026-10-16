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
// It takes `POST /rename` as WIRE.md 7.8 describes it: a workspace or a tab by kind and id, a title of 1 to
// 120 characters, the cap checked, a repeat of a request id answered `replayed`, and a refusal (422
// `rename-refused`) when a test sets `renameRefusal`. A rename changes the title and `rev` rises.
//
// It takes `POST /close` as WIRE.md 7.9 describes it: a pane, a tab or a workspace by kind and id, the cap checked, a
// repeat of a request id answered `replayed`, and a refusal (422 `close-refused`) when a test sets `closeRefusal`. A
// close takes the target and everything inside it out of the layout, and `rev` rises.
//
// It serves its own history as WIRE.md 7.16 describes it, when `caps.history` is set: `GET /conversations`
// from the `conversations` a test lists (newest first, paged by `c<n>`) and `GET /conversation/:id/items` from
// each one's items (paged by `i<n>`). It takes `POST /reopen` when `caps.reopen` is set: a pane it closed comes back
// under the same id, in its tab, and `rev` rises; a refusal (422 `reopen-refused`) when a test sets `reopenRefusal`.
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
  parseActionPost,
  parseAnswerPost,
  type DurableAnswerBody,
  parseClosePost,
  parseControlPost,
  parseEvents,
  parseRenamePost,
  parseReopenPost,
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
    rename?: boolean;
    close?: boolean;
    actions?: boolean;
    history?: boolean;
    reopen?: boolean;
    terminal?: boolean;
  };
}

/** One conversation of the fake's history (WIRE.md 7.16): its row, as served, and its items, oldest first. */
export interface FakeConversation {
  row: JsonObject;
  items: JsonObject[];
}

/** A reopen the fake took. */
export interface FakeReopen {
  readonly requestId: string;
  readonly id: string;
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
  /** The option of a permission, the picks of a choice joined by a comma, and empty for a text or a form. */
  readonly optionId: string;
  /** What was answered, as the program read it. */
  readonly answer: DurableAnswerBody;
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

/** One rename the fake took (WIRE.md section 7.8). A replay is not one. */
export interface FakeRename {
  readonly requestId: string;
  readonly kind: "workspace" | "tab";
  readonly id: string;
  readonly title: string;
}

/** One close the fake took (WIRE.md section 7.9). A replay is not one. */
export interface FakeClose {
  readonly requestId: string;
  readonly kind: "pane" | "tab" | "workspace";
  readonly id: string;
}

/** One belt action the fake ran (WIRE.md section 7.10). A replay is not one. */
export interface FakeAction {
  readonly requestId: string;
  readonly paneId: string;
  readonly actionId: string;
  readonly turnId: string | null;
}

/** What a send or an abort answers. */
export interface ControlDoc {
  ok: true;
  replayed?: true;
}

function reply(
  status: number,
  body: HelloDoc | SnapshotDoc | ProblemDoc | EventsDoc | StarterReplyDoc | AnswerDoc | ControlDoc | JsonObject,
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
  /** The first decision of each ask the phone answered, by ask id: what a second answer's 409 `decided` carries (WIRE.md 7.3). */
  readonly decided = new Map<string, JsonObject>();

  /** Every send the fake took, in order. A replay is not a second entry. */
  readonly sends: FakeSend[] = [];
  /** Every abort the fake took, in order. A replay is not a second entry. */
  readonly aborts: FakeAbort[] = [];
  /** The route and pane per request id a send or abort took (WIRE.md section 7.6). */
  private readonly controlled = new Map<string, { act: "send" | "abort"; paneId: string }>();
  /** The input running on a pane, from the send that started it. */
  private readonly running = new Map<string, { inputId: string; requestId: string }>();
  private turnsMinted = 0;

  /** Every rename the fake took, in order. A replay is not a second entry. */
  readonly renames: FakeRename[] = [];
  /** When set, the next renames fail with 422 `rename-refused` and this message, and store nothing. */
  renameRefusal: string | null = null;
  private readonly renamedByRequest = new Map<string, FakeRename>();

  /** Every close the fake took, in order. A replay is not a second entry. */
  readonly closes: FakeClose[] = [];
  /** When set, the next closes fail with 422 `close-refused` and this message, and change nothing. */
  closeRefusal: string | null = null;
  private readonly closedByRequest = new Map<string, FakeClose>();

  /** The program's history, newest first (WIRE.md 7.16). Served only with `caps.history`. */
  conversations: FakeConversation[] = [];
  /** Every reopen the fake took, in order. A replay is not a second entry. */
  readonly reopens: FakeReopen[] = [];
  /** When set, the next reopens fail with 422 `reopen-refused` and this message, and change nothing. */
  reopenRefusal: string | null = null;
  private readonly reopenedByRequest = new Map<string, FakeReopen>();
  /** The panes a close took out, by conversation id (`sessionId`, else the pane id), so a reopen can put one back. */
  private readonly closedPanes = new Map<string, DurablePane>();

  /** Every belt action the fake ran, in order. A replay is not a second entry. */
  readonly actionsRun: FakeAction[] = [];
  /** When set, the next actions fail with 422 `action-refused` and this message, and change nothing. */
  actionRefusal: string | null = null;
  private readonly actedByRequest = new Map<string, FakeAction>();

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
    if (inside) return null;
    // The refusal names both sides (WIRE.md section 2): the version the caller sent, and the program's range.
    const refusal = Number.isInteger(version) ? { refusal: { code: "version", collie: [version, version], program: [this.range.min, this.range.max] } } : {};
    return reply(409, { code: "incompatible", range: this.range, ...refusal });
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
    if (request.method === "POST" && route === "/rename") return this.handleRename(body ?? "");
    if (request.method === "POST" && route === "/close") return this.handleClose(body ?? "");
    if (request.method === "GET" && route === "/conversations") return this.conversationsReply(url.searchParams);
    const itemsRoute = /^\/conversation\/([^/]+)\/items$/.exec(route);
    if (request.method === "GET" && itemsRoute !== null) return this.itemsReply(decodeURIComponent(itemsRoute[1] ?? ""), url.searchParams);
    if (request.method === "POST" && route === "/reopen") return this.handleReopen(body ?? "");
    const actionRoute = /^\/pane\/([^/]+)\/action$/.exec(route);
    if (request.method === "POST" && actionRoute !== null) return this.handleAction(decodeURIComponent(actionRoute[1] ?? ""), body ?? "");
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

  /**
   * `POST /rename` (WIRE.md section 7.8): the body, then the cap, then the request id memory, then the
   * target, then the program's say. A failure stores nothing, so the same id may try again.
   */
  private handleRename(text: string): Response {
    const post = parseRenamePost(text);
    if (post === "bad-json") return reply(400, { code: "bad-json" });
    // The tests mint UUIDs, as the adapter does.
    if (post === null || !isRequestId(post.requestId)) return reply(400, { code: "bad-body" });
    const { requestId, kind, id, title } = post;
    if (this.hello.caps.rename !== true) return reply(409, { code: "not-supported" });

    const earlier = this.renamedByRequest.get(requestId);
    if (earlier !== undefined) {
      if (earlier.kind !== kind || earlier.id !== id || earlier.title !== title) return reply(409, { code: "request-id-reused" });
      return reply(200, { ok: true, replayed: true });
    }
    const found = kind === "tab" ? this.snapshot.tabs.some((tab) => tab.id === id) : this.snapshot.workspaces.some((workspace) => workspace.id === id);
    if (!found) return reply(404, { code: "no-such-target" });
    if (this.renameRefusal !== null) return reply(422, { code: "rename-refused", message: this.renameRefusal });

    if (kind === "tab") this.renameTab(id, title);
    else {
      this.snapshot.workspaces = this.snapshot.workspaces.map((workspace) => (workspace.id === id ? { ...workspace, title } : workspace));
      this.touch();
    }
    const rename: FakeRename = { requestId, kind, id, title };
    this.renamedByRequest.set(requestId, rename);
    this.renames.push(rename);
    return reply(200, { ok: true });
  }

  /**
   * `POST /close` (WIRE.md section 7.9): the body, then the cap, then the request id memory, then the target, then the
   * program's say. A close takes the target and everything inside it out of the layout, which takes the open asks
   * of those panes with it. A failure changes nothing, so the same id may try again.
   */
  private handleClose(text: string): Response {
    const post = parseClosePost(text);
    if (post === "bad-json") return reply(400, { code: "bad-json" });
    if (post === null || !isRequestId(post.requestId)) return reply(400, { code: "bad-body" });
    const { requestId, kind, id } = post;
    if (this.hello.caps.close !== true) return reply(409, { code: "not-supported" });

    const earlier = this.closedByRequest.get(requestId);
    if (earlier !== undefined) {
      if (earlier.kind !== kind || earlier.id !== id) return reply(409, { code: "request-id-reused" });
      return reply(200, { ok: true, replayed: true });
    }
    const found =
      kind === "pane"
        ? this.snapshot.panes.some((pane) => pane.id === id)
        : kind === "tab"
          ? this.snapshot.tabs.some((tab) => tab.id === id)
          : this.snapshot.workspaces.some((workspace) => workspace.id === id);
    if (!found) return reply(404, { code: "no-such-target" });
    if (this.closeRefusal !== null) return reply(422, { code: "close-refused", message: this.closeRefusal });

    const goneTabs = new Set(
      kind === "tab" ? [id] : kind === "workspace" ? this.snapshot.tabs.filter((tab) => tab.workspaceId === id).map((tab) => tab.id) : [],
    );
    for (const pane of this.snapshot.panes) {
      if (kind === "pane" ? pane.id === id : goneTabs.has(pane.tabId)) this.closedPanes.set(pane.sessionId ?? pane.id, { ...pane, openAsks: [] });
    }
    this.snapshot.panes = this.snapshot.panes.filter((pane) => (kind === "pane" ? pane.id !== id : !goneTabs.has(pane.tabId)));
    this.snapshot.tabs = this.snapshot.tabs.filter((tab) => !goneTabs.has(tab.id));
    if (kind === "workspace") this.snapshot.workspaces = this.snapshot.workspaces.filter((workspace) => workspace.id !== id);
    this.touch();
    const close: FakeClose = { requestId, kind, id };
    this.closedByRequest.set(requestId, close);
    this.closes.push(close);
    return reply(200, { ok: true });
  }

  /** A page of a history route: `after` as `<letter><n>`, `limit` from 1 to `max`. Null for a bad one (400). */
  private pageOf(query: URLSearchParams, letter: string, max: number): { from: number; limit: number } | null {
    const after = query.get("after");
    const limitText = query.get("limit");
    const from = after === null ? 0 : new RegExp(`^${letter}(\\d+)$`).exec(after)?.[1];
    if (from === undefined) return null;
    if (limitText !== null && !/^[1-9]\d*$/.test(limitText)) return null;
    return { from: Number(from), limit: Math.min(limitText === null ? max : Number(limitText), max) };
  }

  /** `GET /conversations` (WIRE.md 7.16): the rows newest first, at most 100 a page. */
  private conversationsReply(query: URLSearchParams): Response {
    if (this.hello.caps.history !== true) return reply(409, { code: "not-supported" });
    const page = this.pageOf(query, "c", 100);
    if (page === null) return reply(400, { code: "bad-cursor" });
    const end = page.from + page.limit;
    const doc: JsonObject = { items: this.conversations.slice(page.from, end).map((conversation) => conversation.row) };
    return reply(200, end < this.conversations.length ? { ...doc, next: `c${String(end)}` } : doc);
  }

  /** `GET /conversation/:id/items` (WIRE.md 7.16): oldest first, at most 1000 a page. */
  private itemsReply(id: string, query: URLSearchParams): Response {
    if (this.hello.caps.history !== true) return reply(409, { code: "not-supported" });
    const page = this.pageOf(query, "i", 1000);
    if (page === null) return reply(400, { code: "bad-cursor" });
    const conversation = this.conversations.find((candidate) => candidate.row.id === id);
    if (conversation === undefined) return reply(404, { code: "no-such-conversation" });
    const end = page.from + page.limit;
    const items = conversation.items.slice(page.from, end);
    return reply(200, end < conversation.items.length ? { items, next: `i${String(end)}`, more: true } : { items, more: false });
  }

  /**
   * `POST /reopen` (WIRE.md 7.16): the body, then the cap, then the request id memory, then the target, then the
   * program's say. An open conversation answers ok and changes nothing. A pane this fake closed comes back.
   */
  private handleReopen(text: string): Response {
    const post = parseReopenPost(text);
    if (post === "bad-json") return reply(400, { code: "bad-json" });
    if (post === null || !isRequestId(post.requestId)) return reply(400, { code: "bad-body" });
    const { requestId, id } = post;
    if (this.hello.caps.reopen !== true) return reply(409, { code: "not-supported" });
    const earlier = this.reopenedByRequest.get(requestId);
    if (earlier !== undefined) {
      if (earlier.id !== id) return reply(409, { code: "request-id-reused" });
      return reply(200, { ok: true, replayed: true });
    }
    if (this.snapshot.panes.some((pane) => (pane.sessionId ?? pane.id) === id)) return reply(200, { ok: true });
    const pane = this.closedPanes.get(id);
    if (pane === undefined) return reply(404, { code: "no-such-target" });
    if (this.reopenRefusal !== null) return reply(422, { code: "reopen-refused", message: this.reopenRefusal });
    this.closedPanes.delete(id);
    this.snapshot.panes = [...this.snapshot.panes, pane];
    this.touch();
    const reopen: FakeReopen = { requestId, id };
    this.reopenedByRequest.set(requestId, reopen);
    this.reopens.push(reopen);
    return reply(200, { ok: true });
  }

  /** `POST /pane/:id/answer`, as WIRE.md section 7.3 says a program answers it. */
  private answer(paneId: string, text: string): Response {
    const post = parseAnswerPost(text);
    if (post === "bad-json") return reply(400, { code: "bad-json" });
    if (post === null) return reply(400, { code: "bad-body" });
    const { requestId, askId, revision } = post;
    const pane = this.snapshot.panes.find((candidate) => candidate.id === paneId);
    if (pane === undefined) return reply(404, { code: "no-such-pane" });
    const earlier = this.answered.get(requestId);
    if (earlier !== undefined) {
      if (earlier.paneId !== paneId) return reply(409, { code: "request-id-reused" });
      return reply(200, { ...earlier.reply, replayed: true });
    }
    const ask = pane.openAsks.find((open) => open.id === askId);
    let answer: AnswerDoc;
    const first = this.decided.get(askId);
    // A second answer to an ask the program remembers deciding: 409 `decided`, with the first outcome (WIRE.md 7.3).
    if (ask === undefined && first !== undefined) return reply(409, { code: "decided", outcome: first });
    if (ask === undefined) {
      answer = { result: "too-late" };
    } else if (ask.revision !== revision) {
      return reply(409, { code: "stale", turnId: pane.turnId, askIds: pane.openAsks.map((open) => open.id), ask });
    } else if (badAnswer(ask, post.answer) === "bad-option") {
      return reply(400, { code: "bad-option" });
    } else if (badAnswer(ask, post.answer) === "bad-body") {
      return reply(400, { code: "bad-body" });
    } else {
      // Resolved: the ask closes with `by: "phone"`, and the pane waits only while another is open.
      this.answers.push({ paneId, askId, toolCallId: ask.toolCallId, optionId: optionOf(post.answer), answer: post.answer, requestId });
      const optionId = post.answer.kind === "option" ? post.answer.optionId : undefined;
      const effect = ask.options.find((option) => option.id === optionId)?.effect;
      const outcome: JsonObject = { decidedBy: "phone", decidedAt: new Date().toISOString() };
      if (optionId !== undefined) outcome.optionId = optionId;
      if (effect !== undefined) outcome.effect = effect;
      this.decided.set(askId, outcome);
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
   * `POST /pane/:id/action` (WIRE.md section 7.10): the body, then the pane, then the request id memory, then the cap,
   * then the turn when the phone named one, then the action, then the program's say. A failure stores nothing, so
   * the same request id may try again.
   */
  private handleAction(paneId: string, text: string): Response {
    const post = parseActionPost(text);
    if (post === "bad-json") return reply(400, { code: "bad-json" });
    if (post === null || !isRequestId(post.requestId)) return reply(400, { code: "bad-body" });
    const { requestId, actionId, turnId } = post;
    const pane = this.snapshot.panes.find((candidate) => candidate.id === paneId);
    if (pane === undefined) return reply(404, { code: "no-such-pane" });
    const earlier = this.actedByRequest.get(requestId);
    if (earlier !== undefined) {
      if (earlier.paneId !== paneId || earlier.actionId !== actionId || earlier.turnId !== turnId) return reply(409, { code: "request-id-reused" });
      return reply(200, { ok: true, replayed: true });
    }
    if (this.hello.caps.actions !== true) return reply(409, { code: "not-supported" });
    if (turnId !== null && turnId !== pane.turnId) return reply(409, { code: "stale", turnId: pane.turnId, askIds: pane.openAsks.map((ask) => ask.id) });
    const row = (pane.actions ?? []).find((candidate) => candidate.id === actionId);
    if (row === undefined) return reply(404, { code: "no-such-action" });
    if (this.actionRefusal !== null) return reply(422, { code: "action-refused", message: this.actionRefusal });
    if (row.disabled === true || row.busy === true) return reply(422, { code: "action-refused" });

    const run: FakeAction = { requestId, paneId, actionId, turnId };
    this.actedByRequest.set(requestId, run);
    this.actionsRun.push(run);
    return reply(200, { ok: true });
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
    this.appendEvent(pane.id, { type: "item", item: { id: `user-${requestId}`, kind: "user", text, requestId } });
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
  // The recorded hello declares no `rename`. This world's program does, so the suite proves it works.
  program.hello.caps.rename = true;
  program.hello.caps.close = true;
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
  program.hello.caps.rename = true;
  program.hello.caps.close = true;
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

// ── What a program checks in an answer (WIRE.md 7.14) ─────────────────────────

/** The `optionId` a recorded answer shows: the option, the picks joined, or empty. */
function optionOf(answer: DurableAnswerBody): string {
  if (answer.kind === "option") return answer.optionId;
  return answer.kind === "options" ? answer.optionIds.join(",") : "";
}

/**
 * Whether the answer fits the ask, as a program answers it: `null` when it does, `bad-option` for an id the ask does
 * not offer, and `bad-body` for the wrong shape, a text over its `maxLength`, or a form that misses a required field.
 */
function badAnswer(ask: DurableAsk, answer: DurableAnswerBody): "bad-option" | "bad-body" | null {
  if (ask.kind === "choice") {
    if (answer.kind !== "options") return "bad-body";
    if (!answer.optionIds.every((id) => ask.options.some((option) => option.id === id))) return "bad-option";
    return answer.optionIds.length === 1 || ask.multiple === true ? null : "bad-body";
  }
  if (ask.kind === "text") {
    if (answer.kind !== "text") return "bad-body";
    return [...answer.text].length >= 1 && [...answer.text].length <= (ask.maxLength ?? 500) ? null : "bad-body";
  }
  if (ask.kind === "form") {
    if (answer.kind !== "values") return "bad-body";
    const fields = ask.fields ?? [];
    for (const key of Object.keys(answer.values)) {
      if (!fields.some((field) => field.id === key)) return "bad-body";
    }
    for (const field of fields) {
      const value = answer.values[field.id];
      if (value === undefined) {
        if (field.required === true) return "bad-body";
        continue;
      }
      if (field.kind === "toggle") {
        if (value !== true && value !== false) return "bad-body";
        continue;
      }
      if (value === true || value === false || Array.isArray(value)) return "bad-body";
      if (field.kind === "text" && [...value].length > (field.maxLength ?? 500)) return "bad-body";
      if (field.kind === "choice" && !(field.options ?? []).some((option) => option.id === value)) return "bad-option";
    }
    return null;
  }
  if (answer.kind !== "option") return "bad-body";
  return ask.options.some((option) => option.id === answer.optionId) ? null : "bad-option";
}
