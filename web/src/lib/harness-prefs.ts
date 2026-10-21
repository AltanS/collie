import { useSyncExternalStore } from "react";

import { asJsonBoolean, asJsonObject, parseJson } from "./json";

// What this phone shows of each harness's own chrome in the Chat view. One thing so far: whether the
// status line the harness paints at the foot of its screen is lifted out and drawn under Chat (the
// strip in components/agent-chat.tsx, and for Claude Code the background-agents block under it).
//
// Device-level, exactly like `lib/strips-collapsed.ts` beside it, and for the same reason: this is
// "how much of the harness's chrome does this screen want", a property of the glass in the hand and
// not of any one pane or any one machine. A phone and a tablet paired to the same collie disagree by
// design. It is NOT a DisplayPrefs field — that dock's prefs are per-instance rendering knobs — and
// it is NOT per-pane: turning the strip off on one Claude Code pane and finding it back on the next
// is the jump this setting exists to stop.
//
// Per HARNESS, because the harnesses differ in what the belt already says. The Tasks and Agents
// pills carry the facts Claude Code's strip repeats; another harness's strip may be the only place
// its branch or its permission mode shows. One switch for all of them would be wrong for somebody.
//
// Default ON for every harness, because the strip is what Chat has always drawn and it carries real
// context (the branch, the permission mode). A first run that quietly dropped it would take that
// context away without the operator ever choosing so. The switch is the way OUT of a strip the
// operator can already see, not the way in to one they cannot.
//
// Stored as ONE JSON object, `{ [harnessId]: { statusLine: boolean } }`, keyed by the agent string
// Herdr reports (the registry's own key). Only an explicit `false` turns anything off, so garbage in
// storage, an unknown shape or a harness nobody has touched all read as the default. The record is
// an object per harness so the next per-harness choice has a field to land in, not a second key.

const STORAGE_KEY = "collie:harness-prefs:v1";

interface HarnessPref {
  statusLine: boolean;
}

type Prefs = Readonly<Record<string, HarnessPref>>;

const DEFAULTS: Prefs = Object.freeze({});

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked / partitioned storage, or SSR
  }
}

/**
 * The stored prefs, or none. A value that is not JSON or not an object reads as none; an entry that
 * is not an object holding a boolean `statusLine` is skipped and the others are kept.
 */
function decode(raw: string | null): Prefs {
  if (raw === null) return DEFAULTS;
  const doc = asJsonObject(parseJson(raw));
  if (doc === undefined) return DEFAULTS;
  const out: Record<string, HarnessPref> = Object.create(null);
  for (const [id, entry] of Object.entries(doc)) {
    const statusLine = asJsonBoolean(asJsonObject(entry)?.statusLine);
    if (statusLine !== undefined) out[id] = { statusLine };
  }
  return out;
}

function load(): Prefs {
  try {
    return decode(storage()?.getItem(STORAGE_KEY) ?? null);
  } catch {
    return DEFAULTS; // private mode
  }
}

// One product, two agent strings: Herdr reports Google's agent as `agy` or as `antigravity`, and the
// registry holds an adapter under each. A switch is for the product, so `agy` is stored and read as
// `antigravity` and Settings shows one row. `canonicalAgent()` (lib/operator-scope.ts) keeps the two
// apart ON PURPOSE, because command catalogs are scoped by the exact string; that is a different
// question, so it is not reused here.
const ALIASES = new Map([["agy", "antigravity"]]);

/** The key a harness's pref is stored under. Applied before every read and write. */
export function prefKey(harnessId: string): string {
  return ALIASES.get(harnessId) ?? harnessId;
}

let prefs = load();
const listeners = new Set<() => void>();

/** Whether the status line is drawn for this harness. `undefined` (no agent) and the unknown read ON. */
export function harnessStatusLineShown(harnessId: string | undefined): boolean {
  if (harnessId === undefined) return true;
  return prefs[prefKey(harnessId)]?.statusLine !== false;
}

export function setHarnessStatusLineShown(harnessId: string, on: boolean): void {
  const next: Record<string, HarnessPref> = Object.create(null);
  Object.assign(next, prefs);
  next[prefKey(harnessId)] = { statusLine: on };
  prefs = next;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore quota / SSR write errors — the in-memory value still applies for this session.
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reactive read for the Chat view and the Settings switch. Module-scoped store, mirroring lib/zen. */
export function useHarnessStatusLineShown(harnessId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => harnessStatusLineShown(harnessId),
    () => true,
  );
}

/** Test seam — resets the module store to defaults between cases. */
export function __resetHarnessPrefs(): void {
  prefs = DEFAULTS;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  for (const fn of listeners) fn();
}

/** Test seam — re-reads storage, as a reload would. */
export function __reloadHarnessPrefs(): void {
  prefs = load();
  for (const fn of listeners) fn();
}
