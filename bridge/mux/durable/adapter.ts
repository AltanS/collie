// A DURABLE PROGRAM, BEHIND THE CONTRACT: a mux with no screen (ADR 0099, WIRE.md).
//
// The program owns its conversations and listens on a private Unix socket. This adapter dials it,
// polls it, and maps what it reads onto the port: the program's workspaces become spaces, its tabs
// become tabs, and each conversation becomes a pane. There is no pty and no terminal, so every verb
// that needs a screen, a key press or a new shell answers the contract's `unsupported`.
//
// WHAT IS HERE: the hello and ready and epoch rules (WIRE.md sections 2 and 8), the snapshot with
// its ETag and 304 (section 7.1), the 250 ms floor between two snapshot reads, the mapping, and the
// events reader that fills the bridge's pane log (`syncEvents()`, events.ts, bridge/durable/log.ts).
// AND STARTERS (ADR 0102): `listStarters()` and `startStarter()`, the program's named ways to begin a
// conversation, run with the phone's request id passed through unchanged.
// WHAT IS NOT: answers, sends and aborts. Those are later specs, and they read the clean view this
// class holds (`program()`, `held()`).
//
// NOT READY IS NOT EMPTY. While the program lays out its panes after a start, or when it speaks no
// version we do, the adapter is `unreachable` with a detail that says why. It never answers an
// empty census for those cases. A program that is up with no panes is a real, empty snapshot.

import { declareCapabilities } from "../capabilities.ts";
import { DurableLogs } from "../../durable/log.ts";
import type { MuxAdapterFactory, MuxTarget } from "../registry.ts";
import {
  muxOk,
  muxUnreachable,
  muxUnsupported,
  type MuxAck,
  type MuxAdapter,
  type MuxCreatedPane,
  type MuxGrid,
  type MuxGridRequest,
  type MuxOutcome,
  type MuxRefusalOutcome,
  type MuxSession,
  type MuxSnapshot,
  type MuxStarterOutcome,
  type MuxStarters,
  type MuxSpaceRequest,
  type MuxSubscription,
  type MuxTabRequest,
  type MuxWatchOptions,
  type MuxWorktree,
  type MuxWorktreeCreateRequest,
  type MuxWorktreeOpenRequest,
  type MuxWorktreeOpened,
  type MuxWorktreeScope,
} from "../types.ts";
import { isWireId, REPLY_CAPS } from "./clean.ts";
import {
  DURABLE_SOCKET_ENV,
  DurableSocketClient,
  DurableUnreachable,
  resolveSocketPath,
  type DurableReply,
  type DurableTransport,
} from "./client.ts";
import { DurableEventReader, type DurableEventSink } from "./events.ts";
import { DURABLE_LOGO_SVG } from "./logo.ts";
import {
  incompatibleDetail,
  negotiateVersion,
  parseHello,
  parseProblem,
  parseSnapshot,
  parseStarterReply,
  toMuxSnapshot,
  type DurableCaps,
  type DurableSnapshot,
} from "./protocol.ts";
import { DurableWatch, IDLE_POLL_MS } from "./watch.ts";

export const DURABLE_MUX = "durable";

/** `MuxTarget.options` key that overrides the socket path. Only tests set it; the bridge reads the variable. */
export const DURABLE_SOCKET_OPTION = "durableSocket";

/** `MuxTarget.options` key that names the folder of the bridge's pane logs. Empty or absent: no log is kept. */
export const DURABLE_LOG_DIR_OPTION = "durableLogDir";

/** The shortest time between two snapshot reads (WIRE.md section 7.1). */
export const MIN_SNAPSHOT_GAP_MS = 250;

/** The budget for `hello` and `snapshot` (WIRE.md section 7.6). */
export const READ_TIMEOUT_MS = 1000;

/** The budget for a starter (WIRE.md section 7.6). A start may spin up a whole conversation. */
export const STARTER_TIMEOUT_MS = 30_000;

/** The refusal detail for a program that has not laid out its panes yet. */
export const STARTING = "starting";

/** The clock the 250 ms floor is measured on. A test supplies its own. */
export interface DurableClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const SYSTEM_CLOCK: DurableClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** What `hello` agreed with the program: the version spoken, and who it is. */
export interface DurableSession {
  readonly version: number;
  readonly epoch: string;
  readonly hostName: string;
  readonly caps: DurableCaps;
}

/** The program as the adapter last saw it, while it is reachable. */
export interface DurableProgram {
  readonly session: DurableSession;
  readonly snapshot: DurableSnapshot;
}

interface Held {
  readonly snapshot: DurableSnapshot;
  readonly mux: MuxSnapshot;
  readonly etag: string | null;
}

interface Reading {
  readonly at: number;
  readonly outcome: MuxOutcome<MuxSnapshot>;
}

const NO_SCREEN = "A durable conversation has no terminal screen.";
const NO_KEYS = "A durable conversation takes no typed keys.";
const NO_STRUCTURE = "A durable program lays out its own workspaces, tabs and conversations.";

export class DurableMux implements MuxAdapter {
  readonly mux = DURABLE_MUX;
  readonly logo = DURABLE_LOGO_SVG;

  /**
   * `agentDetection` and `agentSessionRef` are declared: a durable program reports how each
   * conversation is doing, every pane names the agent `durable`, and every pane names its
   * conversation id as the session, which keys the bridge's pane log for the journal. Everything that
   * needs a screen, a key or a new shell is absent, and the program pushes nothing, so both push
   * capabilities are absent too.
   */
  readonly capabilities = declareCapabilities({
    supports: ["agentDetection", "agentSessionRef"],
    spaces: "many",
    // The slowest the watch ever polls. A change the program did not announce is seen within it.
    topologyLatency: { kind: "bounded", ms: IDLE_POLL_MS },
    notes: {
      paneGrid: NO_SCREEN,
      gridScrollback: NO_SCREEN,
      typeText: NO_KEYS,
      sendKeys: NO_KEYS,
      renamePane: NO_STRUCTURE,
      closePane: NO_STRUCTURE,
      setFocus: "There is no terminal to show a conversation in.",
      createTab: NO_STRUCTURE,
      renameTab: NO_STRUCTURE,
      closeTab: NO_STRUCTURE,
      createSpace: NO_STRUCTURE,
    },
  });

  /** The version `hello` agreed. It rides every later call, `hello` included. Null until agreed. */
  private agreedVersion: number | null = null;
  private current: DurableSession | null = null;
  private kept: Held | null = null;
  private last: Reading | null = null;
  private inflight: Promise<MuxOutcome<MuxSnapshot>> | null = null;
  private readonly events: DurableEventReader | null;

  /**
   * `log` is where a pane's events go. Without one the adapter reads the layout only, which is what a
   * test of the layout wants; the bridge always gives it the pane log.
   */
  constructor(
    private readonly transport: DurableTransport,
    private readonly clock: DurableClock = SYSTEM_CLOCK,
    log: DurableEventSink | null = null,
  ) {
    this.events = log === null ? null : new DurableEventReader(transport, log, () => this.program());
  }

  // ── The floor ───────────────────────────────────────────────────────────────

  async reachable(): Promise<boolean> {
    return (await this.poll()).ok;
  }

  async snapshot(): Promise<MuxSnapshot> {
    const outcome = await this.poll();
    if (!outcome.ok) throw new Error(outcome.detail);
    return outcome.value;
  }

  /**
   * Look now: wait out what is left of the 250 ms floor, then read the snapshot again. After it
   * resolves, the next `snapshot()` is that fresh read. It never throws: a program that does not
   * answer is one stale interval, and `reachable()` already says so.
   */
  async refresh(): Promise<void> {
    if (this.inflight !== null) await this.inflight;
    const wait = this.gapLeft();
    if (wait > 0) await this.clock.sleep(wait);
    await this.poll();
  }

  /**
   * One read of the program, as an outcome. At most one read runs at a time, and a second call
   * inside the 250 ms floor answers the first read again instead of asking the program (a failed read
   * counts: a program that is down is asked once per interval, not once per caller).
   */
  poll(): Promise<MuxOutcome<MuxSnapshot>> {
    if (this.inflight !== null) return this.inflight;
    if (this.last !== null && this.gapLeft() > 0) return Promise.resolve(this.last.outcome);
    const run = this.read().finally(() => {
      this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  /** The program and its clean layout, while it is reachable. Later specs read asks, turns and starters here. */
  program(): DurableProgram | null {
    if (this.current === null || this.kept === null) return null;
    return { session: this.current, snapshot: this.kept.snapshot };
  }

  /**
   * The last layout read, even while the program is restarting or down. A new epoch keeps this
   * until the new snapshot is read (WIRE.md section 8.7), so the pane log can still ask the new
   * program about a pane with the old epoch and its old cursor.
   */
  held(): DurableSnapshot | null {
    return this.kept?.snapshot ?? null;
  }

  /**
   * Read the events of every pane whose `rev` moved, into the pane log. Resolves with the panes whose
   * log gained rows, and never rejects: a program that cannot be asked ends the pass, and the next
   * snapshot read says why. The watch calls it after a census and does not wait for it.
   */
  syncEvents(): Promise<readonly string[]> {
    if (this.events === null) return Promise.resolve([]);
    return this.events.sync().catch(() => []);
  }

  /**
   * What the program offers to start. A program that is unreachable, not ready, or has no `starters`
   * cap lists none: the answer is empty, not an error, because a row that cannot start is not shown.
   */
  async listStarters(): Promise<MuxStarters> {
    const outcome = await this.poll();
    const program = outcome.ok ? this.program() : null;
    if (program === null) return { hostName: "", starters: [], reachable: false };
    if (!program.session.caps.starters) return { hostName: program.session.hostName, starters: [], reachable: true };
    return { hostName: program.session.hostName, starters: program.snapshot.starters, reachable: true };
  }

  /**
   * Run one starter with the phone's request id (WIRE.md section 7.7). The id goes through unchanged,
   * so a repeat is the program's own `replayed` answer. The adapter never retries a POST: a timeout, a
   * dropped connection or a 5xx is `unknown`, and the caller keeps its receipt so "Try again" sends
   * the same id.
   */
  async startStarter(starterId: string, requestId: string): Promise<MuxStarterOutcome> {
    if (!isWireId(starterId) || !isWireId(requestId)) return { kind: "refused", detail: "the starter or request id is not a valid id" };
    const read = await this.poll();
    const session = this.current;
    if (!read.ok || session === null) return { kind: "unreachable", detail: read.ok ? STARTING : read.detail };
    if (!session.caps.starters) return { kind: "unsupported", detail: "this program starts nothing from here" };

    let reply: DurableReply;
    try {
      reply = await this.transport.post({
        path: `/starter/${encodeURIComponent(starterId)}`,
        version: session.version,
        body: JSON.stringify({ requestId }),
        timeoutMs: STARTER_TIMEOUT_MS,
        maxBytes: REPLY_CAPS.post,
      });
    } catch (err) {
      // After any failed connect the next read starts with `hello` again (WIRE.md section 8.8).
      this.current = null;
      const detail = err instanceof Error ? err.message : String(err);
      return err instanceof DurableUnreachable && !err.sent ? { kind: "unreachable", detail } : { kind: "unknown", detail };
    }
    return this.starterOutcome(reply);
  }

  private async starterOutcome(reply: DurableReply): Promise<MuxStarterOutcome> {
    if (reply.status === 200) {
      const parsed = parseStarterReply(reply.text);
      // The program ran it and said something unreadable: it may have started, so the id stays good.
      if (!parsed.ok) return { kind: "unknown", detail: `unreadable starter reply: ${parsed.detail}` };
      // The pane is in the next snapshot (WIRE.md section 7.7). Look now, so the census has it.
      this.last = null;
      await this.poll();
      return { kind: "started", paneId: parsed.value.paneId, replayed: parsed.value.replayed };
    }
    const problem = parseProblem(reply.text);
    if (reply.status === 422) return { kind: "failed", message: problem.message === "" ? "the starter failed" : problem.message };
    if (reply.status === 503) {
      // Not ready, so nothing ran. Ask `hello` again on the next read.
      this.current = null;
      return { kind: "unreachable", detail: STARTING };
    }
    if (reply.status === 401) {
      this.current = null;
      return { kind: "unreachable", detail: "incompatible: program asks for a token" };
    }
    if (reply.status === 409 && problem.code === "incompatible") {
      this.agreedVersion = null;
      this.current = null;
      return { kind: "unreachable", detail: incompatibleDetail(problem.range) };
    }
    if (reply.status === 409 && problem.code === "not-supported") return { kind: "unsupported", detail: "the program cannot start this" };
    if (reply.status >= 400 && reply.status < 500) {
      return { kind: "refused", detail: `program answered ${String(reply.status)} ${problem.code}`.trim() };
    }
    return { kind: "unknown", detail: `program answered ${String(reply.status)}` };
  }

  private gapLeft(): number {
    if (this.last === null) return 0;
    return Math.max(0, this.last.at + MIN_SNAPSHOT_GAP_MS - this.clock.now());
  }

  private async read(): Promise<MuxOutcome<MuxSnapshot>> {
    const at = this.clock.now();
    const outcome = await this.readOnce();
    this.last = { at, outcome };
    return outcome;
  }

  private async readOnce(): Promise<MuxOutcome<MuxSnapshot>> {
    try {
      if (this.current === null) {
        const greeted = await this.greet();
        if (!greeted.ok) return greeted;
      }
      return await this.readSnapshot();
    } catch (err) {
      // After any failed connect the next read starts with `hello` again (WIRE.md section 8.8).
      this.current = null;
      if (err instanceof DurableUnreachable) return muxUnreachable(err.detail);
      return muxUnreachable(err instanceof Error ? err.message : String(err));
    }
  }

  // ── hello ───────────────────────────────────────────────────────────────────

  /** Ask `hello`, agree a version, and check `ready`. The first call carries no version header. */
  private async greet(): Promise<MuxOutcome<DurableSession>> {
    const reply = await this.transport.get({
      path: "/hello",
      version: this.agreedVersion,
      ifNoneMatch: null,
      timeoutMs: READ_TIMEOUT_MS,
      maxBytes: REPLY_CAPS.hello,
    });
    const refused = this.refusalFor(reply);
    if (refused !== null) return refused;

    const parsed = parseHello(reply.text);
    if (!parsed.ok) return muxUnreachable(`unreadable hello: ${parsed.detail}`);
    const hello = parsed.value;
    const version = negotiateVersion(hello.protocol);
    if (version === null) {
      // No overlap: nothing else is called, and the census is never shown as empty.
      this.agreedVersion = null;
      this.current = null;
      return muxUnreachable(incompatibleDetail(hello.protocol));
    }
    this.agreedVersion = version;
    if (!hello.ready) {
      this.current = null;
      return muxUnreachable(STARTING);
    }
    const session: DurableSession = { version, epoch: hello.epoch, hostName: hello.hostName, caps: hello.caps };
    this.current = session;
    return muxOk(session);
  }

  // ── snapshot ────────────────────────────────────────────────────────────────

  private async readSnapshot(): Promise<MuxOutcome<MuxSnapshot>> {
    const session = this.current;
    if (session === null) return muxUnreachable(STARTING);

    const reply = await this.transport.get({
      path: "/snapshot",
      version: session.version,
      ifNoneMatch: this.kept?.etag ?? null,
      timeoutMs: READ_TIMEOUT_MS,
      maxBytes: REPLY_CAPS.snapshot,
    });
    if (reply.status === 304) {
      // Nothing moved since the held read. A 304 with nothing held cannot be answered from memory.
      if (this.kept === null) return muxUnreachable("unreadable snapshot: 304 with nothing held");
      return muxOk(this.kept.mux);
    }
    const refused = this.refusalFor(reply);
    if (refused !== null) return refused;

    const parsed = parseSnapshot(reply.text, session.caps.starters);
    if (!parsed.ok) return muxUnreachable(`unreadable snapshot: ${parsed.detail}`);
    let snapshot = parsed.value;

    if (snapshot.epoch !== session.epoch) {
      // The program restarted between `hello` and `snapshot`. This snapshot is the new epoch's own
      // view, so it replaces the held one. `hello` again gives the new epoch's caps (WIRE.md 8.7).
      this.current = null;
      const greeted = await this.greet();
      if (!greeted.ok) return greeted;
      const again = parseSnapshot(reply.text, greeted.value.caps.starters);
      if (!again.ok) return muxUnreachable(`unreadable snapshot: ${again.detail}`);
      snapshot = again.value;
    }
    this.kept = { snapshot, mux: toMuxSnapshot(snapshot), etag: reply.etag };
    return muxOk(this.kept.mux);
  }

  /** What a reply other than 200 means, as a refusal. Null for a 200. */
  private refusalFor(reply: DurableReply): MuxRefusalOutcome | null {
    if (reply.status === 200) return null;
    if (reply.status === 401) {
      // This wire has no token. A program that asks for one speaks another protocol.
      this.current = null;
      return muxUnreachable("incompatible: program asks for a token");
    }
    if (reply.status === 409) {
      const problem = parseProblem(reply.text);
      if (problem.code === "incompatible") {
        // Never retried at this version. The next read says `hello` without one.
        this.agreedVersion = null;
        this.current = null;
        return muxUnreachable(incompatibleDetail(problem.range));
      }
      return muxUnreachable(`program answered 409 ${problem.code}`);
    }
    if (reply.status === 503) {
      // Not ready: ask `hello` again on the next read.
      this.current = null;
      return muxUnreachable(STARTING);
    }
    return muxUnreachable(`program answered ${String(reply.status)}`);
  }

  // ── What a screenless program cannot do ─────────────────────────────────────

  async readGrid(_paneId: string, _request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> {
    return muxUnsupported("paneGrid", NO_SCREEN);
  }

  async typeText(_paneId: string, _text: string): Promise<MuxAck> {
    return muxUnsupported("typeText", NO_KEYS);
  }

  async sendKeys(_paneId: string, _keys: readonly string[]): Promise<MuxAck> {
    return muxUnsupported("sendKeys", NO_KEYS);
  }

  async renamePane(_paneId: string, _label: string | null): Promise<MuxAck> {
    return muxUnsupported("renamePane", NO_STRUCTURE);
  }

  async closePane(_paneId: string): Promise<MuxAck> {
    return muxUnsupported("closePane", NO_STRUCTURE);
  }

  async setFocus(_paneId: string): Promise<MuxAck> {
    return muxUnsupported("setFocus", "There is no terminal to show a conversation in.");
  }

  async createTab(_request: MuxTabRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    return muxUnsupported("createTab", NO_STRUCTURE);
  }

  async renameTab(_tabId: string, _label: string): Promise<MuxAck> {
    return muxUnsupported("renameTab", NO_STRUCTURE);
  }

  async closeTab(_tabId: string): Promise<MuxAck> {
    return muxUnsupported("closeTab", NO_STRUCTURE);
  }

  async createSpace(_request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    return muxUnsupported("createSpace", NO_STRUCTURE);
  }

  async listWorktrees(_scope: MuxWorktreeScope): Promise<MuxOutcome<readonly MuxWorktree[]>> {
    return muxUnsupported("listWorktrees", "A durable program keeps no git worktrees.");
  }

  async createWorktree(_request: MuxWorktreeCreateRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    return muxUnsupported("createWorktree", "A durable program keeps no git worktrees.");
  }

  async openWorktree(_request: MuxWorktreeOpenRequest): Promise<MuxOutcome<MuxWorktreeOpened>> {
    return muxUnsupported("openWorktree", "A durable program keeps no git worktrees.");
  }

  async listSessions(): Promise<MuxOutcome<readonly MuxSession[]>> {
    return muxUnsupported("listSessions", "One peer drives one durable program.");
  }

  watch(options: MuxWatchOptions): MuxSubscription {
    return new DurableWatch(this, options);
  }
}

/** The socket path named by the environment, or the line that says what is wrong with it. */
function describeSocket(configured: string | undefined): string {
  const resolved = resolveSocketPath(configured);
  return resolved.ok ? `socket ${resolved.path}` : resolved.detail;
}

/**
 * The durable adapter's entry in the mux registry.
 *
 * The socket path is `COLLIE_DURABLE_SOCKET`, read from the process environment when the adapter is
 * built. An unset, relative or over-long path does not stop the bridge: the adapter reports
 * `unreachable` with a detail that names the variable, on every read.
 */
export const durableMuxFactory: MuxAdapterFactory = {
  mux: DURABLE_MUX,
  create(target: MuxTarget) {
    const configured = target.options[DURABLE_SOCKET_OPTION] ?? process.env[DURABLE_SOCKET_ENV];
    const logDir = target.options[DURABLE_LOG_DIR_OPTION] ?? "";
    return new DurableMux(
      new DurableSocketClient(configured),
      SYSTEM_CLOCK,
      logDir === "" ? null : new DurableLogs(logDir),
    );
  },
  describeTarget(_endpoint: string) {
    return describeSocket(process.env[DURABLE_SOCKET_ENV]);
  },
};
