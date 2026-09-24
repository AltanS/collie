import { useEffect, useRef, useState } from "react";

import { apiErrorFields, fitPane, unfitPane } from "@/lib/api";
import { describeApiError, describeThrownError } from "@/lib/api-error-message";
import { clampFitSize, sameFitSize, type FitSize } from "@/lib/fit-grid";
import { t } from "@/lib/i18n";
import { paneScopeKey, type Scope } from "@/lib/scope";
import { setStatus } from "@/lib/status";

// ── "FIT TO PHONE": ONE NAMED TAP, ONE LEASE, AND EVERY WAY IT ENDS (ADR 0049) ───────────────────
//
// The pane view owns this, not the sheet the tap lives in: the sheet closes the moment the row is
// tapped, and a lease has to outlive it for as long as the operator is looking at the pane.
//
// WHAT STARTS IT. `fit()`, and nothing else. There is no effect in this file that fits on mount, on a
// pane change or on a page becoming visible: opening a pane on a phone must never re-lay-out the
// desktop's copy of it under whoever is typing there (ADR 0031's rule, applied to a second write).
//
// WHAT KEEPS IT. A renewal every `FIT_RENEW_MS`, well inside the bridge's two-minute lapse. A renewal
// only EXTENDS: the bridge answers `pane.fit_lapsed` when nothing is held, and this hook then goes
// idle QUIETLY — it never re-takes, because re-taking is a new fit and a new fit needs a new tap.
// A size change (rotation, a font step) is carried by a take AFTER a successful renewal, never
// instead of one: the renewal proves the lease is still Collie's, so the take can only ever REPLACE
// Collie's own lease and never start one the operator walked away from.
//
// WHAT PAUSES IT. A hidden page and a suspended view (a gone pane, a read-only device, a host that
// stopped answering, the idle pause) stop the renewals and release NOTHING. The lapse is the grace
// period: a phone pocketed for a minute comes back to a pane that is still fitted, and a phone left
// in a drawer lets the desk have its terminal back two minutes later without anybody's help. Coming
// back sends one renewal at once, which is how a lapse that happened meanwhile is discovered.
//
// WHAT ENDS IT. Leaving the pane view (unmount, or a pane switch), and the Release control. Both
// POST `unfit` without waiting — the route is idempotent and restoring the size is Herdr's, never
// Collie's — and both bump the epoch, so an answer still in flight from before cannot resurrect a
// lease: a take that lands after its release is released again at once.
//
// WHAT IT SAYS. A refusal of the operator's own tap is an error status (it persists until read, which
// the "another device controls this terminal's size" explanation needs). A renewal says nothing,
// ever, except losing the terminal to another controller — once. See ACK_MANIFEST.fitPane.

/** How often a held lease is renewed. A quarter of the bridge's 120 s lapse. */
export const FIT_RENEW_MS = 30_000;

/** How long the mirror must hold a new width before the lease follows it. Long enough to let a
 *  rotation's two or three resize events settle into one take. */
export const FIT_RESIZE_SETTLE_MS = 1_000;

export type FitPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "fitting" }
  | { readonly kind: "fitted"; readonly cols: number; readonly rows: number };

const IDLE: FitPhase = { kind: "idle" };
const FITTING: FitPhase = { kind: "fitting" };

interface FitToPhoneOptions {
  paneId: string;
  scope?: Scope;
  /** Measure the mirror's grid now, or `null` when there is no layout to measure. */
  measure: () => FitSize | null;
  /** True while the view has stopped being live — see "WHAT PAUSES IT" above. */
  suspended: boolean;
  /**
   * How long `fit()` lets the view settle before it measures. The pane view passes its fit notice's
   * slide-in: the notice takes a row of the column the mirror is in, so the mirror measured BEFORE
   * it arrived would be a few rows taller than the one the lease is then read through.
   */
  settleMs?: number;
}

type Attempt =
  | { readonly ok: true; readonly size: FitSize }
  | { readonly ok: false; readonly code: string | undefined; readonly message: string };

/** One call to the fit route, with a refusal read the same way whether it came back or was thrown. */
async function attempt(paneId: string, size: FitSize, scope: Scope | undefined, renew: boolean): Promise<Attempt> {
  try {
    const res = await fitPane(paneId, size, scope, renew);
    if (res.ok) return { ok: true, size: { cols: res.cols, rows: res.rows } };
    return { ok: false, code: res.code, message: describeApiError(res, t("paneActions.fit.failed")) };
  } catch (e) {
    return { ok: false, code: apiErrorFields(e)?.code, message: describeThrownError(e) };
  }
}

function releaseQuietly(paneId: string, scope: Scope | undefined): void {
  // Fire and forget: the answer is always ok, and a failure has no one left to tell.
  unfitPane(paneId, scope).catch(() => {});
}

export function useFitToPhone({ paneId, scope, measure, suspended, settleMs = 0 }: FitToPhoneOptions) {
  const [phase, setPhaseState] = useState<FitPhase>(IDLE);
  // Live reads for the timers and the visibility listener, which fire between renders. Written at the
  // transitions themselves, the way use-direct-typing's `activeRef` is.
  const phaseRef = useRef<FitPhase>(IDLE);
  const epoch = useRef(0);
  const renewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renewing = useRef(false);
  const hidden = useRef(false);
  const suspendedRef = useRef(suspended);
  const target = useRef({ paneId, scope, measure });
  target.current = { paneId, scope, measure };

  function setPhase(next: FitPhase) {
    phaseRef.current = next;
    setPhaseState(next);
  }

  function paused(): boolean {
    return hidden.current || suspendedRef.current;
  }

  function clearTimers() {
    if (renewTimer.current !== null) clearTimeout(renewTimer.current);
    if (resizeTimer.current !== null) clearTimeout(resizeTimer.current);
    renewTimer.current = null;
    resizeTimer.current = null;
  }

  function scheduleRenewal() {
    if (renewTimer.current !== null) clearTimeout(renewTimer.current);
    renewTimer.current = null;
    if (paused() || phaseRef.current.kind !== "fitted") return;
    renewTimer.current = setTimeout(() => {
      renewTimer.current = null;
      void renew();
    }, FIT_RENEW_MS);
  }

  function measured(): FitSize | null {
    const size = target.current.measure();
    return size === null ? null : clampFitSize(size);
  }

  /** Extend the held lease; then, if the mirror's grid has moved, replace it with one that fits. */
  async function renew() {
    const held = phaseRef.current;
    if (renewing.current || held.kind !== "fitted" || paused()) return;
    renewing.current = true;
    const mine = epoch.current;
    const { paneId: pane, scope: at } = target.current;
    try {
      // The size a renewal carries is the lease's own: the bridge validates it and extends the lease
      // it holds, it never resizes on a renewal. A new size is the take below.
      const renewed = await attempt(pane, { cols: held.cols, rows: held.rows }, at, true);
      if (epoch.current !== mine) return;
      if (!renewed.ok) {
        // The lease is gone: it lapsed while nobody renewed it, or was released. Drop the notice and
        // say nothing — the operator did not act, and re-taking would need a tap they did not make.
        if (renewed.code === "pane.fit_lapsed") return setPhase(IDLE);
        // Another controller has the terminal now. The one renewal outcome worth a word, said once.
        if (renewed.code === "pane.fit_busy") {
          setPhase(IDLE);
          return setStatus(renewed.message, "error");
        }
        // A transport blip or a transient refusal: keep the lease and try again next round. A lease
        // that really is gone answers `pane.fit_lapsed` then.
        return;
      }
      const now = measured();
      if (now === null || sameFitSize(now, renewed.size)) return setPhase({ kind: "fitted", ...renewed.size });
      const moved = await attempt(pane, now, at, false);
      if (epoch.current !== mine) {
        // Released while the take was on the wire, and the take landed anyway: nobody holds it now.
        if (moved.ok) releaseQuietly(pane, at);
        return;
      }
      if (moved.ok) return setPhase({ kind: "fitted", ...moved.size });
      if (moved.code === "pane.fit_busy" || moved.code === "pane.fit_lapsed") {
        setPhase(IDLE);
        if (moved.code === "pane.fit_busy") setStatus(moved.message, "error");
        return;
      }
      setPhase({ kind: "fitted", ...renewed.size });
    } finally {
      renewing.current = false;
      if (epoch.current === mine) scheduleRenewal();
    }
  }

  /** The named tap. Measures, clamps, and takes a lease at that size. */
  async function fit() {
    if (phaseRef.current.kind !== "idle") return;
    const mine = ++epoch.current;
    clearTimers();
    setPhase(FITTING);
    if (settleMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
      if (epoch.current !== mine) return;
    }
    const size = measured();
    if (size === null) {
      setPhase(IDLE);
      setStatus(t("paneActions.fit.unmeasurable"), "error");
      return;
    }
    const { paneId: pane, scope: at } = target.current;
    const taken = await attempt(pane, size, at, false);
    if (epoch.current !== mine) {
      if (taken.ok) releaseQuietly(pane, at);
      return;
    }
    if (!taken.ok) {
      setPhase(IDLE);
      setStatus(taken.message, "error");
      return;
    }
    setPhase({ kind: "fitted", ...taken.size });
    scheduleRenewal();
  }

  /** The Release control. Also cancels a fit still in flight. */
  function release() {
    if (phaseRef.current.kind === "idle") return;
    epoch.current += 1;
    clearTimers();
    setPhase(IDLE);
    releaseQuietly(target.current.paneId, target.current.scope);
  }

  /**
   * The mirror changed size. A new WIDTH (a rotation, a font step) is followed once it settles; a
   * height-only change waits for the next renewal, because the soft keyboard is a height-only change
   * that comes and goes with every tap into the composer, and chasing it would re-lay-out the
   * desktop's pane twice per message.
   */
  function noteResize() {
    if (phaseRef.current.kind !== "fitted" || paused()) return;
    if (resizeTimer.current !== null) clearTimeout(resizeTimer.current);
    resizeTimer.current = setTimeout(() => {
      resizeTimer.current = null;
      const held = phaseRef.current;
      const now = measured();
      if (held.kind === "fitted" && now !== null && now.cols !== held.cols) void renew();
    }, FIT_RESIZE_SETTLE_MS);
  }

  /**
   * Stop renewing on a pause; renew once, at once, on the way back. Never releases.
   *
   * The effects below are LIFECYCLE handlers that must fire on their own condition and nothing else,
   * while this closure is re-created every render — so they call it through a latest-value ref rather
   * than naming it as a dependency (use-direct-typing.ts states the same pattern).
   */
  function pauseChanged(wasPaused: boolean) {
    const nowPaused = paused();
    if (nowPaused === wasPaused) return;
    if (nowPaused) {
      clearTimers();
      return;
    }
    if (phaseRef.current.kind === "fitted") void renew();
  }
  function leave(pane: string, at: Scope | undefined) {
    if (phaseRef.current.kind === "idle") return;
    epoch.current += 1;
    clearTimers();
    phaseRef.current = IDLE;
    setPhaseState(IDLE);
    releaseQuietly(pane, at);
  }
  const lifecycle = useRef({ pauseChanged, leave });
  lifecycle.current = { pauseChanged, leave };

  useEffect(() => {
    const wasPaused = hidden.current || suspendedRef.current;
    suspendedRef.current = suspended;
    lifecycle.current.pauseChanged(wasPaused);
  }, [suspended]);

  // Mounted for the hook's whole life, not keyed on the phase: the return trip has to find a
  // listener that was there when the page went away.
  useEffect(() => {
    const onVisibility = () => {
      const wasPaused = hidden.current || suspendedRef.current;
      hidden.current = document.visibilityState === "hidden";
      lifecycle.current.pauseChanged(wasPaused);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // A lease never crosses a pane boundary. The pane view is keyed by the pane's full address, so in
  // practice this is its unmount; keyed on the address here too, so the rule does not rest on a
  // parent's key. The address is captured when the effect runs, so the cleanup releases the pane it
  // was set up for and never whichever one the latest render named.
  const paneKey = paneScopeKey(scope, paneId);
  useEffect(() => {
    const { paneId: pane, scope: at } = target.current;
    const handlers = lifecycle.current;
    return () => handlers.leave(pane, at);
  }, [paneKey]);

  return { phase, fit, release, noteResize };
}
