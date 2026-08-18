import { join } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import { deriveMode, type PackMode } from "./mode.ts";
import { enrollmentOf, type TrustStoreData } from "./trust-store.ts";

/**
 * The trust store is read ONCE per process, at boot (`bridge/index.ts`), and everything shaped by it
 * — the mode, the roster the lead sweeps, the `ca` list a peer's listener pins — is built from that
 * one read. That is deliberate (§8.3: the pack secret never lives in a long-lived env; §3: a mode
 * discovered mid-startup has already opened what it meant to keep shut), and the membership verbs
 * restart the local service precisely because of it.
 *
 * It leaves one hole, which the two-instance harness walked straight into: **a membership change can
 * arrive at a RUNNING bridge over the wire**, from a machine whose operator is not this one.
 *
 *   - the first `join` lands in the lead's store through the lead's own `/pack/v1/enroll`. The lead
 *     persists the new peer and goes on merging nothing, because its `PackLead` was built from a
 *     roster that was empty at boot;
 *   - `promote` demotes the old lead through `/pack/v1/lead`. It adopts the demotion on disk and
 *     keeps its lead-mode listener — unpinned — until something restarts it.
 *
 * Neither is fixed by re-reading the store in place: re-wiring a live process's mode, listener TLS
 * and sweep would be a second, concurrent startup path, and `server.reload({tls})` does not even swap
 * a pinned `ca` (M4/08's transport investigation). So the fix is the smallest honest one: **notice,
 * and say so.** This module is that noticing, and it is pure — the boot-time snapshot goes to disk as
 * a marker, the CLI compares the marker to the store, and `pack status` tells the operator to run the
 * restart that was always going to be required.
 */

export const PACK_RUNTIME_FILENAME = "pack-runtime.json";

export const packRuntimePath = (stateDir: string): string => join(stateDir, PACK_RUNTIME_FILENAME);

/** What the running bridge resolved at boot, as it left it on disk. */
export interface PackRuntimeMarker {
  readonly bootedAt: number;
  readonly pid: number;
  readonly mode: PackMode;
  /** `<role>:<memberId>` for every ENROLLED member, sorted — the roster this process is serving. */
  readonly roster: readonly string[];
}

/**
 * The roster as a comparable value: enrolled members only, `<role>:<memberId>`, sorted.
 *
 * Only what the process actually WIRED belongs here. An `unenrolled` tombstone is in the store and
 * out of every runtime decision, so counting it would report drift for a change that changes nothing
 * — and a false "restart me" is how a true one stops being read.
 */
export function rosterSignature(data: TrustStoreData | null): string[] {
  if (data === null) return [];
  const members = [...(data.lead === null ? [] : [data.lead]), ...data.peers];
  return members
    .filter((m) => m.status === "enrolled")
    .map((m) => `${m.role}:${m.memberId}`)
    .toSorted();
}

export function markerFor(data: TrustStoreData | null, now: number, pid: number): PackRuntimeMarker {
  return {
    bootedAt: now,
    pid,
    mode: deriveMode(enrollmentOf(data)).mode,
    roster: rosterSignature(data),
  };
}

export function formatMarker(marker: PackRuntimeMarker): string {
  return `${JSON.stringify(marker, null, 2)}\n`;
}

/** Tolerant by design: a marker we cannot read is simply no marker, never a reason to fail a verb. */
export function parseMarker(raw: string | null): PackRuntimeMarker | null {
  if (raw === null || raw.trim() === "") return null;
  let value: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction.
    value = JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v: JsonObject = value;
  const roster = Array.isArray(v.roster) ? v.roster.filter((e): e is string => typeof e === "string") : null;
  if (typeof v.bootedAt !== "number" || typeof v.pid !== "number" || roster === null) return null;
  const mode = v.mode;
  if (mode !== "solo" && mode !== "lead" && mode !== "peer") return null;
  return { bootedAt: v.bootedAt, pid: v.pid, mode, roster };
}

export interface RosterDrift {
  /** Members enrolled on disk that the running process never wired. */
  readonly gained: readonly string[];
  /** Members the running process is still wired for that the store no longer holds. */
  readonly lost: readonly string[];
  /** The mode on disk, when it is not the mode this process booted in (a demotion, or a first peer). */
  readonly modeChanged: PackMode | null;
}

/**
 * What the running process is missing. `null` when there is nothing to say — no marker (no bridge has
 * booted since this store existed, so there is no running process to be stale), or a marker that
 * still describes the store exactly.
 */
export function rosterDrift(marker: PackRuntimeMarker | null, data: TrustStoreData | null): RosterDrift | null {
  if (marker === null) return null;
  const now = rosterSignature(data);
  const booted = new Set(marker.roster);
  const current = new Set(now);
  const gained = now.filter((m) => !booted.has(m));
  const lost = marker.roster.filter((m) => !current.has(m));
  const mode = deriveMode(enrollmentOf(data)).mode;
  const modeChanged = mode === marker.mode ? null : mode;
  if (gained.length === 0 && lost.length === 0 && modeChanged === null) return null;
  return { gained, lost, modeChanged };
}
