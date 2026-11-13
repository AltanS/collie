// Wake and state from a part's events (M99 spec 04, README decision 10).
//
// A part's `turn.start`, `turn.end` and `row` events are a WAKE and a STATE, never items: chat rows
// still come from the session file (v2 "Which source wins": the session file wins for items; a live
// channel beats a file for state). So an event does exactly two things, and the sink has no other door:
//  - it pokes the session's read now (the snapshot poll, and with it the session file's read);
//  - a turn event folds into the pane's Surface as the edge a hook would give: `prompt` (working) for
//    `turn.start`, `stop` (idle) for `turn.end`.

import type { EdgeKind } from "../../web/src/lib/surface/edges.ts";
import type { WireEvent } from "./wire.ts";

/** Where a wake goes. No item, no text: a row's door and id are not even passed on. */
export interface WakeSink {
  /** Fold a state edge into the pane's Surface, at the bridge's clock. */
  edge(paneId: string, kind: EdgeKind, at: number): void;
  /** Read the session now. */
  poke(): void;
}

/** The state edge an event carries, or null. */
export function wakeEdgeOf(event: WireEvent): EdgeKind | null {
  if (event.kind === "turn.start") return "prompt";
  if (event.kind === "turn.end") return "stop";
  return null;
}

/** Apply one event of a pane's part. Returns whether it woke anything. */
export function applyWake(sink: WakeSink, paneId: string, event: WireEvent, now: number): boolean {
  if (event.kind !== "turn.start" && event.kind !== "turn.end" && event.kind !== "row") return false;
  const edge = wakeEdgeOf(event);
  if (edge !== null) sink.edge(paneId, edge, now);
  sink.poke();
  return true;
}

/**
 * Whether a part's event should release its pane's oldest held send now: its turn end (spec 03), or its
 * word that the box holds no draft any more while its turn is known (spec 05, decision of 2026-11-13).
 * A "no draft" before the part's first turn word releases nothing: the run would meet an unknown turn
 * and take the screen road. The run asks the turn and the draft again before anything goes.
 */
export function releasesHeld(event: WireEvent, turn: "running" | "idle" | null): boolean {
  if (event.kind === "turn.end") return true;
  return event.kind === "draft.state" && !event.present && turn !== null;
}
