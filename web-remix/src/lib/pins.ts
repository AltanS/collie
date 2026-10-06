// PINS (ADR 0070): the panes this device asked to lead the dashboard, and the one-line hint that
// teaches the hold that pins one (M38/02). Ported from web/src/lib/pins.ts and pin-hint.ts onto this
// shell's stores, with the same keys and the same rules:
//
//   - A pin is `{ row: paneRowKey(pane), space: <workspace name>, at }` in `collie:pins:v1` (the
//     `pins` pref store in prefs.ts, which already decodes it the way web/ does). It applies while a
//     live pane with that row key sits in a workspace of that name (`pinMatcher`, reused read-only).
//   - ABSENCE NEVER PRUNES. A dormant pin is kept. The store is written on the operator's own acts
//     only (pin, unpin, close from Collie); each pin or unpin write also drops records whose row key
//     now names a live pane in ANOTHER workspace, and keeps at most `MAX_PINS`, the oldest dormant
//     record going first.
//   - The hint (`collie:pin-hint:v1`, "1" when retired) retires on its own X or on the first pin
//     from any door, for good.
import { MAX_PINS, pinMatcher, type Pin } from "@web/lib/pins";
import { paneRowKey } from "@web/lib/hosts";
import { panePlaceParts } from "@web/lib/pane-name";
import { PIN_HINT_MIN_ROWS, showsPinHint } from "@web/lib/pin-hint";
import type { AgentView } from "@web/lib/types";

import { pins } from "./prefs";
import { createStore } from "./store";

export { MAX_PINS, PIN_HINT_MIN_ROWS, pinMatcher, pins, showsPinHint };
export type { Pin };

interface PinId {
  row: string;
  space: string;
}

function pinId(pane: AgentView): PinId {
  return { row: paneRowKey(pane), space: panePlaceParts(pane).space };
}

const same = (a: PinId, b: PinId): boolean => a.row === b.row && a.space === b.space;

/**
 * The records a write keeps (web/'s `prune`): drop a record whose row key now names a live pane in
 * another workspace, then past `MAX_PINS` evict the oldest dormant record first and then the oldest.
 * `keep` is the record this write just made, which the bound never evicts.
 */
export function prunePins(list: readonly Pin[], herd: readonly AgentView[], keep: PinId | null): Pin[] {
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
  const dormant = (p: Pin): number => (liveSpace.get(p.row) === p.space ? 0 : 1);
  const victims = new Set(
    unreused
      .filter((p) => keep === null || !same(p, keep))
      .toSorted((a, b) => dormant(b) - dormant(a) || a.at - b.at)
      .slice(0, excess),
  );
  return unreused.filter((p) => !victims.has(p));
}

/** The pin list after pinning or unpinning `pane`. Pure, for the tests. */
export function pinnedList(
  list: readonly Pin[],
  pane: AgentView,
  on: boolean,
  herd: readonly AgentView[],
  now: number,
): Pin[] {
  const id = pinId(pane);
  const kept = list.filter((p) => !same(p, id));
  const next = on ? [...kept, { ...id, at: now }] : kept;
  return prunePins(next, [...herd, pane], on ? id : null);
}

/** Pin or unpin one pane, the operator's act. A pin also retires the hint for good. */
export function setPinned(pane: AgentView, on: boolean, herd: readonly AgentView[], now: number = Date.now()): void {
  pins.set(pinnedList(pins.get(), pane, on, herd, now));
  if (on) retirePinHint();
}

/** Is this pane pinned now? */
export function isPinned(pane: AgentView): boolean {
  return pinMatcher(pins.get())(pane);
}

/** The pane was closed from Collie: its pin goes with it. Writes only when there was one. */
export function dropPin(pane: AgentView): void {
  const id = pinId(pane);
  const list = pins.get();
  const next = list.filter((p) => !same(p, id));
  if (next.length !== list.length) pins.set(next);
}

// ── The pin hint (web/src/lib/pin-hint.ts) ─────────────────────────────────────────────────────────

const HINT_KEY = "collie:pin-hint:v1";
const RETIRED = "1";

function readRetired(): boolean {
  try {
    return globalThis.localStorage?.getItem(HINT_KEY) === RETIRED;
  } catch {
    return false;
  }
}

/** Whether this device retired the hint. Read synchronously at module load: the cold open is right. */
export const pinHintRetired = createStore<boolean>(readRetired());

/** The operator dismissed the line or pinned a pane: retire it on this device for good. */
export function retirePinHint(): void {
  if (pinHintRetired.get()) return;
  try {
    globalThis.localStorage?.setItem(HINT_KEY, RETIRED);
  } catch {
    // Quota or private mode: the in-memory flag still holds for this session.
  }
  pinHintRetired.set(true);
}
