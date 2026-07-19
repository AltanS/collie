import { useEffect } from "react";

// A registry of reasons the page must NOT be auto-reloaded right now — unsent composer text, an
// in-flight upload, an open action sheet. The no-service-worker self-updater (lib/self-update.ts)
// checks isReloadHeld() before it reloads onto a fresh build and, when the last hold clears, reloads
// then instead (if still stale). Module-scoped like lib/busy so any component participates without
// prop-drilling. A Set of keys (not a counter) so a double-hold / double-release on the same key is
// idempotent, and distinct holders (composer, upload, a sheet) coexist without stepping on each other.

const holds = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Register a reason the page must not auto-reload. Idempotent per key. */
export function holdReload(key: string): void {
  if (holds.has(key)) return;
  holds.add(key);
  emit();
}

/** Clear a previously-registered hold. Idempotent (unknown/duplicate keys are no-ops). */
export function releaseReload(key: string): void {
  if (!holds.delete(key)) return;
  emit();
}

/** True while any hold is active — the self-updater defers its auto-reload. */
export function isReloadHeld(): boolean {
  return holds.size > 0;
}

export function subscribeReloadHeld(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Hold the reload for the lifetime of `active` under `key`. The convenience hook components use: a
 * composer holds while it has unsent text, an upload holds while in flight, an action sheet holds
 * while open. The hold releases on `active` going false OR on unmount, so a hold can never leak.
 */
export function useHoldReload(key: string, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    holdReload(key);
    return () => releaseReload(key);
  }, [key, active]);
}

/** Test helper — clear every hold between cases. */
export function __resetReloadGuard(): void {
  holds.clear();
}
