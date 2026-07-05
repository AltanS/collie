import type { BridgeStatus } from "./types";

export interface ConnState {
  /** Browser connectivity (navigator.onLine). */
  online: boolean;
  /** Herdr link as last reported by the snapshot; undefined before the first successful poll. */
  bridge: BridgeStatus | undefined;
  /** The most recent snapshot fetch failed. */
  error: boolean;
}

// The one predicate for "is the data on screen not yet live" — offline, reconnecting, or Herdr down.
// The Collie mark gallops while this is true and rests when it's false, identically on every screen,
// so the header keeps this out of the per-poll fetch state (it stays put during background
// revalidation, like the status pill, rather than twitching on every tick). Mirrors the not-"live"
// branches of ConnectionBar's status resolver.
export function isConnecting({ online, bridge, error }: ConnState): boolean {
  return !online || error || bridge === undefined || bridge === "disconnected";
}
