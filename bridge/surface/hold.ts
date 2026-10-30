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
import { HOST, type Host } from "../host.ts";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { BeaconLiveness } from "../beacon/reader.ts";
import { EDGE_SCHEMA_VERSION, type EdgeRecord } from "../beacon/types.ts";
import type { LiftedDialog } from "../../web/src/lib/surface/lift.ts";
import {
  decisionOf,
  dialogShowsRequest,
  holdInputHash,
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

/**
 * What ended a hold, for the counters and the receipt. `elsewhere` counts as `void`. `keys` is a keys
 * answer to the dialog on the screen that ended the hook first, and counts as `desk`: the screen answered.
 */
export type HoldOutcome = "phone" | "desk" | "keys" | "elsewhere" | "void" | "timeout" | "mismatch";

/** The counter word of an outcome (spec 09's counters file): desk, phone, void, timeout, mismatch. */
export function counterWordOf(outcome: HoldOutcome): "phone" | "desk" | "void" | "timeout" | "mismatch" {
  if (outcome === "elsewhere") return "void";
  return outcome === "keys" ? "desk" : outcome;
}

/** The ms after a keys answer's commit in which a hook that ends was ended by that answer. */
export const KEYS_CLOSE_MS = 5000;

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

/** What a hook edge says that a hold can use. */
export interface EdgeInfo {
  readonly tool: string | null;
  readonly agent: string | null;
  /** When the hook ran, in epoch ms. */
  readonly at: number;
  /** The tool edge's input hash (`holdInputHash`), or null. */
  readonly inputHash: string | null;
}

/** Whether a tool edge is about this hold's own call. A tool edge with no input hash ends nothing. */
function toolEdgeEnds(held: Held, info: EdgeInfo): boolean {
  if (info.agent !== held.request.agent || info.tool !== held.request.tool) return false;
  if (info.at < held.request.at || info.inputHash === null) return false;
  return info.inputHash === holdInputHash(held.request.tool, held.request.input);
}

/** The key of a hold: its pane and its agent ("-" for the main session). */
function holdKey(paneId: string, agent: string | null): string {
  return `${paneId}\u0000${agent ?? "-"}`;
}

/** The note state of a closed hold's outcome. */
function noteStateOf(outcome: HoldOutcome): HoldState {
  return outcome === "phone" ? "sent" : outcome;
}

export class HoldBook {
  private readonly byId = new Map<string, Held>();
  /** The holds by pane and agent: one per pane for the main session, one per subagent beside it. */
  private readonly byKey = new Map<string, Held>();
  private serial = 0;
  private readonly now: () => number;
  private readonly schedule: (run: () => void, ms: number) => () => void;
  private readonly salt: string;
  private readonly log: (line: string) => void;
  /** Set by the ask book that attaches this one: void the pane's live keys ask. */
  voidKeysAsk: (paneId: string) => void = () => {};
  /** When a keys answer last sent its commit on each pane. */
  private readonly keysAt = new Map<string, number>();

  /** A keys answer on the pane sends its commit now. A hook that ends soon after was ended by it. */
  keysCommitting(paneId: string): void {
    this.keysAt.set(paneId, this.now());
  }

  /**
   * Who answered a hold that ends while it waits: `keys` when it did not adopt the dialog and a keys
   * answer on its pane just sent its commit (the phone's keys card answered the dialog), else `desk`.
   */
  private screenAnswer(held: Held): "keys" | "desk" {
    const keysAt = this.keysAt.get(held.paneId);
    return held.dialog === null && keysAt !== undefined && this.now() - keysAt < KEYS_CLOSE_MS ? "keys" : "desk";
  }

  constructor(private readonly options: HoldBookOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? timerSchedule;
    this.salt = options.salt ?? crypto.randomUUID();
    this.log = options.log ?? ((line) => console.log(line));
  }

  /**
   * A placed request opens a hold, keyed by its pane and its agent. A hold still open under the same
   * key ends as void, never as desk: nothing proves who answered it. Holds of other agents on the
   * pane stay open beside it.
   */
  open(paneId: string, generation: string, request: HoldRequest, conn: HoldConn, profile: HoldProfile): Held {
    const key = holdKey(paneId, request.agent);
    const old = this.byKey.get(key);
    if (old !== undefined && (old.state === "held" || old.state === "answering")) this.end(old, "void");
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
    this.byKey.set(key, held);
    this.line(held, "open");
    return held;
  }

  /** The hold an ask id belongs to, live or closed, or undefined. */
  byAskId(id: string): Held | undefined {
    return this.byId.get(id);
  }

  /** Every hold on the pane, live or closed, oldest first. */
  holdsOn(paneId: string): Held[] {
    return [...this.byKey.values()].filter((held) => held.paneId === paneId).toSorted((a, b) => a.openedAt - b.openedAt);
  }

  /** Whether the hold waits, runs an answer, or just sent one. */
  private isLive(held: Held): boolean {
    if (held.state === "held" || held.state === "answering") return true;
    return held.state === "sent" && held.sentAt !== null && this.now() - held.sentAt < SENT_SHIELD_MS;
  }

  /** Whether the pane's reads go through {@link claim}: a hold on it waits, runs an answer, or just sent one. */
  live(paneId: string): boolean {
    return this.holdsOn(paneId).some((held) => this.isLive(held));
  }

  /**
   * One read of a pane with a live hold. Returns the hook ask the pane's Surface carries, or null:
   * the caller then publishes the screen's dialog as a keys ask, or nothing. Never sends a key.
   *
   * A hold owns the Surface's ask only in two cases. It adopted the permission dialog on the screen
   * (the dialog shows its tool and input), and that dialog is still there. Or the screen shows no
   * dialog at all (a background subagent's request). A dialog the hold did not adopt is the screen's
   * own: it gets a keys ask, and the hold's ask lives only in the hold note, answered from the hold
   * card. So a tap on a screen card never becomes a decision for another request.
   */
  claim(paneId: string, generation: string, dialog: LiftedDialog | null): Ask | null {
    const live = this.holdsOn(paneId).filter((held) => this.isLive(held));
    if (live.length === 0) return null;
    const permission = dialog !== null && dialog.blockKind === "prompt-select" && dialog.kind === "permission" ? dialog : null;
    const adopter = this.adopterOf(live, permission);
    let owner: Ask | null = null;
    for (const held of live) {
      const ask = this.step(held, held === adopter, generation, dialog, permission);
      if (ask !== null && owner === null) owner = ask;
    }
    if (owner !== null) return owner;
    if (dialog !== null) return null;
    // No dialog on the screen: the oldest hold that waits carries the Surface's ask.
    return live.find((held) => held.state === "held" && held.dialog === null)?.ask ?? null;
  }

  /**
   * The one hold that may adopt the permission dialog on the screen, or null. A hold may adopt it when
   * it waits with no dialog and the dialog shows its own tool, agent mark and input. No hold adopts a
   * dialog another hold has already, and none adopts when two or more could: a wrong owner would turn
   * a tap on the dialog's card into a decision for another request.
   */
  private adopterOf(live: readonly Held[], permission: LiftedDialog | null): Held | null {
    if (permission === null) return null;
    if (live.some((held) => held.dialog !== null && sameDialog(held.dialog, permission))) return null;
    const fits = live.filter((held) => held.state === "held" && held.dialog === null && dialogShowsRequest(permission.region, held.request, held.profile));
    return fits.length === 1 ? (fits[0] ?? null) : null;
  }

  /** One hold's part of a read. Returns its ask when it owns the dialog on the screen, else null. */
  private step(held: Held, adopts: boolean, generation: string, dialog: LiftedDialog | null, permission: LiftedDialog | null): Ask | null {
    if (held.state !== "held") return held.dialog !== null ? held.ask : null;
    if (held.dialog === null) {
      // Adopt the permission dialog when this hold is its one fit (adopterOf).
      // The dialog's labels replace the profile's; an id minted before answers `ask_changed`, never a key.
      if (permission !== null && adopts) {
        this.mint(held, generation, permission);
        this.voidKeysAsk(held.paneId);
        return held.ask;
      }
      if (held.ask === null) this.mint(held, generation, null);
      return null;
    }
    const same = permission !== null && sameDialog(held.dialog, permission);
    if (held.hookGone) {
      // The hook ended early. Its dialog still up: the hook stopped on its own, so the dialog
      // becomes a keys ask. Its dialog gone on two reads: the desk answered, and the harness ended the hook.
      if (same) {
        if (this.now() - held.goneAt < CLOSE_SETTLE_MS) return held.ask;
        this.end(held, "void");
        return null;
      }
      return this.miss(held, dialog);
    }
    if (same) {
      held.missing = 0;
      return held.ask;
    }
    return this.miss(held, dialog);
  }

  /**
   * The adopted dialog is not on this read. Two misses in a row: the desk answered. Until then the
   * hold keeps the Surface's ask only while no other dialog shows, so a tap on another card never
   * lands on this hold.
   */
  private miss(held: Held, dialog: LiftedDialog | null): Ask | null {
    held.missing += 1;
    if (held.missing >= DESK_READS) {
      this.end(held, "desk");
      return null;
    }
    return dialog === null ? held.ask : null;
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
    // A keys answer to the dialog on the screen ends the hook of a hold that did not adopt it.
    if (held.state === "held" && this.screenAnswer(held) === "keys") return this.end(held, "keys");
    // A hold with no adopted dialog has nothing for the screen to judge: the hook stopped.
    if (held.dialog === null || held.state === "answering") return this.end(held, "void");
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
  edge(paneId: string, kind: EdgeKind, info: EdgeInfo): void {
    for (const held of this.holdsOn(paneId)) this.edgeOf(held, kind, info);
  }

  private edgeOf(held: Held, kind: EdgeKind, info: EdgeInfo): void {
    switch (kind) {
      case "tool":
        // Only this very call: the same agent and tool, not older than the request, and the same input.
        if (!toolEdgeEnds(held, info)) return;
        if (held.state === "held") return this.end(held, this.screenAnswer(held));
        if (held.state === "sent" && held.decision === "deny") {
          // The phone sent a deny, yet the tool ran: the desk's yes landed first.
          return this.settle(held, "desk");
        }
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
        if (held.state === "held") this.end(held, this.screenAnswer(held));
        if (held.note?.state === "sent") held.note = null;
        return;
      case "dialog":
      case "reread":
        return;
    }
  }

  /**
   * The pane's note for the phone, or null when there is nothing to say. With more than one hold on
   * the pane: the hold that owns the dialog on the screen, else the oldest that waits, else the newest
   * closed note. The phone shows one hold card at a time; the next one shows once the first ends.
   */
  note(paneId: string): HoldNote | null {
    const notes = this.holdsOn(paneId)
      .map((held) => ({ held, note: this.noteNow(held) }))
      .filter((entry): entry is { held: Held; note: HoldNote } => entry.note !== null);
    const waiting = notes.filter((entry) => entry.note.state === "held");
    const pick = waiting.find((entry) => entry.held.dialog !== null) ?? waiting[0] ?? notes.toSorted((a, b) => b.note.since - a.note.since)[0];
    return pick?.note ?? null;
  }

  private noteNow(held: Held): HoldNote | null {
    const note = held.note;
    if (note === null) return null;
    const age = this.now() - note.since;
    if (note.state === "held") return held.state === "held" || held.state === "answering" ? { ...note, adopted: held.dialog !== null } : null;
    if (note.state === "sent") return age < SENT_NOTE_MS ? note : null;
    return age < NOTE_MS ? note : null;
  }

  private noteOf(held: Held, state: HoldState): HoldNote | null {
    const ask = held.ask;
    if (ask === null) return null;
    return {
      askId: ask.id,
      state,
      tool: held.request.tool,
      input: held.request.input,
      agent: held.request.agent !== null,
      options: ask.options.map((option) => option.label),
      hash: ask.hash,
      adopted: held.dialog !== null,
      since: this.now(),
    };
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
  if (!request.hold || request.cut === true || profile === undefined || generation === null || profile.screenOnly.includes(request.tool)) {
    conn.release();
    const reason = request.cut === true ? "cut" : !request.hold || profile?.screenOnly.includes(request.tool) === true ? "screen-only" : "no-hold";
    deps.log?.(`[surface] surface.hold edge-only pane=${paneId} tool=${request.tool} reason=${reason}`);
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
  /** The host the bridge runs on (bridge/host.ts). Defaults to {@link HOST}. */
  readonly host?: Host;
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
    if ((this.deps.host ?? HOST).platform === "win32") {
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
    // A pane of another multiplexer on this machine belongs to that bridge's hold socket, as in EdgeRouter.drop.
    if (reason === "foreign-mux") return;
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
