// One machine's last 24 hours, for the Status view (web/'s `useMachineHistory`).
//
// It rides the polling beat but is NOT read on every tick: the series has one point per minute, so a
// read that is less than a minute old answers false at once. The first read takes the whole day
// (about 23 KB gzipped); later reads ask only for the minutes since the newest point held
// (`?since=`) and `mergeHistory` folds them in. The beat already stops while the page is hidden or
// behind the idle lock, and the Alerts view, an unknown id and an older machine (no reading, so an
// empty day by definition) are left alone, so they ask for nothing.
import { mergeHistory, sinceOf } from "@web/lib/machine-chart";
import { machineReading } from "@web/lib/machine-reading";
import { machineTabOf } from "@web/lib/nav";
import type { MachineHistoryResponse } from "@web/lib/types";

import { bridgeGet, isAbort } from "../../lib/api";
import { createStore, type Store } from "../../lib/store";
import { machines } from "./data";

/** How often an open page re-reads: one point per minute, so faster is waste. */
export const HISTORY_REFRESH_MS = 60_000;

export interface MachineHistoryState {
  /** The last good answer, kept through a failed refresh so a chart never blanks for one bad minute. */
  history: MachineHistoryResponse | null;
  /** The latest read failed. With `history` still set, the chart is stale, not missing. */
  failed: boolean;
}

interface Slot {
  store: Store<MachineHistoryState>;
  lastAt: number;
}

const slots = new Map<string, Slot>();

function slotFor(id: string): Slot {
  let slot = slots.get(id);
  if (!slot) {
    slot = { store: createStore<MachineHistoryState>({ history: null, failed: false }), lastAt: 0 };
    slots.set(id, slot);
  }
  return slot;
}

export function machineHistory(id: string): Store<MachineHistoryState> {
  return slotFor(id).store;
}

/** Whether a read is due: at least a minute since the last good one, and not before. Pure. */
export function historyDue(now: number, lastAt: number): boolean {
  return lastAt === 0 || now - lastAt >= HISTORY_REFRESH_MS;
}

/** True while the page shows Status for a machine that sends a reading: the only case that draws charts. */
function wanted(id: string): boolean {
  if (machineTabOf(window.location.search) !== "status") return false;
  const census = machines.get().census;
  const row = census?.machines.find((m) => m.id === id);
  return row !== undefined && census !== null && machineReading(row, census.ts) !== "older";
}

async function read(id: string, signal: AbortSignal): Promise<boolean> {
  const slot = slotFor(id);
  if (!wanted(id) || !historyDue(Date.now(), slot.lastAt)) return false;
  const held = slot.store.get().history;
  const since = sinceOf(held);
  const query = since === undefined ? "" : `?since=${String(Math.max(0, Math.floor(since)))}`;
  try {
    const answer = await bridgeGet<MachineHistoryResponse>(`/api/machines/${encodeURIComponent(id)}/history${query}`, undefined, signal);
    slot.lastAt = Date.now();
    slot.store.set({ history: mergeHistory(held, answer), failed: false });
    return true;
  } catch (error) {
    if (error instanceof Error && isAbort(error)) throw error;
    // A failed read waits out the minute like a good one: "tries again in a minute" is what the card says.
    slot.lastAt = Date.now();
    slot.store.update((prev) => (prev.failed ? prev : { history: prev.history, failed: true }));
    return false;
  }
}

const sources = new Map<string, { key: string; poll: (signal: AbortSignal) => Promise<boolean> }>();

/** The poll source for one machine's history; one object per id, so `want` counts holders right. */
export function historySource(id: string): { key: string; poll: (signal: AbortSignal) => Promise<boolean> } {
  let source = sources.get(id);
  if (!source) {
    source = { key: `machine-history:${id}`, poll: (signal) => read(id, signal) };
    sources.set(id, source);
  }
  return source;
}
