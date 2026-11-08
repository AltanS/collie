// WHAT A PART'S FRAME SAYS (M94 slice 02): the freshness rule of the design's section 4 and the failure
// display of its section 7, as one pure reading. `part-frame.tsx` draws it.
//
// One line under the part, always reserved, so a part going stale or failing repaints the line and
// moves nothing. The line names ONE thing, the most pressing:
//
//   1. The last tap on this part failed, or got no answer.      (the person just acted here)
//   2. The mod stopped after repeated failures, or is paused.  (nothing will change on its own soon)
//   3. The last run failed and this is the last good version.
//   4. The part is older than its fresh window.                 (the tone goes)
//   5. Nothing: the part is fresh, and the line is empty.
//
// A part past its window loses its tone whatever the line says, so a bridge that is down cannot leave
// "deploy green" on the glass.

import { freshWindowMs, parseDuration, type WireModInfo, type WireModPart } from "./schema";
import type { TapState } from "./store";

export type FrameLine =
  | { kind: "none" }
  | { kind: "age"; asOf: string }
  | { kind: "failed"; asOf: string | undefined; problem: string | undefined }
  | { kind: "paused"; retryAt: string | undefined; problem: string | undefined }
  | { kind: "stopped"; problem: string | undefined }
  | { kind: "tap-failed"; problem: string }
  | { kind: "tap-unknown" };

export interface FrameReading {
  /** The part is past its fresh window: every status tone draws in the unknown grey. */
  stale: boolean;
  line: FrameLine;
}

/**
 * How long a part keeps its tone after `asOf`: its own `fresh`, else the schema's default window.
 * DECISION: the phone does not know the mod's `every`, so a part with no `fresh` gets the default
 * for a mod with no timer, ten minutes. The bridge may write `fresh` on every part it stores.
 */
export function partWindowMs(part: WireModPart): number {
  const fresh = part.fresh === undefined ? undefined : parseDuration(part.fresh);
  return freshWindowMs(fresh, undefined);
}

/**
 * Whether a part is past its window at `now` (the bridge's clock). DECISION: a part with no `asOf`
 * (or one that does not parse) is not judged stale here, because there is no age to show; the bridge
 * stamps every stored part, so this is a crew member on another version.
 */
export function isPastWindow(part: WireModPart, now: number): boolean {
  if (part.asOf === undefined) return false;
  const asOf = Date.parse(part.asOf);
  if (!Number.isFinite(asOf)) return false;
  return now - asOf > partWindowMs(part);
}

/** Read a part's frame. `mod` is its entry in the mod list; `retryAt` is when a paused mod runs again, when known. */
export function readFrame(part: WireModPart, mod: WireModInfo | undefined, tap: TapState | undefined, now: number, retryAt?: string): FrameReading {
  const stale = isPastWindow(part, now);
  if (tap?.phase === "failed") return { stale, line: { kind: "tap-failed", problem: tap.message } };
  if (tap?.phase === "unknown") return { stale, line: { kind: "tap-unknown" } };
  const problem = cleanProblem(part.problem ?? mod?.error);
  if (mod?.state === "stopped") return { stale, line: { kind: "stopped", problem } };
  if (mod?.state === "failing") return { stale, line: { kind: "paused", retryAt, problem } };
  if (part.stale === true) return { stale, line: { kind: "failed", asOf: part.asOf, problem } };
  if (stale && part.asOf !== undefined) return { stale, line: { kind: "age", asOf: part.asOf } };
  return { stale, line: { kind: "none" } };
}

function cleanProblem(problem: string | undefined): string | undefined {
  return problem === undefined || problem.trim() === "" ? undefined : problem;
}

/** The masked line a frame shows on tap, and that its fix button hands to an agent. */
export function problemOf(line: FrameLine): string | undefined {
  if (line.kind === "tap-failed" || line.kind === "failed" || line.kind === "paused" || line.kind === "stopped") return line.problem;
  return undefined;
}
