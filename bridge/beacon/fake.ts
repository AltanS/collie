// A BEACON DIRECTORY IN MEMORY — what lets the decorator and the decorated conformance fixtures run
// with no state directory, no agent and no hooks installed anywhere.
//
// NOT a production module and not imported by one; it is the beacon half of what `mux/*/fixture.ts`
// is for a multiplexer's transport. It keeps this directory's rule intact — there is no filesystem
// call here either, only the two seams `reader.ts` declares, answered out of a map.
//
// THE FILE NAMES ARE THE REAL ONES. Every record is stored under `beaconFileName(beaconKey(markers))`
// exactly as the emitter writes it, so the reader's "the name must be the digest of the record's own
// markers" check is EXERCISED rather than bypassed — a fake that named files freely would let a
// beacon reach a pane by a route the shipped code refuses.

import { beaconFileName, beaconKey } from "./paths.ts";
import type { BeaconDirectory, BeaconLiveness, BeaconSweepDeps } from "./reader.ts";
import type { BeaconRecord } from "./types.ts";

/** One seeded beacon, and whether the process that wrote it is still running. */
export interface FakeBeacon {
  readonly record: BeaconRecord;
  /** False for a beacon whose agent has gone — the reader then reads it as expired. Default true. */
  readonly alive?: boolean;
}

/** The fixed moment a fake sweep happens at. Every seeded heartbeat is measured against it. */
export const FAKE_BEACON_NOW = 1_800_000_000_000;

/**
 * A reader over the given beacons.
 *
 * The clock is pinned rather than `Date.now`, so a fixture's beacon is fresh for as long as the
 * fixture exists and a test never races the TTL.
 */
export function fakeBeaconReader(beacons: readonly FakeBeacon[]): BeaconSweepDeps {
  const files = new Map<string, string>();
  const startTimes = new Map<number, number>();
  for (const beacon of beacons) {
    files.set(beaconFileName(beaconKey(beacon.record.markers)), `${JSON.stringify(beacon.record)}\n`);
    if (beacon.alive !== false) startTimes.set(beacon.record.pid, beacon.record.pidStartTime);
  }
  const directory: BeaconDirectory = {
    list: () => Promise.resolve([...files.keys()]),
    read: (name) => Promise.resolve(files.get(name) ?? null),
  };
  const liveness: BeaconLiveness = {
    startTimeOf: (pid) => Promise.resolve(startTimes.get(pid) ?? null),
  };
  return { directory, liveness, now: () => FAKE_BEACON_NOW };
}
