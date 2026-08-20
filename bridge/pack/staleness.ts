import { join } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import type { DeposedOutcome, DeposedState, ParkReason } from "./deposed.ts";
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

/**
 * The facts only the RUNNING process holds, checkpointed into the marker so `pack status` — which is
 * a different process — can print them (§18.9's amendment of 2026-08-20).
 *
 * **This is not a persisted receipt in §18.9's sense, and the distinction is structural rather than a
 * promise.** §18.9 refuses a receipt that would "survive the restart it is meant to report and then
 * state a falsehood with the authority of the trust store". Every clause of that is closed here:
 * the file is not the trust store, it is rewritten whole at every boot with a fresh
 * {@link PackRuntimeMarker.bootedAt}, and silence is computed exactly as `silentForMs` computes it —
 * from the LATER of the receipt and that boot time. A checkpoint from a previous process is
 * therefore dominated by the new boot stamp and can never make a link look quieter than it is.
 * {@link PackRuntimeMarker.checkpointedAt} says how old the checkpoint itself is, so a reader can
 * also see when NO process has refreshed it — which is what a stopped bridge looks like.
 *
 * There is still exactly one of each of these numbers (§18.9's last rule): the process holds it in
 * memory and writes a copy here, and every reader reads that one copy.
 */
export interface PackRuntimeFacts {
  /**
   * The warrant generation whose deputy this process actually ANCHORED at boot — `deputyAnchorOf`'s
   * answer, turned into a number (RFC §5's phase 2). `null` when this listener anchors only its
   * lead, which is every peer that holds no warrant, holds a revocation, or has not restarted since
   * the warrant landed.
   *
   * It is the ONLY honest source for "anchored", because anchoring is a property of the listener
   * this process bound and `server.reload({tls})` cannot re-pin one (`transport.ts`). A store that
   * holds a warrant says *stored*; this says *armed*.
   */
  readonly anchoredGeneration: number | null;
  /** Gap A (§18.9): the last admitted call from this peer's lead, on this peer's own clock. */
  readonly leadLastDialledAt: number | null;
  /** §18.9's sibling: the last time the pinned lead was refused on the pack SECRET (§8.4). */
  readonly leadRefusedSecretAt: number | null;
  /** §18.12's state, with its outcome resolved as of the checkpoint. `null` on a collie that leads. */
  readonly deposed: DeposedState | null;
}

/** The facts of a process that has resolved none of them — a solo instance, or a boot-time marker. */
export const NO_RUNTIME_FACTS: PackRuntimeFacts = {
  anchoredGeneration: null,
  leadLastDialledAt: null,
  leadRefusedSecretAt: null,
  deposed: null,
};

/** What the running bridge resolved at boot, as it left it on disk, plus {@link PackRuntimeFacts}. */
export interface PackRuntimeMarker extends PackRuntimeFacts {
  readonly bootedAt: number;
  readonly pid: number;
  readonly mode: PackMode;
  /** `<role>:<memberId>` for every ENROLLED member, sorted — the roster this process is serving. */
  readonly roster: readonly string[];
  /**
   * When this marker was last written. Equals `bootedAt` on the boot write.
   *
   * A reader compares it to now: a checkpoint far older than the refresh interval means nothing has
   * rewritten it, which on a machine with a trust store means no bridge is running here.
   */
  readonly checkpointedAt: number;
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

export function markerFor(
  data: TrustStoreData | null,
  now: number,
  pid: number,
  facts: PackRuntimeFacts = NO_RUNTIME_FACTS,
): PackRuntimeMarker {
  return {
    bootedAt: now,
    pid,
    mode: deriveMode(enrollmentOf(data)).mode,
    roster: rosterSignature(data),
    checkpointedAt: now,
    ...facts,
  };
}

/**
 * The same marker, re-stamped with facts the process has learned since it booted.
 *
 * Pure, and it never touches the boot half: `bootedAt`, `pid`, `mode` and `roster` describe what
 * this process WIRED, and a checkpoint that could move them would be a second startup path pretending
 * to be a diagnostic. Only {@link PackRuntimeFacts} and `checkpointedAt` move.
 */
export function checkpointMarker(
  boot: PackRuntimeMarker,
  facts: PackRuntimeFacts,
  now: number,
): PackRuntimeMarker {
  return { ...boot, ...facts, checkpointedAt: now };
}

/** Has anything rewritten this marker lately? `false` ⇒ no bridge is running here (or it is wedged). */
export function checkpointStale(marker: PackRuntimeMarker, now: number, intervalMs: number): boolean {
  return now - marker.checkpointedAt > intervalMs * 3;
}

export function formatMarker(marker: PackRuntimeMarker): string {
  return `${JSON.stringify(marker, null, 2)}\n`;
}

/** An optional epoch-ms field. Anything that is not a number reads as absent, never as an error. */
function optionalNumber(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const OUTCOMES: readonly DeposedOutcome[] = ["healed", "parked-unverifiable", "parked-rotated"];
const PARK_REASONS: readonly ParkReason[] = ["signature", "unknown-deputy", "no-proof"];

/**
 * The deposed mark, or `null`. Tolerant like the rest of this file: a mark this build cannot read is
 * simply no mark. It is never trusted for anything — nothing acts on it, `pack status` only says it.
 */
function parseDeposed(value: JsonValue | undefined): DeposedState | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return null;
  const d: JsonObject = value;
  const outcome = OUTCOMES.find((o) => o === d.outcome);
  if (outcome === undefined) return null;
  if (typeof d.generation !== "number" || typeof d.at !== "number") return null;
  const reason = PARK_REASONS.find((r) => r === d.reason) ?? null;
  return {
    outcome,
    leadMemberId: typeof d.leadMemberId === "string" ? d.leadMemberId : null,
    generation: d.generation,
    at: d.at,
    packName: typeof d.packName === "string" ? d.packName : null,
    reason,
  };
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
  return {
    bootedAt: v.bootedAt,
    pid: v.pid,
    mode,
    roster,
    // A marker written before the 2026-08-20 amendment carries none of the fields below. Absent reads
    // as "this process reported nothing", which is exactly true of a build that could not — and the
    // renderer says so rather than inventing a receipt. `checkpointedAt` falls back to the boot
    // stamp, which is what such a marker actually is: one write, at boot.
    checkpointedAt: optionalNumber(v.checkpointedAt) ?? v.bootedAt,
    anchoredGeneration: optionalNumber(v.anchoredGeneration),
    leadLastDialledAt: optionalNumber(v.leadLastDialledAt),
    leadRefusedSecretAt: optionalNumber(v.leadRefusedSecretAt),
    deposed: parseDeposed(v.deposed),
  };
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
