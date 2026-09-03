import { useEffect, useRef } from "react";
import { useRevalidator } from "react-router";

import { refreshNow } from "@/lib/api";
import { isLongUpload } from "@/lib/connection-health";
import { beginCatchUp, endCatchUp, isLocked, useLocked } from "@/lib/idle";
import {
  burstAppliesTo,
  consumeTopologyPoll,
  useBurstPaneId,
  useFollowing,
  useLastPollChanged,
  useSendCount,
  useTopologyBursting,
} from "@/lib/poll-intent";
import type { HomeData } from "@/lib/loaders";
import type { Scope } from "@/lib/scope";

// Adaptive polling, the React Router way: a timer that calls `revalidator.revalidate()`, which
// re-runs every active loader (snapshot + the open pane) — our equivalent of a refetch interval.
//  - the gap is resolved from what the OPERATOR is doing, not from what the herd is doing: a burst
//    right after a send, a fast gap while they follow something that is moving, a slow one when
//    nothing says anybody is watching (see `intervalFor` for the five rules);
//  - skipped only while the tab is hidden (battery); it deliberately does NOT gate on
//    navigator.onLine (that flag lies on some phones and would wedge polling forever — see the tick),
//    and it's kicked immediately on focus/online/visibility as an accelerator.
//
// WHY IT IS SHAPED THIS WAY (#156). The cadence used to be one dial with two positions — 1.5s while
// anything anywhere was working or a pane was open, 4s otherwise — and both positions were a guess
// about the operator. The guess was wrong in both directions at once: a key you just pressed still
// waited up to 1.5s to show its effect, while a pane nobody was looking at was polled every 4s
// forever. The dial is gone. What replaced it is resolved from what is actually observable — did you
// just send something, is the mirror still changing, are you still on the live tail.
//
// Every constant is exported so the tests can pin the CADENCE BEHAVIOUR against it rather than
// against a number typed twice.
//
/** The gap during a burst — the few beats after a send, while the operator is watching their own
 *  keystroke land. Short enough that a key reads as immediate; spent only on the open pane, and only
 *  for the handful of polls the burst rules allow (lib/poll-intent.ts). */
export const BURST_MS = 300;
/** The gap while the operator follows a pane that has something to show — its agent is working, or
 *  its mirror moved on the last poll. */
export const HOT_MS = 1500;
/** The home screen while an agent somewhere is working or blocked. Nobody is on a mirror, so there
 *  is nothing to keep smooth; the herd's row still has to reflect a status change without feeling
 *  stuck. */
export const HOME_BUSY_MS = 4000;
/** The gap when nothing says anybody is watching: a home screen over an idle herd, a pane scrolled
 *  back into history, a pane whose agent is idle and whose mirror has stopped moving. SLOWER than
 *  the old resting gap on purpose — that is the half of the trade that pays for the burst. */
export const IDLE_MS = 6000;

/**
 * Everything the cadence needs that the snapshot cannot tell us, as plain values.
 *
 * Passed in rather than read here so `intervalFor` stays pure and directly testable: the hook reads
 * the store (lib/poll-intent.ts) and hands over primitives.
 */
export interface PollIntent {
  /** A burst is running AND it belongs to the pane currently open (see `burstApplies`). */
  bursting: boolean;
  /** The pane view is pinned to the live tail. True when no pane is open. */
  following: boolean;
  /** The last pane read came back with new content (a 200 with a body we hadn't seen) rather than
   *  an ETag hit. */
  changed: boolean;
  /** A create or a close just went through and hasn't yet spent its catch-up polls — see
   *  `lib/poll-intent.ts` → `stampTopology`. Unlike `bursting`, this applies wherever the operator
   *  is looking, not only on the pane a send went to. */
  topologyBursting?: boolean;
}

// Self-heal a wedged revalidation. Normally a tick no-ops while one is already in flight (see the
// idle fast-path below), but a black-holed fetch can stay `loading` forever (its timeout aside — the
// timer itself can freeze while the phone sleeps). Once a revalidation has been loading for longer
// than this — just past GET_TIMEOUT_MS (10s) as a belt-and-braces margin — a tick kicks a fresh
// revalidate() anyway: React Router aborts/supersedes the hung one (loaders treat that AbortError as
// "superseded"). We compare against wall-clock (Date.now), not a timer, precisely because timers can
// stop advancing during sleep — the age we care about is real elapsed time since the load began.
export const SUPERSEDE_MS = 12_000;

/**
 * Pure cadence resolver — exported so it can be unit-tested in isolation.
 *
 * The question is not "is anything happening anywhere" but "is the operator watching something
 * happen", answered in five rules, in order:
 *   1. a burst is running on the open pane → BURST_MS;
 *   2. the open pane is followed and its own agent is working/blocked → HOT_MS;
 *   3. the open pane is followed and the last poll brought new content → HOT_MS;
 *   4. no pane is open and some agent in the herd is working/blocked → HOME_BUSY_MS;
 *   5. otherwise → IDLE_MS.
 * Being hidden is not a rule here: the tick already refuses to fetch behind a hidden tab.
 *
 * `intent` is optional so a caller that only wants the herd-shaped answer (rules 4 and 5) can ask
 * without holding the store; an absent intent simply reads as no burst, not following, unchanged.
 */
export function intervalFor(
  data: HomeData | undefined,
  paneId?: string | null,
  intent?: PollIntent,
): number {
  // 0. A create or a close just went through, wherever you're looking: catch the list up.
  if (intent?.topologyBursting) return BURST_MS;

  // 1. A send just happened on the pane you are looking at: watch it land.
  if (intent?.bursting) return BURST_MS;

  // 2 and 3. You are on a pane, pinned to its tail, and it has something to show — either its agent
  // says so, or the mirror itself moved on the last poll. The second half is what covers a plain
  // shell and any harness that publishes no status: "the screen is still changing" needs no adapter.
  if (paneId && intent?.following && paneIsOpen(data, paneId)) {
    if (openPaneWorking(data, paneId)) return HOT_MS;
    if (intent.changed) return HOT_MS;
  }

  // 4. Nobody is on a mirror, but the herd is not resting. The dashboard row is the thing being
  // watched now, and a status that flips there should not sit a full IDLE_MS behind.
  if (!paneId && herdBusy(data)) return HOME_BUSY_MS;

  // 5. Nothing says anybody is watching this.
  return IDLE_MS;
}

/** Whether any agent anywhere in the herd is working or blocked. */
function herdBusy(data: HomeData | undefined): boolean {
  return data?.agents.some((a) => a.status === "working" || a.status === "blocked") ?? false;
}

/** Whether the open pane is one the snapshot still knows about — an agent or a shell. A pane that
 *  has gone has nothing left to poll for. */
function paneIsOpen(data: HomeData | undefined, paneId: string): boolean {
  const allPanes = [...(data?.agents ?? []), ...(data?.shellPanes ?? [])];
  return allPanes.some((p) => p.paneId === paneId);
}

/** Whether the OPEN pane's own agent is working or blocked. Deliberately not "any agent in the
 *  herd": under this cadence the question is what the operator is looking at, and another
 *  workspace's busy agent is answered by the notification path, not by polling faster. */
function openPaneWorking(data: HomeData | undefined, paneId: string): boolean {
  return (
    data?.agents.some(
      (a) => a.paneId === paneId && (a.status === "working" || a.status === "blocked"),
    ) ?? false
  );
}

/**
 * Come back to a fresh herd, not to whatever was true when the phone was put down.
 *
 * THE TWO MOMENTS THIS COVERS ARE THE SAME MOMENT to an operator: the page becoming visible again,
 * and the idle pause being released. Both are "I am looking at this now", and both previously did
 * nothing but revalidate — which re-reads the BRIDGE's snapshot, and the bridge's snapshot is only
 * as fresh as the multiplexer census behind it. Under an adapter that censuses, a tab opened while
 * the phone was in a pocket could therefore be up to its declared bound old at the very instant the
 * operator looked (ADR 0031).
 *
 * The refresh is fired and NOT awaited before the revalidation, deliberately. Awaiting it would make
 * every foreground a two-round-trip wait before anything on screen moved, to save a fraction of one
 * poll interval — the revalidation that follows the refresh's own poke is the one that carries the
 * change, and it arrives on its own. What the operator sees is the current data at once and the
 * corrected data a beat later, rather than a blank beat and then both.
 */
function lookNow(scope: Scope | undefined): void {
  void refreshNow(scope);
}

export function usePolling(
  data: HomeData | undefined,
  paneId?: string | null,
  scope?: Scope,
  following?: boolean,
): number {
  const revalidator = useRevalidator();
  // Held in a ref for the same reason the revalidator is: the tick effect must not re-subscribe
  // every time the viewed host or session changes identity.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  // Hold the revalidator in a ref so the effect only re-subscribes when the cadence changes,
  // not on every revalidation (its identity flips each cycle).
  const ref = useRef(revalidator);
  ref.current = revalidator;

  // Wall-clock timestamp of when the current revalidation began, or null when idle. Stamped on the
  // idle→loading edge and cleared on →idle, so a tick can tell how long a load has been in flight
  // (used to detect and supersede a wedged one). A ref, not state — it must not trigger re-renders.
  const loadingSince = useRef<number | null>(null);
  if (revalidator.state === "loading") {
    if (loadingSince.current === null) loadingSince.current = Date.now();
  } else {
    loadingSince.current = null;
  }

  // The cadence's inputs, read from the store the composer and the pane loader write to.
  const burstPane = useBurstPaneId();
  const storeFollowing = useFollowing();
  const changed = useLastPollChanged();
  const sendKick = useSendCount();
  const topoBursting = useTopologyBursting();
  const ms = intervalFor(data, paneId, {
    bursting: burstAppliesTo(burstPane, paneId),
    // The caller may own the flag directly (the tests do); otherwise the pane view's own follow
    // intent, published to lib/poll-intent, answers — and it is true whenever no pane is open.
    following: following ?? storeFollowing,
    changed,
    topologyBursting: topoBursting,
  });

  // Resuming from the idle lock must refetch AT ONCE. The route tree stays mounted through a pause
  // (see App), so unlocking re-runs no loaders by itself — without this the first thing you'd see on
  // resume is however stale the snapshot got while paused, for up to one full interval. Fires on the
  // falling edge only; `wasLocked` seeds from the current value so mounting never counts as a release.
  const locked = useLocked();
  const wasLocked = useRef(locked);
  useEffect(() => {
    const released = wasLocked.current && !locked;
    wasLocked.current = locked;
    if (!released) return;
    beginCatchUp(); // holds the cover through the refetch — see the settle effect below
    lookNow(scopeRef.current);
    if (ref.current.state === "idle") ref.current.revalidate();
  }, [locked]);

  // End the catch-up beat when the revalidator comes to rest. Keyed on the state itself, so it can't
  // fire on the loading edge: at release the state is still "idle" for one render, but `beginCatchUp`
  // has already run by the time this effect's dependency changes to "loading" and back.
  useEffect(() => {
    if (revalidator.state === "idle") endCatchUp();
  }, [revalidator.state]);

  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      // Idle-locked: the app is covered and nobody is reading it, so don't keep hitting the socket.
      // A live read (not a captured render value) because this fires from an interval — and unlike
      // the `navigator.onLine` trap below, this flag can't lie: it's set by our own lock, and
      // resuming re-runs every loader, so a pause can't strand the UI on stale data.
      if (isLocked()) return;
      // A long upload the operator started (a voice clip) is on the wire. A phone's uplink is the
      // narrow half of a mobile link, so a poll fired now does not arrive sooner — it queues behind
      // the audio and makes the audio slower. Skipped, not cancelled: the upload ends in seconds,
      // releasing it stamps a wake, and the very next tick reads a fresh snapshot.
      if (isLongUpload()) return;
      // Deliberately NO navigator.onLine gate here. On some phones the flag lies — it stuck FALSE
      // after an airplane-mode toggle even though the network was back — and gating the tick on it
      // wedged polling permanently: the app froze on "not connected" with a resting/bad-state dog and
      // a stale mirror forever, because it never fetched again to discover the network had returned. A
      // failed fetch on a genuinely dead connection is cheap and self-heals the instant it's back; the
      // focus/online/visibility listeners below only accelerate that first beat. Never STOP fetching
      // because a possibly-lying flag says offline.
      const r = ref.current;
      if (r.state === "idle") {
        consumeTopologyPoll();
        r.revalidate();
        return;
      }
      // Already loading: normally we leave it be, but a revalidation stuck past SUPERSEDE_MS is
      // almost certainly a black-holed fetch — kick a fresh one to supersede it and self-heal.
      const since = loadingSince.current;
      if (since !== null && Date.now() - since >= SUPERSEDE_MS) r.revalidate();
    };
    const id = window.setInterval(tick, ms);
    const onWake = () => tick();
    const onVisible = () => {
      if (document.hidden) return;
      // Coming back to the foreground is the operator saying "show me now" — see lookNow. `focus`
      // and `online` are deliberately NOT given one: a focus fires on every tap into the window and
      // `online` fires on a flag that is known to lie (see the tick), so either would spend a
      // listing on something that is not somebody returning to the app.
      lookNow(scopeRef.current);
      tick();
    };
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onWake);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onWake);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // `sendKick` is the reschedule: a send must not wait out the remainder of a gap that was timed
    // for an idle pane, so re-running this effect tears the old interval down and starts the next
    // one BURST_MS from the tap. It goes through the same `tick` as every other beat, so it still
    // cannot double-fire while a revalidation is in flight.
  }, [ms, sendKick]);

  return ms;
}
