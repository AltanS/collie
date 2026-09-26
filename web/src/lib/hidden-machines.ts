import { useSyncExternalStore } from "react";

import { isMultiHost, scopeHostKey } from "./hosts";
import { asJsonString, parseJson } from "./json";
import type { ServerSummary } from "./types";

// HIDDEN MACHINES: the crew members this device leaves off the dashboard (issue #288, M40/01).
//
// ── A FILTER, NOT AN ADDRESS ─────────────────────────────────────────────────
// `?h=` answers "which machine am I addressing"; this answers "which machines do I want to see in the
// list". The two stay apart: hiding a machine never changes `?h=`, never navigates and adds no history
// entry (ADR 0067), and the Machines sheet's row tap keeps its one meaning, go to that machine. The
// lead still sends every machine's panes, so the summary line, the Focus badge, push and the sheet's
// own counts keep counting every machine. Nothing here reaches the bridge or the wire.
//
// ── WHERE IT APPLIES ─────────────────────────────────────────────────────────
// One clause at the dashboard's filter point (`agent-list.tsx`): a workspace group whose machine is
// hidden leaves the list, like a hidden workspace, so Panes, Focus and Changes follow at once and
// Changes stops asking the hidden machine. Isolate wins, because the isolated group is found among
// every group before the clause runs; pins ignore it, because the Pinned group is drawn from every
// group before any filter (ADR 0070). In the strip, the machine's workspace chips give way to ONE
// dimmed stand-in chip that keeps its worst status dot and shows the machine again on a tap. The pane
// switcher, the space view, the Spaces navigator and Launch are not filtered.
//
// ── THE ADDRESSED MACHINE ALWAYS SHOWS ───────────────────────────────────────
// The effective set is the stored set minus the machine `?h=` addresses (the lead when absent), so
// the filter can never empty the list, and the Spaces navigator under Panes (which shows the addressed
// machine) never contradicts the list above it. Nothing is written when the operator moves: the
// stored choice comes back when they move away.
//
// ── ITS OWN STORE, NOT A FIELD IN `collie:dash-prefs:v1` ─────────────────────
// For the reason `pins.ts` gives: `useDashPrefs` is per-instance state that saves `{ ...its copy,
// ...patch }`, so a field written from the Machines sheet would be lost at the next save from another
// mounted instance. A module store read with `useSyncExternalStore` has one copy.
//
// ── IT STORES THE HIDDEN SET ─────────────────────────────────────────────────
// Member ids (`ServerSummary.id`), so a machine that joins the crew later is shown by default. An id no
// longer in the roster filters nothing and is kept until the next write, which drops the ids absent
// from the roster it is handed and keeps at most `MAX_HIDDEN_MACHINES`. Writes happen on the
// operator's own acts only, the sheet's switch and the stand-in chip: never on a poll, a render, a
// read or a navigation.
//
// ── SOLO PAYS NOTHING (CREW_PROTOCOL.md §11) ─────────────────────────────────
// Storage is read lazily, on the first read a crew makes. `useHiddenMachines(false)` never touches it,
// and `machinesHiddenFrom` answers the empty set for a roster of fewer than two machines, so a solo
// dashboard runs no clause and draws no chip.
//
// Per device, like `hiddenSpaces` and pins: a view choice about this device's glass.

const STORAGE_KEY = "collie:hidden-machines:v1";

/** The store's bound: more machines than a crew is likely to hold, few enough to stay a short list. */
export const MAX_HIDDEN_MACHINES = 16;

const NONE: readonly string[] = [];
const NOTHING_HIDDEN: ReadonlySet<string> = new Set();

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked / partitioned storage
  }
}

/**
 * The stored ids, or none. A value that is not JSON or not an array reads as none, a non-string entry
 * is skipped and a repeat is read once. Nothing is written back: a read is not the operator's act.
 */
function decode(raw: string | null): readonly string[] {
  if (raw === null) return NONE;
  const doc = parseJson(raw);
  if (!Array.isArray(doc)) return NONE;
  const out: string[] = [];
  for (const item of doc) {
    const id = asJsonString(item);
    if (id === undefined || id === "" || out.includes(id)) continue;
    out.push(id);
  }
  return out.length === 0 ? NONE : out;
}

function load(): readonly string[] {
  const store = storage();
  if (!store) return NONE;
  try {
    return decode(store.getItem(STORAGE_KEY));
  } catch {
    return NONE;
  }
}

/** `null` until a crew first reads the store, so a solo page never reads storage for it at all. */
let hidden: readonly string[] | null = null;
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The stored ids as they stand. The same array until the next write, so a render can compare by identity. */
export function currentHiddenMachines(): readonly string[] {
  hidden ??= load();
  return hidden;
}

const nothingStored = (): readonly string[] => NONE;

/**
 * Reactive read for the dashboard and the Machines sheet. Pass `crew` false (a solo snapshot) and the
 * hook answers none without reading storage.
 */
export function useHiddenMachines(crew: boolean): readonly string[] {
  return useSyncExternalStore(subscribe, crew ? currentHiddenMachines : nothingStored, nothingStored);
}

function save(next: readonly string[]): void {
  hidden = next;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota or private mode. The in-memory set still applies for this session.
  }
  for (const fn of listeners) fn();
}

/**
 * Hide or show one machine, the operator's act (the Machines sheet's switch, the stand-in chip).
 * `servers` is the roster on screen: the write drops every stored id it does not list, then keeps the
 * newest `MAX_HIDDEN_MACHINES`, so the machine just hidden always stays.
 */
export function setMachineHidden(
  id: string,
  hide: boolean,
  servers: readonly ServerSummary[] | undefined,
): void {
  const roster = new Set((servers ?? []).map((s) => s.id));
  const kept = currentHiddenMachines().filter((h) => h !== id && roster.has(h));
  const next = hide ? [...kept, id] : kept;
  save(next.slice(-MAX_HIDDEN_MACHINES));
}

/**
 * The machines the dashboard leaves out: the stored ids that name a machine in the roster, minus the
 * machine `host` addresses (`?h=`, the lead when absent), which always shows. Empty on a solo roster.
 * Returns ONE shared empty set whenever nothing is hidden, so a caller can test `size` and skip work.
 */
export function machinesHiddenFrom(
  stored: readonly string[],
  servers: readonly ServerSummary[] | undefined,
  host: string | undefined,
): ReadonlySet<string> {
  if (stored.length === 0 || servers === undefined || !isMultiHost(servers)) return NOTHING_HIDDEN;
  const addressed = scopeHostKey({ host }, servers);
  const out = new Set(stored.filter((id) => id !== addressed && servers.some((s) => s.id === id)));
  return out.size === 0 ? NOTHING_HIDDEN : out;
}

/** Test seam: forget the set, in memory and in storage, and read storage again on the next read. */
export function __resetHiddenMachines(): void {
  hidden = null;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  for (const fn of listeners) fn();
}

/** Test seam: read the store again from storage on the next read, as a fresh page load would. */
export function __reloadHiddenMachines(): void {
  hidden = null;
  for (const fn of listeners) fn();
}
