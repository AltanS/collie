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
//
// Sticky escalation (`lostLatched`): the wake grace above is honest ONLY before we've escalated. Once
// the app is already showing "not connected" (red pill + banner) and the user switches apps and comes
// back MID-OUTAGE, the wake stamp used to reset the anchor to now and downgrade red → amber
// "reconnecting…" for another full window, even though nothing had changed — a dishonest de-escalation.
// So we LATCH the escalated state: `latchLost()` is called the moment a real connecting consumer
// observes `lost` (see use-connection-lost), and while latched `effectiveAnchor()` DROPS the wake grace
// (measures from `lastLiveAt` alone). Red therefore stays red across backgrounding until the connection
// proves itself — the latch clears ONLY when `markLive()` stamps a genuine live poll, at which point the
// live stamp and the latch clear together and everything recovers as before. The latch is coupled to a
// consumer actually crossing the threshold (not merely the wall-clock going stale) because the anchor
// can go stale for benign reasons too — e.g. the idle-lock pausing polling — where nobody is
// `connecting` and no red UI is showing, so nothing should latch.

// How long the app must stay continuously not-live before we escalate from the quiet header pill
// ("reconnecting…") to a prominent prompt. Long enough that a normal poll blip, a pane-open hiccup,
// or a brief tunnel drop never trips it — only a genuinely sustained outage does.
export const CONNECTION_LOST_MS = 15_000;

// How long the app must stay continuously not-live before the connection bar fades IN as an ambient
// amber "reconnecting…" (and the header dog starts to gallop). Short enough to catch a genuine stall,
// long enough that a single slow poll (the stall itself only trips at 2.5s) or one failed fetch never
// flashes a bar — the flicker fix. Measured from the SAME shared anchor as CONNECTION_LOST_MS (via
// useConnectionTrouble), just far shorter and, crucially, NON-latching: only the 15s escalation latches.
export const TROUBLE_MS = 4_000;

// Both initialise to module-load time (app open), so a dead cold start escalates ~CONNECTION_LOST_MS
// after open (the BootSplash case) — the first successful poll then advances `lastLiveAt` for real.
let lastLiveAt = Date.now();
let lastWakeAt = Date.now();
// Sticky-escalation latch — set once a real connecting consumer OBSERVES the lost condition (see
// latchLost + use-connection-lost) and cleared ONLY by a provably-live poll (markLive). While latched,
// effectiveAnchor() drops the wake grace, so backgrounding + returning MID-OUTAGE can no longer
// downgrade red → amber. Module-scoped so every consumer agrees on one escalated/not answer.
let lostLatched = false;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/**
 * Stamp a provably-live moment: a snapshot/pane fetch that returned live data (a 304 counts). Called
 * from lib/api.ts at the same fetch interception point that captures X-Collie-Build, so the anchor
 * can't drift from reality. Every stamp advances the wall-clock and notifies subscribers. This is also
 * the ONLY thing that clears the sticky-escalation latch: recovery proves itself with a real poll, so
 * the live stamp and the latch clear together and every consumer de-escalates at once.
 */
export function markLive(): void {
  lastLiveAt = Date.now();
  lostLatched = false;
  emit();
}

/**
 * Stamp a wake: the tab returned to the foreground, granting a fresh grace window before escalation
 * (a phone resuming from sleep shouldn't flash red while its first poll is still in flight). Does NOT
 * touch the latch: while escalated, effectiveAnchor() ignores this stamp, so a mid-outage app switch
 * can't reset the countdown or downgrade red back to amber.
 */
export function markWake(): void {
  lastWakeAt = Date.now();
  emit();
}

/**
 * Latch the sticky-escalation state. Idempotent — only the first call (per outage) flips the flag and
 * notifies; repeats are no-ops. Called from use-connection-lost the instant a consumer observes `lost`
 * true, so the latch is coupled to a real connecting consumer crossing the threshold rather than the
 * bare wall-clock anchor going stale (which happens for benign reasons too, e.g. the idle-lock pausing
 * polling, with nobody connecting and no red UI showing — that must NOT latch).
 */
export function latchLost(): void {
  if (lostLatched) return;
  lostLatched = true;
  emit();
}

/** Whether the sticky-escalation latch is currently set (exported for tests / diagnostics). */
export function isLostLatched(): boolean {
  return lostLatched;
}

/** The most recent provably-live anchor — the later of the last live poll and the last wake. */
export function lastHealthyAt(): number {
  return Math.max(lastLiveAt, lastWakeAt);
}

/**
 * The anchor escalation is measured from. NOT latched → `max(lastLiveAt, lastWakeAt)`: a wake grants a
 * fresh grace window so a phone resuming from sleep on a HEALTHY network never flashes red while its
 * first poll is still in flight. LATCHED → `lastLiveAt` alone (wake grace dropped): once we've
 * escalated, a wake can no longer reset the countdown, so an already-red outage that is still failing
 * stays red across app switches. Safe because `lostLatched` implies `lastLiveAt` is already at least
 * CONNECTION_LOST_MS stale — markLive is the only thing that freshens it, and markLive also clears the
 * latch — so dropping the wake grace can never manufacture a false escalation.
 */
export function effectiveAnchor(): number {
  return lostLatched ? lastLiveAt : lastHealthyAt();
}

export function subscribeHealth(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Reactive read of the shared ESCALATION anchor — re-renders a consumer whenever markLive/markWake/
 * latchLost fires. Returns effectiveAnchor(), so it already honours the sticky latch (drops the wake
 * grace once escalated); consumers derive `lost` from this single value and cannot disagree.
 */
export function useConnectionHealth(): number {
  return useSyncExternalStore(subscribeHealth, effectiveAnchor, effectiveAnchor);
}

// A phone backgrounds Collie (screen off, app switch) far more than it truly disconnects; timers
// freeze while it's away. On return, grant a fresh grace window rather than escalating on the stale,
// pre-sleep anchor. Module-level (registered once) so it's independent of any component's lifecycle.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") markWake();
  });
}

/** Test helper — reset both anchors (defaults to now) AND clear the sticky latch between cases. */
export function __resetConnectionHealth(now = Date.now()): void {
  lastLiveAt = now;
  lastWakeAt = now;
  lostLatched = false;
}
