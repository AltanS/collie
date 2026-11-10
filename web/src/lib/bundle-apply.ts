import { useSyncExternalStore } from "react";

import { getUpdateStage, subscribeUpdateStage, type UpdateStage } from "@/lib/pwa";
import { selfUpdateBannerVisible, subscribeBanner } from "@/lib/self-update";

// ── THE APP BUNDLE BEING APPLIED, AS ONE FACT (2026-11-06) ──────────────────────────────────────
//
// Two things used to say "a new app build is coming" in the strip band under the header: the
// download row (`bundle-installing`) and the reload row (`bundle`), both `lib/update-ribbon.ts`
// kinds. Altan asked for the band to stop carrying them. The header mark says it instead, every
// bead turning in the update colour at the calm pace, and a tap on the mark opens the dashboard,
// whose update line says what is happening (`components/update-banner.tsx`).
//
// So three surfaces now read the same fact: the mark (`components/collie-home.tsx`, fed by
// `AppHeaderHost`), the dashboard's update line, and the band, which reads it to stay quiet. This
// file is that fact, read ONCE, so the three cannot disagree about whether an update is applying.
//
// ── THE BAND'S TWO STATES, PLUS THE AUTOMATIC LANE ──────────────────────────────────────────────
// Both ribbon kinds require `bundleStale`, the self-updater's own flag (`lib/self-update.ts`): it is
// true only when the bridge serves a newer build AND the self-updater may not reload by itself right
// now (a hold is active, or it already spent its one automatic reload on this build). Either way the
// app is being applied, and the stage picks which of the two it is.
//
// The flag is false on the AUTOMATIC LANE, which is the common case: nothing is held, so the
// self-updater (or the worker's own 60 s check) starts the download and the page reloads by itself
// when it lands. On the dev lane that is every deploy, and Altan saw the page reload with nothing
// having said so (2026-11-06). So a download counts on its own as well, but only with a worker
// ALREADY IN CONTROL: the stage is `installing` on the app's very first install too, when nothing
// is being replaced and there is nothing to announce. A controller is what tells the two apart.
//
// ── IT READS; IT DOES NOT MOUNT THE CONTROLLER ───────────────────────────────────────────────────
// `useSelfUpdate()` is a controller as well as a flag, and its `started` guard hands a second
// mounter a no-op disposer. A second mount here would tie the controller's life to whichever of two
// components unmounted first. `UpdateRibbon` stays the one place that mounts it; this hook only
// subscribes to the flag the controller publishes.

/** Which bundle state is on, or null when no new app build is being applied. */
export type BundleApply = "installing" | "ready" | null;

/** The three facts the reading needs. */
export interface BundleSignals {
  /** The self-updater's flag: a newer build is confirmed and the page may not reload by itself. */
  bundleStale: boolean;
  /** The service worker's stage (`lib/pwa.ts`). */
  stage: UpdateStage;
  /** A worker already controls this document, so a download REPLACES an app (see the header). */
  controlled: boolean;
}

/**
 * The fact, decided once. `installing`: this document's worker is downloading the new bundle.
 * `ready`: the bundle on screen is behind, and the page reloads onto the new one when it may.
 */
export function bundleApply({ bundleStale, stage, controlled }: BundleSignals): BundleApply {
  if (stage === "installing" && (bundleStale || controlled)) return "installing";
  if (bundleStale) return "ready";
  return null;
}

/**
 * Whether a service worker controls this document. Read at render, not subscribed: it changes only
 * on a controller swap, which reloads the page, and the first claim of a first install comes with
 * the stage leaving `installing`, which re-renders every reader anyway.
 */
export function swControlled(): boolean {
  return "serviceWorker" in navigator && navigator.serviceWorker.controller !== null;
}

/** The same fact, live. Reads the self-updater's flag, the service worker's stage and its control. */
export function useBundleApply(): BundleApply {
  const bundleStale = useSyncExternalStore(subscribeBanner, selfUpdateBannerVisible, selfUpdateBannerVisible);
  const stage = useSyncExternalStore(subscribeUpdateStage, getUpdateStage, getUpdateStage);
  return bundleApply({ bundleStale, stage, controlled: swControlled() });
}

// ── THE ONE-SHOT SCROLL TO THE UPDATE LINE ───────────────────────────────────────────────────────
//
// A tap on the applying mark opens the dashboard, and the dashboard brings its update line into
// view ONCE. A plain visit to the dashboard does not scroll: only the tap sets the flag, and the
// dashboard takes it. A store and not a navigation state, because the tap may land ON the dashboard
// already, where there is no navigation to carry anything.
//
// It expires. A tap whose navigation never lands (a sheet that swallowed it, a route that refused)
// must not leave a flag for some later, plain visit to find. Two seconds is far past a client-side
// navigation and far short of the next deliberate visit.

/** How long a tap's request to show the update line stays good. */
export const BUNDLE_FOCUS_TTL_MS = 2_000;

let focusAt: number | null = null;
const focusListeners = new Set<() => void>();

function emitFocus(): void {
  for (const listener of focusListeners) listener();
}

/** The tap on the applying mark asks the dashboard to show its update line. */
export function requestBundleFocus(now: number = Date.now()): void {
  focusAt = now;
  emitFocus();
}

/** Is a request waiting? A snapshot read for `useSyncExternalStore`; it never consumes. */
export function bundleFocusPending(): boolean {
  return focusAt !== null;
}

/**
 * Consume the request. True only once per tap, and only while the request is fresh. The flag is
 * cleared either way, so an expired request never lingers for the next visit.
 */
export function takeBundleFocus(now: number = Date.now()): boolean {
  if (focusAt === null) return false;
  const fresh = now - focusAt <= BUNDLE_FOCUS_TTL_MS;
  focusAt = null;
  emitFocus();
  return fresh;
}

export function subscribeBundleFocus(listener: () => void): () => void {
  focusListeners.add(listener);
  return () => focusListeners.delete(listener);
}

/** Whether a request is waiting, live. The dashboard reacts to it both on arrival and in place. */
export function useBundleFocusPending(): boolean {
  return useSyncExternalStore(subscribeBundleFocus, bundleFocusPending, bundleFocusPending);
}

/** Test helper: drop any waiting request. */
export function __resetBundleFocus(): void {
  focusAt = null;
  emitFocus();
}
