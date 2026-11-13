// Where a part's hello lands (M99 spec 01, README decision 3): the edge placement, unchanged.
//
// A hello is placed exactly as a hook edge is (`bridge/surface/edges.ts` placeEdge): the marker table
// (`bridge/beacon/env-markers.ts`) turns the part's raw variables into markers, exactly one pane of
// this bridge's sessions must match one of them, the pid must be alive with the start time the part
// named, and where the multiplexer reports the pane's foreground, it must hold the pid. Anything else
// is "not mine", with the placement's own reason word. No heuristic, no second rule.
//
// A part that cannot read its own start time (a platform with no `/proc`) sends none; the bridge then
// reads the pid's start time itself and binds to that, so a reused pid still breaks the binding later.

import type { BeaconLiveness } from "../beacon/reader.ts";
import { readEnvMarkers } from "../beacon/env-markers.ts";
import { EDGE_SCHEMA_VERSION, type EdgeRecord } from "../beacon/types.ts";
import { placeEdge, type EdgeTarget } from "../surface/edges.ts";
import type { PlaceResult } from "./hub.ts";
import type { Hello } from "./wire.ts";

/** The edge event name a hello is placed under. It reaches no fold: the record is only placed. */
const HELLO_EVENT = "inside.hello";

/** Place a hello on one pane of the given targets. */
export async function placeHello(hello: Hello, targets: readonly EdgeTarget[], liveness: BeaconLiveness, now: () => number = Date.now): Promise<PlaceResult> {
  const markers = readEnvMarkers(hello.env);
  if (markers.length === 0) return { kind: "not-mine", reason: "no-markers" };
  const start = hello.pidStartTime ?? (await liveness.startTimeOf(hello.pid).catch(() => null));
  if (start === null) return { kind: "not-mine", reason: "dead-pid" };
  const record: EdgeRecord = {
    schemaVersion: EDGE_SCHEMA_VERSION,
    harness: hello.harness,
    event: HELLO_EVENT,
    detail: null,
    pid: hello.pid,
    pidStartTime: start,
    markers,
    at: now(),
    promptHash: null,
  };
  const placement = await placeEdge(record, targets, liveness);
  if (placement.kind === "dropped") return { kind: "not-mine", reason: placement.reason };
  return { kind: "placed", address: { session: placement.target.session, paneId: placement.paneId }, pidStartTime: start };
}
