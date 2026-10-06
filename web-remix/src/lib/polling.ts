// The polling scheduler: web/src/hooks/use-polling.ts's cadence, as a plain module.
//
// Routes REGISTER the reads they need (`want`) for as long as they are mounted; the scheduler runs
// every registered read on one beat and the reads write their stores (lib/data.ts). There is one
// beat for the whole app, as there was one revalidation: a tick never overlaps the previous one, and
// one stuck past SUPERSEDE_MS is aborted and replaced.
//
// The gap is resolved from what the OPERATOR is doing, in the same five rules (`intervalFor`):
//   0/1. a send (or a create/close) just happened → BURST_MS for a few polls;
//   2/3. a pane is open, followed, and its agent is busy or its mirror moved → HOT_MS;
//   3b.  an update run is moving on this machine or its crew → HOT_MS;
//   4.   no pane open and some agent is working or blocked → HOME_BUSY_MS;
//   5.   otherwise → IDLE_MS.
// No tick fetches while the page is hidden or the idle lock is up.
import { crewMoving, runInFlight } from "@web/lib/update-ribbon";
import type { SnapshotResponse } from "@web/lib/types";

import { snapshot } from "./data";
import { endCatchUp, isLocked, setReleaseRefresh } from "./idle";
import { createStore } from "./store";

export const BURST_MS = 300;
export const HOT_MS = 1500;
export const HOME_BUSY_MS = 4000;
export const IDLE_MS = 6000;
/** A tick in flight this long is a black-holed fetch: abort it and start the next one. */
export const SUPERSEDE_MS = 12_000;
/** A burst lasts at least this many polls (web/src/lib/poll-intent.ts). */
const BURST_MIN_POLLS = 5;
/** …and ends after this many consecutive unchanged polls past the minimum. */
const BURST_QUIET_POLLS = 2;

/** One read the scheduler runs on every beat. `poll` resolves true when its data changed. */
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

interface Burst {
  paneId: string | null;
  polls: number;
  quiet: number;
  /** Polls left of a topology burst (a create or a close), spent wherever the operator looks. */
  topology: number;
}

let burst: Burst = { paneId: null, polls: 0, quiet: 0, topology: 0 };
let lastChanged = false;

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
  if (!force && (document.hidden || isLocked())) {
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
    const results = await Promise.allSettled([...sources.values()].map(({ source }) => source.poll(controller.signal)));
    if (controller.signal.aborted) return;
    const changed = results.some((r) => r.status === "fulfilled" && r.value);
    lastChanged = changed;
    if (burst.topology > 0) burst = { ...burst, topology: burst.topology - 1 };
    if (burst.paneId !== null) {
      const polls = burst.polls + 1;
      const quiet = changed ? 0 : burst.quiet + 1;
      burst = polls >= BURST_MIN_POLLS && quiet >= BURST_QUIET_POLLS
        ? { ...burst, paneId: null, polls: 0, quiet: 0 }
        : { ...burst, polls, quiet };
    }
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

/** Start the beat. Called once at boot (main.tsx); routes register their reads with `want`. */
export function startPolling(): void {
  if (started) return;
  started = true;
  setReleaseRefresh(() => refreshNow().finally(endCatchUp));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) kick();
  });
  window.addEventListener("focus", kick);
  window.addEventListener("online", kick);
  // A change of focus (a pane opened or left) re-times the beat at once.
  focus.subscribe(() => schedule());
  void tick();
}
