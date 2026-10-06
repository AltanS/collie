// Crew facts the home surfaces share, as pure functions.
//
// Tier-2 health of the crew's members, derived on demand from the snapshot. web/ derives it once at
// the data root (`CrewProvider`) and publishes it through a context; this shell has no provider, and
// the three surfaces that need it (the machine switcher, the launch strip, the new-space sheet) each
// subscribe to `snapshot` themselves, so each one calls this in render.
//
// The clock is the LEAD's (`SnapshotResponse.ts`), never `Date.now()`: lib/host-health.ts says why.
// `pollMs` is the cadence the scheduler runs on (crew-health.ts reads it).
import { hostHealth, hostHealthMap, writeRefusal as hostRefusal, type HostHealth } from "@web/lib/host-health";
import { isMultiHost, leadHost } from "@web/lib/hosts";
import type { ServerSummary, SnapshotResponse } from "@web/lib/types";

const NO_HEALTH: ReadonlyMap<string, HostHealth> = new Map();

/** Every member's health, keyed by member id. Empty for a solo snapshot. */
export function crewHealth(body: SnapshotResponse | undefined, pollMs: number): ReadonlyMap<string, HostHealth> {
  const servers = body?.servers;
  if (body === undefined || servers === undefined || servers.length === 0) return NO_HEALTH;
  return hostHealthMap(servers, { at: body.ts, pollMs });
}

/**
 * One member's health, with web/'s fallback for a map that lacks it: re-derive with no clock at all,
 * which skips the presented-stale tolerance and hands back the lead's plain boolean.
 */
export function memberHealth(health: ReadonlyMap<string, HostHealth>, s: ServerSummary): HostHealth {
  return health.get(s.id) ?? hostHealth(s, { at: 0, pollMs: 0 });
}

// ── The hidden-machines set (web/src/lib/hidden-machines.ts, `setMachineHidden`) ──────────────────

/** The store's bound: more machines than a crew is likely to hold, few enough to stay a short list. */
export const MAX_HIDDEN_MACHINES = 16;

/**
 * The stored hidden set after the operator hides or shows one machine. Drops every stored id the
 * roster does not list, then keeps the newest `MAX_HIDDEN_MACHINES`, so the machine just hidden
 * always stays. Pure: the caller writes the answer to `hiddenMachines` (lib/prefs.ts).
 */
export function nextHiddenMachines(
  stored: readonly string[],
  id: string,
  hide: boolean,
  servers: readonly ServerSummary[] | undefined,
): readonly string[] {
  const roster = new Set((servers ?? []).map((s) => s.id));
  const kept = stored.filter((h) => h !== id && roster.has(h));
  const next = hide ? [...kept, id] : kept;
  return next.slice(-MAX_HIDDEN_MACHINES);
}

// ── The new-space sheet's default machine (web/src/components/new-space-sheet.tsx, `defaultHost`) ──

/**
 * Which machine the "+" should create on, before the operator touches anything: the scope's host (or
 * the lead, which an absent `?h=` means), moved to the first writable member when that one refuses
 * writes. When NOTHING is writable the sheet still lands on a member, so it names the machine it
 * would have used and states the refusal. A solo roster has no host dimension and answers undefined.
 */
export function defaultHost(
  servers: readonly ServerSummary[],
  health: ReadonlyMap<string, HostHealth>,
  want: string | undefined,
): string | undefined {
  if (!isMultiHost(servers)) return undefined;
  const wanted = want ?? leadHost(servers);
  const writable = (id: string | undefined): boolean =>
    servers.some((s) => s.id === id && hostRefusal(memberHealth(health, s)) === undefined);
  if (writable(wanted)) return wanted;
  const firstWritable = servers.find((s) => hostRefusal(memberHealth(health, s)) === undefined);
  return firstWritable?.id ?? wanted ?? servers[0]?.id;
}
