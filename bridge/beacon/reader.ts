// The sweep: every beacon in the directory, decided live or expired, as of now.
//
// Pure and injectable. The directory and the pid probe are seams the caller supplies, so the whole
// of this module runs under `bun test` with no temp files and no live process — the repo convention
// (sessions.test.ts, state-engine.test.ts). The concrete filesystem and platform implementations of
// those seams live OUTSIDE bridge/beacon/ — no filesystem call of any kind appears under this
// directory, and M11/04 greps for that rather than trusting it.
//
// A BEACON IS A HINT, NEVER A CONTROL CHANNEL (.adr/0024). Nothing this module returns may cause a
// send, a key, a rename or a close. Its output feeds the snapshot join (M11/03) and the journal key
// (M11/04) and nothing else.

import { beaconKey, beaconKeyOf, beaconFileName } from "./paths.ts";
import { parseBeacon } from "./parse.ts";
import { BEACON_TTL_MS, type BeaconMarker, type BeaconReading, type BeaconRecord } from "./types.ts";

/**
 * The directory seam. Both methods answer `null` for "nothing here" rather than throwing, because
 * every failure mode of a beacon directory — absent, unreadable, a file that vanished mid-sweep, a
 * symlink the implementation refuses to follow — means exactly the same thing to the reader: skip it
 * and carry on.
 */
export interface BeaconDirectory {
  /** File names in the beacon directory, or null when it cannot be listed at all. */
  list(): Promise<readonly string[] | null>;
  /** One file's text, or null when it is gone, unreadable, or not a regular file we will follow. */
  read(name: string): Promise<string | null>;
}

/**
 * The liveness seam — the precise half of expiry.
 *
 * `startTimeOf` answers the start time of the process currently holding `pid`, or null when no
 * process holds it. The reader compares that against the beacon's stored `pidStartTime`, which is
 * what makes pid reuse a dead beacon instead of a resurrected one: a recycled pid is running, but it
 * started at a different moment, and it is not the agent that wrote this file.
 */
export interface BeaconLiveness {
  startTimeOf(pid: number): Promise<number | null>;
}

/** What a sweep needs. `now` and `ttlMs` are injected so a test can pin a clock; production omits both. */
export interface BeaconSweepDeps {
  readonly directory: BeaconDirectory;
  readonly liveness: BeaconLiveness;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

/**
 * Is this beacon's process still the process that wrote it?
 *
 * Two ways to be false and they are not the same: nobody holds the pid (the agent exited), or
 * somebody does but started at another moment (the pid was recycled). Both are "the agent is gone",
 * which is the only thing the caller needs.
 */
async function pidIsStillOurs(record: BeaconRecord, liveness: BeaconLiveness): Promise<boolean> {
  const startTime = await liveness.startTimeOf(record.pid).catch(() => null);
  return startTime !== null && startTime === record.pidStartTime;
}

/**
 * One file's text as a reading, or null when it is not a beacon we will use.
 *
 * The file name must be the digest of the record's own markers. That check is what keeps a foreign
 * file — or a beacon copied to a second name — from presenting a pane with a second identity: the
 * join matches on markers, so two files claiming the same markers would be two answers to a question
 * that has one. It also means a beacon can never be renamed onto another pane's key.
 */
async function readOne(
  name: string,
  deps: BeaconSweepDeps,
  now: number,
  ttlMs: number,
): Promise<BeaconReading | null> {
  const key = beaconKeyOf(name);
  if (key === null) return null;
  const text = await deps.directory.read(name).catch(() => null);
  if (text === null) return null;
  const record = parseBeacon(text);
  if (record === null) return null;
  if (beaconFileName(beaconKey(record.markers)) !== name) return null;

  // EXPIRY IS `pid dead OR heartbeat stale`. The pid carries the weight — it is the precise signal,
  // and it is the one that catches an agent that died a second ago. The heartbeat is the backstop for
  // a machine that never got to run a `SessionEnd` hook at all (a `kill -9`, a laptop lid), which is
  // why its TTL is measured in hours rather than minutes: see BEACON_TTL_MS.
  const fresh = now - record.heartbeatMs <= ttlMs;
  const live = fresh && (await pidIsStillOurs(record, deps.liveness));

  // The status is DROPPED here, not carried and ignored downstream. An expired beacon keeps its
  // session ref because a finished conversation is still readable (M11/04); it keeps no claim about
  // what the agent is doing, because it has not been able to make one since it died.
  if (!live) {
    return { liveness: "expired", key, harness: record.harness, session: record.session, markers: record.markers };
  }
  return {
    liveness: "live",
    key,
    harness: record.harness,
    session: record.session,
    markers: record.markers,
    status: record.status,
  };
}

/**
 * Every readable beacon in the directory, live and expired, ordered by key.
 *
 * TOTAL OVER GARBAGE. An unlistable directory, a file that is not ours, a torn write, a newer
 * schema, a symlink the seam declined to follow, a read that failed mid-sweep — each is skipped and
 * the sweep continues. A directory of garbage yields an empty list and never throws, because the
 * honest reading of "I could not understand this file" is the same as "there is no beacon here",
 * which every consumer already handles.
 */
export async function readBeacons(deps: BeaconSweepDeps): Promise<readonly BeaconReading[]> {
  const names = await deps.directory.list().catch(() => null);
  if (names === null) return [];
  const now = (deps.now ?? Date.now)();
  const ttlMs = deps.ttlMs ?? BEACON_TTL_MS;
  const readings: BeaconReading[] = [];
  for (const name of names) {
    const reading = await readOne(name, deps, now, ttlMs);
    if (reading !== null) readings.push(reading);
  }
  return readings.toSorted((a, b) => a.key.localeCompare(b.key));
}

/**
 * The marker entries of one reading that belong to `namespace`.
 *
 * THE LIST IS THE POINT. A beacon written inside a nested pair carries one entry per multiplexer it
 * could see, and each adapter's matcher asks only for its own — so a Collie driving the inner
 * multiplexer and a Collie driving the outer one read the same file and each finds its own answer.
 * Returning a list rather than a first hit keeps that honest: an emitter that somehow saw two panes
 * of one multiplexer must not have one of them silently chosen for it.
 */
export function markersIn(reading: BeaconReading, namespace: string): readonly BeaconMarker[] {
  return reading.markers.filter((marker) => marker.namespace === namespace);
}
