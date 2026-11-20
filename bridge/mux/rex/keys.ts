// Neutral key spelling → Rex's `send-key` grammar.
//
// Rex takes `+`-joined key names, as the contract does: `ctrl+c`, `shift+tab`, `enter`. Every named
// key below was sent to a block running `cat -v` on rex 0.0.1795019727 (MUX_CONTRACT.md, source
// **RX**) and arrived as the bytes an xterm sends for it: `up` as `^[[A`, `home` as `^[[H`, `pageup`
// as `^[[5~`, `f1` as `^[OP`, `shift+tab` as `^[[Z`, `alt+f` as `^[f`, `delete` as `^[[3~`.
//
// Two answers differ from the other CLI adapters, both from that probe:
//
//  • `meta` (and `super`) chords are REFUSED. `rex send-key super+a` exits 0 and the block receives
//    nothing at all, so a meta chord sent anyway would be a silent no-op the caller reads as done.
//  • `ctrl+Enter` is SENT. It arrived as `^[[27;5;13~`, the modifyOtherKeys form, and not as the
//    plain `^M` tmux and zellij deliver (../keys.ts `EXTENDED_ONLY_CHORDS`), so it cannot be mistaken
//    for Enter and submit a draft.
//
// Single characters need care, because Rex reads a key name as a PHYSICAL key on a US layout:
//
//  • A bare capital is sent as `shift+<letter>`: `send-key A` delivered `a`, `shift+a` delivered `A`.
//  • `alt` with a capital is REFUSED: `alt+A` and `alt+shift+a` both delivered `^[a`, lower case.
//  • `+` under a modifier is REFUSED: `ctrl++` delivered nothing and exited 0.
//  • A lone space is sent as `space`: `send-key " "` is refused as an empty binding.
//
// Any other character is passed through, and Rex itself refuses one it has no key for (`?`, `!`,
// `é` answer `invalid key`, exit 2). Probed: that refusal sends NOTHING of the batch, so a batch with
// one such key is all-or-nothing, as the contract requires.

import { MUX_NAMED_KEYS, parseMuxKey, type MuxModifier, type MuxNamedKey } from "../keys.ts";

/** Every named key in the contract's alphabet, in Rex's spelling. */
const REX_NAMED_KEYS = {
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

const REX_MODIFIERS = {
  ctrl: "ctrl",
  alt: "alt",
  shift: "shift",
} satisfies Partial<Record<MuxModifier, string>>;

export type RexKeyRejection = "unparsed" | "meta" | "undeliverable";

export type RexKeyResult = { readonly ok: true; readonly key: string } | { readonly ok: false; readonly reason: RexKeyRejection };

/** Named keys Rex cannot send. None: every one was probed arriving as itself. */
export const REX_UNSENDABLE_KEYS: readonly MuxNamedKey[] = [];

const _EVERY_UNSENDABLE_IS_A_NAMED_KEY: readonly (typeof MUX_NAMED_KEYS)[number][] = REX_UNSENDABLE_KEYS;
void _EVERY_UNSENDABLE_IS_A_NAMED_KEY;

const NAMED_BY_CONTRACT_SPELLING = new Map<string, string>(Object.entries(REX_NAMED_KEYS));

/** One neutral key as Rex spells it, or why it cannot be sent. */
export function toRexKey(spelling: string): RexKeyResult {
  const parsed = parseMuxKey(spelling);
  if (parsed === null) return { ok: false, reason: "unparsed" };
  if (parsed.modifiers.includes("meta")) return { ok: false, reason: "meta" };

  const modifiers = new Set(parsed.modifiers);
  let base = NAMED_BY_CONTRACT_SPELLING.get(parsed.key);
  if (base === undefined) {
    const char = parsed.key;
    if (char === " ") {
      base = "space";
    } else if (char === "+" && modifiers.size > 0) {
      return { ok: false, reason: "undeliverable" };
    } else if (/^[A-Z]$/u.test(char)) {
      if (modifiers.has("alt")) return { ok: false, reason: "undeliverable" };
      // A capital is the shifted letter; under ctrl the byte is the same either way (`^A`).
      if (!modifiers.has("ctrl")) modifiers.add("shift");
      base = char.toLowerCase();
    } else {
      base = char;
    }
  }

  const parts: string[] = [];
  if (modifiers.has("ctrl")) parts.push(REX_MODIFIERS.ctrl);
  if (modifiers.has("alt")) parts.push(REX_MODIFIERS.alt);
  if (modifiers.has("shift")) parts.push(REX_MODIFIERS.shift);
  parts.push(base);
  return { ok: true, key: parts.join("+") };
}
