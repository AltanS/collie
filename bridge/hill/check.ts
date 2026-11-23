// The check at the end of a turn (Asks, part B; .adr/0177). At the end of an operator turn the Claude Code
// `Stop` hook runs `collie beacon check`, which asks this bridge (`ask.check` on the walky socket) whether the
// session should look at its open asks once more. This book holds every fact that answer needs and that the
// Hill's store does not: the turn each pane is in, the turn that was already checked, and the brake.
//
// ALL OF IT LIVES HERE, IN THE BRIDGE, so two hook processes of one stop cannot both say "check": the
// decision and its record happen in one synchronous call, with no `await` between them.
//
// THE TURN. An operator turn starts with Claude Code's `UserPromptSubmit`, which reaches this bridge as a
// `prompt` hook edge (`collie beacon emit`, bridge/surface/edges.ts). Its `at` (the hook's own clock, the
// same machine clock as the bridge's) is the turn's key and its start. A pane with no prompt edge since the
// bridge started has no key, and gets no check: a restart forgives, it never guesses.
//
// THE BRAKE. A check after which the agent ran no ask verb (`keep`, `ask`, `ask --replaces`, `cancel`) is
// ignored. After one ignored check the next one comes 2 turns later, then 4, then 8, and stays at 8. Any
// ask verb of the session resets it. The counters are in memory: a bridge restart forgives. Whether the
// check was ignored is settled at the session's next turn: an ask verb at any time resets the brake anyway,
// so a verb in the check's own turn and one in the next turn come to the same thing.
//
// THE PANE'S STATE. The `Stop` that runs the check also runs `beacon emit`, which writes an idle beacon and a
// stop edge; the check then goes on with no new prompt. So while a check runs the book LIFTS the pane: the
// state engine reads an idle or done pane as `working` (state-engine.ts `liftChecks`). The lift ends on the
// stop edge of the check's own turn, on a new prompt, on a start or an end edge, or after
// {@link ASK_CHECK_LIFT_MAX_MS}, whichever comes first.
//
// Pure: the clock is injected, and nothing here reads a file or a socket.

import type { EdgeKind } from "../../web/src/lib/surface/edges.ts";
import type { HillDecision } from "../../web/src/lib/hill/wire.ts";

/** At most this many asks are listed in one check (the open cap is also 5, `HILL_ASK_OPEN_MAX`). */
export const ASK_CHECK_LISTED_MAX = 5;

/** The turns from one ignored check to the next: 2, then 4, then 8, and 8 from then on. */
export const ASK_CHECK_WAITS: readonly number[] = [2, 4, 8];

/** The longest a check lifts its pane to `working`. A check is one short step; a longer one reads as the beacon says. */
export const ASK_CHECK_LIFT_MAX_MS = 120_000;

/**
 * How recent the pane's last stop edge may be, at the moment a check is answered, to be the stop that ran
 * the check. The emitter and the check start together; whichever reaches the bridge first, both arrive within
 * this time.
 */
export const ASK_CHECK_STOP_SEEN_MS = 5_000;

/** How many sessions and panes the book keeps before it forgets the oldest. */
const BOOK_MAX = 500;

/** The asks a check lists, as the hook prints them. */
export interface AskCheckItem {
  readonly id: string;
  readonly title: string;
  /** When it was posted. */
  readonly at: number;
}

/** What the bridge answers `ask.check` with. */
export type AskCheckDecision = { readonly kind: "check"; readonly asks: readonly AskCheckItem[] } | { readonly kind: "none"; readonly why: AskCheckNone };

/** Why a check answered "none": named so the tests can tell the gates apart. */
export type AskCheckNone = "no_turn" | "no_asks" | "checked" | "backoff" | "touched" | "off" | "error";

/** The wait after the `ignored`-th ignored check in a row (1 or more). */
export function askCheckWait(ignored: number): number {
  if (ignored <= 0) return 1;
  return ASK_CHECK_WAITS[Math.min(ignored, ASK_CHECK_WAITS.length) - 1]!;
}

interface PaneTurn {
  /** The `at` of the pane's last prompt edge: the turn's key. */
  prompt: number | null;
  /** The `at` of the pane's last stop edge. */
  stop: number | null;
  /** A check's lift: since when, and how many stop edges end it. */
  lift: { readonly since: number; stopsLeft: number } | null;
  touched: number;
}

interface SessionBrake {
  /** The turn a check was answered "check" in. */
  checked: number | null;
  /** The turn the brake last counted. */
  counted: number | null;
  /** This turn is one the brake waits out. */
  waiting: boolean;
  /** When the last "check" was answered, until the next turn settles whether it was ignored. */
  pending: number | null;
  /** The last ask verb of the session. */
  verbAt: number;
  /** Ignored checks in a row. */
  ignored: number;
  /** Turns still to wait. */
  skipLeft: number;
  touched: number;
}

function paneKey(session: string, paneId: string): string {
  return `${session}\u0000${paneId}`;
}

/** The newest time an ask was posted, kept or replaced: a replace posts a new ask, so its `at` says it. */
function touchedAt(decision: Pick<HillDecision, "at" | "ask">): number {
  return Math.max(decision.at, decision.ask?.confirmedAt ?? 0);
}

export class AskCheckBook {
  private readonly panes = new Map<string, PaneTurn>();
  private readonly sessions = new Map<string, SessionBrake>();

  constructor(private readonly now: () => number = Date.now) {}

  /** One placed hook edge of a pane's own session (never a subagent's). Never throws. */
  edge(session: string, paneId: string, kind: EdgeKind, at: number): void {
    if (kind !== "prompt" && kind !== "stop" && kind !== "start" && kind !== "end") return;
    const pane = this.pane(session, paneId);
    switch (kind) {
      case "prompt":
        pane.prompt = at;
        pane.lift = null;
        return;
      case "stop":
        pane.stop = at;
        if (pane.lift === null) return;
        pane.lift.stopsLeft -= 1;
        if (pane.lift.stopsLeft <= 0) pane.lift = null;
        return;
      case "start":
        pane.lift = null;
        return;
      case "end":
        pane.prompt = null;
        pane.lift = null;
        return;
    }
  }

  /** The key of the pane's current operator turn, or null when the bridge saw no prompt for it. */
  turn(session: string, paneId: string): number | null {
    return this.panes.get(paneKey(session, paneId))?.prompt ?? null;
  }

  /** An ask verb of the session ran (a post, a keep, a replace, a cancel): the brake is reset. */
  noteVerb(address: string): void {
    const brake = this.brake(address);
    brake.verbAt = this.now();
    brake.ignored = 0;
    brake.skipLeft = 0;
    brake.waiting = false;
  }

  /**
   * Whether the session at `address`, in the turn `turn`, gets a check, given its open asks. Records the
   * answer in the same call. `open` holds only the session's own open asks.
   */
  decide(address: string, turn: number | null, open: readonly Pick<HillDecision, "id" | "title" | "at" | "ask">[]): AskCheckDecision {
    if (turn === null) return { kind: "none", why: "no_turn" };
    const brake = this.brake(address);
    if (brake.counted !== turn) this.count(brake, turn);
    if (brake.checked === turn) return { kind: "none", why: "checked" };
    if (brake.waiting) return { kind: "none", why: "backoff" };
    if (open.length === 0) return { kind: "none", why: "no_asks" };
    // An ask the agent posted, kept or replaced in this turn is confirmed already.
    const stale = open.filter((decision) => touchedAt(decision) < turn).toSorted((a, b) => a.at - b.at);
    if (stale.length === 0) return { kind: "none", why: "touched" };
    brake.checked = turn;
    brake.pending = this.now();
    return { kind: "check", asks: stale.slice(0, ASK_CHECK_LISTED_MAX).map((decision) => ({ id: decision.id, title: decision.title, at: decision.at })) };
  }

  /** A check was answered for this pane: it reads as working until the check's own turn ends. */
  lift(session: string, paneId: string): void {
    const pane = this.pane(session, paneId);
    const now = this.now();
    // The stop that ran the check may have reached the bridge first. Then only the check's own stop is left.
    const seen = pane.stop !== null && now - pane.stop <= ASK_CHECK_STOP_SEEN_MS && pane.stop >= (pane.prompt ?? Number.NEGATIVE_INFINITY);
    pane.lift = { since: now, stopsLeft: seen ? 1 : 2 };
  }

  /** Whether a check's turn runs in this pane now. */
  lifting(session: string, paneId: string): boolean {
    const pane = this.panes.get(paneKey(session, paneId));
    if (pane?.lift === undefined || pane.lift === null) return false;
    if (this.now() - pane.lift.since < ASK_CHECK_LIFT_MAX_MS) return true;
    pane.lift = null;
    return false;
  }

  /** A new turn for the brake: settle the last check, then count this turn against the wait. */
  private count(brake: SessionBrake, turn: number): void {
    brake.counted = turn;
    brake.waiting = false;
    if (brake.pending !== null) {
      if (brake.verbAt < brake.pending) {
        brake.ignored += 1;
        brake.skipLeft = askCheckWait(brake.ignored) - 1;
      }
      brake.pending = null;
    }
    if (brake.skipLeft > 0) {
      brake.skipLeft -= 1;
      brake.waiting = true;
    }
  }

  private pane(session: string, paneId: string): PaneTurn {
    const key = paneKey(session, paneId);
    let pane = this.panes.get(key);
    if (pane === undefined) {
      pane = { prompt: null, stop: null, lift: null, touched: this.now() };
      this.panes.set(key, pane);
      trim(this.panes);
    }
    pane.touched = this.now();
    return pane;
  }

  private brake(address: string): SessionBrake {
    let brake = this.sessions.get(address);
    if (brake === undefined) {
      brake = { checked: null, counted: null, waiting: false, pending: null, verbAt: Number.NEGATIVE_INFINITY, ignored: 0, skipLeft: 0, touched: this.now() };
      this.sessions.set(address, brake);
      trim(this.sessions);
    }
    brake.touched = this.now();
    return brake;
  }
}

/** Forget the least recently touched entry once a map grows past {@link BOOK_MAX}. */
function trim(map: Map<string, { touched: number }>): void {
  if (map.size <= BOOK_MAX) return;
  let oldest: string | null = null;
  let at = Number.POSITIVE_INFINITY;
  for (const [key, value] of map) {
    if (value.touched < at) {
      at = value.touched;
      oldest = key;
    }
  }
  if (oldest !== null) map.delete(oldest);
}
