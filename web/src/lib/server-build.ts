import { useSyncExternalStore } from "react";

// The build id the bridge is currently serving, observed passively from the `X-Collie-Build` header
// the bridge stamps on every snapshot/pane response (captured in lib/api.ts). Every poll refreshes it
// for free — no extra request. Modelled on the lib/busy.ts store idiom: plain module state + a
// subscribe + a useSyncExternalStore hook, so any call site participates without prop-drilling.
//
// This is the raw feed for two consumers:
//   1. <BuildStamp/> reads the latest value (useServerBuild) to show its "new build — tap to update"
//      nag live, and
//   2. lib/self-update.ts subscribes to drive the no-service-worker auto-reload (with hysteresis).
// Because (2) counts CONSECUTIVE sightings of the same stale id, we notify on EVERY observation —
// repeats included — not only on change; the display hook coalesces unchanged values via React.

// The response header the bridge stamps (bridge/server.ts `BUILD_HEADER`). Kept here so lib/api.ts —
// the only reader — imports one constant rather than hard-coding the string at each fetch site.
export const SERVER_BUILD_HEADER = "x-collie-build";

let current: string | undefined;
const listeners = new Set<() => void>();

/**
 * Record the server build id seen on an API response header. A `null`/`undefined` value (an older
 * bridge that doesn't send the header) is a no-op: the store stays as-is, so nothing downstream
 * activates and we never clobber a good value with "unknown". A real id notifies every subscriber —
 * including on a repeat of the same id, which the self-update hysteresis relies on.
 */
export function observeServerBuild(id: string | null | undefined): void {
  if (id == null) return;
  current = id;
  for (const fn of listeners) fn();
}

/** Non-hook read of the latest observed server build id (for the self-update controller and tests). */
export function getServerBuild(): string | undefined {
  return current;
}

export function subscribeServerBuild(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Reactive read of the latest server build id — undefined until the first header lands. */
export function useServerBuild(): string | undefined {
  return useSyncExternalStore(subscribeServerBuild, getServerBuild, getServerBuild);
}

/** Test helper — reset module state between cases. */
export function __resetServerBuild(): void {
  current = undefined;
}
