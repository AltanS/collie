import { useSyncExternalStore } from "react";

import { fetchStandbyRun, fetchUpdateState } from "./api";
import { getUpdateStarted, legsStillMoving, runInFlight, subscribeUpdateStarted } from "./update-ribbon";
import type { UpdateScreenCrewRun } from "./update-screen";
import type { UpdateCheckResponse, UpdateCrewMember, UpdateInfo, UpdateRun } from "./types";

// ── ONE POLL FOR THE WHOLE UPDATE SUBJECT ───────────────────────────────────────────────────────
//
// ONE poll for that subject, and not one per surface: `.adr/0044`, which carries the dated
// incidents the split produced.
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
//
// ── A RUN THAT MOVES ONLY THE MEMBERS RIDES THE STATUS, NOT A RECORD (M32) ───
// A peers-only run writes no record on the lead, so none of the three run sources above carries it.
// Its legs ride the status instead (`peers`, `settledAt`, `peersTo`), and both the snapshot poll and
// this store's own `GET /api/update/check` read that status. So the store takes the legs from BOTH
// and keeps the LATER reading: the two are one composer on the bridge, read at two moments, so the
// later reading is simply the later reading. "Later" is when the snapshot ARRIVED, and when this
// store's own read was ASKED: that read is fetched once when the first reader subscribes and answers
// whenever it answers, and an answer to a question asked before the crew moved must never overwrite
// a poll that has already seen it move.
//
// Nothing new polls for it. The snapshot poll already goes hot while the crew moves
// (`hooks/use-polling.ts`), and `routes/root.tsx` hands every snapshot over. Which of those legs are
// a crew-only run is the reducer's decision, not this file's.
//
// ONE BEAT IS NOBODY'S, and this store fills it. The confirm's 202 comes back before the lead's first
// sweep has folded the run it just began, and the bridge sends no legs at all until then. A device
// that has just asked for a peers-only run would see the PREVIOUS run's settled legs, or nothing, and
// the takeover would arrive one poll late, or flash last run's failure first. So the card calls
// {@link noteCrewRunBegun}, and until the first legs of the NEW run arrive, for at most
// {@link CREW_BEGUN_MS}, the store answers "a crew run with no legs yet" and sets aside the reading it
// held at the tap. That reading is the old run's, and the bridge's own `begin` just cleared it.
//
// That beat is a SECOND piece of state beside the polls. It is bounded, it lives in this one place,
// and it expires on its own. A third piece of state would be the signal that "one reducer and one
// shared poll" (ADR 0044) has stopped describing the screen.

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

/**
 * How long the beat after this device's own peers-only confirm may last with no legs (M32).
 *
 * The lead's first sweep folds the run within a second or two, and the snapshot poll is at most one
 * idle gap behind it. Twenty seconds is three of those gaps with room to spare. Past it, a run that
 * never produced a leg stops holding the screen: the takeover must never outlive the thing it shows.
 */
export const CREW_BEGUN_MS = 20_000;

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
   * Did the LAST read of `GET /api/update/check` fail (a timeout, the network, a non-2xx)? That is
   * not the same fact as `check.preflight === null`, which is the bridge ANSWERING that it could not
   * run the preflight (issue 400). A failed read says nothing about this machine; the card shows
   * "couldn't reach the bridge" and a Retry, and never the preflight's own sentence.
   */
  readonly readFailed: boolean;
  /**
   * Has ANY source said anything about the run: the front door, the snapshot, the standby door or a
   * 202? `checked` is true after a failed read too, which is right for the card and wrong for update
   * mode: a document that boots during the restart gap has heard nothing, and must not read that as
   * "there is no run" (ADR 0064).
   */
  readonly answered: boolean;
  /**
   * What this machine is called, or null while nothing has said.
   *
   * Published by `routes/root.tsx` off the snapshot's roster ({@link noteLeadName}), because the
   * update screen is mounted outside that router and the solo toast names the MACHINE rather than a
   * crew that does not exist.
   */
  readonly leadName: string | null;
  /**
   * The legs that ride the STATUS rather than a run record, or null when it carries none (M32). On a
   * peers-only run they are the whole run; see the header. The reducer decides what they are.
   */
  readonly crewRun: UpdateScreenCrewRun | null;
}

const EMPTY: UpdateRunSnapshot = {
  check: undefined,
  run: undefined,
  crew: [],
  checked: false,
  readFailed: false,
  answered: false,
  leadName: null,
  crewRun: null,
};

let snapshot: UpdateRunSnapshot = EMPTY;
let checkRun: UpdateRun | undefined;
let pollRun: UpdateRun | undefined;
let standbyRun: UpdateRun | undefined;
const listeners = new Set<() => void>();

/** One reading of the status legs, and when it was taken: a snapshot when it arrived, this store's
 *  own read when it was asked. See the header. */
interface CrewReading {
  readonly crew: UpdateScreenCrewRun | null;
  readonly at: number;
}

let snapshotCrew: CrewReading | undefined;
let checkCrew: CrewReading | undefined;
/** This device's own peers-only confirm, while no leg of the run it began has arrived. */
let begun: { readonly at: number; readonly current: string } | null = null;
/** The reading held at that confirm: the PREVIOUS run's legs, set aside until the new run's arrive. */
let setAside: string | null = null;
let begunTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The legs a status carries at the top level, or null when it carries none.
 *
 * Only the top level: legs the lead's own record owns ride `run.peers` and belong to that run's own
 * reading. Exported for the test, which pins what a status with and without `peersTo` becomes.
 */
export function crewRunOf(update: UpdateInfo | undefined): UpdateScreenCrewRun | null {
  const legs = update?.peers;
  if (update === undefined || legs === undefined) return null;
  return { legs, settledAt: update.settledAt ?? null, to: update.peersTo ?? null, current: update.current };
}

/** What one reading SAYS, for comparing two of them. The receipt time is not part of it. */
function crewKey(crew: UpdateScreenCrewRun | null): string | null {
  return crew === null ? null : JSON.stringify(crew);
}

/** The status legs, reconciled: the later of the two readings, then the beat after a confirm. */
function reconcileCrew(now: number): UpdateScreenCrewRun | null {
  const newest =
    snapshotCrew === undefined || (checkCrew !== undefined && checkCrew.at > snapshotCrew.at) ? checkCrew : snapshotCrew;
  let crew = newest?.crew ?? null;
  // The old run's legs, still in a reading (a poll that left before the confirm and landed after it).
  // Not the run this device just began, so it says nothing.
  if (crew !== null && setAside !== null && crewKey(crew) === setAside) crew = null;
  if (crew !== null) {
    // The new run has spoken. The beat is over, and so is the setting aside.
    setAside = null;
    begun = null;
  }
  if (begun !== null) {
    if (now - begun.at < CREW_BEGUN_MS) return { legs: [], settledAt: null, to: begun.current, current: begun.current };
    begun = null;
  }
  return crew;
}

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
  const crewRun = reconcileCrew(Date.now());
  const next: UpdateRunSnapshot = {
    check: snapshot.check,
    run,
    crew: snapshot.check?.crew ?? [],
    checked: snapshot.checked,
    readFailed: snapshot.readFailed,
    answered: snapshot.answered || run !== undefined || snapshotCrew !== undefined,
    leadName: snapshot.leadName,
    // The same object while it says the same thing, so a poll that changed nothing about the crew
    // does not hand every reader a new one.
    crewRun: crewKey(crewRun) === crewKey(snapshot.crewRun) ? snapshot.crewRun : crewRun,
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

/**
 * The snapshot poll's own status, handed over by whatever reads the router, for its top-level legs
 * (M32). Stamped on receipt; the store tells listeners only when what the crew says has changed.
 */
export function noteSnapshotCrew(update: UpdateInfo | undefined): void {
  const crew = crewRunOf(update);
  const before = snapshot.crewRun;
  snapshotCrew = { crew, at: Date.now() };
  if (crewKey(reconcileCrew(Date.now())) !== crewKey(before)) recompute();
}

/**
 * This device's own peers-only confirm was accepted (M32). The run it began has no legs yet, and the
 * legs on screen are the previous run's: see the header. `current` is the lead's version, which is
 * what a peers-only run levels every member to.
 */
export function noteCrewRunBegun(current: string): void {
  begun = { at: Date.now(), current };
  setAside = crewKey(snapshot.crewRun);
  // The beat ends on its own even if nothing else changes, so a run that never produced a leg can
  // never hold the screen past it.
  if (begunTimer !== undefined) clearTimeout(begunTimer);
  begunTimer = setTimeout(() => {
    begunTimer = undefined;
    recompute();
  }, CREW_BEGUN_MS);
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

/**
 * How long the card's own read may take before it gives up (issue 400). The bridge can need most of
 * 40 s to answer it: 5 s for the release check, 5 s for the crew sweep and 30 s for a fresh preflight
 * when its 60 s cache has expired. The client's default GET leash is 10 s, so the card used to
 * report "could not be run" about a bridge that was still working on the answer.
 */
export const READ_TIMEOUT_MS = 45_000;

/**
 * The wait before each automatic retry of a failed read, while a card is mounted. The last entry
 * repeats. Growing, so a bridge that is down is not asked every few seconds for an hour, and short
 * at first, so a read that lost one race is made good before the operator has looked twice.
 */
export const READ_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000];

/** Front-door reads in flight, so the poll interval never stacks a request on a slow one. */
let frontReads = 0;

/** Ask the front door now. Used on mount and on every settle — the preflight's answer after an
 *  update is a different answer from the one before it. */
export async function readUpdateState(signal?: AbortSignal): Promise<void> {
  const askedAt = Date.now();
  frontReads += 1;
  try {
    const check = await fetchUpdateState(signal, READ_TIMEOUT_MS);
    checkRun = check.run;
    checkCrew = { crew: crewRunOf(check), at: askedAt };
    snapshot = { ...snapshot, check, checked: true, readFailed: false, answered: true };
    retryAttempt = 0;
    clearRetryTimer();
  } catch {
    // A failed read is not an error to render as a verdict: the versions come from the snapshot
    // anyway, and the preflight simply stays unknown. It is recorded as its own fact (issue 400),
    // so the card can say the bridge was not reached, and a mounted card asks again.
    //
    // A read that a caller aborted (the card left, or asked again) is not a failure of the bridge.
    const aborted = signal?.aborted === true;
    snapshot = { ...snapshot, checked: true, readFailed: aborted ? snapshot.readFailed : true };
    if (!aborted) scheduleRetry();
  } finally {
    frontReads -= 1;
  }
  recompute();
}

// ── THE RETRY OF A FAILED READ (issue 400) ──────────────────────────────────────────────────────
//
// The card asked once when it opened, and a read that failed left the button blocked until the page
// was reloaded. While a card is mounted and the last read failed, ask again after a growing wait.
// One timer, one request: the next wait starts when the last request has ended, so reads never
// overlap, and a success or the card leaving stops it.

let retryUsers = 0;
let retryAttempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryRead: Promise<void> | undefined;

function clearRetryTimer(): void {
  if (retryTimer !== undefined) clearTimeout(retryTimer);
  retryTimer = undefined;
}

function scheduleRetry(): void {
  if (retryUsers === 0 || retryTimer !== undefined || retryRead !== undefined) return;
  const delay = READ_RETRY_DELAYS_MS[Math.min(retryAttempt, READ_RETRY_DELAYS_MS.length - 1)]!;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    retryAttempt += 1;
    void retryUpdateRead();
  }, delay);
}

/**
 * Read again now, for the card's Retry button and for the timer. Joins a retry already in flight
 * rather than starting a second one. A manual call starts the schedule over.
 */
export function retryUpdateRead(manual = false): Promise<void> {
  if (manual) {
    retryAttempt = 0;
    clearRetryTimer();
  }
  if (retryRead !== undefined) return retryRead;
  const read = readUpdateState().finally(() => {
    retryRead = undefined;
    // The failure inside the read could not schedule while this one was still marked in flight.
    if (snapshot.readFailed) scheduleRetry();
  });
  retryRead = read;
  return read;
}

/**
 * A card is mounted and wants a failed read made good. Returns the stop: when the last card leaves,
 * the pending timer goes. Nothing is asked here; the read that fails is what starts the schedule, and
 * a read that had already failed before the card mounted starts it now.
 */
export function holdReadRetry(): () => void {
  retryUsers += 1;
  if (snapshot.readFailed) scheduleRetry();
  return () => {
    retryUsers -= 1;
    if (retryUsers > 0) return;
    retryAttempt = 0;
    clearRetryTimer();
  };
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
  // A CLAIM ASKS TOO (ADR 0064). A document that boots holding one, mid-restart, knows of no run yet:
  // without this it would never ask the standby door, the one reader that answers in that window.
  const wanted = listeners.size > 0 && (runInFlight(snapshot.run) || crewStillMoving() || getUpdateStarted() !== null);
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
    // Not on top of a read that has not ended: its leash is 45 s now, and a dark network would
    // otherwise stack a request every four seconds behind it.
    setInterval(() => {
      if (frontReads === 0) void readUpdateState();
    }, FRONT_POLL_MS),
  ];
}

/**
 * Whether the CREW half of the subject is still moving, asked of the reconciled legs (M32).
 *
 * ── WHY THE LEAD'S OWN RUN IS NOT THE WHOLE QUESTION (2026-09-20) ────────────
 * A crew update is two phases, and `arm` used to watch only the first. The lead updates itself,
 * writes `done`, and the members are levelled AFTER that — so on the 1.11.0 run the lead's record
 * reached `done` in six seconds and this store stopped polling before the crew phase had begun.
 *
 * That is not only a stale screen. `GET /api/update/check` is what makes the lead sweep carrying
 * `X-Crew-Preflight: fresh`, and a member whose banked verdict is unknown is refused its turn
 * (`bridge/crew/follow.ts`, `eligible`). So a phone that stops asking can leave a member sitting on
 * `waiting` with nothing on either machine saying why. Measured on the real crew: the lead granted
 * at 13:50:23, workshop was told at 13:52:48, and did the work in four seconds.
 *
 * `hooks/use-polling.ts` already reads the subject this way (`runInFlight(...) || crewMoving(...)`).
 * This is the same question, asked of the legs this store has already reconciled — and it must be
 * asked of THOSE, not of `snapshot.check`, because `check` is refreshed by the very poll this
 * decides to run. The legs come from the snapshot poll, which is hot on its own account, so the
 * condition can never latch itself off.
 */
function crewStillMoving(): boolean {
  const crew = snapshot.crewRun;
  if (crew !== null && legsStillMoving(crew.legs, crew.settledAt)) return true;
  // THE LEAD'S OWN RUN, AFTER ITS OWN `done` (ADR 0064). Its members ride its record, and update mode
  // stays on step 5 while one of them moves, so the front door is asked for as long as they do.
  const run = snapshot.run;
  return run !== undefined && legsStillMoving(run.peers ?? [], run.settledAt ?? null);
}

// The claim comes and goes on its own store; the intervals follow it.
subscribeUpdateStarted(() => arm());

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
  snapshotCrew = undefined;
  checkCrew = undefined;
  begun = null;
  setAside = null;
  retryUsers = 0;
  retryAttempt = 0;
  retryRead = undefined;
  clearRetryTimer();
  frontReads = 0;
  if (begunTimer !== undefined) clearTimeout(begunTimer);
  begunTimer = undefined;
}
