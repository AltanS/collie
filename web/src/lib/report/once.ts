// The trouble signal fires at most once per card kind, pane and UTC day on this device. A card that
// re-mounts (a pane switch, a reload) is the same trouble, and the bridge adds one per signal, so one
// pane could count a dozen times in a day. The wire is unchanged: this gate runs on the phone, before
// the signal's two reads, so a suppressed signal costs no request.
//
// The record is a small set of `<kind>|<pane key>|<YYYY-MM-DD>` entries (the pane key is the crew host and the pane id) in one localStorage key. It
// never leaves the device, and each write keeps only today's entries, so it cannot grow past the
// panes that signalled today. A device whose storage is blocked has no record and signals as before.

import { asJsonString, parseJson } from "../json";
import type { TroubleKind } from "./signal";

const KEY = "collie:trouble-signalled:v1";

/** The UTC day of a moment, `YYYY-MM-DD`. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The entry that stands for one kind on one pane on one UTC day. */
export function onceEntry(kind: TroubleKind, paneKey: string, now: number): string {
  return `${kind}|${paneKey}|${utcDay(now)}`;
}

/** Whether the signal for this entry has not gone out yet. Pure. */
export function isFresh(seen: readonly string[], entry: string): boolean {
  return !seen.includes(entry);
}

/** The record after this entry is added, with every entry of another day dropped. Pure. */
export function recordEntry(seen: readonly string[], entry: string, now: number): string[] {
  const suffix = `|${utcDay(now)}`;
  const today = seen.filter((old) => old.endsWith(suffix));
  return today.includes(entry) ? today : [...today, entry];
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked or partitioned storage
  }
}

function readSeen(store: Storage): string[] | null {
  try {
    const raw = store.getItem(KEY);
    if (raw === null) return [];
    const doc = parseJson(raw);
    return Array.isArray(doc) ? doc.flatMap((item) => asJsonString(item) ?? []) : [];
  } catch {
    return null; // an unreadable store counts as no store
  }
}

/** Entries whose POST is in flight, so a second mount in the same moment does not signal too. */
const inFlight = new Set<string>();

/**
 * Run `send` unless this kind already signalled for this pane today. The entry is written after `send`
 * settled, so a signal that threw before it was attempted does not use up the day. With no usable
 * storage, `send` runs every time.
 */
export async function signalOncePerDay(kind: TroubleKind, paneKey: string, send: () => Promise<void>, now: number = Date.now()): Promise<void> {
  const store = storage();
  const seen = store === null ? null : readSeen(store);
  if (store === null || seen === null) return send();
  const entry = onceEntry(kind, paneKey, now);
  if (!isFresh(seen, entry) || inFlight.has(entry)) return;
  inFlight.add(entry);
  try {
    await send();
  } finally {
    inFlight.delete(entry);
    try {
      store.setItem(KEY, JSON.stringify(recordEntry(readSeen(store) ?? [], entry, now)));
    } catch {
      // A full or blocked store loses the mark, never the signal.
    }
  }
}

/** Forget the record. The unpair wipe runs it: the entries name panes of the bridge this phone was paired to. */
export function forgetTroubleSignals(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Blocked storage holds nothing to forget.
  }
}
