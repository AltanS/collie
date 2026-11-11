import { useEffect, useMemo, useSyncExternalStore } from "react";

import { apiErrorStatus, fetchTrickViews } from "@/lib/api";
import { bareAddress } from "@/lib/walky";

import { viewTurnText } from "./reader";
import type { TrickViewSession, TrickViewsAnswer } from "./wire";

// AGENT VIEWS, HELD ON THE PHONE: every view of the sessions the phone shows, keyed by (trick, session),
// with its switch, its screen and the lines the bridge sent from it, in one small store read with
// `useSyncExternalStore`. Modelled on the hill's store (lib/hill/store.ts).
//
// ── ONLY THE SESSIONS THE PHONE SHOWS ────────────────────────────────────────────────────────────
// A session screen says it shows a session (`useShowAgentViews`) while it is mounted. Every read names
// those sessions (`GET /api/trick-views?session=...`), and the store keeps the views of those sessions
// alone. A read with `since` is only asked for the same set the held list is for; a set that gained a
// session reads its views whole. With no session shown nothing is read. An older bridge that answers
// every view is narrowed here by the same rule.
//
// ── ONE READ SAYS WHETHER THE BRIDGE HAS AGENT VIEWS ─────────────────────────────────────────────
// The first read for a shown session is a whole read. A 200 is a bridge that has them; a 404 is one that
// does not, and no switch is offered. `trickViewsRev` cannot say it: a fresh bridge sends no number until
// a view exists. Any other failure leaves the question open, and the next snapshot asks again. A snapshot
// that does carry a number proves agent views, so a "no" is asked again then.
//
// ── THEN THE SNAPSHOT SAYS WHEN TO READ ──────────────────────────────────────────────────────────
// The bridge moves `trickViewsRev` on every switch and every write. The root loader hands it to
// `syncAgentViews` on every live snapshot: the store reads `?since=<held rev>` when the number differs
// from the one it holds. A number BELOW the held one is a bridge that restarted: a whole read. A snapshot
// with no number reads nothing and keeps what is held. One read at a time; a newer number named while a
// read is in flight is read once the first answer is in. A failed read leaves the held list alone.
//
// ── THE FAST READ, WHILE A SCREEN IS IN WORK ─────────────────────────────────────────────────────
// A screen built block by block moves the number several times a second, faster than the snapshot
// comes. While an agent view is on screen and its session is busy (the agent drawing or working, a
// request not answered yet, or a change in the last {@link VIEW_FAST_QUIET_MS}), the view holds the fast
// read (`useAgentViewLive`). ONE app timer then reads every {@link VIEW_FAST_MS}, whatever number of views
// hold it, for every trick's view of the shown sessions at once. It reads nothing while another read is
// in flight, stops while the page is hidden, and stops when nothing holds it or everything is quiet.
// After {@link VIEW_FAST_FAILURES} failed reads in a row it waits twice as long per further failure, up
// to {@link VIEW_FAST_BACKOFF_MAX_MS}; one good read sets it back. A snapshot that lags behind the fast read
// (below the held number, and not below the last snapshot's) is not a restart: it reads nothing.
//
// ── A SESSION IS ITS WALKY ADDRESS ───────────────────────────────────────────────────────────────
// The wire keys a view by the pane's walky address, which may carry the session's `#<instance>` token. A
// held view answers for an address when the two are equal, or when one of them has no token and both
// name the same pane. A held address with ANOTHER token is another session in the same pane.

interface Held {
  /** The revision of the views held, or null when none are. */
  rev: number | null;
  /** By {@link viewKey}. */
  views: ReadonlyMap<string, TrickViewSession>;
  /** Every line the bridge sent from a held view: the turns Chat draws without the view's wording. */
  sent: ReadonlySet<string>;
  /** The shown sessions the held views are for ({@link setKey}), or null before the first read. */
  covers: string | null;
}

const NO_VIEWS: ReadonlyMap<string, TrickViewSession> = new Map();
const NO_SENT: ReadonlySet<string> = new Set();
const EMPTY: Held = { rev: null, views: NO_VIEWS, sent: NO_SENT, covers: null };

let held: Held = EMPTY;
/** The newest revision a snapshot named, or null while none has. */
let wanted: number | null = null;
/** Whether the bridge has agent views, from the first whole read (the top of this file). */
let support: "unknown" | "yes" | "no" = "unknown";
let reading = false;
/** Counts the times the store was emptied; a read that lands under another count is dropped. */
let generation = 0;
/** The read loop in flight, for a test to wait on. */
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();
/** The number the last snapshot named, to tell a lagging snapshot from a restarted bridge. */
let snapshotRev: number | null = null;
/** Each session screen that shows a session, and the session's address. */
const shownBy = new Map<symbol, string>();
/** A read asked for now, whatever the numbers say (a tap the bridge refused as stale). */
let forced = false;

/** The fast read's pace, in ms. */
export const VIEW_FAST_MS = 800;
/** How long after the last change a held fast read keeps going without a busy view. */
export const VIEW_FAST_QUIET_MS = 20_000;
/** Failed fast reads in a row before the pace slows. */
export const VIEW_FAST_FAILURES = 3;
/** The slowest the fast read gets while it fails. */
export const VIEW_FAST_BACKOFF_MAX_MS = 15_000;
/** The most sessions one read names: the bridge's own cap. */
export const VIEW_READ_SESSIONS_MAX = 16;

/** Each view holding the fast read, and whether its session is busy now. */
const fastHolders = new Map<symbol, boolean>();
let fastTimer: ReturnType<typeof setTimeout> | null = null;
let fastFailures = 0;
/** When a read last brought a new number, in ms since the epoch, or null. */
let changedAt: number | null = null;

/** One view's key: the trick and the session. */
export function viewKey(trick: string, session: string): string {
  return `${trick}\u0000${session}`;
}

/** Whether a held view's session answers for an address, by the rule at the top of this file. */
export function sessionAnswers(own: string, address: string): boolean {
  if (own === address) return true;
  const ownBare = bareAddress(own);
  const askedBare = bareAddress(address);
  if (ownBare !== askedBare) return false;
  return ownBare === own || askedBare === address;
}

/** The shown sessions, in a stable order, at most {@link VIEW_READ_SESSIONS_MAX}. */
function shownSessions(): string[] {
  return [...new Set(shownBy.values())].toSorted().slice(0, VIEW_READ_SESSIONS_MAX);
}

function setKey(sessions: readonly string[]): string {
  return sessions.join("\n");
}

function sentOf(views: ReadonlyMap<string, TrickViewSession>): ReadonlySet<string> {
  const lines = [...views.values()].flatMap((view) => (view.sent ?? []).map((item) => item.line));
  return lines.length === 0 ? NO_SENT : new Set(lines);
}

function publish(next: Omit<Held, "sent"> & { sent?: ReadonlySet<string> }): void {
  if (next.rev !== held.rev) changedAt = Date.now();
  held = { ...next, sent: next.views === held.views ? held.sent : sentOf(next.views) };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Tell every reader; for a change no held list carries (the support answer). */
function notify(): void {
  for (const listener of listeners) listener();
}

/** The views of an answer that belong to the shown sessions. */
function ofShown(views: readonly TrickViewSession[], sessions: readonly string[]): TrickViewSession[] {
  return views.filter((view) => sessions.some((shown) => sessionAnswers(view.session, shown)));
}

/** Take an answer the bridge served for these sessions. A whole answer replaces; a `since` answer merges by its keys. */
function take(answer: TrickViewsAnswer, sessions: readonly string[]): void {
  const covers = setKey(sessions);
  if (answer.unchanged === true) {
    if (held.rev !== answer.rev) publish({ ...held, rev: answer.rev });
    return;
  }
  const incoming = ofShown(answer.views, sessions);
  if (answer.keys === undefined) {
    publish({ rev: answer.rev, views: new Map(incoming.map((view) => [viewKey(view.trick, view.session), view])), covers });
    return;
  }
  const present = new Set(answer.keys.map((key) => viewKey(key.trick, key.session)));
  const views = new Map([...held.views].filter(([key]) => present.has(key)));
  for (const view of incoming) views.set(viewKey(view.trick, view.session), view);
  publish({ rev: answer.rev, views, covers });
}

/** The `since` a read may name: the held rev, for the same sessions only, and only below the target. */
function sinceFor(sessions: readonly string[], target: number | null): number | undefined {
  if (held.rev === null || held.covers !== setKey(sessions)) return undefined;
  if (target !== null && target < held.rev) return undefined;
  return held.rev;
}

/** Whether the held list is what the shown sessions and the wanted number ask for. */
function current(sessions: readonly string[]): boolean {
  return !forced && held.covers === setKey(sessions) && (wanted === null || wanted === held.rev);
}

/** Read until the held list is current, one read at a time. */
async function readUntilCurrent(): Promise<void> {
  if (reading) return;
  reading = true;
  try {
    // Bounded: each pass either reaches the wanted list or stops on a failed read.
    for (let pass = 0; pass < 4; pass += 1) {
      const sessions = shownSessions();
      if (sessions.length === 0 || current(sessions)) return;
      const target = wanted;
      const since = sinceFor(sessions, target);
      const startedIn = generation;
      forced = false;
      let answer: TrickViewsAnswer;
      try {
        answer = await fetchTrickViews({ since, sessions });
      } catch (thrown) {
        if (startedIn !== generation) continue;
        if (support === "unknown" && apiErrorStatus(thrown) === 404) {
          support = "no";
          notify();
        }
        return;
      }
      if (startedIn !== generation) continue;
      if (support !== "yes") {
        support = "yes";
        notify();
      }
      take(answer, sessions);
      // A whole read is the bridge's own truth: its number is the one to hold.
      if (since === undefined && wanted === target) wanted = answer.rev;
      if (wanted === null || answer.rev > wanted) wanted = answer.rev;
    }
  } finally {
    reading = false;
    // A change read here may wake a quiet hold on the fast read.
    scheduleFast();
  }
}

/** Start a read when one is due and none is in flight. */
function kick(): void {
  if (reading) return;
  if (support === "no" && !forced) return;
  const sessions = shownSessions();
  if (sessions.length === 0 || current(sessions)) return;
  inFlight = readUntilCurrent();
}

/**
 * The root loader's call on every live snapshot, with the snapshot's `trickViewsRev`. Reads the views of
 * the shown sessions when the number moved; asks again whether the bridge has agent views on a number.
 */
export function syncAgentViews(rev: number | undefined): void {
  if (rev !== undefined) {
    const lagging = held.rev !== null && rev < held.rev && snapshotRev !== null && rev >= snapshotRev;
    snapshotRev = rev;
    wanted = lagging ? held.rev : rev;
    // A number proves agent views: a "no" from an older bridge is asked again.
    if (support === "no") support = "unknown";
    // A number below the held one, not a lag, is a restarted bridge: read whole.
    if (!lagging && held.rev !== null && rev < held.rev) publish({ ...held, covers: null });
  }
  kick();
}

/** Read the shown sessions' views now, whatever the numbers say: after a tap the bridge refused as stale. */
export function refetchAgentViews(): Promise<void> {
  forced = true;
  kick();
  return inFlight ?? Promise.resolve();
}

/** A session screen shows this session: its views are read while the screen is mounted. The returned function lets go. */
export function showAgentViews(address: string): () => void {
  const key = Symbol("agent-view-shown");
  shownBy.set(key, address);
  kick();
  return () => {
    shownBy.delete(key);
    // Fewer sessions: the held list is narrowed in place, nothing is read.
    const sessions = shownSessions();
    if (sessions.length === 0 || held.covers === null) return;
    const views = new Map([...held.views].filter(([, view]) => sessions.some((shown) => sessionAnswers(view.session, shown))));
    publish({ ...held, views: views.size === held.views.size ? held.views : views, covers: setKey(sessions) });
  };
}

/** Show a session's views for as long as the caller is mounted and `enabled`. */
export function useShowAgentViews(address: string, enabled: boolean): void {
  useEffect(() => (enabled ? showAgentViews(address) : undefined), [address, enabled]);
}

/** Whether the fast read should run now: a view holds it, the page shows, and one is busy or changed lately. */
function fastWanted(): boolean {
  if (fastHolders.size === 0 || support !== "yes" || shownBy.size === 0) return false;
  if (document.visibilityState === "hidden") return false;
  if ([...fastHolders.values()].some((busy) => busy)) return true;
  return changedAt !== null && Date.now() - changedAt < VIEW_FAST_QUIET_MS;
}

/** The wait before the next fast read: the pace, slowed after repeated failures. */
function fastDelay(): number {
  if (fastFailures < VIEW_FAST_FAILURES) return VIEW_FAST_MS;
  return Math.min(VIEW_FAST_MS * 2 ** (fastFailures - VIEW_FAST_FAILURES + 1), VIEW_FAST_BACKOFF_MAX_MS);
}

/** Arm the one timer when the fast read is wanted and none is armed; disarm it when it is not wanted. */
function scheduleFast(): void {
  if (!fastWanted()) {
    if (fastTimer !== null) clearTimeout(fastTimer);
    fastTimer = null;
    return;
  }
  if (fastTimer !== null) return;
  fastTimer = setTimeout(() => {
    fastTimer = null;
    inFlight = fastRead();
  }, fastDelay());
}

/** One fast read, unless a read is in flight; then the next one is armed. */
async function fastRead(): Promise<void> {
  if (!fastWanted()) return;
  if (reading) {
    scheduleFast();
    return;
  }
  const sessions = shownSessions();
  reading = true;
  const startedIn = generation;
  try {
    const answer = await fetchTrickViews({ since: sinceFor(sessions, null), sessions });
    if (startedIn !== generation) return;
    fastFailures = 0;
    take(answer, sessions);
    if (wanted === null || answer.rev > wanted) wanted = answer.rev;
  } catch {
    if (startedIn === generation) fastFailures += 1;
  } finally {
    reading = false;
  }
  if (startedIn !== generation) return;
  // A snapshot that named a newer number while this read was in flight is read now.
  if (!current(shownSessions())) await readUntilCurrent();
  scheduleFast();
}

function onVisibility(): void {
  scheduleFast();
}

/**
 * Hold the fast read while this view is on screen. `busy` is whether its session is in work now: the
 * agent drawing or working, or a request not answered yet. The returned function lets go.
 */
export function holdAgentViewFast(busy: boolean): () => void {
  const key = Symbol("agent-view-fast");
  if (fastHolders.size === 0) document.addEventListener("visibilitychange", onVisibility);
  fastHolders.set(key, busy);
  scheduleFast();
  return () => {
    fastHolders.delete(key);
    if (fastHolders.size === 0) document.removeEventListener("visibilitychange", onVisibility);
    scheduleFast();
  };
}

/** A view's hold on the fast read, for as long as it is mounted; `busy` as {@link holdAgentViewFast} takes it. */
export function useAgentViewLive(busy: boolean): void {
  useEffect(() => holdAgentViewFast(busy), [busy]);
}

/** Every held view of one session, in the order the bridge listed them. */
export function viewsOf(views: ReadonlyMap<string, TrickViewSession>, address: string): TrickViewSession[] {
  return [...views.values()].filter((view) => sessionAnswers(view.session, address));
}

/**
 * Keep what one switch came to, until the next read: the view the bridge sent back. A view switched on
 * turns every other view of that session off here too, as the bridge did (one view on per session).
 */
export function noteAgentViewSwitch(answered: TrickViewSession): void {
  const views = new Map(held.views);
  if (answered.on) {
    for (const [key, view] of views) {
      if (view.trick === answered.trick || !view.on || !sessionAnswers(view.session, answered.session)) continue;
      const off: TrickViewSession = { trick: view.trick, session: view.session, on: false, off: "switch" };
      if (view.sent !== undefined) off.sent = view.sent;
      views.set(key, off);
    }
  }
  views.set(viewKey(answered.trick, answered.session), answered);
  publish({ ...held, views });
}

/** Every held view of one session, or none (no view of it is held). */
export function useAgentViewsOf(address: string): readonly TrickViewSession[] {
  const views = useSyncExternalStore(
    subscribe,
    () => held.views,
    () => NO_VIEWS,
  );
  return useMemo(() => viewsOf(views, address), [views, address]);
}

/** Whether the bridge this phone reads has agent views: its first whole read answered 200. */
export function useAgentViewsAvailable(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => support === "yes",
    () => false,
  );
}

/** A person turn as Chat draws it: without the view's head and tail only when the bridge sent that exact line ({@link viewTurnText}). */
export function useViewTurnText(text: string): string {
  const sent = useSyncExternalStore(
    subscribe,
    () => held.sent,
    () => NO_SENT,
  );
  return useMemo(() => viewTurnText(text, sent), [text, sent]);
}

/** Forget everything. For tests, which share one module between cases. */
export function __resetAgentViews(): void {
  wanted = null;
  snapshotRev = null;
  changedAt = null;
  fastFailures = 0;
  if (fastTimer !== null) clearTimeout(fastTimer);
  fastTimer = null;
  support = "unknown";
  generation += 1;
  reading = false;
  forced = false;
  inFlight = null;
  shownBy.clear();
  publish(EMPTY);
}

/** Wait for the read in flight, if any. For tests. */
export async function __settleAgentViews(): Promise<void> {
  // A read may start another on its way out (a newer number came in): wait for each, a few at most.
  for (let i = 0; i < 4; i += 1) {
    const now = inFlight;
    if (now === null) return;
    await now;
    if (inFlight === now) return;
  }
}
