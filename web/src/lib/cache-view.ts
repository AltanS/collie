import { t } from "@/lib/i18n";
import type { PaneCache } from "@/lib/types";

// What the cache chip says, as a pure function of a pane's reading and the current time.
//
// Pure on purpose, and the reason is the grace below: "is this cold yet" is a rule with an edge, and a
// rule with an edge belongs in a table test rather than inside a component where it can only be
// checked by rendering.

/**
 * How far past `expiresAt` a chip waits before it says `cold` on its own.
 *
 * The bridge's reading can be up to one probe floor behind (five seconds), so a chip that flipped the
 * instant its own clock crossed zero would go cold and then warm again a second later on a busy
 * machine. Ten seconds is longer than that floor and far shorter than the shortest window any rule
 * describes (180 s), so it costs nothing a reader can perceive.
 */
export const COLD_GRACE_MS = 10_000;

/** What the chip renders: a tone, a label and whether to draw the overridden mark. */
export interface CacheChipView {
  tone: "warm" | "expiring" | "cold";
  /** Already localised. `12m`, `3m`, `<1m`, or the word for cold. */
  label: string;
  overridden: boolean;
}

/**
 * The chip for one pane, or `null` when there is nothing to say.
 *
 * `null` covers three cases that all render as an empty slot: no reading at all (the harness has no
 * adapter, the pane named no session, or the agent has not taken a turn yet), the `unknown` state, and
 * a reading with no expiry. None of them gets a placeholder: a chip that appears to say something and
 * says nothing is worse than no chip (ADR 0041).
 *
 * The bridge's own `state` is trusted for `cold`, because only the bridge can see a turn that MISSED —
 * a cache miss is cold with plenty of clock left. The local clock may only turn a `warm` or `expiring`
 * reading cold, and then only once the grace has passed.
 */
export function cacheChipView(cache: PaneCache | undefined, now: number): CacheChipView | null {
  if (cache === undefined || cache.state === "unknown") return null;
  const overridden = cache.overridden === true;
  if (cache.state === "cold") return { tone: "cold", label: t("cache.cold"), overridden };
  if (cache.expiresAt === undefined) return null;
  const msLeft = cache.expiresAt - now;
  if (msLeft <= -COLD_GRACE_MS) return { tone: "cold", label: t("cache.cold"), overridden };
  // Inside the grace the chip keeps the last thing the bridge said, rather than inventing a state.
  const tone = cache.state === "expiring" ? "expiring" : "warm";
  return { tone, label: remaining(msLeft), overridden };
}

/**
 * The countdown itself: whole minutes, and `<1m` below that.
 *
 * Never a second count. On a dashboard of forty rows a ticking seconds digit is forty things moving,
 * and the question the chip answers ("have I got time to finish this thought") is a minutes question.
 */
function remaining(msLeft: number): string {
  const mins = Math.floor(Math.max(0, msLeft) / 60_000);
  return mins < 1 ? t("cache.under1m") : `${mins}m`;
}
