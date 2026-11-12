// WHAT A PART'S FRAME SAYS (M94 slice 02): the freshness rule of the design's section 4 and the failure
// display of its section 7, as one pure reading. `part-frame.tsx` draws it.
//
// One line under the part, always reserved, so a part going stale or failing repaints the line and
// moves nothing. The line names ONE thing, the most pressing:
//
//   1. The last tap on this part failed, was refused, or got no answer.  (the person just acted here)
//   2. The trick stopped after repeated failures, or is paused.  (nothing will change on its own soon)
//   3. The last run failed and this is the last good version.
//   4. The part is older than its fresh window.                 (the tone goes)
//   5. The part is fresh: the line says its age in muted text, "just now", "2 min ago" (slice 03), so
//      it is never a blank band, and it still never moves.
//
// A part past its window loses its tone whatever the line says, so a bridge that is down cannot leave
// "deploy green" on the glass.

import { freshWindowMs, parseDuration, type TapRefusal, type WireTrickInfo, type WireTrickPart } from "./schema";
import type { TapState } from "./store";

export type FrameLine =
  /** Fresh. The line carries the part's age, when it has one. */
  | { kind: "none"; asOf?: string }
  | { kind: "age"; asOf: string }
  | { kind: "failed"; asOf: string | undefined; problem: string | undefined }
  | { kind: "paused"; retryAt: string | undefined; problem: string | undefined }
  | { kind: "stopped"; problem: string | undefined }
  | { kind: "tap-failed"; problem: string }
  /** The bridge refused the last tap before anything ran (fault A): the line says why, in Collie's words. */
  | { kind: "tap-refused"; refused: TapRefusal }
  | { kind: "tap-unknown" };

export interface FrameReading {
  /** The part is past its fresh window: every status tone draws in the unknown grey. */
  stale: boolean;
  line: FrameLine;
}

/**
 * How long a part keeps its tone after `asOf`: its own `fresh`, else the schema's default window.
 * DECISION: the phone does not know the trick's `every`, so a part with no `fresh` gets the default
 * for a trick with no timer, ten minutes. The bridge may write `fresh` on every part it stores.
 */
export function partWindowMs(part: WireTrickPart): number {
  const fresh = part.fresh === undefined ? undefined : parseDuration(part.fresh);
  return freshWindowMs(fresh, undefined);
}

/**
 * Whether a part is past its window at `now` (the bridge's clock). DECISION: a part with no `asOf`
 * (or one that does not parse) is not judged stale here, because there is no age to show; the bridge
 * stamps every stored part, so this is a crew member on another version.
 */
export function isPastWindow(part: WireTrickPart, now: number): boolean {
  if (part.asOf === undefined) return false;
  const asOf = Date.parse(part.asOf);
  if (!Number.isFinite(asOf)) return false;
  return now - asOf > partWindowMs(part);
}

/** Read a part's frame. `trick` is its entry in the trick list; `retryAt` is when a paused trick runs again, when known. */
export function readFrame(part: WireTrickPart, trick: WireTrickInfo | undefined, tap: TapState | undefined, now: number, retryAt?: string): FrameReading {
  const stale = isPastWindow(part, now);
  if (tap?.phase === "failed" && tap.refused !== undefined) return { stale, line: { kind: "tap-refused", refused: tap.refused } };
  if (tap?.phase === "failed") return { stale, line: { kind: "tap-failed", problem: tap.message } };
  if (tap?.phase === "unknown") return { stale, line: { kind: "tap-unknown" } };
  const problem = cleanProblem(part.problem ?? trick?.error);
  if (trick?.state === "stopped") return { stale, line: { kind: "stopped", problem } };
  if (trick?.state === "failing") return { stale, line: { kind: "paused", retryAt, problem } };
  if (part.stale === true) return { stale, line: { kind: "failed", asOf: part.asOf, problem } };
  if (stale && part.asOf !== undefined) return { stale, line: { kind: "age", asOf: part.asOf } };
  return { stale, line: part.asOf === undefined ? { kind: "none" } : { kind: "none", asOf: part.asOf } };
}

function cleanProblem(problem: string | undefined): string | undefined {
  return problem === undefined || problem.trim() === "" ? undefined : problem;
}

/** The masked line a frame shows on tap, and that its fix button hands to an agent. */
export function problemOf(line: FrameLine): string | undefined {
  if (line.kind === "tap-failed" || line.kind === "failed" || line.kind === "paused" || line.kind === "stopped") return line.problem;
  return undefined;
}
