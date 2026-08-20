// THE PARSE BOUNDARY. Every field read of an on-disk beacon happens in this file and nowhere else.
//
// A beacon is a file in a directory. Collie did not necessarily write it: the emitter writes to a
// temp file and renames, but a foreign process need not, so what arrives here may be a torn write, a
// record from a newer schema, a file some other tool dropped in the directory, or plain garbage.
// Every one of those is SKIPPED, never thrown on — `null` from {@link parseBeacon} means "there is no
// beacon here", which is a case the reader already handles honestly. A directory of garbage yields
// zero beacons and never an error page.
//
// This is a parse boundary in the ADR 0019 sense, which is why `anti-slop/no-runtime-typeof` is off
// for this ONE file in `.oxlintrc.json`: the `typeof` checks below ARE the parse, not a dodge of one.
// Keeping them all here is what keeps that override narrow — nothing else under bridge/beacon/ reads
// an unvalidated field.
//
// VALIDATION IS NOT TRUST. Nothing here decides a value is safe to act on; it decides the record is
// well-formed enough to be a hint (.adr/0024). A `path` session ref that survives this file is still
// attacker-shaped and is still confined by `journal/files.ts` before anything reads it.

import type { JsonObject, JsonValue } from "../json.ts";
import type { AgentSessionRef } from "../journal/types.ts";
import { BEACON_SCHEMA_VERSION, type BeaconMarker, type BeaconRecord, type BeaconStatus } from "./types.ts";

/** The three words a beacon may use, as a runtime list — the type alone cannot check a file. */
const BEACON_STATUSES: readonly BeaconStatus[] = ["working", "waiting", "idle"];

/** The two session-ref kinds the journal knows. A third value is not a ref we can do anything with. */
const SESSION_KINDS: readonly AgentSessionRef["kind"][] = ["id", "path"];

/** Longest field we will accept anywhere. A beacon is small; a megabyte one is not a beacon. */
const MAX_FIELD_CHARS = 4096;

/** Most marker sets one pane can plausibly report. Nesting is real; forty deep is not. */
const MAX_MARKERS = 8;

function readObject(value: JsonValue | undefined): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value;
}

/** A non-empty, bounded string, or null. Whitespace-only is empty — it names nothing. */
function readText(row: JsonObject, key: string): string | null {
  const value = row[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_FIELD_CHARS) return null;
  return trimmed;
}

/** A finite non-negative number, or null. `NaN` and `Infinity` survive `JSON.parse` of nothing, but
 *  a hand-written file can still carry `1e999`, which parses to `Infinity`. */
function readNumber(row: JsonObject, key: string): number | null {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/** A positive integer, or null — pids and versions are counted, never measured. */
function readInteger(row: JsonObject, key: string): number | null {
  const value = readNumber(row, key);
  if (value === null || !Number.isInteger(value)) return null;
  return value;
}

function readStatus(row: JsonObject): BeaconStatus | null {
  const value = readText(row, "status");
  return BEACON_STATUSES.find((status) => status === value) ?? null;
}

function readSession(row: JsonObject): AgentSessionRef | null {
  const session = readObject(row.session);
  if (session === null) return null;
  const kindText = readText(session, "kind");
  const kind = SESSION_KINDS.find((candidate) => candidate === kindText);
  if (kind === undefined) return null;
  const value = readText(session, "value");
  if (value === null) return null;
  return { kind, value };
}

/**
 * One marker triple, RAW.
 *
 * Nothing is normalised, prefixed or lower-cased on the way in: the value is what the multiplexer's
 * env var held, and the adapter's matcher at the join is the only thing entitled to transform it
 * (M11/03). A value rewritten here could never be un-rewritten there.
 */
function readMarker(entry: JsonValue): BeaconMarker | null {
  const row = readObject(entry);
  if (row === null) return null;
  const namespace = readText(row, "namespace");
  const scope = readText(row, "scope");
  const pane = readText(row, "pane");
  if (namespace === null || scope === null || pane === null) return null;
  return { namespace, scope, pane };
}

/**
 * The marker list, with unreadable entries dropped rather than the whole record.
 *
 * A beacon whose SECOND multiplexer wrote a malformed entry is still a perfectly good beacon for its
 * first, and losing the pane's identity over the outer half of a nested pair is the "works until you
 * nest" bug this list exists to prevent. A record with no readable marker at all names no pane and is
 * rejected by the caller.
 */
function readMarkers(value: JsonValue | undefined): BeaconMarker[] {
  if (!Array.isArray(value)) return [];
  const markers: BeaconMarker[] = [];
  for (const entry of value.slice(0, MAX_MARKERS)) {
    const marker = readMarker(entry);
    if (marker !== null) markers.push(marker);
  }
  return markers;
}

/**
 * One beacon file's text as a record, or null when it is not a beacon this build can read.
 *
 * Total over garbage by construction: there is no input for which this throws.
 */
export function parseBeacon(text: string): BeaconRecord | null {
  let decoded: JsonValue;
  try {
    decoded = JSON.parse(text);
  } catch {
    // A torn write is the ordinary case here, not an exceptional one — the reader sweeps again in a
    // second and the emitter's rename will have landed by then.
    return null;
  }
  const row = readObject(decoded);
  if (row === null) return null;

  // A NEWER SCHEMA IS SKIPPED, NOT GUESSED AT. A version we do not know may mean a field we do know
  // differently, and a misread identity is worse than an absent one.
  const schemaVersion = readInteger(row, "schemaVersion");
  if (schemaVersion !== BEACON_SCHEMA_VERSION) return null;

  const harness = readText(row, "harness");
  const session = readSession(row);
  const status = readStatus(row);
  const pid = readInteger(row, "pid");
  const pidStartTime = readNumber(row, "pidStartTime");
  const heartbeatMs = readNumber(row, "heartbeatMs");
  const markers = readMarkers(row.markers);

  if (harness === null || session === null || status === null) return null;
  if (pid === null || pid === 0 || pidStartTime === null || heartbeatMs === null) return null;
  // No marker, no pane: nothing could ever join this record to anything, so it is not a beacon.
  if (markers.length === 0) return null;

  return { schemaVersion, harness, session, status, pid, pidStartTime, markers, heartbeatMs };
}
