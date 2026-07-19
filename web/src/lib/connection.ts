import type { BridgeStatus } from "./types";

export interface ConnState {
  /** Herdr link as last reported by the snapshot; undefined before the first successful poll. */
  bridge: BridgeStatus | undefined;
  /** The most recent snapshot fetch failed. */
  error: boolean;
  /**
   * A load (revalidation OR route navigation) has been in flight long enough to look stalled rather
   * than merely slow — see use-loading-stalled. Distinct from `error`: a stall is a fetch that has
   * NOT yet settled (so nothing has failed), which is exactly the black-hole case where the app
   * would otherwise look dead with no feedback. Optional so callers that don't track it read false.
   */
  stalled?: boolean;
}

// The one predicate for "is the data on screen not yet live" — snapshot error, no first snapshot yet,
// Herdr disconnected, or a load stalled mid-flight. POLL-TRUTH ONLY: liveness is whether the snapshot
// path is healthy, and it deliberately does NOT consult navigator.onLine. A phone's onLine flag lies
// both ways — it stays true in airplane mode, and after an airplane cycle it can STICK false while the
// network is actually fine — so gating liveness on it galloped a phantom outage forever ("the dog is
// running yet the status says idle") while polls quietly succeeded. Polls always attempt; if they
// land, the data is live regardless of what onLine claims. onLine survives only as COPY selection
// (which not-live cause to name) in the ConnectionBanner — never as a liveness gate. The
// Collie mark gallops while this is true and rests when it's false, identically on every screen, so
// the header keeps this out of the per-poll fetch state (it stays put during a normal background
// revalidation, like the status pill, rather than twitching on every tick) — only a genuinely STALLED
// load trips it. Mirrors the not-"live" branches of the ConnectionBanner's tone resolver.
export function isConnecting({ bridge, error, stalled = false }: ConnState): boolean {
  return error || bridge === undefined || bridge === "disconnected" || stalled;
}
