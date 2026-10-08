import { useSyncExternalStore } from "react";
import { hasDocument } from "./env";

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
//
// THE SECOND WAY IN (M46 pass 3, 2026-10-07): a failed herd read latches too, without the 15s wait
// (`noteNetworkFailure`, `noteServerFailure`). A read that got no answer at all latches on the first
// failure, a 5xx on the second in a row. On a phone with a VPN up and the radio off, nothing else says
// the network is gone: `navigator.onLine` stays true, and the 15s clock made the app look live for far
// too long.
//
// EXCEPT RIGHT AFTER A WAKE (2026-10-08): there the first read with no answer is one strike, and the
// second in a row latches. A phone that reaches the bridge through a Tailscale relay needs a moment
// after it returns from the background, and its first poll often gets no answer: those requests never
// reached the proxy. Latching on it turned the screen red on almost every wake, over a bridge that was
// fine. The strike covers a read that started while the page was hidden, one that was in flight across
// the wake, and one that started within WAKE_STRIKE_MS after it (`noteReadStart` stamps the start). The
// poll retries such a read 0.5s later (hooks/use-polling.ts RETRY_MS), so a real outage is still red
// within about a second of the wake's first failure.

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

// How long after a wake a herd read that gets no answer is one strike rather than proof of the outage
// (see `noteNetworkFailure`). TROUBLE_MS, because that is the stretch in which the app already shows
// nothing at all for a link that is not live: the strike only spares a read the operator could not have
// seen fail anyway. The wake's own read starts inside it (use-polling fires one at once on `visible`),
// and an ordinary poll after it mostly does not, so a later failure latches as before.
export const WAKE_STRIKE_MS = TROUBLE_MS;

// Both initialise to module-load time (app open), so a dead cold start escalates ~CONNECTION_LOST_MS
// after open (the BootSplash case) — the first successful poll then advances `lastLiveAt` for real.
let lastLiveAt = Date.now();
let lastWakeAt = Date.now();
// Sticky-escalation latch — set once a real connecting consumer OBSERVES the lost condition (see
// latchLost + use-connection-lost) and cleared ONLY by a provably-live poll (markLive). While latched,
// effectiveAnchor() drops the wake grace, so backgrounding + returning MID-OUTAGE can no longer
// downgrade red → amber. Module-scoped so every consumer agrees on one escalated/not answer.
let lostLatched = false;
// How many HERD reads in a row came back as a server error (a 5xx, most often a proxy whose bridge is
// down). See `noteServerFailure`: one such answer is a blip, two in a row are an outage.
let serverFailures = 0;
// The last real wake (markWake). Apart from `lastWakeAt`, which also starts at module load: opening the
// app is not a wake for the strike, because a cold open draws the saved copy until its first live answer
// anyway (lib/loaders.ts `drawnFromSave`). -Infinity until the first one.
let wokeAt = Number.NEGATIVE_INFINITY;
// When the newest herd read started, and whether the page was hidden then (`noteReadStart`). Null once
// its failure has been counted, and before any read.
let readStartedAt: number | null = null;
let readStartedHidden = false;
// The wake's one strike is spent: the next read with no answer latches. Cleared by a live answer and by
// the next wake.
let wakeStrike = false;
// How many long uploads the operator started are in flight right now. A counter, not a boolean: two
// panes can each be transcribing a clip, and the second one finishing must not un-suspend the first.
let longUploads = 0;
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
  serverFailures = 0;
  wakeStrike = false;
  emit();
}

/**
 * What kind of failure a read was (lib/api.ts `readFailureKind`).
 *
 *  - `network`: the request never got an answer. A thrown `fetch` (no route, airplane mode) or the
 *    poll timeout running out (lib/api.ts `POLL_TIMEOUT_MS`). A VPN that stays up while the radio is
 *    off is this case: the request goes into the tunnel and nothing comes back.
 *  - `server`: an answer came back, and it was a 5xx. A proxy in front of a stopped bridge says this,
 *    and so does a bridge having one bad moment, so ONE of them proves nothing.
 *  - `other`: a refusal or any other answer. It says nothing about the connection.
 */
export type ReadFailureKind = "network" | "server" | "other";

/** How many server errors in a row latch the outage. A network failure latches on the first. */
export const SERVER_FAILURES_TO_LATCH = 2;

/**
 * Stamp the start of a HERD read (lib/api.ts `fetchSnapshot`), so the failure that may follow can be
 * judged by when it started: before or near a wake, or while the page was hidden (see
 * `noteNetworkFailure`).
 *
 * A stamp in the store, read by a nullary note, rather than a start time passed to the note: this store
 * has no parameters by design (host-health.test.ts pins every export's arity). One stamp is enough,
 * because only one herd read is in flight at a time: the poll supersedes the old one before it starts
 * another, and a superseded read counts nothing.
 */
export function noteReadStart(): void {
  readStartedAt = Date.now();
  readStartedHidden = pageHidden();
}

/**
 * Count one failed HERD read that got NO answer (lib/api.ts `fetchSnapshot`, the read every poll
 * makes): it latches the outage at once. M46 pass 3, decided 2026-10-07: the 15s wait made the phone
 * slow to admit it had lost the bridge. A live answer clears the latch (markLive). The latch is what
 * turns the screen into the saved copy (the loaders' `stale`, the Chat window's saved-copy mark, the
 * red strip and the muted dog), so all of them flip on the same failure.
 *
 * Right after a wake the first such read is one strike instead (see the header, 2026-10-08): it
 * latches nothing, the poll retries it 0.5s later, and the next read with no answer latches at once.
 *
 * Two nullary functions rather than one that takes the kind: this store has no parameters by design
 * (host-health.test.ts pins every export's arity), and the caller already knows which one it is.
 */
export function noteNetworkFailure(): void {
  const strike = !wakeStrike && readNearWake();
  readStartedAt = null;
  if (strike) {
    wakeStrike = true;
    return;
  }
  latchLost();
}

/**
 * Whether a read that got no answer right now is still inside the wake's one strike, and so proves
 * nothing yet. The pane and Chat reads ask this before they draw their saved copy at once: they fail in
 * the same poll as the herd read, and they must not say "outage" over the strike the herd read took.
 * False once the outage is latched.
 */
export function wakeStrikeHolds(): boolean {
  if (lostLatched) return false;
  return wakeStrike || readNearWake();
}

/** Whether the newest herd read began near a wake: hidden, in flight across it, or soon after it. */
function readNearWake(): boolean {
  if (readStartedAt === null) return false;
  if (readStartedHidden || pageHidden()) return true;
  return readStartedAt < wokeAt + WAKE_STRIKE_MS;
}

function pageHidden(): boolean {
  return hasDocument() && document.visibilityState === "hidden";
}

/** Count one failed herd read that came back as a 5xx: the second in a row latches the outage. */
export function noteServerFailure(): void {
  serverFailures += 1;
  if (serverFailures >= SERVER_FAILURES_TO_LATCH) latchLost();
}

/**
 * Stamp a wake: the tab returned to the foreground, granting a fresh grace window before escalation
 * (a phone resuming from sleep shouldn't flash red while its first poll is still in flight). Does NOT
 * touch the latch: while escalated, effectiveAnchor() ignores this stamp, so a mid-outage app switch
 * can't reset the countdown or downgrade red back to amber. It does open the wake's one strike (see
 * `noteNetworkFailure`): the first herd read near it that gets no answer latches nothing.
 */
export function markWake(): void {
  lastWakeAt = Date.now();
  wokeAt = lastWakeAt;
  // Every wake grants its own strike: an old one spent before the phone slept says nothing now.
  wakeStrike = false;
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

/**
 * A LONG UPLOAD THE OPERATOR STARTED — begin.
 *
 * One thing only: for as long as one is in flight, slowness is not evidence of an outage. A voice
 * clip is megabytes going UP a phone's uplink, which is the narrow half of a mobile link; the
 * snapshot poll then queues behind it and looks stalled, and Collie used to answer that by fading in
 * the amber "Reconnecting…" bar over a connection that was working perfectly and was busy carrying
 * the operator's own recording. Reported from the v1 beta.
 *
 * Two consumers, and they are the whole of it: `use-connection-lost` stops escalating while this is
 * set, and `use-polling` stops ticking, which leaves the uplink to the upload rather than racing it.
 * It is NOT a connection state of its own — nothing renders from it, and the transcription's own
 * failure message is what speaks if the upload really does fail.
 */
export function beginLongUpload(): void {
  longUploads += 1;
  emit();
}

/**
 * A long upload finished, failed or was discarded — the counter must fall on every one of those
 * paths, which is why the only caller wraps it in a `finally`.
 *
 * Releasing stamps a WAKE, for the reason returning to the foreground does: the anchor went stale
 * while we were deliberately not polling, so measuring escalation from it would flash the bar the
 * instant the transcript landed. The wake grants one fresh window, and the next poll — which
 * `use-polling` resumes immediately — either proves the link live or escalates honestly.
 */
export function endLongUpload(): void {
  longUploads = Math.max(0, longUploads - 1);
  if (longUploads === 0) markWake();
  else emit();
}

/** Whether any long upload is in flight. A live read, for the poll tick that runs off an interval. */
export function isLongUpload(): boolean {
  return longUploads > 0;
}

/** Reactive read of {@link isLongUpload}, on the same store subscription as the anchor. */
export function useLongUpload(): boolean {
  return useSyncExternalStore(subscribeHealth, isLongUpload, isLongUpload);
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
/** {@link isLostLatched} for a component: re-renders when the latch is set or cleared. */
export function useLostLatched(): boolean {
  return useSyncExternalStore(subscribeHealth, isLostLatched, isLostLatched);
}

export function useConnectionHealth(): number {
  return useSyncExternalStore(subscribeHealth, effectiveAnchor, effectiveAnchor);
}

// A phone backgrounds Collie (screen off, app switch) far more than it truly disconnects; timers
// freeze while it's away. On return, grant a fresh grace window rather than escalating on the stale,
// pre-sleep anchor. Module-level (registered once) so it's independent of any component's lifecycle.
if (hasDocument()) {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") markWake();
  });
}

/**
 * Test helper — reset both anchors (defaults to now) AND clear the sticky latch between cases. It
 * clears the strike too, and leaves no wake behind: a reset phone has not just woken.
 * Notifies subscribers, same as every other mutation in this module (markLive/markWake/latchLost),
 * so a reset mid-test (e.g. the playground driving a control) repaints deterministically instead of
 * waiting for a consumer's own once-per-mount self-correction timer.
 */
export function __resetConnectionHealth(now = Date.now()): void {
  lastLiveAt = now;
  lastWakeAt = now;
  lostLatched = false;
  serverFailures = 0;
  wokeAt = Number.NEGATIVE_INFINITY;
  readStartedAt = null;
  readStartedHidden = false;
  wakeStrike = false;
  longUploads = 0;
  emit();
}
