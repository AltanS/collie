import { useSyncExternalStore } from "react";

// WHETHER THIS DEVICE IS DONE WITH THE ONE-TIME KEYBOARD HINT (M108): the card that says "you have a
// keyboard, Collie takes Herdr's keys" (components/keyboard-hint-card.tsx). It is shown once the device
// has seen a hardware key press (lib/hardware-keyboard.ts) and until this flag is set.
//
// DONE means the person closed the card, opened the shortcut list from it, or pressed the prefix for the
// first time (they found the keys on their own). Remembered under `collie:keyboard-hint-done:v1`, a bare
// value, in the shape of lib/hardware-keyboard.ts: per device, never written to a bridge, no private data.

const KEY = "collie:keyboard-hint-done:v1";

function readDone(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) === "1";
  } catch {
    return false; // private mode
  }
}

function writeDone(): void {
  try {
    globalThis.localStorage?.setItem(KEY, "1");
  } catch {
    // Quota or private mode: the in-memory value still applies for this session.
  }
}

let done = readDone();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isKeyboardHintDone(): boolean {
  return done;
}

/** The hint has done its work on this device. Calling it again does nothing. */
export function markKeyboardHintDone(): void {
  if (done) return;
  done = true;
  writeDone();
  emit();
}

/** Whether this device is done with the keyboard hint, reactive. */
export function useKeyboardHintDone(): boolean {
  return useSyncExternalStore(subscribe, isKeyboardHintDone, () => true);
}

/** Test seam: a device that never closed the hint. */
export function __resetKeyboardHint(): void {
  done = false;
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    // Private mode: nothing was stored.
  }
  emit();
}

/** Test seam: read storage again, as a reload would. */
export function __reloadKeyboardHint(): void {
  done = readDone();
  emit();
}
