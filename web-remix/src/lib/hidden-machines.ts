// HIDDEN MACHINES (issue #288): the crew members this device leaves off the dashboard. web/'s rules
// (web/src/lib/hidden-machines.ts) on this shell's `hiddenMachines` pref store (prefs.ts, the same
// key `collie:hidden-machines:v1`). `machinesHiddenFrom` is reused read-only: the addressed machine
// always shows, an id off the roster filters nothing, a solo roster hides nothing. Writes happen on
// the operator's own acts only (the stand-in chip, the Machines sheet), never on a poll or a render.
import { MAX_HIDDEN_MACHINES, machinesHiddenFrom } from "@web/lib/hidden-machines";
import type { ServerSummary } from "@web/lib/types";

import { hiddenMachines } from "./prefs";

export { hiddenMachines, machinesHiddenFrom, MAX_HIDDEN_MACHINES };

/** The stored set after hiding or showing `id`, against the roster on screen. Pure, for the tests. */
export function nextHiddenMachines(
  stored: readonly string[],
  id: string,
  hide: boolean,
  servers: readonly ServerSummary[] | undefined,
): string[] {
  const roster = new Set((servers ?? []).map((s) => s.id));
  const kept = stored.filter((h) => h !== id && roster.has(h));
  return (hide ? [...kept, id] : kept).slice(-MAX_HIDDEN_MACHINES);
}

/** Hide or show one machine. Drops stored ids the roster no longer lists; keeps the newest 16. */
export function setMachineHidden(id: string, hide: boolean, servers: readonly ServerSummary[] | undefined): void {
  hiddenMachines.set(nextHiddenMachines(hiddenMachines.get(), id, hide, servers));
}
