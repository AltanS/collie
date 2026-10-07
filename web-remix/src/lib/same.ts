// "Did this poll bring anything new?" The pure half of the quiet-polls rule (REMIX3.md, "A module
// store is right when"): a poll whose payload did not change keeps the HELD object, so the store's
// equality gate holds and no subscriber wakes. Freshness (when the bridge last answered) is not part
// of any payload; it lives in its own store (`snapshotAt`, lib/data.ts).
//
// The snapshot is the hard case. The bridge sends no ETag for it, and its `ts` moves on every read
// (bench 2026-10-06; lib/polling.ts says why that also mattered for the cadence). So two bodies are
// the same when they serialize to the same JSON with the top-level `ts` set to 0. Both come from the
// bridge's one serializer, so the key order is stable; were it ever not, the cost is a spurious
// publish, never a missed one. About 5 KB per poll on a 7-agent herd. One reader DOES use `ts`:
// tier-2 crew health ages each member's `lastSeenAt` against it (web's lib/host-health.ts). With
// members present, a body whose only change is `ts` still counts as new when it moves any member's
// health (its state, its writability or its "last seen" label), so a member that stops answering
// still goes stale on screen.
import { hostHealthMap } from "@web/lib/host-health";
import type { SnapshotResponse } from "@web/lib/types";

import type { PaneRead, PaneScreen } from "./pane-read";

/**
 * The cadence crew health is presented at. It is `IDLE_MS` in lib/polling.ts, restated here because
 * polling.ts imports lib/data.ts, which imports this file (`quiet-polls.test.ts` pins the two together).
 */
export const CREW_HEALTH_POLL_MS = 6000;

/** Each member's presented health, as one comparable string; "" for a solo snapshot. */
function crewHealthKey(body: SnapshotResponse): string {
  const servers = body.servers;
  if (servers === undefined || servers.length === 0) return "";
  const health = hostHealthMap(servers, { at: body.ts ?? 0, pollMs: CREW_HEALTH_POLL_MS });
  let key = "";
  for (const [id, h] of health) key += `${id}\u0000${h.state}\u0000${String(h.writable)}\u0000${h.lastSeenLabel}\u0001`;
  return key;
}

/** True when `next` brings nothing `held` does not already show (see the header for `ts`). */
export function sameSnapshot(held: SnapshotResponse, next: SnapshotResponse): boolean {
  if (held === next) return true;
  if (JSON.stringify({ ...held, ts: 0 }) !== JSON.stringify({ ...next, ts: 0 })) return false;
  return held.ts === next.ts || crewHealthKey(held) === crewHealthKey(next);
}

/**
 * True when two mirror reads show the same screen. `notModified` is the client's own flag, not the
 * payload. The revision IS payload: the dialog race guard reads it at tap time (routes/pane/pane.tsx
 * `target()`), so a moved revision publishes even over the same text.
 */
export function samePaneRead(a: PaneRead | undefined, b: PaneRead | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.paneId === b.paneId &&
    a.text === b.text &&
    a.revision === b.revision &&
    a.truncated === b.truncated &&
    a.logicalText === b.logicalText &&
    sameScreen(a.screen, b.screen)
  );
}

/**
 * True when two screen models are the same screen. The stamp covers the text and the agent, and every
 * other field but the reply's place is derived from them; the place is derived from the stamp's screen
 * and the probe, so the probe it answers belongs to the comparison too.
 */
function sameScreen(a: PaneScreen | undefined, b: PaneScreen | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.stamp === b.stamp &&
    a.agent === b.agent &&
    a.reply?.key === b.reply?.key &&
    a.reply?.fit === b.reply?.fit &&
    a.reply?.endLine === b.reply?.endLine
  );
}
