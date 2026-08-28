// The meaning behind the plain numbers ui/strip-host.tsx arbitrates on. StripHost is deliberately
// domain-blind — it doesn't know what a connection or an update is, only that a bigger number wins
// — so the fact "AUTH beats OUTAGE beats DEGRADED beats UPDATE" has to live somewhere that DOES
// know what those words mean. That's here, on the feature side, not in ui/.
//
// The gaps are 10, not 1, so a future strip can be slotted between two existing ones (say, a new
// level between OUTAGE and DEGRADED) by picking a number in the gap, without renumbering anything
// else and without churning every call site that already reads one of these constants.

/** The operator's writes are at risk (session auth has failed) — the loudest fact this app has. */
export const AUTH = 40;

/** The connection is down; nothing round-trips until it recovers. */
export const OUTAGE = 30;

/** The connection is up but unhealthy — reconnecting, degraded, slow. */
export const DEGRADED = 20;

/** A new build is available. A calm fact, not a warning — lowest priority by design. */
export const UPDATE = 10;
