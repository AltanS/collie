import { useEffect, useRef } from "react";
import { useRevalidator } from "react-router";

import { refreshNow } from "@/lib/api";
import { isLongUpload } from "@/lib/connection-health";
import { beginCatchUp, endCatchUp, isLocked, useLocked } from "@/lib/idle";
import type { HomeData } from "@/lib/loaders";
import type { Scope } from "@/lib/scope";

// Adaptive polling, the React Router way: a timer that calls `revalidator.revalidate()`, which
// re-runs every active loader (snapshot + the open pane) — our equivalent of a refetch interval.
//  - fast (1.5s) while any agent is active OR a pane is open (you're watching it live), slow (4s)
//    when idle on the home screen with no active work;
//  - skipped only while the tab is hidden (battery); it deliberately does NOT gate on
//    navigator.onLine (that flag lies on some phones and would wedge polling forever — see the tick),
//    and it's kicked immediately on focus/online/visibility as an accelerator.
// Exported so the tests can pin the CADENCE BEHAVIOUR against the constant rather than against a
// number typed twice: the tick fires at exactly this gap, and cooling switches the interval.
export const HOT_MS = 1500;
export const COLD_MS = 4000;

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
 * Returns HOT_MS when:
 *   - Any agent anywhere in the herd is `working` or `blocked`, OR
 *   - A pane detail is open (paneId is set) and that pane exists in agents ∪ shellPanes.
 *     A shell you've drilled into is implicitly "live" regardless of its status.
 *
 * Returns COLD_MS otherwise (home screen, idle herd, no pane open).
 */
export function intervalFor(data: HomeData | undefined, paneId?: string | null): number {
  const anyActive = data?.agents.some((a) => a.status === "blocked" || a.status === "working");
  if (anyActive) return HOT_MS;

  if (paneId) {
    const allPanes = [...(data?.agents ?? []), ...(data?.shellPanes ?? [])];
    if (allPanes.some((p) => p.paneId === paneId)) return HOT_MS;
  }

  return COLD_MS;
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

export function usePolling(data: HomeData | undefined, paneId?: string | null, scope?: Scope): void {
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

  const ms = intervalFor(data, paneId);

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
  }, [ms]);
}
