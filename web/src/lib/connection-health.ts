import { useSyncExternalStore } from "react";

// The ONE connection-health clock, shared by every consumer (the header pill, the outage banner, the
// in-pane header, the boot splash). Module-scoped store in the lib/busy.ts + lib/server-build.ts
// idiom — plain module state + a subscribe + a useSyncExternalStore hook — so escalation is derived
// from a SINGLE source of truth that no remount, route change, or per-instance timer can fork.
//
// Why this exists: escalation used to live in a per-COMPONENT ref/timer (useConnectionLost stamped a
// local `since` when it first saw `connecting`). Two independent instances could diverge — most
// visibly, the pill renders inside each route's header, so navigating home→space mid-outage REMOUNTED
// it and restarted its clock, while the banner (in the persistent RootLayout) escalated on time. The
// result on-device: the banner went red "not connected" while the header pill sat amber
// "reconnecting…" for far longer. Anchoring every consumer on this shared store fixes that by
// construction.
//
// Anchor semantics: `lastLiveAt` is the wall-clock of the last PROVABLY LIVE moment — stamped when a
// snapshot/pane fetch returns genuinely live data (see lib/api.ts; a 304 counts as live). `lastWakeAt`
// is stamped when the tab returns to the foreground. Escalation measures a flat CONNECTION_LOST_MS of
// no live data from `max(lastLiveAt, lastWakeAt)`: anchoring on the last SUCCESS means device delays
// (a 10s fetch timeout, a poll gap) can no longer stack BEFORE the clock starts, and the wake anchor
// gives a phone waking from sleep a fresh grace window instead of an instant red flash while its first
// poll is still in flight.

// How long the app must stay continuously not-live before we escalate from the quiet header pill
// ("reconnecting…") to a prominent prompt. Long enough that a normal poll blip, a pane-open hiccup,
// or a brief tunnel drop never trips it — only a genuinely sustained outage does.
export const CONNECTION_LOST_MS = 15_000;

// Both initialise to module-load time (app open), so a dead cold start escalates ~CONNECTION_LOST_MS
// after open (the BootSplash case) — the first successful poll then advances `lastLiveAt` for real.
let lastLiveAt = Date.now();
let lastWakeAt = Date.now();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/**
 * Stamp a provably-live moment: a snapshot/pane fetch that returned live data (a 304 counts). Called
 * from lib/api.ts at the same fetch interception point that captures X-Collie-Build, so the anchor
 * can't drift from reality. Every stamp advances the wall-clock and notifies subscribers.
 */
export function markLive(): void {
  lastLiveAt = Date.now();
  emit();
}

/**
 * Stamp a wake: the tab returned to the foreground, granting a fresh grace window before escalation
 * (a phone resuming from sleep shouldn't flash red while its first poll is still in flight).
 */
export function markWake(): void {
  lastWakeAt = Date.now();
  emit();
}

/** The most recent provably-live anchor — the later of the last live poll and the last wake. */
export function lastHealthyAt(): number {
  return Math.max(lastLiveAt, lastWakeAt);
}

export function subscribeHealth(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Reactive read of the shared anchor — re-renders a consumer whenever markLive/markWake fires. */
export function useConnectionHealth(): number {
  return useSyncExternalStore(subscribeHealth, lastHealthyAt, lastHealthyAt);
}

// A phone backgrounds Collie (screen off, app switch) far more than it truly disconnects; timers
// freeze while it's away. On return, grant a fresh grace window rather than escalating on the stale,
// pre-sleep anchor. Module-level (registered once) so it's independent of any component's lifecycle.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") markWake();
  });
}

/** Test helper — reset both anchors (defaults to now) between cases. */
export function __resetConnectionHealth(now = Date.now()): void {
  lastLiveAt = now;
  lastWakeAt = now;
}
