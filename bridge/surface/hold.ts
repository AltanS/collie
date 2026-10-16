// A hook-held permission (M56 spec 12; the contract is in the M56 README, "Ask", and
// experiments/reader-stability/ARCHITECTURE.md section 3). Two parts:
//
//  - `HoldServer`: the bridge-local socket the harness's permission hook connects to
//    (`<stateDir>/hold/sock`, cli/hold.ts). One per bridge. It reads one request line, places it on
//    one pane the way an edge is placed (edges.ts `placeEdge`: the markers, the pid and its start
//    time, the foreground), and hands it to that session. A request it cannot place is dropped with
//    one log line, and the connection closes with no decision.
//  - `HoldBook`: one per session, beside the ask book. It owns the held request's ask
//    (`channel: hook`), its single-use id, and the connection. The ask book asks it first on every
//    read of a pane with a live hold, so the poll, the Send Protocol and the answer route all see the
//    hook ask and never mint a keys ask for the same dialog.
//
// What ends a hold, and what the phone then says (the `HoldNote`):
//  - The person's tap (AskAnswerer): the decision goes to the hook, and the card says Sent until a
//    tool edge or the screen moves on. Nothing else ever becomes a decision.
//  - The desk first: the dialog left the screen (two reads), or a tool edge or a turn edge came while
//    the hook still waits. The hook is released with no decision; the card says "answered at the desk".
//    A user hook that auto-allows reads the same way.
//  - Another Collie first: the hook says so on the socket; the card says "answered elsewhere".
//  - The hook stopped (killed, the harness timed it out, the agent quit): the card is voided.
//  - The limit: the bridge releases the hook; the card is voided.
//  - A hash mismatch: the bridge releases the hook with no decision.
// After any of these the dialog on the screen, if still there, becomes a new keys ask with a new id.
// The old id stays here, so a tap on it is refused and never becomes keys.
//
// No harness name lives here (no-harness-names.test.ts scans this folder). The harness's profile
// names the events, the options and the decision rules (web/src/lib/surface/hold.ts).

import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { once } from "node:events";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { BeaconLiveness } from "../beacon/reader.ts";
import { EDGE_SCHEMA_VERSION, type EdgeRecord } from "../beacon/types.ts";
import type { LiftedDialog } from "../../web/src/lib/surface/lift.ts";
import {
  decisionOf,
  HOLD_LINE_MAX,
  holdAsk,
  isElsewhereLine,
  parseHoldRequest,
  type HoldDecision,
  type HoldNote,
  type HoldProfile,
  type HoldRequest,
  type HoldState,
} from "../../web/src/lib/surface/hold.ts";
import type { EdgeKind } from "../../web/src/lib/surface/edges.ts";
import { shortHash, type Ask } from "../../web/src/lib/surface/surface.ts";
import { sameDialog } from "./ask.ts";
import { placeEdge, type EdgeTarget } from "./edges.ts";

/** How many reads in a row must miss a dialog the screen showed before the desk counts as first. */
export const DESK_READS = 2;
/** How long after the hold opened a screen dialog may still give the ask its labels. */
export const RELABEL_MS = 2000;

/**
 * How long a hold whose hook ended early waits for the screen to say who ended it. Claude Code
 * 2.1.301 ends the hook when the desk answers with Esc or No: the dialog is then gone (desk). A
 * dialog still on the screen means the hook stopped on its own (void). No read in time is void.
 */
export const CLOSE_GRACE_MS = 3000;

/** A dialog read sooner than this after the early close may be the last frame before the desk's repaint. */
export const CLOSE_SETTLE_MS = 600;
/** How long a hold that went to the hook still shields its pane from a keys ask for the closing dialog. */
export const SENT_SHIELD_MS = 2000;
/** How long the phone keeps a closed hold's note (desk, void, timeout). */
export const NOTE_MS = 15_000;
/** How long a "Sent" note waits for a tool edge before it goes on its own. */
export const SENT_NOTE_MS = 30_000;
/** How long the server waits for the request line. */
export const REQUEST_LINE_MS = 1000;
/** How many hold ids the book remembers, newest kept. */
const BOOK_SIZE = 256;
/** The journal tag of a hold line. */
export const HOLD_TAG = "surface.hold";

/** What ended a hold, for the counters and the receipt. `elsewhere` counts as `void`. */
export type HoldOutcome = "phone" | "desk" | "elsewhere" | "void" | "timeout" | "mismatch";

/** The counter word of an outcome (spec 09's counters file): desk, phone, void, timeout, mismatch. */
export function counterWordOf(outcome: HoldOutcome): "phone" | "desk" | "void" | "timeout" | "mismatch" {
  return outcome === "elsewhere" ? "void" : outcome;
}

/** The connection back to the hook. */
export interface HoldConn {
  /** Write the decision and end the connection. False when it is already gone. */
  reply(decision: HoldDecision): boolean;
  /** End the connection with no decision. Safe to call twice. */
  release(): void;
}

type HeldState = "held" | "answering" | "sent" | "ended";

/** One held request. */
export interface Held {
  readonly paneId: string;
  readonly generation: string;
  readonly request: HoldRequest;
  readonly profile: HoldProfile;
  readonly openedAt: number;
  readonly conn: HoldConn;
  /** Every id minted for this hold. The last one is the live ask's. */
  readonly ids: string[];
  ask: Ask | null;
  /** The decision each option stands for, by position. Null: answered only on the screen. */
  decisions: (HoldDecision | null)[];
  /** The screen dialog the ask took its labels from, or null (no dialog: a subagent's request). */
  dialog: LiftedDialog | null;
  missing: number;
  state: HeldState;
  outcome: HoldOutcome | null;
  sentAt: number | null;
  /** The decision that went to the hook, once one did. */
  decision: HoldDecision | null;
  /** True once the hook's connection closed early: the next reads decide desk or void. */
  hookGone: boolean;
  goneAt: number;
  note: HoldNote | null;
  cancelLimit: () => void;
}

export interface HoldBookOptions {
  readonly now?: () => number;
  /** Runs `run` after `ms`; returns a cancel. Defaults to an unref'd timer. */
  readonly schedule?: (run: () => void, ms: number) => () => void;
  readonly salt?: string;
  /** Counts one outcome. Never throws to the book. */
  readonly count?: (held: Held, outcome: HoldOutcome) => void;
  readonly log?: (line: string) => void;
}

const timerSchedule = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/** The note state of a closed hold's outcome. */
function noteStateOf(outcome: HoldOutcome): HoldState {
  return outcome === "phone" ? "sent" : outcome;
}

export class HoldBook {
  private readonly byId = new Map<string, Held>();
  private readonly byPane = new Map<string, Held>();
  private serial = 0;
  private readonly now: () => number;
  private readonly schedule: (run: () => void, ms: number) => () => void;
  private readonly salt: string;
  private readonly log: (line: string) => void;
  /** Set by the ask book that attaches this one: void the pane's live keys ask. */
  voidKeysAsk: (paneId: string) => void = () => {};

  constructor(private readonly options: HoldBookOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? timerSchedule;
    this.salt = options.salt ?? crypto.randomUUID();
    this.log = options.log ?? ((line) => console.log(line));
  }

  /**
   * A placed request opens a hold on its pane. A hold still open there ends as desk first: the
   * harness asks one request at a time per session, so a new one means the old one was answered.
   */
  open(paneId: string, generation: string, request: HoldRequest, conn: HoldConn, profile: HoldProfile): Held {
    const old = this.byPane.get(paneId);
    if (old !== undefined && (old.state === "held" || old.state === "answering")) this.end(old, "desk");
    this.voidKeysAsk(paneId);
    const held: Held = {
      paneId,
      generation,
      request,
      profile,
      openedAt: this.now(),
      conn,
      ids: [],
      ask: null,
      decisions: [],
      dialog: null,
      missing: 0,
      state: "held",
      outcome: null,
      sentAt: null,
      decision: null,
      hookGone: false,
      goneAt: 0,
      note: null,
      cancelLimit: () => {},
    };
    held.cancelLimit = this.schedule(() => {
      if (held.state === "held") this.end(held, "timeout");
    }, profile.limitMs);
    this.byPane.set(paneId, held);
    this.line(held, "open");
    return held;
  }

  /** The hold an ask id belongs to, live or closed, or undefined. */
  byAskId(id: string): Held | undefined {
    return this.byId.get(id);
  }

  /** Whether the pane's reads go through {@link claim}: a hold waits, runs an answer, or just sent one. */
  live(paneId: string): boolean {
    const held = this.byPane.get(paneId);
    if (held === undefined) return false;
    if (held.state === "held" || held.state === "answering") return true;
    return held.state === "sent" && held.sentAt !== null && this.now() - held.sentAt < SENT_SHIELD_MS;
  }

  /** The pane's hold, in any state, or undefined. */
  heldOn(paneId: string): Held | undefined {
    return this.byPane.get(paneId);
  }

  /**
   * One read of a pane with a live hold. Returns the hook ask, or null when the hold ended on this
   * read (the caller then publishes the screen's dialog as a keys ask). Never sends a key.
   */
  claim(paneId: string, generation: string, dialog: LiftedDialog | null): Ask | null {
    const held = this.byPane.get(paneId);
    if (held === undefined || !this.live(paneId)) return null;
    const permission = dialog !== null && dialog.blockKind === "prompt-select" && dialog.kind === "permission" ? dialog : null;
    if (held.ask === null) {
      this.mint(held, generation, permission);
      return held.ask;
    }
    if (held.state !== "held") return held.ask;
    if (held.hookGone) {
      // The hook ended early. A dialog still up: the hook stopped on its own, so the dialog becomes
      // a keys ask. No dialog on two reads: the desk answered, and Claude ended the hook.
      if (permission !== null) {
        if (this.now() - held.goneAt < CLOSE_SETTLE_MS) return held.ask;
        this.end(held, "void");
        return null;
      }
      held.missing += 1;
      if (held.missing < DESK_READS) return held.ask;
      this.end(held, "desk");
      return null;
    }
    if (held.dialog === null) {
      // Labels from the profile so far. A dialog that paints soon after takes over once, so the card on
      // the phone and the ask name the same options. The old id answers `ask_changed`, never a key.
      if (permission !== null && held.request.agent === null && this.now() - held.openedAt < RELABEL_MS) this.mint(held, generation, permission);
      return held.ask;
    }
    if (permission !== null && sameDialog(held.dialog, permission)) {
      held.missing = 0;
      return held.ask;
    }
    held.missing += 1;
    if (held.missing < DESK_READS) return held.ask;
    this.end(held, "desk");
    return null;
  }

  private mint(held: Held, _generation: string, dialog: LiftedDialog | null): void {
    this.serial += 1;
    const id = `ask-${shortHash(`${this.salt}\nhold\n${String(this.serial)}\n${held.paneId}`)}`;
    const labels = dialog === null ? held.profile.options.map((o) => o.label) : [...dialog.labels];
    held.decisions = dialog === null ? held.profile.options.map((o) => o.decision) : labels.map((label) => decisionOf(held.profile.decisions, label));
    held.dialog = dialog;
    held.missing = 0;
    held.ask = holdAsk(id, held.request.tool, held.request.input, labels);
    held.ids.push(id);
    held.note = this.noteOf(held, "held");
    this.byId.set(id, held);
    while (this.byId.size > BOOK_SIZE) {
      const oldest = this.byId.keys().next().value;
      if (oldest === undefined) break;
      this.byId.delete(oldest);
    }
  }

  /** The tap won the race to the hook: write the decision. False when the hook is gone (then voided). */
  decide(held: Held, decision: HoldDecision): boolean {
    if (held.state !== "answering") return false;
    if (!held.conn.reply(decision)) {
      this.end(held, "void");
      return false;
    }
    held.state = "sent";
    held.sentAt = this.now();
    held.decision = decision;
    held.cancelLimit();
    held.note = this.noteOf(held, "sent");
    this.line(held, `sent decision=${decision}`);
    return true;
  }

  /**
   * The evidence after a decision went to the hook: `phone` when the screen or the edges show the
   * hook decided, `desk` when the desk had answered first and the hook's answer was ignored.
   */
  settle(held: Held, outcome: "phone" | "desk"): void {
    if (held.state !== "sent" || held.outcome !== null) return;
    held.outcome = outcome;
    this.count(held, outcome);
    if (outcome === "desk") {
      held.state = "ended";
      held.note = this.noteOf(held, "desk");
    } else if (held.decision === "deny" && held.request.agent === null) {
      // A deny runs no tool, so no tool edge ends the Sent note. The screen already moved on (the
      // hook's line shows), so the note ends here. Found in the lab on Claude Code 2.1.301.
      held.state = "ended";
      held.note = null;
    }
    this.line(held, `settled outcome=${outcome}`);
  }

  /** Close the hold with no decision. Safe to call twice; the first outcome stays. */
  end(held: Held, outcome: Exclude<HoldOutcome, "phone">): void {
    if (held.state === "ended") return;
    const wasSent = held.state === "sent";
    held.state = "ended";
    held.cancelLimit();
    held.conn.release();
    if (wasSent && held.outcome !== null) return;
    held.outcome = outcome;
    held.note = this.noteOf(held, noteStateOf(outcome));
    this.count(held, outcome);
    this.line(held, `ended outcome=${outcome}`);
  }

  /** The hook's side ended: another Collie answered, or the hook stopped. */
  closed(held: Held, how: "closed" | "elsewhere"): void {
    if (held.state !== "held" && held.state !== "answering") return;
    if (how === "elsewhere") return this.end(held, "elsewhere");
    // A close at the limit is the hook's own timer: the same outcome as the bridge's.
    const late = this.now() - held.openedAt >= held.profile.limitMs - 2000;
    if (late) return this.end(held, "timeout");
    // A subagent's request has no dialog for the screen to judge: the hook stopped.
    if (held.request.agent !== null || held.state === "answering") return this.end(held, "void");
    held.hookGone = true;
    held.goneAt = this.now();
    held.missing = 0;
    held.cancelLimit();
    held.cancelLimit = this.schedule(() => {
      if (held.state === "held") this.end(held, "void");
    }, CLOSE_GRACE_MS);
  }

  /**
   * A hook edge on the pane. A tool edge for the held tool means the tool ran: the desk (or another
   * hook) allowed it while the hook waited, or the phone's allow took effect. A turn edge on a main
   * session's request means the dialog is gone. A session edge voids the hold.
   */
  edge(paneId: string, kind: EdgeKind, info: { readonly tool: string | null; readonly agent: string | null }): void {
    const held = this.byPane.get(paneId);
    if (held === undefined) return;
    const matches = info.agent === held.request.agent && (info.tool === null || info.tool === held.request.tool);
    switch (kind) {
      case "tool":
        if (!matches) return;
        if (held.state === "held") return this.end(held, "desk");
        if (held.state === "sent") {
          this.settle(held, "phone");
          held.note = null;
          held.state = "ended";
        }
        return;
      case "start":
      case "end":
        if (held.state === "held" || held.state === "answering") this.end(held, "void");
        if (held.state === "sent" || held.note?.state === "sent") held.note = null;
        return;
      case "prompt":
      case "stop":
        if (held.request.agent !== null) return;
        if (held.state === "held") this.end(held, "desk");
        if (held.note?.state === "sent") held.note = null;
        return;
      case "dialog":
      case "reread":
        return;
    }
  }

  /** The pane's note for the phone, or null when there is nothing to say. */
  note(paneId: string): HoldNote | null {
    const held = this.byPane.get(paneId);
    const note = held?.note ?? null;
    if (held === undefined || note === null) return null;
    const age = this.now() - note.since;
    if (note.state === "held") return held.state === "held" || held.state === "answering" ? note : null;
    if (note.state === "sent") return age < SENT_NOTE_MS ? note : null;
    return age < NOTE_MS ? note : null;
  }

  private noteOf(held: Held, state: HoldState): HoldNote | null {
    const askId = held.ask?.id;
    if (askId === undefined) return null;
    return { askId, state, tool: held.request.tool, input: held.request.input, agent: held.request.agent !== null, since: this.now() };
  }

  private count(held: Held, outcome: HoldOutcome): void {
    try {
      this.options.count?.(held, outcome);
    } catch {
      // A counter is not a verdict.
    }
  }

  private line(held: Held, what: string): void {
    // The tool name, never the input: the input can hold a secret.
    this.log(`[surface] ${HOLD_TAG} ${what} pane=${held.paneId} tool=${held.request.tool} agent=${held.request.agent === null ? "-" : "sub"} ask=${held.ask?.id ?? "-"}`);
  }
}

/** What {@link takeHold} needs of a session. */
export interface TakeHoldDeps {
  readonly book: HoldBook;
  /** The pane generation, or null when the pane holds no agent the bridge knows. */
  generation(paneId: string): string | null;
  /** The harness's hold profile, or undefined when it holds nothing. */
  profile(harness: string): HoldProfile | undefined;
  /** Force a fresh read of the pane soon (a `dialog` edge into its fold). */
  reread(paneId: string): void;
  /** One journal line when a request is released as an edge only. Optional. */
  log?(line: string): void;
}

/**
 * A placed request, taken by its session. Every request forces a fresh read: a dialog is up or about
 * to paint. A screen-only tool (a question, a plan, whose dialog a hook decision cannot answer), a
 * harness that holds nothing, or a pane with no known agent is an edge only: the connection closes
 * with no decision and the dialog stays a keys ask. Else the hold opens. Returns the hold, or null.
 */
export function takeHold(deps: TakeHoldDeps, paneId: string, request: HoldRequest, conn: HoldConn, onClose: (listener: (how: "closed" | "elsewhere") => void) => void): Held | null {
  deps.reread(paneId);
  const profile = deps.profile(request.harness);
  const generation = deps.generation(paneId);
  if (!request.hold || profile === undefined || generation === null || profile.screenOnly.includes(request.tool)) {
    conn.release();
    deps.log?.(`[surface] surface.hold edge-only pane=${paneId} tool=${request.tool} reason=${!request.hold || profile?.screenOnly.includes(request.tool) === true ? "screen-only" : "no-hold"}`);
    return null;
  }
  const held = deps.book.open(paneId, generation, request, conn, profile);
  onClose((how) => {
    deps.book.closed(held, how);
    // An early close is judged by the screen: read it again soon.
    deps.reread(paneId);
  });
  return held;
}

// ── The socket ─────────────────────────────────────────────────────────────────────────────────

/** A session that can take holds: an edge target plus the hand-off. */
export interface HoldTarget extends EdgeTarget {
  /** Take a placed request. `hold: false` requests are edges only; the caller closes them. */
  hold?(paneId: string, request: HoldRequest, conn: HoldConn, onClose: (listener: (how: "closed" | "elsewhere") => void) => void): void;
}

export interface HoldServerDeps {
  readonly socketPath: string;
  readonly liveness: BeaconLiveness;
  targets(): readonly HoldTarget[];
  readonly log?: (line: string) => void;
}

/** The connection as the book sees it, over one socket. */
function connOf(socket: Socket): HoldConn {
  let done = false;
  return {
    reply: (decision) => {
      if (done || socket.destroyed || !socket.writable) return false;
      done = true;
      socket.end(`${JSON.stringify({ decision })}\n`);
      return true;
    },
    release: () => {
      if (done) return;
      done = true;
      socket.end();
    },
  };
}

/**
 * The bridge-local hold socket. Owner-only: the directory is 0700 and the socket file 0600, so no
 * other user can connect. A request is accepted only from a pid the bridge can place on a pane.
 */
export class HoldServer {
  private server: Server | null = null;
  private readonly log: (line: string) => void;
  private readonly logged = new Map<string, number>();

  constructor(private readonly deps: HoldServerDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** Listen. False when another live bridge holds the path, or the path cannot be made safe. */
  async start(): Promise<boolean> {
    const path = this.deps.socketPath;
    const dir = dirname(path);
    // No hold on Windows yet: the socket's owner-only rule is a POSIX file mode. Permissions stay
    // screen asks there, and the hook finds no socket and prints nothing.
    if (process.platform === "win32") {
      this.log(`[surface] ${HOLD_TAG} no socket: holds are not built for Windows yet`);
      return false;
    }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      if (existsSync(path)) {
        if (!lstatSync(path).isSocket()) {
          this.log(`[surface] ${HOLD_TAG} no socket: ${path} exists and is not a socket`);
          return false;
        }
        if (await answers(path)) {
          this.log(`[surface] ${HOLD_TAG} no socket: another bridge listens on ${path}`);
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
      this.log(`[surface] ${HOLD_TAG} no socket: ${err instanceof Error ? err.message : String(err)}`);
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

  private drop(socket: Socket, reason: string, pid: number | null): void {
    socket.destroy();
    const key = `${reason}:${String(pid ?? "-")}`;
    const now = Date.now();
    const last = this.logged.get(key);
    if (last !== undefined && now - last < 60_000) return;
    if (this.logged.size > 256) this.logged.clear();
    this.logged.set(key, now);
    this.log(`[surface] ${HOLD_TAG}.dropped reason=${reason} pid=${String(pid ?? "-")}`);
  }

  /** One connection: one request line, placed, handed off. Never throws. */
  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    let taken = false;
    const timer = setTimeout(() => {
      if (!taken) this.drop(socket, "slow", null);
    }, REQUEST_LINE_MS);
    timer.unref?.();
    const closeListeners: ((how: "closed" | "elsewhere") => void)[] = [];
    let ended = false;
    const fire = (how: "closed" | "elsewhere"): void => {
      if (ended) return;
      ended = true;
      for (const listener of closeListeners) listener(how);
    };
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > HOLD_LINE_MAX + 1) {
        clearTimeout(timer);
        this.drop(socket, "long", null);
        return;
      }
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!taken) {
          taken = true;
          clearTimeout(timer);
          void this.route(socket, line, (listener) => closeListeners.push(listener));
        } else if (isElsewhereLine(line)) {
          fire("elsewhere");
        }
        at = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => fire("closed"));
    socket.on("error", () => fire("closed"));
  }

  private async route(socket: Socket, line: string, onClose: (listener: (how: "closed" | "elsewhere") => void) => void): Promise<void> {
    try {
      const request = parseHoldRequest(line);
      if (request === null) return this.drop(socket, "unparsed", null);
      const record: EdgeRecord = {
        schemaVersion: EDGE_SCHEMA_VERSION,
        harness: request.harness,
        event: "hold",
        detail: null,
        pid: request.pid,
        pidStartTime: request.pidStartTime,
        markers: request.markers,
        at: request.at,
        promptHash: null,
      };
      const targets = this.deps.targets();
      const placement = await placeEdge(record, targets, this.deps.liveness);
      if (placement.kind === "dropped") return this.drop(socket, placement.reason, request.pid);
      // SAFETY: `targets()` returns HoldTargets, and `placeEdge` hands back one of them unchanged.
      const target = placement.target as HoldTarget;
      if (target.hold === undefined) return this.drop(socket, "no-hold", request.pid);
      target.hold(placement.paneId, request, connOf(socket), onClose);
    } catch (err) {
      this.drop(socket, "error", null);
      console.warn(`[surface] hold route failed: ${err instanceof Error ? err.message : String(err)}`);
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
