import { useSyncExternalStore } from "react";

// "FOLLOW TERMINAL" — the phone follows the operator's own screen, and never the other way round.
//
// With it on, moving focus in tmux/zellij/Herdr moves the pane Collie is showing. It is the mirror
// image of the "Show in terminal" row, and the asymmetry between the two is the whole design:
//
//   • the phone moving the TERMINAL is a named tap, once, on one pane (ADR 0031);
//   • the terminal moving the PHONE is opt-in, off by default, and abandons itself the moment the
//     operator is doing something the jump would ruin.
//
// ── THE HOLD, AND WHY IT IS A STORE RATHER THAN A PROP ─────────────────────────────────────────────
//
// The state that must suppress a jump lives deep inside the pane view — a half-typed draft, an armed
// "Type into terminal", an open sheet — and the effect that performs the jump lives at the router's
// root, where the snapshot is. Threading four booleans up through the tree would put this feature's
// name in every component between the two. So the pane view HOLDS the follow, by name, and the root
// asks one question: is anything holding?
//
// A hold is released by the same component that took it (its effect's cleanup), so a pane view that
// unmounts mid-hold cannot strand one. Two holders are counted, not overwritten — an open sheet and
// a draft are independent reasons and either alone is enough.
//
// The setting itself is persisted like haptics and the theme: a module store over `localStorage`,
// read through `useSyncExternalStore`. Default OFF, because a phone that jumps on its own before the
// operator has asked it to is a bug they cannot name.

const STORAGE_KEY = "collie:followTerminal:v1";
const DEFAULT_ENABLED = false;

let enabled = load();
const listeners = new Set<() => void>();

/** Reasons currently holding the follow off, by name. Empty = nothing is in the way. */
const holds = new Set<string>();

function load(): boolean {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_ENABLED;
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return DEFAULT_ENABLED; // private mode / SSR
  }
}

export function followTerminalEnabled(): boolean {
  return enabled;
}

export function setFollowTerminalEnabled(on: boolean): void {
  enabled = on;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // Ignore quota / SSR write errors — the in-memory value still applies for this session.
  }
  for (const fn of listeners) fn();
}

/**
 * Hold the follow off, or let it go, under a named reason.
 *
 * Idempotent per reason, so an effect may call it on every render of a changing value without
 * counting a hold twice. The name is for the holder's own clarity — nothing reads it.
 */
export function holdFollowTerminal(reason: string, held: boolean): void {
  const before = holds.size;
  if (held) holds.add(reason);
  else holds.delete(reason);
  if (holds.size !== before) for (const fn of listeners) fn();
}

/** Whether anything is currently holding the follow off. */
export function followTerminalHeld(): boolean {
  return holds.size > 0;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reactive read for the Settings toggle. */
export function useFollowTerminalEnabled(): boolean {
  return useSyncExternalStore(subscribe, followTerminalEnabled, () => DEFAULT_ENABLED);
}

/**
 * Whether the follow may act right now: the operator turned it on AND nothing is holding it.
 *
 * One hook rather than two, because a caller that read them separately could act on a stale half —
 * and there is exactly one caller, the effect at the router's root.
 */
export function useFollowTerminalActive(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => enabled && !followTerminalHeld(),
    () => false,
  );
}

/** Test seam — resets the module store to defaults between cases. */
export function __resetFollowTerminal(): void {
  enabled = DEFAULT_ENABLED;
  holds.clear();
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  for (const fn of listeners) fn();
}
