import { useSyncExternalStore } from "react";

import type { EnterChoice } from "@/lib/enter-key";

// Whether a bare Enter from a physical keyboard sends the reply (ADR 0157; the rule is lib/enter-key.ts).
//
// Per device and nothing else, the way lib/wide-layout-store.ts and lib/zen.ts are: it is how THIS
// keyboard behaves, so it is never written to a bridge and another device keeps its own. Ctrl/Cmd+Enter
// sends whatever this says; the on-screen keyboard's Enter is a new line whatever this says.

const KEY = "collie:enter-sends:v1";

// THE STORE HOLDS THE PERSON'S CHOICE AND NOTHING ELSE. "on", "off", or nothing (never chosen). There
// is no default by device, no guess from a mouse or a screen size: nothing stored means Enter is a new
// line everywhere, and only a tap, on the Settings switch or on the one-time offer above the box, writes
// a value. A bad stored value reads as nothing.

let choice = load();
const listeners = new Set<() => void>();

function readStorage(): string | null {
  try {
    return globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    return null; // private mode
  }
}

function writeStorage(value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(KEY);
    else globalThis.localStorage?.setItem(KEY, value);
  } catch {
    // Quota or private mode: the in-memory value still applies for this session.
  }
}

function load(): EnterChoice {
  const raw = readStorage();
  if (raw === "on" || raw === "off") return raw;
  return null;
}

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** What the person chose on this device, or null when they never did. */
export function enterSendsChoice(): EnterChoice {
  return choice;
}

/** Store the person's choice. The Settings switch and both actions of the offer end here. */
export function setEnterSends(on: boolean): void {
  const next: EnterChoice = on ? "on" : "off";
  if (choice === next) return;
  choice = next;
  writeStorage(next);
  emit();
}

/** The person's choice, reactive. Null until they choose. */
export function useEnterSendsChoice(): EnterChoice {
  return useSyncExternalStore(subscribe, enterSendsChoice, () => null);
}

/** Test seam: back to a device that never chose. */
export function __resetEnterSendsStore(): void {
  choice = null;
  writeStorage(null);
  emit();
}

/** Test seam: read storage again, as a reload would. */
export function __reloadEnterSendsStore(): void {
  choice = load();
  emit();
}
