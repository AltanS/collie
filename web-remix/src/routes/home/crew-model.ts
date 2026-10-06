// Crew facts the home surfaces share, as pure functions.
//
// The members' tier-2 health is NOT derived here: chips/crew.ts (`crewOf(body).health`, `currentCrew()`) is
// the one place it is computed, cached per snapshot body, and the machine switcher, the launch strip and
// the new-space sheet read it from there. The clock is the LEAD's (`SnapshotResponse.ts`), never
// `Date.now()`: lib/host-health.ts says why.
import { hostHealth, writeRefusal as hostRefusal, type HostHealth } from "@web/lib/host-health";
import { isMultiHost, leadHost } from "@web/lib/hosts";
import type { ServerSummary } from "@web/lib/types";

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
