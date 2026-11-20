import { useSyncExternalStore } from "react";

import { isSoftKeyboardUp } from "@/hooks/use-keyboard";

// WHETHER THIS DEVICE HAS EVER SEEN A HARDWARE KEY PRESS, and the test of one press that decides it.
//
// NO WEB API KNOWS A KEYBOARD IS ATTACHED. Nothing here says "connected", and nothing may: the width
// class is no sign of one (a large tablet is wide and has none), and a phone may have one paired. What a
// page can learn is that a keydown LOOKED like a physical key's, and it learns it from the press, as
// ADR 0157 does for Enter. So the name is "seen", and the answer only ever errs towards "not seen".
//
// ONE PRESS COUNTS as proof only when all three hold (`isHardwareKeyboardEvidence`):
//   1. It looks physical: not composing, `keyCode` not 229 (the code an input method reports for a key it
//      handled, which Safari reports without `isComposing`) and `code` not empty (`isHardwareKeyPress`,
//      which `lib/enter-key.ts` reads too).
//   2. The on-screen keyboard is DOWN at that press (hooks/use-keyboard.ts, the composer's height test).
//   3. Its `code` is one an on-screen keyboard does not send as a key event: a letter (`KeyA`..`KeyZ`),
//      `Control*`, `Alt*`, `Meta*`, `Escape` or `F1`..`F12`. Enter, Backspace, Tab, Space, digits, arrows,
//      Shift and the media keys do not count: Chrome on Android fills `code` for some of those from an
//      on-screen keyboard, and a phone once showed the hint while its owner typed.
//
// ONE DEVICE: the first such press is remembered under `collie:hardware-keyboard-seen:v2`, a bare value,
// in the shape of lib/wide-layout-store.ts. Per device and nothing else, never written to a bridge. It
// decides only whether a control that needs keys is drawn (the shortcut list's row in Settings,
// components/shortcut-settings-row.tsx) and the one-time hint card; a wrong guess changes nothing a person
// does. The root shortcut listener (hooks/use-shortcuts.ts) calls `noteKeyPress` on every keydown.

const KEY = "collie:hardware-keyboard-seen:v2";

/** The facts of one keydown the test reads. A DOM `KeyboardEvent` has all of them. */
export interface KeyPressFacts {
  /** The physical key. An on-screen keyboard usually leaves it empty. */
  readonly code: string;
  /** True while an input method (IME) composition is open. */
  readonly isComposing: boolean;
  /** 229 means "an input method handled this key". */
  readonly keyCode: number;
}

/** The key code an input method uses for a key it handled (`VK_PROCESSKEY`). */
const IME_KEY_CODE = 229;

/** Whether this one press looks like a physical key's. Pure. A modifier alone counts: it names its key. */
export function isHardwareKeyPress(facts: KeyPressFacts): boolean {
  if (facts.isComposing || facts.keyCode === IME_KEY_CODE) return false;
  return facts.code !== "";
}

/** The codes only a hardware keyboard sends as key events. */
const HARDWARE_ONLY_CODES = /^(?:Key[A-Z]|Control\w*|Alt\w*|Meta\w*|Escape|F(?:[1-9]|1[0-2]))$/u;

/**
 * Whether one press proves a hardware keyboard: it looks physical, the on-screen keyboard is down, and
 * its `code` is one an on-screen keyboard never sends. Pure. Stricter than {@link isHardwareKeyPress},
 * which stays as it is for Enter's rule.
 */
export function isHardwareKeyboardEvidence(input: { facts: KeyPressFacts; isSoftKeyboardUp: boolean }): boolean {
  if (input.isSoftKeyboardUp) return false;
  if (!isHardwareKeyPress(input.facts)) return false;
  return HARDWARE_ONLY_CODES.test(input.facts.code);
}

function readSeen(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) === "1";
  } catch {
    return false; // private mode
  }
}

function writeSeen(): void {
  try {
    globalThis.localStorage?.setItem(KEY, "1");
  } catch {
    // Quota or private mode: the in-memory value still applies for this session.
  }
}

let seen = readSeen();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function hasSeenHardwareKeyboard(): boolean {
  return seen;
}

/** Remember the first press that proves a hardware keyboard. Every other press, and every press after it, does nothing. */
export function noteKeyPress(facts: KeyPressFacts): void {
  if (seen || !isHardwareKeyboardEvidence({ facts, isSoftKeyboardUp: isSoftKeyboardUp() })) return;
  seen = true;
  writeSeen();
  emit();
}

/** Whether this device has shown a hardware key press, reactive. */
export function useHardwareKeyboardSeen(): boolean {
  return useSyncExternalStore(subscribe, hasSeenHardwareKeyboard, () => false);
}

/** Test seam: a device that never saw one. */
export function __resetHardwareKeyboard(): void {
  seen = false;
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    // Private mode: nothing was stored.
  }
  emit();
}

/** Test seam: read storage again, as a reload would. */
export function __reloadHardwareKeyboard(): void {
  seen = readSeen();
  emit();
}
