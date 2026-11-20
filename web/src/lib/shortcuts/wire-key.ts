// A chord of the keymap as the key spelling the bridge takes on `/api/pane/:id/keys` (the one the
// Keys tray sends, `lib/key-board.ts`): modifiers in the order ctrl, alt, shift, meta, then one
// literal character or a CapitalCase name. `ctrl+b` is `ctrl+b`, `esc` is `Escape`.

import { isFunctionKey, isSingleChar } from "./chord";
import type { Chord } from "./types";

const NAMED_KEYS: ReadonlyMap<string, string> = new Map([
  ["space", "Space"],
  ["enter", "Enter"],
  ["esc", "Escape"],
  ["tab", "Tab"],
  ["backspace", "Backspace"],
  ["left", "Left"],
  ["right", "Right"],
  ["up", "Up"],
  ["down", "Down"],
]);

function baseKey(key: string): string {
  const named = NAMED_KEYS.get(key);
  if (named !== undefined) return named;
  if (isFunctionKey(key)) return key.toUpperCase();
  if (isSingleChar(key)) return key;
  throw new Error(`shortcuts: no wire key for "${key}"`);
}

export function chordToWireKey(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("ctrl");
  if (chord.alt) parts.push("alt");
  if (chord.shift) parts.push("shift");
  if (chord.meta) parts.push("meta");
  parts.push(baseKey(chord.key));
  return parts.join("+");
}
