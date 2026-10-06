// The polling scheduler: web/src/hooks/use-polling.ts's cadence, as a plain module.
//
// Routes REGISTER the reads they need (`want`) for as long as they are mounted; the scheduler runs
// every registered read on one beat and the reads write their stores (lib/data.ts). There is one
// beat for the whole app, as there was one revalidation: a tick never overlaps the previous one, and
// one stuck past SUPERSEDE_MS is aborted and replaced.
//
// The gap is resolved from what the OPERATOR is doing, in the same five rules (`intervalFor`):
//   0/1. a send (or a create/close) just happened → BURST_MS for a few polls;
//   2/3. a pane is open, followed, and its agent is busy or its MIRROR moved → HOT_MS;
//   3b.  an update run is moving on this machine or its crew → HOT_MS;
//   4.   no pane open and some agent is working or blocked → HOME_BUSY_MS;
//   5.   otherwise → IDLE_MS.
// No tick fetches while the page is hidden, the idle lock is up, or a long upload is on the wire.
//
// "THE MIRROR MOVED" IS THE PANE READ'S ANSWER, AND NOBODY ELSE'S. web's paneLoader is the only
// caller of `markPollResult` (web/src/lib/loaders.ts); the snapshot, the chat window and the config
// never feed it. A busy herd changes the snapshot on every read (its `ts` alone moves), so letting any
// source's change count held an idle pane at HOT_MS forever: 76 requests in 30 s against web's 14
// (bench 2026-10-06). The mirror read reports through `markPollResult` (routes/pane/data.ts).
// CADENCE.md beside this file is the table of which screen reads what, and when.
import { refreshNow as lookNowOnBridge } from "@web/lib/api";
import { isLongUpload } from "@web/lib/connection-health";
import { crewMoving, runInFlight } from "@web/lib/update-ribbon";
import type { SnapshotResponse } from "@web/lib/types";

import { address, snapshot } from "./data";
import { endCatchUp, isLocked, setReleaseRefresh } from "./idle";
import { createStore } from "./store";

export const BURST_MS = 300;
export const HOT_MS = 1500;
export const HOME_BUSY_MS = 4000;
export const IDLE_MS = 6000;
/** A tick in flight this long is a black-holed fetch: abort it and start the next one. */
export const SUPERSEDE_MS = 12_000;
/** A burst lasts at least this many polls (web/src/lib/poll-intent.ts). */
export const BURST_MIN_POLLS = 5;
/** …and ends after this many consecutive unchanged polls past the minimum. */
export const BURST_QUIET_POLLS = 2;

/**
 * One read the scheduler runs on every beat. `poll` resolves true when its data changed; the
 * scheduler does not time the beat from that (only `markPollResult` does), it is for callers.
 */
export interface PollSource {
  /** Identity: two registrations with one key are one read. */
  readonly key: string;
  poll(signal: AbortSignal): Promise<boolean>;
}

/** What the open screen tells the cadence (the pane view publishes it; home publishes none). */
export interface Focus {
  /** The open pane, or null on every other screen. */
  paneId: string | null;
  /** The pane view is pinned to the live tail. */
  following: boolean;
}

export const focus = createStore<Focus>(
  { paneId: null, following: true },
  (a, b) => a.paneId === b.paneId && a.following === b.following,
);

export interface Burst {
  paneId: string | null;
  polls: number;
  quiet: number;
  /** Polls left of a topology burst (a create or a close), spent wherever the operator looks. */
  topology: number;
}

let burst: Burst = { paneId: null, polls: 0, quiet: 0, topology: 0 };
/** The last MIRROR read came back with text not seen before (web's `lastPollChanged`). */
let lastChanged = false;

/**
 * Fold one mirror read's verdict into the send burst (web/src/lib/poll-intent.ts `burstOnPoll`):
 * at least BURST_MIN_POLLS reads, then BURST_QUIET_POLLS unchanged reads in a row end it. Pure.
 */
export function burstOnPoll(state: Burst, changed: boolean): Burst {
  if (state.paneId === null) return state;
  const polls = state.polls + 1;
  const quiet = changed ? 0 : state.quiet + 1;
  if (polls >= BURST_MIN_POLLS && quiet >= BURST_QUIET_POLLS) return { ...state, paneId: null, polls: 0, quiet: 0 };
  return { ...state, polls, quiet };
}

/**
 * One pane mirror read came back: `changed` false when the text is the one already held (a 304, or
 * the same body). The only input of rules 3 and the burst, as web's `markPollResult`. A flip re-times
 * the beat when no tick is in flight (web re-creates its interval when the gap changes).
 */
export function markPollResult(changed: boolean): void {
  const next = burstOnPoll(burst, changed);
  if (next === burst && lastChanged === changed) return;
  burst = next;
  lastChanged = changed;
  if (started && !inFlight) schedule();
}

/** Pure cadence resolver, exported for tests. Rules in the header. */
export function intervalFor(
  data: SnapshotResponse | undefined,
  open: Focus,
  intent: { bursting: boolean; changed: boolean; topology: boolean },
): number {
  if (intent.topology || intent.bursting) return BURST_MS;
  const paneId = open.paneId;
  if (paneId !== null && open.following && paneKnown(data, paneId)) {
    if (paneBusy(data, paneId)) return HOT_MS;
    if (intent.changed) return HOT_MS;
  }
  if (runInFlight(data?.update?.run) || crewMoving(data?.update)) return HOT_MS;
  if (paneId === null && herdBusy(data)) return HOME_BUSY_MS;
  return IDLE_MS;
}

function busy(status: string): boolean {
  return status === "working" || status === "blocked";
}

function herdBusy(data: SnapshotResponse | undefined): boolean {
  return data?.agents.some((a) => busy(a.status)) ?? false;
}

function paneKnown(data: SnapshotResponse | undefined, paneId: string): boolean {
  return [...(data?.agents ?? []), ...(data?.shellPanes ?? [])].some((p) => p.paneId === paneId);
}

function paneBusy(data: SnapshotResponse | undefined, paneId: string): boolean {
  return data?.agents.some((a) => a.paneId === paneId && busy(a.status)) ?? false;
}

// ── The scheduler ────────────────────────────────────────────────────────────────────────────────

const sources = new Map<string, { source: PollSource; holders: number }>();
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight: { controller: AbortController; since: number; done: Promise<void> } | undefined;
let started = false;

function currentInterval(): number {
  const open = focus.get();
  return intervalFor(snapshot.get().data, open, {
    bursting: burst.paneId !== null && burst.paneId === open.paneId,
    changed: lastChanged,
    topology: burst.topology > 0,
  });
}

function schedule(ms = currentInterval()): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tick(), ms);
}

/** Run every registered read once, now, unless one beat is already in flight. */
async function tick(force = false): Promise<void> {
  // Hidden: battery. Locked: nobody is reading. A long upload (a voice clip) owns the narrow uplink,
  // and a poll fired now only slows it down (web's tick skips it the same way).
  if (!force && (document.hidden || isLocked() || isLongUpload())) {
    schedule();
    return;
  }
  if (inFlight) {
    if (Date.now() - inFlight.since < SUPERSEDE_MS) return inFlight.done;
    inFlight.controller.abort();
    inFlight = undefined;
  }
  const controller = new AbortController();
  const run = async (): Promise<void> => {
    // A topology burst is spent per tick, wherever the operator looks (web's `consumeTopologyPoll`).
    if (burst.topology > 0) burst = { ...burst, topology: burst.topology - 1 };
    // What each read resolves does not time the beat: only the mirror read does, through
    // `markPollResult`, as it runs inside this same tick.
    await Promise.allSettled([...sources.values()].map(({ source }) => source.poll(controller.signal)));
  };
  const done = run().finally(() => {
    if (inFlight?.controller === controller) inFlight = undefined;
    schedule();
  });
  inFlight = { controller, since: Date.now(), done };
  return done;
}

/**
 * Keep `source` on the beat until `until` aborts (pass the component's `handle.signal`). The first
 * registration of a key fetches at once, so a route shows data without waiting out a gap.
 */
export function want(source: PollSource, until: AbortSignal): void {
  if (until.aborted) return;
  const entry = sources.get(source.key);
  if (entry) entry.holders++;
  else sources.set(source.key, { source, holders: 1 });
  until.addEventListener(
    "abort",
    () => {
      const current = sources.get(source.key);
      if (!current) return;
      current.holders--;
      if (current.holders <= 0) sources.delete(source.key);
    },
    { once: true },
  );
  if (!entry && started) void source.poll(new AbortController().signal);
}

/** Poll now: the page came back, the network came back, or a screen needs fresh data. */
export function kick(): void {
  void tick();
}

/** Every registered read, now, even behind a lock being released. Resolves when they settle. */
export function refreshNow(): Promise<void> {
  return tick(true);
}

/** A send went to `paneId`: watch it land at BURST_MS, starting now rather than after the gap. */
export function noteSend(paneId: string): void {
  burst = { ...burst, paneId, polls: 0, quiet: 0 };
  schedule(BURST_MS);
}

/** A create or a close went through: catch the lists up wherever the operator is looking. */
export function noteTopology(): void {
  burst = { ...burst, topology: BURST_MIN_POLLS };
  schedule(BURST_MS);
}

/**
 * "Look now": ask the bridge to re-read its multiplexer before the next read (web's `lookNow`,
 * hooks/use-polling.ts). Fired, not awaited, on the two moments that mean "I am looking again": the
 * page coming back to the foreground and the idle lock being released. Not on `focus` or `online`.
 * web's `refreshNow` is a no-op for a peer scope and never throws.
 */
function lookNow(): void {
  void lookNowOnBridge(address.get().scope);
}

/** Start the beat. Called once at boot (main.tsx); routes register their reads with `want`. */
export function startPolling(): void {
  if (started) return;
  started = true;
  setReleaseRefresh(() => {
    lookNow();
    return refreshNow().finally(endCatchUp);
  });
  // Back in the foreground: look now, and read at once rather than after the rest of the gap.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    lookNow();
    kick();
  });
  window.addEventListener("focus", kick);
  window.addEventListener("online", kick);
  // A change of focus (a pane opened or left) re-times the beat at once.
  focus.subscribe(() => schedule());
  void tick();
}
