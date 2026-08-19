// Neutral key spelling → zellij's `send-keys` grammar.
//
// The THIRD grammar of three, and the one that finally settles why the contract owns a neutral
// spelling at all (../keys.ts says so in its header). zellij joins a chord's parts with SPACES and
// capitalises each one — `"Ctrl a"`, `"Alt Shift b"`, `"Shift Tab"` — where Herdr joins with a `+`
// and tmux uses single-letter prefixes. None of the three is guessable from either of the others.
//
// The contract's spellings are deliberately absent from this file as STRINGS: they exist here only
// as the parsed {@link MuxKey} structure, so no translation can ever be a match on somebody else's
// grammar.
//
// ── WHAT ZELLIJ DOES WITH A NAME IT DOES NOT KNOW ────────────────────────────────────────────────
//
// It REFUSES, and that is a real difference from tmux worth writing down. Probed on 0.44.2:
// `send-keys "Nonsense"` answered `Invalid key at position 1: "Nonsense" / Error: unsupported key`
// and exited 2 — where tmux would have typed the word into the pane. So a typo in an operator's
// `keys.toml` row cannot reach a live agent as literal text through this adapter. The table below is
// still closed, because refusing BEFORE a process is spawned is better than refusing after, and
// because a closed table is what makes the `satisfies` check below possible.
//
// ── THE TWO NAMES ZELLIJ SPELLS DIFFERENTLY ──────────────────────────────────────────────────────
//
// `Esc` (probed: `Escape` is rejected outright) and nothing else. Every other name in the contract's
// alphabet — including the paging and edit block Herdr refuses — was accepted verbatim, so zellij's
// `unsupportedKeys` is EMPTY.
//
// ── WHY `meta` IS REFUSED, EVEN THOUGH ZELLIJ ACCEPTS `Super` ─────────────────────────────────────
//
// This is the trap this file exists to close. `send-keys "Super a"` exits 0 — and the pane receives
// a bare `a` (probed, with the character landing in a shell's input line). zellij parses the
// modifier and then drops it, because a PTY has no encoding for Super. Passing `meta` through would
// therefore turn "send Super+a" into "type a" at a live agent, silently. A refusal that says so is
// the only honest answer. It is not an `unsupportedKeys` entry because that list holds KEYS —
// enumerating every meta chord is not a list, and the Keys tray greys buttons off it.

import { MUX_NAMED_KEYS, parseMuxKey, type MuxModifier, type MuxNamedKey } from "../keys.ts";

/**
 * Every named key in the contract's alphabet, in zellij's spelling.
 *
 * Total over {@link MUX_NAMED_KEYS} by construction — the `satisfies` is what makes a key added to
 * the contract fail this build until someone has run it against a real zellij, rather than falling
 * through to a spelling zellij would reject at the operator's next tap.
 */
const ZELLIJ_NAMED_KEYS = {
  Up: "Up",
  Down: "Down",
  Left: "Left",
  Right: "Right",
  Tab: "Tab",
  Enter: "Enter",
  Escape: "Esc",
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

/** The modifier words zellij understands and actually delivers. `meta` is absent — see the header. */
const ZELLIJ_MODIFIERS = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
} satisfies Partial<Record<MuxModifier, string>>;

/** How zellij joins the parts of one chord. Its whole grammar, in one constant. */
const CHORD_SEPARATOR = " ";

/** Why a chord never reached zellij, in the words the refusal detail prints. */
export type ZellijKeyRejection = "unparsed" | "meta";

/** A translated chord, or the reason zellij will not be asked for it. */
export type ZellijKeyResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: ZellijKeyRejection };

/**
 * zellij sends no key at all for these — the empty list, and it is a real answer rather than a stub.
 *
 * Every named key in the contract's alphabet has a zellij spelling above and every one of them was
 * accepted by the real binary, so the Keys tray greys nothing on zellij. Kept as an exported
 * constant so the declaration in adapter.ts reads the same way the other two adapters' do, and so
 * the day zellij drops a key there is one place to say so.
 */
export const ZELLIJ_UNSENDABLE_KEYS: readonly MuxNamedKey[] = [];

// A compile-time tie to the contract's alphabet, exactly as the other two tables keep one: a named
// key renamed in ../keys.ts stops being assignable here rather than quietly dropping out.
const _EVERY_UNSENDABLE_IS_A_NAMED_KEY: readonly (typeof MUX_NAMED_KEYS)[number][] = ZELLIJ_UNSENDABLE_KEYS;
void _EVERY_UNSENDABLE_IS_A_NAMED_KEY;

/**
 * One neutral chord in zellij's spelling.
 *
 * A single literal character is passed through as itself (`a`, `A`, `1`, `;`, `+`) — all probed, and
 * all typed as themselves. No escaping is needed anywhere: the argv is an array and `--` ends
 * zellij's flag parsing (protocol.ts `sendKeysArgs`), so a key that IS a dash is a key.
 */
export function toZellijKey(spelling: string): ZellijKeyResult {
  const parsed = parseMuxKey(spelling);
  if (parsed === null) return { ok: false, reason: "unparsed" };
  if (parsed.modifiers.includes("meta")) return { ok: false, reason: "meta" };
  const parts: string[] = [];
  for (const modifier of parsed.modifiers) {
    // `meta` is already refused above, so every survivor is a key of ZELLIJ_MODIFIERS.
    if (modifier === "ctrl") parts.push(ZELLIJ_MODIFIERS.ctrl);
    if (modifier === "alt") parts.push(ZELLIJ_MODIFIERS.alt);
    if (modifier === "shift") parts.push(ZELLIJ_MODIFIERS.shift);
  }
  parts.push(namedKey(parsed.key) ?? parsed.key);
  return { ok: true, key: parts.join(CHORD_SEPARATOR) };
}

// Keyed on the contract's spelling. A Map rather than a lookup on the object literal, so a key
// arriving from an operator's `keys.toml` row can never resolve through Object.prototype — the same
// reason the mux registry uses `Object.hasOwn` (../registry.ts).
const NAMED_BY_CONTRACT_SPELLING = new Map<string, string>(Object.entries(ZELLIJ_NAMED_KEYS));

/** zellij's spelling of a contract named key, or null when `key` is a literal character. */
function namedKey(key: string): string | null {
  return NAMED_BY_CONTRACT_SPELLING.get(key) ?? null;
}
