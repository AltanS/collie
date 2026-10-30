import { isExtendedOnlyChord, MUX_NAMED_KEYS, parseMuxKey, type MuxNamedKey } from "../keys.ts";

// The contract's key names in herdr-core's spelling, for `terminal.keys`. Probed on hc 0.1.14
// against a raw-mode sink in a private core session (HC_API.md § Typing).
//
// The core takes key NAMES, lower case or not, and refuses what it cannot name with
// `invalid_params`: a literal space, a non-ASCII character, and the shifted punctuation
// `! " # $ % & ( ) * + : < > ? @ ^ _ { | } ~`. A batch is translated whole before anything is sent,
// so one key the core cannot express sends nothing (MUX_CONTRIBUTING.md § A batch is a sequence).

/**
 * Every named key in the contract's alphabet, in hc's spelling. The `satisfies` makes a key added
 * to the contract fail this build until somebody has probed what hc calls it.
 */
const HC_NAMED_KEYS = {
  Up: "up",
  Down: "down",
  Left: "left",
  Right: "right",
  Tab: "tab",
  Enter: "enter",
  Escape: "esc",
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

const NAMED_BY_CONTRACT_SPELLING = new Map<string, string>(Object.entries(HC_NAMED_KEYS));

const _EVERY_NAMED_KEY_IS_TRANSLATED: readonly (typeof MUX_NAMED_KEYS)[number][] = MUX_NAMED_KEYS;
void _EVERY_NAMED_KEY_IS_TRANSLATED;

/**
 * The single characters hc names as keys (probed): letters, digits and the unshifted punctuation of
 * a US keyboard. Any other character has no hc name.
 */
const HC_NAMEABLE_CHAR = /^[A-Za-z0-9',\-./;=[\\\]`]$/u;

/** One translated key: a name for `terminal.keys`, or a character to type as raw input. */
export type HcKey = { readonly kind: "key"; readonly name: string } | { readonly kind: "text"; readonly text: string };

/** Why a key never reached the socket, in the words the refusal detail prints. */
export type HcKeyRejection = "unparsed" | "meta" | "extended" | "unnamed";

export type HcKeyResult = { readonly ok: true; readonly key: HcKey } | { readonly ok: false; readonly reason: HcKeyRejection };

/**
 * The modifiers a key name needs to keep the letter's case. The core lower-cases every name, so `G`
 * would arrive as `g` (the lab sent 0x67 for `G`, and the route answered ok). A capital is therefore
 * `shift+g`, which the lab measured as 0x47. `ctrl+G` is `ctrl+g` to a terminal (0x07), so a ctrl
 * chord only loses the capital. Everything that is not a capital letter passes unchanged.
 */
function withCase(modifiers: readonly string[], key: string): readonly string[] {
  if (!/^[A-Z]$/u.test(key)) return modifiers;
  if (modifiers.includes("ctrl") || modifiers.includes("shift")) return modifiers;
  return [...modifiers, "shift"];
}

/**
 * One neutral chord in hc's spelling.
 *
 * - A named key or a nameable character, with or without modifiers, is a key name. A capital
 *   letter keeps its case as `shift+<letter>`, because the core takes names case-insensitively.
 * - A single printable character hc has no name for (`$`, `!`, `ä`), with NO modifier, is typed as
 *   raw input: a plain character is its own bytes, which is exactly what a terminal sends for it.
 * - A modifier on such a character (`ctrl+$`) has no encoding to fall back on, and is refused.
 * - A `meta` chord is refused: hc accepts `super+a`, and whether a program receives it as itself
 *   depends on its keyboard mode, which was not probed. `ctrl+Enter` is refused for the same reason
 *   (`EXTENDED_ONLY_CHORDS`).
 */
export function toHcKey(spelling: string): HcKeyResult {
  const parsed = parseMuxKey(spelling);
  if (parsed === null) return { ok: false, reason: "unparsed" };
  if (parsed.modifiers.includes("meta")) return { ok: false, reason: "meta" };
  if (isExtendedOnlyChord(spelling)) return { ok: false, reason: "extended" };
  const named = NAMED_BY_CONTRACT_SPELLING.get(parsed.key);
  if (named !== undefined) return { ok: true, key: { kind: "key", name: [...parsed.modifiers, named].join("+") } };
  if (parsed.key === " ") return { ok: true, key: { kind: "key", name: [...parsed.modifiers, "space"].join("+") } };
  if (HC_NAMEABLE_CHAR.test(parsed.key)) return { ok: true, key: { kind: "key", name: [...withCase(parsed.modifiers, parsed.key), parsed.key.toLowerCase()].join("+") } };
  if (parsed.modifiers.length === 0) return { ok: true, key: { kind: "text", text: parsed.key } };
  return { ok: false, reason: "unnamed" };
}

/**
 * hc sends every named key of the contract's alphabet, so the only key listed as unsendable is the
 * extended-only chord. A `meta` chord and a modified character hc cannot name are refused at send
 * time, because a list of chords is not a list of keys.
 */
export const HC_UNSENDABLE_KEYS: readonly string[] = [];
