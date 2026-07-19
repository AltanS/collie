import { useEffect, useSyncExternalStore } from "react";

import { BUILD, isStaleBuild } from "@/lib/build";
import { getServerBuild, subscribeServerBuild } from "@/lib/server-build";
import { isReloadHeld, subscribeReloadHeld } from "@/lib/reload-guard";
import { checkForUpdate } from "@/lib/pwa";

// API-observed self-update. The bridge serves index.html + sw.js with no-cache and hashed assets as
// immutable, so a real reload always fetches fresh code — the missing piece is KNOWING when to
// reload. Neither built-in path is reliable on its own: over plain HTTP the service worker never
// registers (so pwa.ts's update→activate→reload never runs), AND over HTTPS the SW pipeline can wedge
// for hours (a proxy heuristically caching an old sw.js starves registration.update()). So we don't
// depend on the SW discovering a new build: the bridge stamps the on-disk build id on EVERY poll
// response (lib/server-build.ts), and when that drifts ahead of this bundle we drive the update
// ourselves — via checkForUpdate(), which handles BOTH origins (with a SW it runs
// update→skip-waiting→activate→reload and unregister-then-reload for a wedged precache; without one
// it plain-reloads from the bridge).
//
// Three safeguards keep that from being annoying or dangerous:
//   1. Hysteresis — a stale id must be seen on TWO consecutive polls before we act, so a header that
//      flips for a single poll mid-deploy (an atomic dist swap) never triggers a reload.
//   2. A once-per-build sessionStorage guard — we auto-update at most once for a given server build
//      id, so a still-stale-after-reload state can never loop; it shows the manual banner instead.
//   3. A safety gate — never yank the page while the user has unsent work (composer text, an upload,
//      an open action sheet); we show a "New version — tap to update" banner and auto-update only
//      once the hold clears.

// sessionStorage key: keyed by build id so a genuinely newer build gets its own fresh guard.
const reloadedKey = (id: string): string => `collie:auto-reloaded-for=${id}`;

// Injectable update trigger — the default is the same path the footer button uses (checkForUpdate,
// which reloads onto the fresh bundle on both SW and no-SW origins). Tests swap in a spy (jsdom's
// window.location.reload throws) and assert the auto-update fires.
let reloadImpl: () => void = () => void checkForUpdate();

/** Test seam — replace the reload implementation. */
export function __setReloadImpl(fn: () => void): void {
  reloadImpl = fn;
}

// Hysteresis state: a stale id seen once is `pendingStale` (awaiting a confirming second sighting);
// once seen twice it becomes `confirmedStale` and drives the action.
let pendingStale: string | undefined;
let confirmedStale: string | undefined;

// Banner store (busy.ts idiom): true when we're confirmed-stale but can't auto-reload right now
// (a hold is active, or we already auto-reloaded for this id) — the user taps the banner to update.
let banner = false;
const bannerListeners = new Set<() => void>();

function setBanner(v: boolean): void {
  if (v === banner) return;
  banner = v;
  for (const fn of bannerListeners) fn();
}

function reloadedFor(id: string): boolean {
  try {
    return sessionStorage.getItem(reloadedKey(id)) !== null;
  } catch {
    return false; // storage disabled (private mode) — don't let that block a needed reload
  }
}

function markReloadedFor(id: string): void {
  try {
    sessionStorage.setItem(reloadedKey(id), String(Date.now()));
  } catch {
    /* storage disabled — the reload still happens; we just can't guard against a re-loop */
  }
}

// Decide what to do about a CONFIRMED-stale build id. Re-run whenever the observation confirms OR a
// hold changes (a cleared hold may now allow the deferred update). Acts regardless of service-worker
// presence — checkForUpdate() picks the right reload path for the origin.
function act(id: string): void {
  // Already auto-updated for this id yet STILL stale → never loop. Surface the manual banner.
  if (reloadedFor(id)) {
    setBanner(true);
    return;
  }
  // Unsafe to reload now (unsent composer text, an upload, an open sheet) → defer: show the banner,
  // and update when the last hold clears (onReloadGuard re-runs act()).
  if (isReloadHeld()) {
    setBanner(true);
    return;
  }
  // Safe + not yet updated for this id → update exactly once. reloadImpl defaults to checkForUpdate(),
  // which reloads onto the fresh bundle on both SW (update→activate→reload, with the unregister
  // fallback for a wedged precache) and no-SW (plain reload from the bridge) origins.
  markReloadedFor(id);
  setBanner(false);
  reloadImpl();
}

// Run the hysteresis on each server-build observation.
function onServerBuild(): void {
  const server = getServerBuild();
  if (!isStaleBuild(BUILD.id, server)) {
    // Current (or unknown) — clear any pending/confirmed staleness and hide the banner.
    pendingStale = undefined;
    confirmedStale = undefined;
    setBanner(false);
    return;
  }
  const id = server as string; // isStaleBuild guarantees a defined, non-"unknown" id here
  if (id === confirmedStale) {
    act(id); // already confirmed — re-evaluate (a hold or the SW state may have changed)
    return;
  }
  if (id === pendingStale) {
    // Second consecutive sighting of the same stale id → confirm and act.
    confirmedStale = id;
    pendingStale = undefined;
    act(id);
    return;
  }
  // First sighting of this stale id (or the id changed since the last poll) → hold one more poll.
  // Drop any prior confirmation: the server moved on, so the old confirmed id is void until this new
  // one confirms — otherwise onReloadGuard could act on a build the server no longer serves.
  pendingStale = id;
  confirmedStale = undefined;
  setBanner(false);
}

function onReloadGuard(): void {
  // A hold just changed. If we're confirmed-stale, re-run the decision — clearing the last hold flips
  // act() from "show banner" to "auto-reload now".
  if (confirmedStale !== undefined) act(confirmedStale);
}

let started = false;

/**
 * Subscribe the controller to the server-build and reload-guard stores. Idempotent (guarded by
 * `started`); returns a disposer that unsubscribes. Mounted via useSelfUpdate below.
 */
export function startSelfUpdate(): () => void {
  if (started) return () => {};
  started = true;
  const unsubBuild = subscribeServerBuild(onServerBuild);
  const unsubHold = subscribeReloadHeld(onReloadGuard);
  onServerBuild(); // evaluate once in case a build was observed before we subscribed
  return () => {
    unsubBuild();
    unsubHold();
    started = false;
  };
}

/** Non-hook read of the banner state (for tests). */
export function selfUpdateBannerVisible(): boolean {
  return banner;
}

function subscribeBanner(cb: () => void): () => void {
  bannerListeners.add(cb);
  return () => bannerListeners.delete(cb);
}

/**
 * Mount the self-updater and reflect its "New version — tap to update" banner state. Returns true
 * when the banner should show (confirmed-stale but auto-reload is held off or already used). The
 * effect starts the controller so auto-reload runs even while this returns false (banner hidden).
 */
export function useSelfUpdate(): boolean {
  useEffect(() => startSelfUpdate(), []);
  return useSyncExternalStore(subscribeBanner, selfUpdateBannerVisible, selfUpdateBannerVisible);
}

/** Test helper — reset controller state (not subscriptions; those are disposer-managed). */
export function __resetSelfUpdate(): void {
  pendingStale = undefined;
  confirmedStale = undefined;
  banner = false;
  reloadImpl = () => void checkForUpdate();
}
