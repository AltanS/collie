// THE VERDICT: what one measured tap target is judged to be, from the numbers the scanner took
// (`scan.ts`) and, where a run has them, the two dynamic ones (how far it moved when a pane arrived,
// whether a long press steals its tap). Pure: no DOM, no I/O. The census script stamps every row with
// it when it writes the JSON, and the playground sorts and groups by it, so a rule changed here
// changes both. The numbers are DESIGN.md §6's: 44px is the floor for anything tappable, and the
// brief that started this asks for 8px between two targets.

import type { Target } from "./scan";

/** The floor, in CSS px, of a tap target's reach in either axis. DESIGN.md §6. */
export const FLOOR = 44;
/** The gap, in CSS px, below which two small targets are too close to tell apart with a finger. */
export const MIN_GAP = 8;
/** Below this share of its own box reached, something lies over the target. */
export const COVERED_BELOW = 0.9;
/** How far a target may move between a pane arriving and the finger landing and still be the same target. */
export const SHIFT_PX = 1;

export type Verdict = "ok" | "small" | "covered" | "shifts" | "dead-time";

/** How many targets hold each verdict. */
export interface VerdictTally {
  ok: number;
  small: number;
  covered: number;
  shifts: number;
  "dead-time": number;
}

/** The facts a run adds that the scanner cannot take from one still page. */
export interface Dynamic {
  /** How far the target moved when a pane arrived above it, in px. Null: not measured, or it went away. */
  shiftPx: number | null;
}

export interface Judged {
  verdict: Verdict;
  /** Every reason that applies, worst first. The verdict is the first. */
  flags: string[];
  /** A sort key: higher is worse. */
  severity: number;
}

/** The smaller side of what a finger reaches: the hit area where there is one, else the box. */
export function reachMin(t: Pick<Target, "box" | "hit">): number {
  const r = t.hit ?? t.box;
  return Math.min(r.w, r.h);
}

export function judge(t: Target, dyn: Dynamic = { shiftPx: null }): Judged {
  const parts: { kind: Verdict; flag: string; score: number }[] = [];
  const share = t.hit === null ? 0 : t.hitShare;
  // A link that wraps over several lines has a bounding box that is mostly the paragraph around it, so its share says nothing.
  if (!t.inline && share < COVERED_BELOW) parts.push({ kind: "covered", flag: `covered ${String(Math.round((1 - share) * 100))}% by ${t.coveredBy[0] ?? "a layer"}`, score: 100 * (1 - share) });
  if (!t.inline && t.restShare !== null && t.restShare < COVERED_BELOW) {
    parts.push({ kind: "covered", flag: `covered ${String(Math.round((1 - t.restShare) * 100))}% where first seen, by ${t.restCoveredBy[0] ?? "a layer"}`, score: 50 * (1 - t.restShare) });
  }
  const side = reachMin(t);
  if (side < FLOOR) {
    const tight = t.gap !== null && t.gap < MIN_GAP;
    parts.push({ kind: "small", flag: `reach ${String(Math.round(side))}px under ${String(FLOOR)}${tight ? `, ${String(t.gap)}px from ${t.gapTo ?? "the next target"}` : ""}`, score: ((FLOOR - side) / FLOOR) * 60 + (tight ? 10 : 0) });
  }
  if (dyn.shiftPx !== null && dyn.shiftPx > SHIFT_PX) parts.push({ kind: "shifts", flag: `moves ${String(Math.round(dyn.shiftPx))}px when a pane arrives`, score: 25 + Math.min(15, dyn.shiftPx / 10) });
  if (t.holdGuard) parts.push({ kind: "dead-time", flag: "a press over 450ms is a hold, not a tap", score: 12 });
  const sorted = parts.toSorted((a, b) => b.score - a.score);
  const first = sorted[0];
  if (first === undefined) return { verdict: "ok", flags: [], severity: 0 };
  return { verdict: first.kind, flags: sorted.map((p) => p.flag), severity: Math.round(sorted.reduce((sum, p) => sum + p.score, 0) * 10) / 10 };
}
