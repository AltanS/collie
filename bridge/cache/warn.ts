// Which watched panes earn a push right now. ONE PURE FUNCTION, and that is the whole module.
//
// No timer, no clock, no HTTP server, no `Push`: `nowMs` arrives as a parameter, the marks to record
// are RETURNED beside the messages, and the caller is what writes either one. That is collie's rule for
// new bridge logic (CLAUDE.md § Tests) and it is what lets `bun test` drive every gate below as data.
//
// ── FIVE CONDITIONS, AND THE THIRD IS THE ONE NOBODY EXPECTS ─────────────────
// The configured window was sized for a one-hour cache (Claude's), so a shorter-lived rule gets HALF
// its own lifetime as its window instead of the fixed one: `effectiveWarn = min(warnSeconds,
// floor(ttlSeconds / 2))`. A 3600 s pane keeps the 300 s default unchanged; a 300 s pane (Codex,
// OpenCode, pi, omp — see `bridge/cache/rules/*.ts`) warns at 150 s left, and a 180 s Google pane at
// 90 s. The old rule skipped any pane whose TTL did not exceed the fixed window outright, which meant
// the push could never fire for those harnesses at all; halving keeps the same "never warn on every
// request" guarantee — the window is still well inside the TTL — without silencing them.
//
// ── ONE TAG PER WATCHED PANE, WITH `renotify` ────────────────────────────────
// Two watched panes must never overwrite each other, which is why this does not reuse the herd slot:
// that slot is the coordinator's single summary and a cache warning is not part of that summary. WITHIN
// one pane the collapse is deliberate the other way — a new cycle's warning REPLACES the last one on a
// platform that collapses by tag, and `renotify` makes the replacement alert rather than land silently
// (`web/src/sw.ts` § showNotification). One live warning per watched pane is what is wanted; a stack of
// stale deadlines is not.
//
// Push strings are NOT translated (ADR 0030, restated in CLAUDE.md), so the two sentences are written
// in English here exactly as `"Collie update available"` is at its own send site.

import type { PushMessage } from "../push.ts";
import { sentMarkOf, watchIdOf, type CacheWarnPane } from "./watch-key.ts";

/** Everything {@link cacheWarnings} is allowed to look at. */
export interface CacheWarnInput {
  /** Every pane in play: this collie's, plus a member's when a lead is judging a swept body. */
  readonly panes: readonly CacheWarnPane[];
  /** `prefs.cache` OR the store says yes. The precedence rule, handed in as a predicate (ADR 0042). */
  readonly watched: (pane: CacheWarnPane) => boolean;
  readonly nowMs: number;
  /** The push window, `COLLIE_CACHE_WARN_SECONDS`. NOT spec 02's amber threshold — see docs/configure.md. */
  readonly warnSeconds: number;
  /** The `(key, expiresAt)` marks already pushed, as {@link sentMarkOf} spells them. */
  readonly sent: ReadonlySet<string>;
}

/** The messages to send, and the marks to record once they are sent. */
export interface CacheWarnings {
  readonly messages: PushMessage[];
  readonly sentPairs: { key: string; expiresAt: number }[];
}

/**
 * The window in whole minutes, which is what the copy says — and it says "about" with it.
 *
 * The deadline is inferred from a transcript tail with a stated confidence (spec 02) and the clock is
 * the mux poll, 12 s coarse when idle. "About" is the honest word for a number that is right to within
 * a few percent, and it costs nothing to say.
 */
export function warnMinutes(warnSeconds: number): number {
  return Math.max(1, Math.round(warnSeconds / 60));
}

/** Fold the five conditions over every pane. Returns messages plus the marks that record them. */
export function cacheWarnings(input: CacheWarnInput): CacheWarnings {
  const { panes, watched, nowMs, warnSeconds, sent } = input;
  const messages: PushMessage[] = [];
  const sentPairs: { key: string; expiresAt: number }[] = [];
  for (const pane of panes) {
    const cache = pane.cache;
    // 2. A reading with a deadline, and a state that still has one ahead of it. An absent `cache` key
    //    is the ordinary case for a pane whose agent has not taken a turn yet (spec 02, Decision 1).
    //    A pane cold from a pending reset (a `/model` switch, issue #236) still has a deadline ahead,
    //    but no cache behind it, so "goes cold in about 5 min" would be false twice: it stays silent.
    if (cache === undefined || cache.expiresAt === undefined) continue;
    if (cache.state !== "warm" && cache.state !== "expiring") continue;
    // 3. See the module header: the window is halved for a cache shorter than twice it.
    const effectiveWarn = Math.min(warnSeconds, Math.floor(cache.ttlSeconds / 2));
    const effectiveWindowMs = effectiveWarn * 1000;
    // 4. Inside the window, and not already past the deadline.
    const left = cache.expiresAt - nowMs;
    if (left <= 0 || left > effectiveWindowMs) continue;
    // 1. And the operator asked about this one — the global switch or the list.
    if (!watched(pane)) continue;
    // 5. Once per warm cycle. The last outbound request moves `expiresAt`, and only then may it warn
    //    again, which is what makes the pair the unit of suppression rather than the key.
    const mark = sentMarkOf(pane.key, cache.expiresAt);
    if (sent.has(mark)) continue;
    messages.push(warnMessage(pane, effectiveWarn));
    sentPairs.push({ key: pane.key, expiresAt: cache.expiresAt });
  }
  return { messages, sentPairs };
}

/** One pane's warning. The host leads the body for a peer's pane, as `makeNotifySink` already does. */
function warnMessage(pane: CacheWarnPane, warnSeconds: number): PushMessage {
  const body = pane.host === undefined ? pane.label : `${pane.host} · ${pane.label}`;
  const msg: PushMessage = {
    // The opaque id rather than the key: a key holds a NUL and, for pi, an absolute path.
    tag: `collie:cache:${watchIdOf(pane.key)}`,
    title: `Cache goes cold in about ${warnMinutes(warnSeconds)} min`,
    // The rule is IN the notification rather than only in the docs, because the docs are not what a
    // phone shows at 300 seconds, and nobody should sit waiting for a second nudge at one minute.
    body: `${body}. One warning per cycle.`,
    paneId: pane.paneId,
    renotify: true,
  };
  if (pane.session !== undefined) msg.session = pane.session;
  if (pane.host !== undefined) msg.host = pane.host;
  return msg;
}
