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
// The 250 ms floor between snapshot reads is real in the adapter. The conformance world therefore
// runs it on `FakeDurableClock`, and every change the world makes moves that clock past the floor, so
// the next read is a real read. A test of the floor itself uses the clock directly.

import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "../../json.ts";
import { isRequestId } from "../../worktree-receipts.ts";
import type { MuxConformanceFixture, MuxConformanceWorld } from "../conformance.ts";
import { DURABLE_MUX, DurableMux, MIN_SNAPSHOT_GAP_MS, type DurableClock } from "./adapter.ts";
import { DurableSocketClient } from "./client.ts";
import recordedHello from "./fixtures/hello.json";
import recordedSnapshot from "./fixtures/snapshot.json";
import type { DurablePane, DurableStarter, DurableTab, DurableWorkspace, ProtocolRange } from "./protocol.ts";

// ── The documents ─────────────────────────────────────────────────────────────

/** A `hello` document as the fake serves it. `epoch`, `ready` and `protocol` come from the fake's state. */
export interface FakeHello {
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

/** One request the fake saw. */
export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly version: string | null;
  readonly ifNoneMatch: string | null;
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

function reply(status: number, body: HelloDoc | SnapshotDoc | ProblemDoc | StarterReplyDoc, etag?: string): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (etag !== undefined) headers.set("etag", etag);
  return new Response(JSON.stringify(body), { status, headers });
}

/** The mode WIRE.md section 1 asks of the socket: the owner only. */
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
  override: FakeOverride | null = null;
  readonly requests: FakeRequest[] = [];
  /** Every start that ran. A repeat of a request id that already succeeded is not added (WIRE.md 7.6). */
  readonly starts: FakeStart[] = [];
  /** When set, the next starts fail with 422 `starter-failed` and this message, and store nothing. */
  starterFailure: string | null = null;

  private readonly startedByRequest = new Map<string, FakeStart>();

  private server: ReturnType<typeof Bun.serve> | null = null;

  private constructor(
    readonly socketPath: string,
    private readonly dir: string,
  ) {}

  /** Start a program on a fresh socket under the temp directory. */
  static async start(): Promise<FakeDurableProgram> {
    // `mkdtemp` makes the directory mode 0700.
    const dir = mkdtempSync(join(tmpdir(), "collie-durable-"));
    const program = new FakeDurableProgram(join(dir, "s.sock"), dir);
    program.listen();
    return program;
  }

  private listen(): void {
    this.server = Bun.serve({ unix: this.socketPath, fetch: (request) => this.handle(request) });
    // The listener creates the socket with the process umask. A program must create it private.
    chmodSync(this.socketPath, PRIVATE_SOCKET_MODE);
  }

  /** Stop listening, then listen again on the same path. The state is untouched. */
  async dropConnections(): Promise<void> {
    await this.server?.stop(true);
    rmSync(this.socketPath, { force: true });
    this.listen();
  }

  /** The program restarts: a new epoch, and `rev` starts over. Pane ids stay, as WIRE.md section 8 says. */
  restart(options: { ready: boolean } = { ready: true }): void {
    this.epoch = randomEpoch();
    this.rev = 1;
    this.ready = options.ready;
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

  removePane(paneId: string): void {
    this.snapshot.panes = this.snapshot.panes.filter((pane) => pane.id !== paneId);
    this.touch();
  }

  /** The hello document the program serves right now. */
  currentHello(): HelloDoc {
    return {
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
    this.requests.push({ method: request.method, path: url.pathname, version, ifNoneMatch });

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
      const etag = this.etag();
      if (ifNoneMatch === etag) return new Response(null, { status: 304, headers: { etag } });
      return reply(200, this.currentSnapshot(), etag);
    }
    const starter = /^\/starter\/([^/]+)$/u.exec(route);
    if (request.method === "POST" && starter !== null) return this.handleStarter(decodeURIComponent(starter[1] ?? ""), request);
    return reply(404, { code: "not-found" });
  }

  /**
   * `POST /starter/:id` (WIRE.md sections 3 and 7.6). A repeat of a request id that already succeeded
   * answers the first pane with `replayed: true` and runs nothing. A failure is 422 and stores
   * nothing. The same id for another starter is 409 `request-id-reused`.
   */
  private async handleStarter(starterId: string, request: Request): Promise<Response> {
    if (this.hello.caps.starters !== true) return reply(409, { code: "not-supported" });
    let body: { requestId?: JsonValue } | null;
    try {
      body = await request.json();
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

  /** Stop listening and remove the socket and its directory. Idempotent. */
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    await server?.stop(true);
    rmSync(this.dir, { recursive: true, force: true });
  }
}

// ── The conformance world ─────────────────────────────────────────────────────

/** Move the clock past the floor, so the adapter's next read is a real read. */
const PAST_THE_FLOOR_MS = MIN_SNAPSHOT_GAP_MS + 50;

/**
 * A durable world: the real adapter over the real socket client, dialling a fake program that holds
 * five conversations in two workspaces and three tabs.
 *
 * `focusOutOfBand` is absent on purpose. A durable conversation has no terminal for anyone to focus,
 * so the world cannot move focus, and the suite then demands that no pane is ever reported focused.
 */
export async function durableWorld(): Promise<MuxConformanceWorld> {
  const program = await FakeDurableProgram.start();
  const clock = new FakeDurableClock();
  const adapter = new DurableMux(new DurableSocketClient(program.socketPath), clock);
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
