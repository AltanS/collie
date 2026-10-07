// Neutral key spelling → tuios's `send-keys` grammar.
//
// tuios's grammar is close to the contract's: `ctrl+c`, `shift+Tab`, `alt+Up`, and the whole named
// alphabet under the contract's own names (`PageUp`, `Delete`, `F7`). So this is a small
// translation, like Herdr's. The grammar is stable and closed, and `list-keys` returns it
// (tuios docs/protocol.md § Key grammar). Three rules make this more than a pass-through:
//
//  1. **Tokens are split on spaces and commas.** A batch goes out as one space-joined string, so a
//     literal space is spelled `Space` and a literal comma `Comma`.
//  2. **Every token is parsed before anything is sent**, and a key name tuios does not know is
//     refused by the daemon with nothing sent. So a batch is all or nothing on the daemon's side
//     too, and a chord tuios refuses (`ctrl++`) comes back `refused`.
//  3. **tuios's `meta+` means Alt**, and its Super modifier reaches only the window manager of an
//     attached client, never a pane. The contract's `meta` is Super/Command, so a `meta` chord is
//     refused here and never sent, exactly as on tmux.
//
// Probed 2026-10-01 against tuios main (`c24cbc80`) by sending each key to a pane running a raw
// byte logger: every named key and every printable ASCII character arrived as the bytes a terminal
// sends for it. `Up` came as `ESC [ A`, `shift+Tab` as `ESC [ Z`, `ctrl+alt+Delete` as
// `ESC [ 3 ; 7 ~`, `Comma` as `,` and `alt+Comma` as `ESC ,`.
//
// `ctrl+Enter` was NOT in that probe, and nothing since has shown what tuios delivers for it. On tmux
// and zellij it arrives as a plain Enter, which submits a draft in Claude Code's input box, so until a
// probe shows it arriving as itself it is declared unsupported (../keys.ts `EXTENDED_ONLY_CHORDS`)
// and refused here. Fail closed: a refused key is a missing button, a mis-sent one is a sent draft.

import { isExtendedOnlyChord, MUX_NAMED_KEYS, parseMuxKey, type MuxNamedKey } from "../keys.ts";

/**
 * Every named key in the contract's alphabet, in tuios's spelling. The same names, and the table is
 * still spelled out: the `satisfies` makes a key added to the contract fail this build until
 * somebody has probed what tuios calls it.
 */
const TUIOS_NAMED_KEYS = {
  Up: "Up",
  Down: "Down",
  Left: "Left",
  Right: "Right",
  Tab: "Tab",
  Enter: "Enter",
  Escape: "Escape",
  Space: "Space",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",
} satisfies Record<MuxNamedKey, string>;

const NAMED_BY_CONTRACT_SPELLING = new Map<string, string>(Object.entries(TUIOS_NAMED_KEYS));

/**
 * tuios sends every key in the contract's alphabet, so the list is empty. A `meta` chord is
 * refused at send time instead, because a list of chords is not a list of keys.
 */
export const TUIOS_UNSENDABLE_KEYS: readonly string[] = [];

// A compile-time tie to the contract's alphabet, as the Herdr and tmux tables keep one.
const _EVERY_NAMED_KEY_IS_TRANSLATED: readonly (typeof MUX_NAMED_KEYS)[number][] = MUX_NAMED_KEYS;
void _EVERY_NAMED_KEY_IS_TRANSLATED;

/** Why a key never reached the socket, in the words the refusal detail prints. */
export type TuiosKeyRejection = "unparsed" | "meta" | "extended";

/** A translated chord, or the reason tuios will not be asked for it. */
export type TuiosKeyResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: TuiosKeyRejection };

/** The literal characters that are token separators, and the name that sends each one. */
const SEPARATOR_NAMES = new Map<string, string>([
  [" ", "Space"],
  [",", "Comma"],
]);

/** One neutral chord in tuios's spelling. */
export function toTuiosKey(spelling: string): TuiosKeyResult {
  const parsed = parseMuxKey(spelling);
  if (parsed === null) return { ok: false, reason: "unparsed" };
  if (parsed.modifiers.includes("meta")) return { ok: false, reason: "meta" };
  if (isExtendedOnlyChord(spelling)) return { ok: false, reason: "extended" };
  const base = NAMED_BY_CONTRACT_SPELLING.get(parsed.key) ?? SEPARATOR_NAMES.get(parsed.key) ?? parsed.key;
  return { ok: true, key: [...parsed.modifiers, base].join("+") };
}
