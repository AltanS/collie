// Neutral key spelling → Tern's `send BLOCK keys` grammar.
//
// Tern accepts key tokens joined with `+` (e.g. `ctrl+c`, `alt+f`, `enter`, `shift+tab`).
// A meta modifier is refused because terminal PTYs do not receive Super/Command chords.

import { MUX_NAMED_KEYS, parseMuxKey, type MuxModifier, type MuxNamedKey } from "../keys.ts";

/** Every named key in the contract's alphabet, in Tern's spelling. */
const TERN_NAMED_KEYS = {
  Up: "up",
  Down: "down",
  Left: "left",
  Right: "right",
  Tab: "tab",
  Enter: "enter",
  Escape: "escape",
  Space: "space",
  Backspace: "backspace",
  Delete: "delete",
  Insert: "insert",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  F1: "f1",
  F2: "f2",
  F3: "f3",
  F4: "f4",
  F5: "f5",
  F6: "f6",
  F7: "f7",
  F8: "f8",
  F9: "f9",
  F10: "f10",
  F11: "f11",
  F12: "f12",
} satisfies Record<MuxNamedKey, string>;

const TERN_MODIFIERS = {
  ctrl: "ctrl",
  alt: "alt",
  shift: "shift",
} satisfies Partial<Record<MuxModifier, string>>;

export type TernKeyRejection = "unparsed" | "meta";

export type TernKeyResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: TernKeyRejection };

export const TERN_UNSENDABLE_KEYS: readonly MuxNamedKey[] = [];

const _EVERY_UNSENDABLE_IS_A_NAMED_KEY: readonly (typeof MUX_NAMED_KEYS)[number][] = TERN_UNSENDABLE_KEYS;
void _EVERY_UNSENDABLE_IS_A_NAMED_KEY;

const NAMED_BY_CONTRACT_SPELLING = new Map<string, string>(Object.entries(TERN_NAMED_KEYS));

function namedKey(key: string): string | null {
  return NAMED_BY_CONTRACT_SPELLING.get(key) ?? null;
}

export function toTernKey(spelling: string): TernKeyResult {
  const parsed = parseMuxKey(spelling);
  if (parsed === null) return { ok: false, reason: "unparsed" };
  if (parsed.modifiers.includes("meta")) return { ok: false, reason: "meta" };

  const parts: string[] = [];
  for (const modifier of parsed.modifiers) {
    if (modifier === "ctrl") parts.push(TERN_MODIFIERS.ctrl);
    if (modifier === "alt") parts.push(TERN_MODIFIERS.alt);
    if (modifier === "shift") parts.push(TERN_MODIFIERS.shift);
  }

  const base = namedKey(parsed.key) ?? parsed.key.toLowerCase();
  parts.push(base);
  return { ok: true, key: parts.join("+") };
}
