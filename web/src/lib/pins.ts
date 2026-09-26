import { useSyncExternalStore } from "react";

import { paneRowKey } from "./hosts";
import { asJsonNumber, asJsonObject, asJsonString, parseJson } from "./json";
import { panePlaceParts } from "./pane-name";
import { retirePinHint } from "./pin-hint";
import type { AgentView } from "./types";

// PINS: the panes this device asked to lead the dashboard and the switcher (ADR 0070).
//
// A pin is a place the operator chose, never a state. It moves a pane once, when the operator pins
// or unpins it, and nothing else ever does: the Pinned group runs in place order and never reads
// status (ADR 0063).
//
// ── ITS OWN STORE, NOT A FIELD IN `collie:dash-prefs:v1` ─────────────────────
// `useDashPrefs` is per-instance React state, and each instance saves `{ ...its copy, ...patch }`.
// Four of them mount at once on the pane screen and home, so a pin written by the pane menu would be
// lost the first time `agent-chat.tsx` saved `shellsOpen` from its own older copy. A device pref that
// several mounted surfaces read lives in a module store read with `useSyncExternalStore`, the shape
// `strips-collapsed.ts` and `harness-bar-pref.ts` already have.
//
// ── KEYED BY THE ROW AND THE WORKSPACE NAME ──────────────────────────────────
// A pin is `{ row: paneRowKey(pane), space: <workspace name>, at }`. It applies to the live pane with
// that row key only while that pane sits in a workspace of that name. A pane id is unique only for
// one bridge process (`bridge/mux/identity.ts` rule 4): Herdr reuses ids as workspaces come and go,
// and a new tmux server counts from `%0` again. The name is the guard `workspacePrefKey` already
// trusts for hide and isolate, and it catches an id another workspace reused. Ids stay opaque; the
// key never parses them.
//
// ── ABSENCE NEVER PRUNES ─────────────────────────────────────────────────────
// A pin whose pane is not in the list is DORMANT: it draws nothing and takes no place. It is not
// removed, because a multiplexer restart that keeps ids (Herdr's promise) can pass through a listing
// without the pane, and the pin must come back with it. The store writes on the operator's own acts
// only: pin, unpin, and close from Collie. Never on a poll, never on a render, never on a read.
// Each pin or unpin write also drops records whose row key now names a live pane in ANOTHER
// workspace (reused), and keeps at most `MAX_PINS`, the oldest dormant record going first.
//
// Per device, like `hiddenSpaces`: a phone and a tablet pin what their own thumb needs. Nothing here
// reaches the bridge or the wire.

const STORAGE_KEY = "collie:pins:v1";

/** The store's bound, the same as `mirror-invert.ts`'s: far more than a thumb pins, small enough that
 *  a reused id cannot inherit a pin set months ago. It bounds records, not the list (no cap). */
export const MAX_PINS = 32;

export interface Pin {
  /** The pane's `paneRowKey`: host, session and pane id, NUL-joined. */
  row: string;
  /** The name of the workspace the pane sat in when it was pinned (`panePlaceParts(pane).space`). */
  space: string;
  /** When it was pinned. Only the bound's eviction reads it; the screen never shows it. */
  at: number;
}

/** A pin's identity, without its stamp. */
interface PinId {
  row: string;
  space: string;
}

const NONE: readonly Pin[] = [];

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked / partitioned storage
  }
}

/**
 * The stored list, or none. A value that is not JSON, not an array, or holds a record missing a
 * field reads as the records it can read: a bad record is skipped, never repaired, and nothing is
 * written back, because a read is not the operator's act.
 */
function decode(raw: string | null): readonly Pin[] {
  if (raw === null) return NONE;
  const doc = parseJson(raw);
  if (!Array.isArray(doc)) return NONE;
  const out: Pin[] = [];
  for (const item of doc) {
    const rec = asJsonObject(item);
    const row = asJsonString(rec?.row);
    const space = asJsonString(rec?.space);
    const at = asJsonNumber(rec?.at);
    if (row === undefined || space === undefined || at === undefined) continue;
    if (out.some((p) => p.row === row && p.space === space)) continue;
    out.push({ row, space, at });
  }
  return out;
}

function load(): readonly Pin[] {
  const store = storage();
  if (!store) return NONE;
  try {
    return decode(store.getItem(STORAGE_KEY));
  } catch {
    return NONE;
  }
}

let pins: readonly Pin[] = load();
const listeners = new Set<() => void>();

function save(next: readonly Pin[]): void {
  pins = next;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota or private mode. The in-memory list still applies for this session.
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The pins as they stand. The same array until the next write, so a render can compare by identity. */
export function currentPins(): readonly Pin[] {
  return pins;
}

/** Reactive read for the dashboard, the switcher and the pane menu. */
export function usePins(): readonly Pin[] {
  return useSyncExternalStore(subscribe, currentPins, () => NONE);
}

function pinId(pane: AgentView): PinId {
  return { row: paneRowKey(pane), space: panePlaceParts(pane).space };
}

const same = (a: PinId, b: PinId) => a.row === b.row && a.space === b.space;

const NOTHING_PINNED: (pane: AgentView) => boolean = () => false;

/**
 * The test a list applies to each pane: pinned when a record carries its row key AND the name of the
 * workspace it sits in now. Built once per render, so a list of forty panes asks a map, not the list.
 */
export function pinMatcher(list: readonly Pin[]): (pane: AgentView) => boolean {
  if (list.length === 0) return NOTHING_PINNED;
  const spacesByRow = new Map<string, Set<string>>();
  for (const p of list) {
    const spaces = spacesByRow.get(p.row) ?? new Set<string>();
    spaces.add(p.space);
    spacesByRow.set(p.row, spaces);
  }
  return (pane) => {
    const id = pinId(pane);
    return spacesByRow.get(id.row)?.has(id.space) ?? false;
  };
}

/**
 * The records a write keeps. Drops a record whose row key now names a live pane in another workspace
 * (the id was reused), then, past `MAX_PINS`, evicts the oldest dormant record first and then the
 * oldest. `keep` is the record this write just made, which the bound never evicts.
 */
function prune(list: readonly Pin[], herd: readonly AgentView[], keep: PinId | null): Pin[] {
  const liveSpace = new Map<string, string>();
  for (const pane of herd) {
    const id = pinId(pane);
    liveSpace.set(id.row, id.space);
  }
  const unreused = list.filter((p) => {
    const space = liveSpace.get(p.row);
    return space === undefined || space === p.space;
  });
  const excess = unreused.length - MAX_PINS;
  if (excess <= 0) return unreused;
  const dormant = (p: Pin) => (liveSpace.get(p.row) === p.space ? 0 : 1);
  const victims = new Set(
    unreused
      .filter((p) => keep === null || !same(p, keep))
      .toSorted((a, b) => dormant(b) - dormant(a) || a.at - b.at)
      .slice(0, excess),
  );
  return unreused.filter((p) => !victims.has(p));
}

/**
 * Pin or unpin one pane, the operator's act. `herd` is every pane the caller's list holds (agents and
 * shells); the prune reads it to tell a live record from a dormant one and to spot a reused id. The
 * pane itself counts as live whether or not the caller's list carries it.
 *
 * A pin, from whichever door, also retires the Panes tab's hint for good (`pin-hint.ts`): the
 * operator has found the gesture it teaches. An unpin retires nothing.
 */
export function setPinned(
  pane: AgentView,
  on: boolean,
  herd: readonly AgentView[],
  now: number = Date.now(),
): void {
  const id = pinId(pane);
  const kept = pins.filter((p) => !same(p, id));
  const next = on ? [...kept, { ...id, at: now }] : kept;
  save(prune(next, [...herd, pane], on ? id : null));
  if (on) retirePinHint();
}

/**
 * The pane was closed from Collie, so its pin goes with it. Writes only when there was one, so a
 * close of an unpinned pane leaves the store untouched.
 */
export function dropPin(pane: AgentView): void {
  const id = pinId(pane);
  const next = pins.filter((p) => !same(p, id));
  if (next.length === pins.length) return;
  save(next);
}

/** Test seam: forget every pin, in memory and in storage. */
export function __resetPins(): void {
  pins = NONE;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  for (const fn of listeners) fn();
}

/** Test seam: read the store again from storage, as a fresh page load would. */
export function __reloadPins(): void {
  pins = load();
  for (const fn of listeners) fn();
}
