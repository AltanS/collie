import { useSyncExternalStore } from "react";

import { fetchStandbyRun, fetchUpdateState } from "./api";
import { runInFlight } from "./update-ribbon";
import type { UpdateCheckResponse, UpdateCrewMember, UpdateRun } from "./types";

// ── ONE POLL FOR THE WHOLE UPDATE SUBJECT ───────────────────────────────────────────────────────
//
// The Updates card and the update screen both need the same three things: the run record, the crew
// census and the preflight. The card used to own all of it — a mount read of `GET /api/update/check`,
// a re-read on every settle, and a `setInterval` on the standby door — and the sheet cannot own any
// of it, because it is mounted in `App.tsx` OUTSIDE the router (see `components/update-screen.tsx`)
// and therefore has no route loader data and no `CrewProvider`.
//
// Two surfaces each running that machinery would poll the standby door twice whenever both are
// mounted, which is the one route that is answered by a SECOND listener on a second port during the
// restart gap. So the machinery lives here, once, ref-counted by its subscribers, and both surfaces
// read it through `useSyncExternalStore`.
//
// ── WHY THIS STORE POLLS THE FRONT DOOR AT ALL ───────────────────────────────
// The card never had to: the snapshot poll goes hot while a run is in flight (`hooks/use-polling.ts`)
// and carries the run record, and the card reads the snapshot through the router. The sheet has no
// snapshot. So the store reads `GET /api/update/check` on its own while a run is moving, and the card
// hands it every snapshot it sees ({@link noteSnapshotRun}) so the two sources reconcile here rather
// than on two screens.
//
// ── THE RESTART GAP IS NOT AN OUTAGE ─────────────────────────────────────────
// A failed read changes nothing on screen and is tried again. The bridge is genuinely gone during
// `restarting` — that is the update working — and `GET /standby/update` (CREW_PROTOCOL.md §18.15) is
// the one reader that still answers in that window.

/**
 * How often the standby door is asked while a run is in flight (M20/08).
 *
 * The number and the reasoning both moved here from `components/update-card.tsx`, unchanged: this is
 * the only reader that works while the bridge serving this page is down, which is the minute the
 * operator called the most confusing.
 */
export const STANDBY_POLL_MS = 2000;

/**
 * How often the FRONT door is asked while a run is in flight.
 *
 * Slower than the standby door on purpose. The standby door answers the one question nothing else
 * can; this read carries the peer legs and the census, which move at the pace of a crew sweep and
 * not at the pace of a restart.
 */
export const FRONT_POLL_MS = 4000;

export interface UpdateRunSnapshot {
  /** `GET /api/update/check` in full — versions, preflight, census. Undefined before the first read. */
  readonly check: UpdateCheckResponse | undefined;
  /** The freshest run record of the three sources. See {@link freshest}. */
  readonly run: UpdateRun | undefined;
  /** The crew census, or an empty list on a solo install and on an older bridge. */
  readonly crew: readonly UpdateCrewMember[];
  /** Has the front door answered once? A card cannot claim anything about this machine before it has. */
  readonly checked: boolean;
  /**
   * What this machine is called, or null while nothing has said.
   *
   * Published by `routes/root.tsx` off the snapshot's roster ({@link noteLeadName}), because the
   * update screen is mounted outside that router and the solo toast names the MACHINE rather than a
   * crew that does not exist.
   */
  readonly leadName: string | null;
}

const EMPTY: UpdateRunSnapshot = {
  check: undefined,
  run: undefined,
  crew: [],
  checked: false,
  leadName: null,
};

let snapshot: UpdateRunSnapshot = EMPTY;
let checkRun: UpdateRun | undefined;
let pollRun: UpdateRun | undefined;
let standbyRun: UpdateRun | undefined;
const listeners = new Set<() => void>();

/** The freshest of the records the app can hold. `updatedAt` decides — the standby door and the
 *  front door are two readers of ONE file, so the newer reading is simply the newer reading.
 *
 *  `>` and not `>=` (M20/14). Copies of one run tie on `updatedAt`, and the arguments are ordered by
 *  how live each source is: the standby door during a restart, then the snapshot poll, then this
 *  store's own `GET /api/update/check`. `>` hands a tie to the FIRST. */
export function freshest(...runs: (UpdateRun | undefined)[]): UpdateRun | undefined {
  let best: UpdateRun | undefined;
  for (const run of runs) {
    if (run === undefined) continue;
    if (best === undefined || run.updatedAt > best.updatedAt) best = run;
  }
  return best;
}

function recompute(): void {
  const run = freshest(standbyRun, pollRun, checkRun);
  const next: UpdateRunSnapshot = {
    check: snapshot.check,
    run,
    crew: snapshot.check?.crew ?? [],
    checked: snapshot.checked,
    leadName: snapshot.leadName,
  };
  snapshot = next;
  for (const listener of listeners) listener();
  // The intervals exist exactly while a run is in flight and somebody is looking, so the decision is
  // re-taken on every change rather than only when a component mounts.
  arm();
}

/** The snapshot poll's own copy of the run, handed over by whatever surface reads the router. */
export function noteSnapshotRun(run: UpdateRun | undefined): void {
  if (run === pollRun) return;
  pollRun = run;
  recompute();
}

/** The record `POST /api/update` answered with. The freshest thing in the world for one beat. */
export function noteStartedRun(run: UpdateRun | null): void {
  if (run === null) return;
  standbyRun = run;
  recompute();
}

/** The roster's lead, published by the data root. A name, never a mount. */
export function noteLeadName(name: string | null): void {
  if (name === snapshot.leadName) return;
  snapshot = { ...snapshot, leadName: name };
  recompute();
}

export function getUpdateRunSnapshot(): UpdateRunSnapshot {
  return snapshot;
}

/** Ask the front door now. Used on mount and on every settle — the preflight's answer after an
 *  update is a different answer from the one before it. */
export async function readUpdateState(signal?: AbortSignal): Promise<void> {
  try {
    const check = await fetchUpdateState(signal);
    checkRun = check.run;
    snapshot = { ...snapshot, check, checked: true };
  } catch {
    // A failed read is not an error to render: the versions come from the snapshot anyway, and the
    // preflight simply stays unknown, which disables nothing and claims nothing.
    snapshot = { ...snapshot, checked: true };
  }
  recompute();
}

let timers: ReturnType<typeof setInterval>[] = [];
let driving = false;

function stopTimers(): void {
  for (const timer of timers) clearInterval(timer);
  timers = [];
  driving = false;
}

/** Start or stop the two intervals, so they exist exactly while a run is in flight and somebody is
 *  looking. Called after every change, and idempotent. */
function arm(): void {
  const wanted = listeners.size > 0 && runInFlight(snapshot.run);
  if (wanted === driving) return;
  if (!wanted) {
    stopTimers();
    return;
  }
  driving = true;
  timers = [
    setInterval(() => {
      void (async () => {
        try {
          standbyRun = await fetchStandbyRun();
          recompute();
        } catch {
          /* expected twice over — there may be no deputy, and the bridge is restarting */
        }
      })();
    }, STANDBY_POLL_MS),
    setInterval(() => void readUpdateState(), FRONT_POLL_MS),
  ];
}

export function subscribeUpdateRun(listener: () => void): () => void {
  const first = listeners.size === 0;
  listeners.add(listener);
  if (first && !snapshot.checked) void readUpdateState();
  arm();
  return () => {
    listeners.delete(listener);
    arm();
  };
}

/** The store, as a hook. The one way a component reads it. */
export function useUpdateRun(): UpdateRunSnapshot {
  return useSyncExternalStore(subscribeUpdateRun, getUpdateRunSnapshot, getUpdateRunSnapshot);
}

/** Test seam. Module-scoped state outlives a `render()`, so a suite that did not reset it would
 *  carry one case's run into the next. */
export function __resetUpdateRunStore(): void {
  stopTimers();
  snapshot = EMPTY;
  checkRun = undefined;
  pollRun = undefined;
  standbyRun = undefined;
}
