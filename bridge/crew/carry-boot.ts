import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AuditEntry } from "../audit.ts";
import { asJsonNumber, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";
import { HillMediaStore } from "../hill/media.ts";
import { adoptCarriedInto } from "../hill/service.ts";
import { hillDir, HillStore } from "../hill/store.ts";
import { adoptCarriedTricks, writeCarryNotices, type AdoptTricksResult } from "./carry-adopt.ts";
import { adoptCarriedHill, type AdoptHillResult } from "./hill-adopt.ts";
import type { StandbyHillStore } from "./standby-hill.ts";
import type { StandbyTricksStore } from "./standby-tricks.ts";

// THE DEPUTY'S TWO COPIES AROUND THE TAKEOVER (CREW_PROTOCOL §25).
//
// The copies of the lead's tricks (standby-tricks.ts) and of its open Decisions (standby-hill.ts) are
// removed once this machine is not its lead's deputy any more, and the takeover commit itself makes it
// the lead. So the commit holds both copies, and the person's tap (the takeover commit, or `collie
// promote` typed here) adopts nothing itself: it writes a marker, `<stateDir>/standby-adopt.json`, that
// names the lead it took over from. The next boot, as the lead, adopts both copies before it builds its
// Hill or its tricks, so no running process holds an older list in memory that a later write of its
// own would put back over the merge. One code path for the tap and the promote.
//
// The marker is the person's yes. Only the tap and the promote write it; no crew route does. A copy
// whose lead is not the one the marker names is not adopted. While the marker is on disk, the copies
// stay through any role change.

export const ADOPT_MARKER_FILE = "standby-adopt.json";

/** Who wrote the marker: the standby page's tap, or `collie promote`. */
export type AdoptBy = "takeover" | "handover";

/** The person's tap, waiting for the next boot. */
export interface AdoptMarker {
  readonly lead: string;
  readonly by: AdoptBy;
  readonly at: number;
}

/** A copy the commit holds. */
export interface HeldCopy {
  hold(): () => void;
}

/** Hold every copy at once. The one release lets go of all of them, once. */
export function holdCopies(copies: readonly (HeldCopy | null)[]): () => void {
  const releases = copies.flatMap((copy) => (copy === null ? [] : [copy.hold()]));
  return () => {
    for (const release of releases) release();
  };
}

function markerPath(stateDir: string): string {
  return join(stateDir, ADOPT_MARKER_FILE);
}

/** Write the marker, 0600, through a temp sibling. */
export async function writeAdoptMarker(stateDir: string, marker: AdoptMarker): Promise<void> {
  const path = markerPath(stateDir);
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ v: 1, lead: marker.lead, by: marker.by, at: marker.at })}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/** The marker, or null when there is none or it does not read. */
export async function readAdoptMarker(stateDir: string): Promise<AdoptMarker | null> {
  const doc = parseJsonObject(await readFile(markerPath(stateDir), "utf8").catch(() => ""));
  const lead = asJsonString(doc?.lead);
  const by = asJsonString(doc?.by);
  const at = asJsonNumber(doc?.at);
  if (doc === undefined || asJsonNumber(doc.v) !== 1 || lead === undefined || lead === "" || at === undefined) return null;
  if (by !== "takeover" && by !== "handover") return null;
  return { lead, by, at };
}

export async function removeAdoptMarker(stateDir: string): Promise<void> {
  await rm(markerPath(stateDir), { force: true }).catch(() => {});
}

export interface BootAdoptDeps {
  readonly stateDir: string;
  /** The folder tricks live under, or null on a bridge with no tricks. */
  readonly configDir: string | null;
  readonly tricks: StandbyTricksStore;
  readonly hill: StandbyHillStore;
  /** This boot leads its crew. A boot that does not adopts nothing and drops the marker. */
  readonly leads: boolean;
  /** This machine's member id and display name, for the trick Decisions that move here. */
  readonly self: string;
  readonly machine: string;
  readonly now: () => number;
  readonly audit: (entry: AuditEntry) => void;
  readonly log: (line: string) => void;
}

export interface BootAdoptResult {
  readonly marker: AdoptMarker;
  readonly tricks: AdoptTricksResult;
  readonly hill: AdoptHillResult;
}

const NOTHING_STARTED: AdoptTricksResult = { started: [], failed: [], keptFolder: [] };

/**
 * Adopt the copies the person's tap left for this boot. Run once at boot, before the Hill and the
 * tricks are built and before the copies are reconciled. Null when there was no marker or this boot
 * does not lead. The copies and the marker are removed after. Throws only what a write throws.
 */
export async function adoptAtBoot(deps: BootAdoptDeps): Promise<BootAdoptResult | null> {
  const marker = await readAdoptMarker(deps.stateDir);
  if (marker === null) return null;
  if (!deps.leads) {
    deps.log(`[crew] a takeover of "${marker.lead}" left its copies for this boot, but this machine does not lead: nothing adopted`);
    await removeAdoptMarker(deps.stateDir);
    return null;
  }
  const tricksFrom = (await deps.tricks.load())?.from ?? null;
  const hillFrom = (await deps.hill.load())?.from ?? null;
  for (const from of [tricksFrom, hillFrom]) {
    if (from !== null && from !== marker.lead) deps.log(`[crew] a copy here is from "${from}", not from "${marker.lead}" whom the tap took over from: not adopted`);
  }
  const tricks = deps.configDir === null ? NOTHING_STARTED : await adoptCarriedTricks({ stateDir: deps.stateDir, configDir: deps.configDir, store: deps.tricks, lead: marker.lead, by: marker.by, now: deps.now });
  await writeCarryNotices(deps.stateDir, marker.lead, deps.now(), tricks.failed);
  const dir = hillDir(deps.stateDir);
  const media = new HillMediaStore(dir, []);
  const store = new HillStore(dir, deps.now, undefined, (ids) => {
    for (const id of ids) media.remove(id);
  });
  const hill = await adoptCarriedHill({
    store: deps.hill,
    hill: { adoptCarried: (decisions, files) => adoptCarriedInto(store, media, decisions, files) },
    lead: marker.lead,
    self: deps.self,
    machine: deps.machine,
    started: new Set(tricks.started.map((t) => t.id)),
    stateDir: deps.stateDir,
    now: deps.now,
  });
  const from = marker.lead;
  const by = marker.by;
  deps.audit({
    action: "tricks.carried",
    detail: { from, by, started: tricks.started.map((t) => t.id), failed: tricks.failed.map((t) => t.id), keptFolder: [...tricks.keptFolder] },
  });
  deps.audit({ action: "hill.carried", detail: { from, by, open: hill.open, closed: hill.closed, dropped: hill.dropped } });
  if (tricks.started.length > 0) deps.log(`[crew] ${by}: started ${String(tricks.started.length)} of the lead's tricks here: ${tricks.started.map((t) => t.id).join(", ")}`);
  if (tricks.failed.length > 0) deps.log(`[crew] ${by}: did not start ${tricks.failed.map((t) => `${t.id} (${t.reason})`).join(", ")}`);
  if (hill.open + hill.closed > 0) deps.log(`[crew] ${by}: brought ${String(hill.open)} open Decision(s) of the lead's Hill here, ${String(hill.closed)} closed with their reason`);
  await deps.tricks.clear();
  await deps.hill.clear();
  await removeAdoptMarker(deps.stateDir);
  return { marker, tricks, hill };
}
