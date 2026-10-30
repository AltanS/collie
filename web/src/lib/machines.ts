import { hostHealth, type HostHealth } from "./host-health";
import type { ServerSummary } from "./types";

// MACHINES: the crew's members grouped by the physical host they run on (M77).
//
// ── A MEMBER IS AN INSTANCE, A HOST IS A MACHINE ─────────────────────────────
// A crew member is one Collie instance: one bridge, one multiplexer. Since one host can run two (the
// Herdr TUI and Herdr core side by side), the member rows overstate the machines. Each member reports
// the hostname it reads itself as `host`; two rows with the same `host` are one machine. A row without
// `host` (an older member) is a machine of its own, keyed by its member id, so a crew of older builds
// groups to exactly the rows it had.
//
// ── A VIEW, NEVER A KEY ──────────────────────────────────────────────────────
// Member ids stay the keys underneath: `?h=`, hidden machines, walky addresses and every API path keep
// the member id. Nothing here is stored or sent.
//
// ── HEALTH IS A SUM, AND IT HAS ONE SOURCE ───────────────────────────────────
// An instance counts as reachable when its tier-2 health is `writable` (lib/host-health.ts), the same
// reading the composer gate and the sheet's dimming use. The map comes from the data root when there
// is one; without it, `hostHealth` at no clock presents the lead's plain boolean, exactly as the sheet's
// and the crew page's fallbacks do. There is no second reachability rule.

/** `ok`: every instance reachable. `degraded`: some are not. `down`: none is. */
export type MachineHealth = "ok" | "degraded" | "down";

export interface Machine {
  /** The `host` the instances share, or the member id of a row that reports none. */
  key: string;
  /** What the machine is called: the host when it runs several instances, the member's own name when one. */
  name: string;
  /** The member rows on this host: the lead first, then the deputy, then by name. Never empty. */
  instances: ServerSummary[];
  health: MachineHealth;
  /** The instances that are not reachable, by {@link instanceLabel}, in instance order. */
  downInstances: string[];
}

export interface GroupByHostOptions {
  /** The tier-2 health per member id, derived at the data root. A member it lacks is read without a clock. */
  health?: ReadonlyMap<string, HostHealth>;
  /** The deputy's member id, when the caller knows it (the crew page does, the snapshot does not). */
  deputyId?: string | null;
}

const NO_HEALTH: ReadonlyMap<string, HostHealth> = new Map();

/** Whether one member row counts as reachable for a machine's sum. */
function reachable(s: ServerSummary, health: ReadonlyMap<string, HostHealth>): boolean {
  return (health.get(s.id) ?? hostHealth(s, { at: 0, pollMs: 0 })).writable;
}

function displayName(s: ServerSummary): string {
  return s.name || s.id;
}

/**
 * How one instance is named inside its machine: its multiplexer, or its member name when it reported
 * none or another instance on the same machine reports the same one.
 */
export function instanceLabel(s: ServerSummary, siblings: readonly ServerSummary[] = [s]): string {
  if (s.mux === undefined) return displayName(s);
  const shared = siblings.some((o) => o.id !== s.id && o.mux === s.mux);
  return shared ? displayName(s) : s.mux;
}

function rank(s: ServerSummary, deputyId: string | null | undefined): number {
  if (s.isLead) return 0;
  if (deputyId !== undefined && deputyId !== null && s.id === deputyId) return 1;
  return 2;
}

function byRankThenName<T>(rankOf: (v: T) => number, nameOf: (v: T) => string): (a: T, b: T) => number {
  return (a, b) => rankOf(a) - rankOf(b) || nameOf(a).localeCompare(nameOf(b));
}

/**
 * The crew's members grouped into machines. Pure: same rows in, same machines out, no clock read.
 *
 * Machines are ordered the lead's first, the deputy's second, then by name.
 */
export function groupByHost(servers: readonly ServerSummary[], options: GroupByHostOptions = {}): Machine[] {
  const health = options.health ?? NO_HEALTH;
  const deputyId = options.deputyId;
  const byKey = new Map<string, ServerSummary[]>();
  for (const s of servers) {
    const key = s.host ?? s.id;
    const held = byKey.get(key);
    if (held === undefined) byKey.set(key, [s]);
    else held.push(s);
  }

  const machines: Machine[] = [];
  for (const [key, rows] of byKey) {
    const instances = rows.toSorted(byRankThenName((s) => rank(s, deputyId), displayName));
    const down = instances.filter((s) => !reachable(s, health));
    machines.push({
      key,
      name: instances.length > 1 ? key : displayName(instances[0]!),
      instances,
      health: down.length === 0 ? "ok" : down.length === instances.length ? "down" : "degraded",
      downInstances: down.map((s) => instanceLabel(s, instances)),
    });
  }
  // A machine's rank is its best instance's, which sits first after the sort above.
  return machines.toSorted(byRankThenName((m) => rank(m.instances[0]!, deputyId), (m) => m.name));
}

/** True when some machine runs more than one instance, the one case the grouped views differ from today. */
export function hasSharedHost(machines: readonly Machine[]): boolean {
  return machines.some((m) => m.instances.length > 1);
}

/** The machine that holds member `id`, if any. */
export function machineOf(machines: readonly Machine[], id: string): Machine | undefined {
  return machines.find((m) => m.instances.some((s) => s.id === id));
}
