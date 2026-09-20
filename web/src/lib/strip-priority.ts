// The meaning behind the plain numbers ui/strip-host.tsx arbitrates on. StripHost is deliberately
// domain-blind — it doesn't know what a connection or an update is, only that a bigger number wins
// — so the fact "AUTH beats OUTAGE beats UPDATE_RUN beats DEGRADED beats UPDATE" has to live
// somewhere that DOES know what those words mean. That's here, on the feature side, not in ui/.
//
// The gaps are 10, not 1, so a future strip can be slotted between two existing ones (say, a new
// level between OUTAGE and DEGRADED) by picking a number in the gap, without renumbering anything
// else and without churning every call site that already reads one of these constants.

/** The operator's writes are at risk (session auth has failed) — the loudest fact this app has. */
export const AUTH = 40;

/** The connection is down; nothing round-trips until it recovers. */
export const OUTAGE = 30;

/**
 * An update is running right now, on this crew, and this device is not the one driving it.
 *
 * ── WHY IT IS BELOW `OUTAGE` AND NOT ABOVE IT ───────────────────────────────
 * There is a real argument for above. A machine being rebuilt stops answering, so during a crew
 * update the red bar and this line are often the SAME event seen twice, and of the two sentences
 * "updating minibuch, restarting" is the one that explains the other.
 *
 * It is below anyway, because that argument only holds while the two ARE the same event. An outage
 * on a machine this run is not touching, or one that outlives a stalled run, is a different fact —
 * and hiding "cannot reach this machine" behind "an update is running" is the worse of the two
 * failures. Ranking is a blunt instrument for a conditional relationship, so the blunt instrument is
 * set to the safe side. Saying both at once, or naming the outage inside this line when it is the
 * updating member's, is the better answer and is not a patch-sized one.
 *
 * Above `DEGRADED`: a connection that is merely slow says less than a run in progress, and a run in
 * progress is frequently why it is slow.
 */
export const UPDATE_RUN = 25;

/** The connection is up but unhealthy — reconnecting, degraded, slow. */
export const DEGRADED = 20;

/** A new build is available. A calm fact, not a warning — lowest priority by design. */
export const UPDATE = 10;
