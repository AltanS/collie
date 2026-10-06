// The composer's key mapping, pure. Two halves:
//
//  1. WHAT A KEYSTROKE IN THE BOX MEANS (web/src/components/composer.tsx `onKeyDown`, ADR 0057).
//     Enter is a shell character, so a bare Enter and Shift+Enter put a newline in the draft, and
//     Ctrl+Enter or Cmd+Enter sends. A key that arrives while an input method is still composing
//     belongs to the input method, never to the composer.
//  2. THE SPECIAL KEYS ROW. The keys the Keys tray (web/src/components/nav-tray.tsx) offers on its
//     first row, by their wire names in the multiplexer contract's neutral alphabet (MUX_CONTRACT.md),
//     each sent through `POST /api/pane/:id/keys`. Labels come from web's own `keyLabel`, so a chip
//     reads the same in both shells.
import { keyLabel } from "@web/lib/key-queue";
import { keysSendable } from "@web/lib/mux-capability";

export type KeyIntent = "send" | "newline" | "none";

/** The fields of a KeyboardEvent the mapping reads. A DOM event satisfies it. */
export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

/** What a keystroke in the composer's box asks for. */
export function composerKeyIntent(press: KeyPress): KeyIntent {
  if (press.key !== "Enter" || press.isComposing) return "none";
  return press.ctrlKey || press.metaKey ? "send" : "newline";
}

export interface SpecialKey {
  /** Stable id, for the button's test hook. */
  id: string;
  /** The key on the wire. */
  wire: string;
  /** The name a screen reader says (the Keys tray's own aria-labels, which are key names). */
  aria: string;
}

/** The special keys row, in the Keys tray's order: Esc, Ctrl+C, the arrows, Tab, Enter. */
export const SPECIAL_KEYS: readonly SpecialKey[] = [
  { id: "esc", wire: "Escape", aria: "Esc" },
  { id: "ctrl-c", wire: "ctrl+c", aria: "Ctrl+C" },
  { id: "left", wire: "Left", aria: "Left" },
  { id: "up", wire: "Up", aria: "Up" },
  { id: "down", wire: "Down", aria: "Down" },
  { id: "right", wire: "Right", aria: "Right" },
  { id: "tab", wire: "Tab", aria: "Tab" },
  { id: "enter", wire: "Enter", aria: "Enter" },
];

/** The chip text for a special key. */
export function specialKeyLabel(key: SpecialKey): string {
  return keyLabel(key.wire);
}

/** The keys a tap on `key` sends: one key, one call. */
export function keysFor(key: SpecialKey): string[] {
  return [key.wire];
}

/** Whether the multiplexer accepts `key` (its refused-key list from `/api/config`). */
export function specialKeyAllowed(key: SpecialKey, unsupported: readonly string[]): boolean {
  return keysSendable(keysFor(key), unsupported);
}
