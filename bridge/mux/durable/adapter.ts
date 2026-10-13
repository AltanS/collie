// A DURABLE PROGRAM, BEHIND THE CONTRACT: a mux with no screen (ADR 0099, WIRE.md).
//
// The program owns its conversations and listens on a private Unix socket, or behind TLS with a
// bearer token (ADR 0103; transport.ts picks which). This adapter dials it,
// polls it, and maps what it reads onto the port: the program's workspaces become spaces, its tabs
// become tabs, and each conversation becomes a pane. There is no pty and no terminal, so every verb
// that needs a screen, a key press or a new shell answers the contract's `unsupported`.
//
// WHAT IS HERE: the hello and ready and epoch rules (WIRE.md sections 2 and 8), the snapshot with
// its ETag and 304 (section 7.1), the 250 ms floor between two snapshot reads, the mapping, and the
// events reader that fills the bridge's pane log (`syncEvents()`, events.ts, bridge/durable/log.ts).
// STARTERS (ADR 0102): `listStarters()` and `startStarter()`, the program's named ways to begin a
// conversation, run with the phone's request id passed through unchanged.
// ASKS: the open ones per pane (`openAsks`) and the one POST that answers one (`answerAsk`, WIRE.md
// section 7.3, ADR 0100).
// CONTROLS (ADR 0101): the newest turn per pane (`paneTurn`), and the one POST that sends text to it or
// stops it (`controlTurn`, WIRE.md section 7.4), after the name the phone sent is checked against the
// latest listing (`namesCurrent`, bridge/durable/control.ts). A stale name never reaches the socket.
//
// A PERSON'S TAP ONLY. `answerAsk` and `controlTurn` each have one caller, a route that runs for a
// tap and has written its receipt first. Nothing in this class calls them: not a poll, not a restart,
// not a timeout. A POST whose fate is unknown is reported as unknown and never sent again from here.
//
// NOT READY IS NOT EMPTY. While the program lays out its panes after a start, or when it speaks no
// version we do, the adapter is `unreachable` with a detail that says why. It never answers an
// empty census for those cases. A program that is up with no panes is a real, empty snapshot.

import { declareCapabilities, type MuxCapabilityDeclaration } from "../capabilities.ts";
import { namesCurrent, type TurnView } from "../../durable/control.ts";
import { DurableLogs } from "../../durable/log.ts";
import type { MuxAdapterFactory, MuxTarget } from "../registry.ts";
import {
  muxGone,
  muxOk,
  muxRefused,
  muxUnreachable,
  muxUnsupported,
  type MuxAck,
  type MuxAnswerResult,
  type MuxAdapter,
  type MuxControlOutcome,
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
import type { AnswerRequest, Ask, ControlRequest } from "../../types.ts";
import { byteLength, CAPS, isWireId, REPLY_CAPS } from "./clean.ts";
import {
  DURABLE_SOCKET_ENV,
  DurableOutcomeUnknown,
  DurableUnreachable,
  SOCKET_NOT_PRIVATE,
  type DurableReply,
  type DurableTransport,
  type DurableTransportKind,
} from "./client.ts";
import { DurableEventReader, type DurableEventSink } from "./events.ts";
import { DURABLE_LOGO_SVG } from "./logo.ts";
import {
  askForWire,
  incompatibleDetail,
  negotiateVersion,
  NOT_A_DURABLE_PROGRAM,
  parseAnswerReply,
  parseControlReply,
  parseHello,
  parseProblem,
  parseSnapshot,
  parseStaleAsk,
  parseStaleControl,
  parseStarterReply,
  toMuxSnapshot,
  type DurableCaps,
  type DurableControlBody,
  type DurablePane,
  type DurableSnapshot,
} from "./protocol.ts";
import { buildDurableTransport, chooseDurableTransport, type DurableEnv } from "./transport.ts";
import { DurableWatch, type PollCadence } from "./watch.ts";

export const DURABLE_MUX = "durable";

/** `MuxTarget.options` key that overrides the socket path. Only tests set it; the bridge reads the variable. */
export const DURABLE_SOCKET_OPTION = "durableSocket";

/** `MuxTarget.options` key that names the folder of the bridge's pane logs. Empty or absent: no log is kept. */
export const DURABLE_LOG_DIR_OPTION = "durableLogDir";

/** The shortest time between two snapshot reads (WIRE.md section 7.1). */
export const MIN_SNAPSHOT_GAP_MS = 250;

/** The budget for `hello` and `snapshot` over the socket (WIRE.md section 7.6). */
export const READ_TIMEOUT_MS = 1000;

/** The budget for a starter (WIRE.md section 7.6). A start may spin up a whole conversation. */
export const STARTER_TIMEOUT_MS = 30_000;

/**
 * The budget for `answer`, `send` and `abort` over the socket (WIRE.md section 7.6). Under the crew's
 * 5 second budget for a forwarded write, so a lead hears this peer's own "unknown" instead of timing
 * out on its own.
 */
export const WRITE_TIMEOUT_MS = 3000;

/** How hard the adapter asks one transport: its poll cadence, its read and write budgets, its down-gap. */
export interface DurableBudget {
  /** The watch's census while a phone is plainly reading this collie. */
  readonly watchedPollMs: number;
  /** The census otherwise: the slowest the watch polls, and the adapter's `topologyLatency` ceiling. */
  readonly idlePollMs: number;
  /** `hello`, `snapshot` and `events`. */
  readonly readTimeoutMs: number;
  /** `answer`, `send` and `abort`. A starter keeps {@link STARTER_TIMEOUT_MS} on both transports. */
  readonly writeTimeoutMs: number;
  /**
   * The least time between two reads while the program is not answering (the last read ended
   * `unreachable`). Every caller inside it gets that answer again, so a program that is down, or
   * that refuses the token, is asked once per this gap, however fast the bridge polls.
   */
  readonly downGapMs: number;
}

/**
 * THE TWO CADENCES, ONE TABLE (ADR 0103). Each row is what one poll COSTS on that transport.
 *
 * socket: a poll is a local request on a Unix socket and costs the program next to nothing. The
 *   watch runs every 1 s while a phone watches and every 3 s otherwise, a read gets 1000 ms and a
 *   write 3000 ms (under the crew's 5000 ms forwarded-write budget), and a down program is asked
 *   again after the 250 ms floor.
 *
 * https: EVERY POLL IS A BILLED REQUEST. On Cloudflare one poll is one Worker request and one Durable
 *   Object request, and a 304 is billed like a 200. At the socket's 1 s that is about 86,400 Durable
 *   Object requests a day, 86% of the Free plan's 100,000, and about 2.6 million a month, past the
 *   Paid plan's 1 million. So the watch runs every 2 s while a phone watches and every 10 s
 *   otherwise, and THE WATCH IS THE ONLY DIALER: the bridge's own 12 s safety-net poll is served the
 *   watch's last good read (`poll()`), so an idle peer reads once per 10 s in total, 8,640 Durable
 *   Object requests a day. Only the watch (`census()`) and `refresh()`, a person's look, start a read.
 *   Reads and writes get 5000 ms, because a Durable Object that slept wakes cold and the request
 *   crosses the internet. A program that is down, or refuses the token, is asked once per 10 s, never
 *   at the bridge's 1.5 s fast poll: refused requests are billed too, and a storm of them can spend a
 *   Free day.
 *
 * The loopback `http://` of `wrangler dev` takes the https row: it stands in for the deployed program.
 */
export const DURABLE_BUDGETS = {
  socket: { watchedPollMs: 1000, idlePollMs: 3000, readTimeoutMs: READ_TIMEOUT_MS, writeTimeoutMs: WRITE_TIMEOUT_MS, downGapMs: MIN_SNAPSHOT_GAP_MS },
  https: { watchedPollMs: 2000, idlePollMs: 10_000, readTimeoutMs: 5000, writeTimeoutMs: 5000, downGapMs: 10_000 },
} satisfies Readonly<Record<DurableTransportKind, DurableBudget>>;

/**
 * How many transport failures in a row it takes to call the program unreachable. One dropped read
 * keeps the last good layout for one interval; the second in a row flips the peer (WIRE.md 8.8).
 */
export const FAILURES_TO_UNREACHABLE = 2;

/** The longest note an answer may carry, in bytes (WIRE.md section 6). */
export const NOTE_MAX_BYTES = 2048;

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
  /** The session that read it: what `program()` answers with while the layout is held over a dropped read. */
  readonly session: DurableSession;
  readonly snapshot: DurableSnapshot;
  readonly mux: MuxSnapshot;
  readonly etag: string | null;
}

interface Reading {
  /** When the read began: the 250 ms floor and the down-gap count from here. */
  readonly at: number;
  /** When it ended: over HTTPS, the age `poll()` serves it to counts from here. */
  readonly endedAt: number;
  readonly outcome: MuxOutcome<MuxSnapshot>;
}

const NO_SCREEN = "A durable conversation has no terminal screen.";
const GONE = "The conversation is not in the program's layout.";

/** What is current on a pane, for the control guard: its newest turn and its open asks. */
function turnView(pane: DurablePane): TurnView {
  return { turnId: pane.turnId, askIds: pane.openAsks.map((ask) => ask.id) };
}

/** Why the program cannot take this control, from its caps (WIRE.md section 7.4), or null when it can. */
function controlUnsupported(caps: DurableCaps, request: ControlRequest): string | null {
  if (request.act === "abort") return caps.abort ? null : "This program cannot stop a turn from here.";
  if (!caps.send) return "This program takes no text from here.";
  if (request.steer && !caps.steer) return "This program cannot steer a running turn.";
  return null;
}
const NO_KEYS = "A durable conversation takes no typed keys.";
const NO_STRUCTURE = "A durable program lays out its own workspaces, tabs and conversations.";

/**
 * `agentDetection` and `agentSessionRef` are declared: a durable program reports how each
 * conversation is doing, every pane names the agent `durable`, and every pane names its conversation
 * id as the session, which keys the bridge's pane log for the journal. Everything that needs a
 * screen, a key or a new shell is absent, and the program pushes nothing, so both push capabilities
 * are absent too. `idlePollMs` is the transport's slowest census: a change the program did not
 * announce is seen within it.
 */
function durableCapabilities(idlePollMs: number): MuxCapabilityDeclaration {
  return declareCapabilities({
    supports: ["agentDetection", "agentSessionRef"],
    spaces: "many",
    topologyLatency: { kind: "bounded", ms: idlePollMs },
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
}

export class DurableMux implements MuxAdapter {
  readonly mux = DURABLE_MUX;
  readonly logo = DURABLE_LOGO_SVG;

  /** What this adapter declares; its `topologyLatency` is its transport's slowest census. */
  readonly capabilities: MuxCapabilityDeclaration;

  /** The cadence and budgets of this adapter's transport, one row of {@link DURABLE_BUDGETS}. */
  readonly budget: DurableBudget;

  /** The version `hello` agreed. It rides every later call, `hello` included. Null until agreed. */
  private agreedVersion: number | null = null;
  private current: DurableSession | null = null;
  private kept: Held | null = null;
  /** True while the last read was a dropped one whose layout is held for this interval (WIRE.md section 8.8). */
  private holding = false;
  private last: Reading | null = null;
  private inflight: Promise<MuxOutcome<MuxSnapshot>> | null = null;
  /** Transport failures in a row: a connect, a timeout or a cut reply. A real answer resets it. */
  private failures = 0;
  private readonly events: DurableEventReader | null;
  /** Over HTTPS every read is billed, so only the watch and `refresh()` start one (see `poll()`). */
  private readonly watchDials: boolean;
  /** The delay the watch armed with its last census: how old a good read `poll()` may serve over HTTPS. */
  private watchCadenceMs: number;

  /**
   * `log` is where a pane's events go. Without one the adapter reads the layout only, which is what a
   * test of the layout wants; the bridge always gives it the pane log.
   */
  constructor(
    private readonly transport: DurableTransport,
    private readonly clock: DurableClock = SYSTEM_CLOCK,
    log: DurableEventSink | null = null,
  ) {
    this.budget = DURABLE_BUDGETS[transport.kind ?? "socket"];
    this.watchDials = transport.kind === "https";
    this.watchCadenceMs = this.budget.idlePollMs;
    this.capabilities = durableCapabilities(this.budget.idlePollMs);
    this.events = log === null ? null : new DurableEventReader(transport, log, () => this.program(), this.budget.readTimeoutMs);
  }

  /** The watch's two cadences, from this transport's row of {@link DURABLE_BUDGETS}. */
  pollCadence(): PollCadence {
    return { watchedMs: this.budget.watchedPollMs, idleMs: this.budget.idlePollMs };
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
   * Look now: wait out what is left of the 250 ms floor, then read the snapshot again, even inside a
   * down-gap. After it resolves, the next `snapshot()` is that fresh read. It never throws: a program that does not
   * answer is one stale interval, and `reachable()` already says so.
   */
  async refresh(): Promise<void> {
    if (this.inflight !== null) await this.inflight;
    const wait = this.gapLeft();
    if (wait > 0) await this.clock.sleep(wait);
    // A look someone asked for: it passes the down-gap, never the floor or a read in flight.
    await (this.inflight ?? this.start());
  }

  /**
   * One read of the program, as an outcome: what `snapshot()`, `reachable()` and the bridge's own poll
   * ask for.
   *
   * Over the socket it is {@link census} without the cadence. OVER HTTPS THE WATCH IS THE ONLY DIALER:
   * a good read younger than the watch's cadence (2 s watched, 10 s idle, counted from the end of the
   * read) is served again, so the bridge's 12 s safety-net poll adds no billed request between two
   * census reads. Past that age, or after a read that failed, it reads as `census` does.
   */
  poll(): Promise<MuxOutcome<MuxSnapshot>> {
    if (this.inflight !== null) return this.inflight;
    const last = this.last;
    if (this.watchDials && last !== null && last.outcome.ok && this.clock.now() - last.endedAt < this.watchCadenceMs) {
      return Promise.resolve(last.outcome);
    }
    return this.throttled();
  }

  /**
   * The watch's own read (watch.ts). `cadenceMs` is the delay the watch arms after it, which over HTTPS is
   * how long `poll()` serves this read to everyone else.
   */
  census(cadenceMs: number): Promise<MuxOutcome<MuxSnapshot>> {
    this.watchCadenceMs = cadenceMs;
    return this.throttled();
  }

  /**
   * One read of the program, as an outcome. At most one read runs at a time, and a second call
   * inside the 250 ms floor answers the first read again instead of asking the program (a failed read
   * counts: a program that is down is asked once per interval, not once per caller). After a read
   * that ended `unreachable` the floor is the transport's down-gap instead, which is the same 250 ms
   * on the socket and 10 s over HTTPS, where every refused request is billed.
   */
  private throttled(): Promise<MuxOutcome<MuxSnapshot>> {
    if (this.inflight !== null) return this.inflight;
    if (this.last !== null && this.gapLeft(this.last.outcome.ok ? MIN_SNAPSHOT_GAP_MS : this.budget.downGapMs) > 0) {
      return Promise.resolve(this.last.outcome);
    }
    return this.start();
  }

  /** Begin one read and hold it as the one in flight. */
  private start(): Promise<MuxOutcome<MuxSnapshot>> {
    const run = this.read().finally(() => {
      this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  /**
   * The program and its clean layout, while it is reachable. Later specs read asks, turns and starters
   * here. While one dropped read is held (WIRE.md section 8.8) the answer is the last good read's, so
   * the layout and its open asks hold together and the blip does not show.
   */
  program(): DurableProgram | null {
    if (this.kept === null) return null;
    const session = this.current ?? (this.holding ? this.kept.session : null);
    return session === null ? null : { session, snapshot: this.kept.snapshot };
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
        body: { requestId },
        timeoutMs: STARTER_TIMEOUT_MS,
        maxBytes: REPLY_CAPS.post,
      });
    } catch (err) {
      // A POST that may have left is `unknown` and keeps its receipt, so "Try again" sends the same id.
      if (err instanceof DurableOutcomeUnknown) return { kind: "unknown", detail: err.detail };
      // After any failed connect the next read starts with `hello` again (WIRE.md section 8.8).
      this.current = null;
      const detail = err instanceof Error ? err.message : String(err);
      return err instanceof DurableUnreachable ? { kind: "unreachable", detail } : { kind: "unknown", detail };
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

  // ── Asks (ADR 0100, WIRE.md section 7.3) ───────────────────────────────────

  /**
   * The open asks of one pane, from the last layout read, oldest first. `undefined` when the program
   * does not raise asks (`caps.asks` false) or the pane is not in the layout, so the pane then carries
   * no `asks` field at all. Asks nothing of the program: it is called at serialise time.
   */
  openAsks(paneId: string): readonly Ask[] | undefined {
    const program = this.program();
    if (program === null || !program.session.caps.asks) return undefined;
    const pane = program.snapshot.panes.find((candidate) => candidate.id === paneId);
    return pane === undefined ? undefined : pane.openAsks.map(askForWire);
  }

  /**
   * Answer one ask (WIRE.md section 7.3). ONE POST, never retried here. The answer route calls this
   * after it has written its receipt, and only for a person's tap.
   */
  async answerAsk(paneId: string, answer: AnswerRequest): Promise<MuxOutcome<MuxAnswerResult>> {
    // The id rule, checked before anything leaves, so the program never sees a `bad-id` from us.
    for (const id of [paneId, answer.requestId, answer.askId, answer.optionId]) {
      if (!isWireId(id)) return muxRefused("An id in the answer breaks the id rule.");
    }
    if (!Number.isSafeInteger(answer.revision) || answer.revision < 1) return muxRefused("The revision is not a whole number from 1.");
    if (answer.note !== undefined && byteLength(answer.note) > NOTE_MAX_BYTES) {
      return muxRefused(`The note is longer than ${String(NOTE_MAX_BYTES)} bytes.`);
    }
    const session = this.current;
    if (session === null) return muxUnreachable(STARTING);
    if (!session.caps.asks) return muxRefused("This program takes no answers.");

    const body = {
      requestId: answer.requestId,
      askId: answer.askId,
      revision: answer.revision,
      answer: answer.note === undefined ? { optionId: answer.optionId } : { optionId: answer.optionId, note: answer.note },
    };
    let reply: DurableReply;
    try {
      reply = await this.transport.post({
        path: `/pane/${encodeURIComponent(paneId)}/answer`,
        version: session.version,
        body,
        timeoutMs: this.budget.writeTimeoutMs,
        maxBytes: REPLY_CAPS.post,
      });
    } catch (err) {
      if (err instanceof DurableOutcomeUnknown) return muxOk({ kind: "unknown", detail: err.detail });
      // Nothing was sent. The next read starts with `hello` again (WIRE.md section 8.8).
      this.current = null;
      if (err instanceof DurableUnreachable) return muxUnreachable(err.detail);
      return muxUnreachable(err instanceof Error ? err.message : String(err));
    }
    return this.answerOutcome(reply);
  }

  /** What one reply to an answer means (WIRE.md sections 3 and 7.3). */
  private answerOutcome(reply: DurableReply): MuxOutcome<MuxAnswerResult> {
    if (reply.status === 200) {
      const parsed = parseAnswerReply(reply.text);
      // A 200 the adapter cannot read may have closed the ask. Its outcome is unknown.
      if (parsed === null) return muxOk({ kind: "unknown", detail: "unreadable answer reply" });
      return muxOk({ kind: parsed.result, replayed: parsed.replayed });
    }
    if (reply.status >= 500 && reply.status !== 503) {
      return muxOk({ kind: "unknown", detail: `program answered ${String(reply.status)}` });
    }
    const problem = parseProblem(reply.text);
    if (reply.status === 409 && problem.code === "stale") {
      const ask = parseStaleAsk(reply.text);
      return muxOk({ kind: "stale", ask: ask === null ? null : askForWire(ask) });
    }
    if (reply.status === 404 && problem.code === "no-such-pane") return muxGone("The conversation is not in the program's layout.");
    // Version, token and ready refusals: nothing ran, and the next read asks `hello` again.
    if (reply.status === 401 || reply.status === 503 || (reply.status === 409 && problem.code === "incompatible")) {
      return this.refusalFor(reply) ?? muxUnreachable(`program answered ${String(reply.status)}`);
    }
    return muxRefused(`program answered ${String(reply.status)} ${problem.code}`.trim());
  }

  // ── Controls (ADR 0101, WIRE.md section 7.4) ───────────────────────────────

  /**
   * The newest turn of one pane, from the last layout read. `undefined` when the pane is not in the
   * layout or the program is not reachable, so the pane then carries no `turnId` field. Asks nothing
   * of the program: it is called at serialise time.
   */
  paneTurn(paneId: string): string | undefined {
    return this.program()?.snapshot.panes.find((pane) => pane.id === paneId)?.turnId;
  }

  /**
   * Send text to, or stop, the turn the phone named. The route calls this after it has written its
   * receipt, and only for a person's tap.
   *
   * In order: the id rule and the text cap (nothing leaves that the program would answer 400); a
   * fresh read of the layout, inside the 250 ms floor; the program's caps (`unsupported`); the pane
   * (`gone`); then the name against the layout (`stale`, WIRE.md section 7.4). Only a current name
   * reaches the socket, as ONE POST, never retried here.
   */
  async controlTurn(paneId: string, request: ControlRequest): Promise<MuxControlOutcome> {
    for (const id of [paneId, request.requestId, request.target.id]) {
      if (!isWireId(id)) return { kind: "refused", detail: "An id in the request breaks the id rule." };
    }
    if (request.act === "send" && (request.text === "" || byteLength(request.text) > CAPS.sendText)) {
      return { kind: "refused", detail: `The text must be 1 to ${String(CAPS.sendText)} bytes.` };
    }
    const read = await this.poll();
    const program = read.ok ? this.program() : null;
    if (program === null) return { kind: "unreachable", detail: read.ok ? STARTING : read.detail };
    const unsupported = controlUnsupported(program.session.caps, request);
    if (unsupported !== null) return { kind: "unsupported", detail: unsupported };
    const pane = program.snapshot.panes.find((candidate) => candidate.id === paneId);
    if (pane === undefined) return { kind: "gone", detail: GONE };
    const view = turnView(pane);
    if (!namesCurrent(request.target, view)) return { kind: "stale", ...view };

    const body: DurableControlBody = { requestId: request.requestId };
    if (request.act === "send") {
      body.text = request.text;
      if (request.steer) body.steer = true;
    }
    if (request.target.kind === "turn") body.turnId = request.target.id;
    else body.askId = request.target.id;
    let reply: DurableReply;
    try {
      reply = await this.transport.post({
        path: `/pane/${encodeURIComponent(paneId)}/${request.act}`,
        version: program.session.version,
        body,
        timeoutMs: this.budget.writeTimeoutMs,
        maxBytes: REPLY_CAPS.post,
      });
    } catch (err) {
      if (err instanceof DurableOutcomeUnknown) return { kind: "unknown", detail: err.detail };
      // Nothing was sent. The next read starts with `hello` again (WIRE.md section 8.8).
      this.current = null;
      return { kind: "unreachable", detail: err instanceof Error ? err.message : String(err) };
    }
    return this.controlOutcome(paneId, reply);
  }

  /** What one reply to a send or abort means (WIRE.md sections 3 and 7.4). */
  private async controlOutcome(paneId: string, reply: DurableReply): Promise<MuxControlOutcome> {
    if (reply.status === 200) {
      const parsed = parseControlReply(reply.text);
      // A 200 the adapter cannot read may have acted. Its outcome is unknown.
      if (parsed === null) return { kind: "unknown", detail: "unreadable control reply" };
      return { kind: "ok", replayed: parsed.replayed };
    }
    if (reply.status >= 500 && reply.status !== 503) return { kind: "unknown", detail: `program answered ${String(reply.status)}` };
    const problem = parseProblem(reply.text);
    if (reply.status === 409 && problem.code === "stale") {
      const stale = parseStaleControl(reply.text);
      if (stale.turnId !== null) return { kind: "stale", turnId: stale.turnId, askIds: stale.askIds };
      // A stale refusal that names no current turn: read the layout again and take it from there.
      this.last = null;
      await this.poll();
      const pane = this.program()?.snapshot.panes.find((candidate) => candidate.id === paneId);
      return pane === undefined ? { kind: "gone", detail: GONE } : { kind: "stale", ...turnView(pane) };
    }
    if (reply.status === 409 && problem.code === "not-supported") return { kind: "unsupported", detail: "The program cannot take this here." };
    if (reply.status === 404 && problem.code === "no-such-pane") return { kind: "gone", detail: GONE };
    // Version, token and ready refusals: nothing ran, and the next read asks `hello` again.
    if (reply.status === 401 || reply.status === 503 || (reply.status === 409 && problem.code === "incompatible")) {
      const refusal = this.refusalFor(reply);
      return { kind: "unreachable", detail: refusal?.detail ?? `program answered ${String(reply.status)}` };
    }
    return { kind: "refused", detail: `program answered ${String(reply.status)} ${problem.code}`.trim() };
  }

  /** What is left of `gapMs` since the last read began. `refresh()` waits out the 250 ms floor only. */
  private gapLeft(gapMs: number = MIN_SNAPSHOT_GAP_MS): number {
    if (this.last === null) return 0;
    return Math.max(0, this.last.at + gapMs - this.clock.now());
  }

  private async read(): Promise<MuxOutcome<MuxSnapshot>> {
    const at = this.clock.now();
    const outcome = await this.readOnce();
    this.last = { at, endedAt: this.clock.now(), outcome };
    return outcome;
  }

  private async readOnce(): Promise<MuxOutcome<MuxSnapshot>> {
    try {
      if (this.current === null) {
        const greeted = await this.greet();
        if (!greeted.ok) {
          this.failures = 0;
          this.holding = false;
          return greeted;
        }
      }
      const outcome = await this.readSnapshot();
      this.failures = 0;
      this.holding = false;
      return outcome;
    } catch (err) {
      // After any failed connect the next read starts with `hello` again (WIRE.md section 8.8).
      this.current = null;
      this.failures += 1;
      // HYSTERESIS. One failure keeps the last good layout for this interval, so a single dropped
      // read does not flip the peer to unreachable and back. The second failure in a row does. A
      // program that ANSWERS (starting, incompatible) is never held: that is an answer, not a drop.
      // Neither is a socket that failed the privacy check: that is a fault to show now.
      const previous = this.last?.outcome;
      const transient = !(err instanceof DurableUnreachable && err.detail.startsWith(SOCKET_NOT_PRIVATE));
      this.holding = transient && this.failures < FAILURES_TO_UNREACHABLE && previous?.ok === true && this.kept !== null;
      if (this.holding && this.kept !== null) return muxOk(this.kept.mux);
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
      timeoutMs: this.budget.readTimeoutMs,
      maxBytes: REPLY_CAPS.hello,
    });
    const refused = this.refusalFor(reply);
    if (refused !== null) return refused;

    const parsed = parseHello(reply.text);
    // A socket that answers without the service name is some other program: a wrong path, named so.
    if (!parsed.ok && parsed.detail === NOT_A_DURABLE_PROGRAM) {
      this.agreedVersion = null;
      return muxUnreachable(`incompatible: ${NOT_A_DURABLE_PROGRAM}`);
    }
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
      timeoutMs: this.budget.readTimeoutMs,
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
    const kept = this.current ?? session;
    this.kept = { session: kept, snapshot, mux: toMuxSnapshot(snapshot), etag: reply.etag };
    return muxOk(this.kept.mux);
  }

  /** What a reply other than 200 means, as a refusal. Null for a 200. */
  private refusalFor(reply: DurableReply): MuxRefusalOutcome | null {
    if (reply.status === 200) return null;
    if (reply.status === 401) {
      // The socket carries no token, so a program that asks for one there speaks another protocol.
      // Over HTTPS a 401 never reaches here: the client turns it into `token-refused` first.
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

/**
 * The adapter for one environment and the target's options. The transport is chosen in one place
 * (transport.ts): the socket, or the URL with its token. A test's socket option overrides the
 * environment's socket, as it always did.
 */
export function createDurableMux(env: DurableEnv, options: Readonly<Record<string, string | undefined>>): DurableMux {
  const override = options[DURABLE_SOCKET_OPTION];
  const choice = chooseDurableTransport(override === undefined ? env : { [DURABLE_SOCKET_ENV]: override });
  const logDir = options[DURABLE_LOG_DIR_OPTION] ?? "";
  return new DurableMux(buildDurableTransport(choice).transport, SYSTEM_CLOCK, logDir === "" ? null : new DurableLogs(logDir));
}

/** The boot line's half that says which transport this peer uses and where it points. Never the token. */
export function describeDurableTarget(env: DurableEnv): string {
  return buildDurableTransport(chooseDurableTransport(env)).description;
}

/**
 * The durable adapter's entry in the mux registry.
 *
 * The transport comes from `COLLIE_DURABLE_SOCKET`, or from `COLLIE_DURABLE_URL` and
 * `COLLIE_DURABLE_TOKEN`, read from the process environment when the adapter is built. A missing,
 * conflicting or broken setting does not stop the bridge: the boot line names it once, and the
 * adapter reports `unreachable` with the same line on every read.
 */
export const durableMuxFactory: MuxAdapterFactory = {
  mux: DURABLE_MUX,
  create(target: MuxTarget) {
    return createDurableMux(process.env, target.options);
  },
  describeTarget(_endpoint: string) {
    return describeDurableTarget(process.env);
  },
};
