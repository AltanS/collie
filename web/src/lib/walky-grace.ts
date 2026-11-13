/**
 * How long a message must have waited before the mark above the box tells the owner about it (M62 spec 03, the
 * 20 second grace of 2026-11-13). A person who types a line and sends it inside this time never sees the mark: the
 * message goes in by itself when the box clears. ONE constant, for every session, linked or not, and for both
 * reasons a message waits. Its own module with no imports, so the browser-leg rig reads the same number and moves
 * the phone's clock past it (`page.clock.fastForward`) instead of sleeping it. Nothing shortens it.
 */
export const WALKY_MARK_GRACE_MS = 20_000;
