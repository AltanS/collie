// The machines census as a store the polling scheduler writes (lib/polling.ts `want`), shaped like
// lib/data.ts: the last good body survives a failed read, so a bad tick shows stale numbers flagged
// instead of an empty screen. web/'s `machinesLoader` is the reference (lib/loaders.ts).
//
// ONE read serves the list and the machine page. The list wants each card's last half hour (`?spark=`);
// the page ignores `spark`, and 30 minutes of two metrics is a few hundred bytes. One source is one
// request per beat, whichever of the two is open.
//
// A 404 is an ANSWER, not a failure: only a lead or a solo collie serves `/api/machines`, so a peer
// opened directly says "nothing to show here". Every other refusal is `error`.
import { shareEqual } from "@web/lib/share-equal";
import type { MachinesResponse } from "@web/lib/types";

import { ApiError, bridgeGet, isAbort } from "../../lib/api";
import { createStore } from "../../lib/store";

/** How many complete minutes the small charts of a card show: the Crew tab's half hour. */
export const MACHINE_SPARK_MINUTES = 30;

export interface MachinesData {
  /** The census, or `null` when this collie serves none (404) or no read has landed. */
  census: MachinesResponse | null;
  /** The last read FAILED (not a 404). With a census still held, the numbers are stale, not missing. */
  error: boolean;
  /** False until the first answer or failure lands: a skeleton, not the empty card, shows until then. */
  loaded: boolean;
}

export const machines = createStore<MachinesData>(
  { census: null, error: false, loaded: false },
  (a, b) => a.census === b.census && a.error === b.error && a.loaded === b.loaded,
);

/** The census with the lead first, whatever order a bridge sends (the wire already does it). */
export function leadFirst<T extends { isLead: boolean }>(rows: readonly T[]): T[] {
  return rows.toSorted((a, b) => Number(b.isLead) - Number(a.isLead));
}

/** One beat's read. Resolves true when the body changed. */
export async function loadMachines(signal: AbortSignal): Promise<boolean> {
  try {
    const fresh = await bridgeGet<MachinesResponse>(`/api/machines?spark=${String(MACHINE_SPARK_MINUTES)}`, undefined, signal);
    const prev = machines.get().census;
    // Every row equal to the last census's row keeps that row's identity, so a tick that brings the
    // same numbers wakes no card (web/lib/loaders.ts `keepCensusIdentity`).
    const kept = prev === null ? fresh : shareEqual(prev, fresh);
    machines.set({ census: kept, error: false, loaded: true });
    return kept !== prev;
  } catch (error) {
    if (error instanceof Error && isAbort(error)) throw error;
    if (error instanceof ApiError && error.status === 404) {
      machines.set({ census: null, error: false, loaded: true });
      return false;
    }
    machines.update((prev) => ({ ...prev, error: true, loaded: true }));
    return false;
  }
}

export const MACHINES_SOURCE = { key: "machines", poll: loadMachines };
