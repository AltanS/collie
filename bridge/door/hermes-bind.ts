// Which Hermes session a pane shows, by identity (SPEC V16, V28, V29; ADR 0141 point 3).
//
// WHY NOT THE MULTIPLEXER'S WORD. Herdr's Hermes plugin runs inside the gateway that every Ink pane
// shares, so with two Ink panes it names the first pane's session for the other pane, and none for the
// first (leg F). A send to "pane A's session" by that word landed in pane B. The gateway's live list
// carries no pane and is a call the door may not make (ADR 0142 point 4).
//
// THE RULE. Each live session's latest turn (journal/hermes.ts, `hermesLatestTurns`) is probed by the
// tail of its folded prose, the identity probe of the "Full reply" card (lib/latest-reply.ts). The pane
// binds to a session only when exactly one session's probe is on its screen, that probe is long enough
// to mean something, and it is on no other Hermes pane's screen. Every screen is read through the
// split cut (lib/surface/split.ts), so a panel beside the agent never matches. A read that fails, comes
// back partial or runs out of time refuses: an unread pane proves nothing about "no other".
//
// THEN THE PROOF'S SESSION. The journal proves a door send from the session the multiplexer names for
// the pane (bridge/server.ts), so a binding that disagrees with it, or a pane it names none for, refuses
// too: the send would be proved against another session's log, or none (SPEC V28). Two Ink
// panes on one gateway therefore keep the screen path until Herdr names each pane's own session.

import { lineText } from "../../web/src/lib/blocks.ts";
import { fold, PROBE_CHARS } from "../../web/src/lib/probe-fold.ts";
import { readRows } from "../../web/src/lib/surface/split.ts";
import { hermesLatestTurns, type HermesLatestTurn } from "../journal/hermes.ts";
import type { DoorTarget } from "./door.ts";
import type { HermesBinding } from "./hermes.ts";

/** The whole binding's time: it comes off the submit's share of the pane lock (ADR 0141 point 2). */
export const BIND_MS = 1000;

/** The shortest folded probe that may bind: a short turn ("ok") is on too many screens to name one. */
export const PROBE_FLOOR = 24;

/** The refusal the person reads in the log: the pane keeps the screen path and its confirm tap. */
export const UNBOUND = "Which Hermes session is this pane showing? Nothing was sent.";

/** A Hermes pane of this bridge session, as the multiplexer names it. */
export interface HermesPane {
  readonly paneId: string;
  /** The session the multiplexer reports for the pane: the one the journal proof reads. */
  readonly session: string | undefined;
}

export interface HermesBindDeps {
  /** The gateway's home's `state.db`: the profile the door's ticket is for, and no other. */
  readonly dbPath: string;
  /** Every pane of this bridge session the multiplexer names Hermes in. */
  panes(): readonly HermesPane[];
  /** The pane's viewport as the multiplexer painted it, or null when it cannot hand all of it over. */
  read(paneId: string): Promise<string | null>;
  /** The live sessions' latest turns; the store by default. */
  turns?(dbPath: string): readonly HermesLatestTurn[] | null;
}

/** A turn's identity probe: the tail of its folded prose. */
function probeOf(turn: HermesLatestTurn): string {
  return fold(turn.text).slice(-PROBE_CHARS);
}

/** A screen as the probes compare it: cut, plain, folded. */
function screenOf(raw: string): string {
  return readRows(raw).map((row) => fold(lineText(row))).join("");
}

/** `work`, or null once `signal` aborts. */
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return null;
  let onAbort!: () => void;
  const aborted = new Promise<null>((resolveAbort) => {
    onAbort = () => resolveAbort(null);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work.catch(() => null), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** The `bind` Hermes's door takes ({@link HermesDoorDeps.bind}). */
export function hermesBinder(deps: HermesBindDeps): (target: DoorTarget, signal: AbortSignal) => Promise<HermesBinding> {
  const turnsOf = deps.turns ?? hermesLatestTurns;
  return async (target, outer) => {
    const signal = AbortSignal.any([outer, AbortSignal.timeout(BIND_MS)]);
    const turns = turnsOf(deps.dbPath);
    if (turns === null) return { ok: false, why: `${UNBOUND} (Hermes's session store could not be read)` };
    const probed = turns.filter((turn) => turn.whole).map((turn) => ({ turn, probe: probeOf(turn) })).filter(({ probe }) => probe !== "");

    const panes = deps.panes();
    const own = panes.find((pane) => pane.paneId === target.paneId);
    const others = panes.filter((pane) => pane.paneId !== target.paneId);
    const screens = await Promise.all([target.paneId, ...others.map((pane) => pane.paneId)].map((paneId) => untilAborted(deps.read(paneId), signal)));
    if (screens.some((screen) => screen === null)) return { ok: false, why: `${UNBOUND} (a Hermes pane could not be read whole)` };
    const [mine, ...theirs] = screens.map((screen) => screenOf(screen ?? ""));

    const matches = probed.filter(({ probe }) => mine?.includes(probe) === true);
    const match = matches[0];
    if (matches.length !== 1 || match === undefined) return { ok: false, why: `${UNBOUND} (${String(matches.length)} live sessions' latest turns are on its screen)` };
    const { turn, probe } = match;
    if (probe.length < PROBE_FLOOR) return { ok: false, why: `${UNBOUND} (its latest turn is too short to name it)` };
    if (theirs.some((screen) => screen.includes(probe))) return { ok: false, why: `${UNBOUND} (another Hermes pane shows the same turn)` };
    if (own?.session !== turn.sessionId) return { ok: false, why: `${UNBOUND} (the multiplexer names ${own?.session === undefined ? "no session" : "another session"} for it, so the journal could not prove the send)` };
    return { ok: true, sessionId: turn.sessionId };
  };
}
