// Neutral key spelling → tmux's `send-keys` grammar.
//
// A REAL translation table, unlike Herdr's, and the reason the contract owns the neutral spelling at
// all (../keys.ts says so in its header). tmux spells a chord `C-c`, a shifted Tab `BTab` and a page
// key `PPage`; none of that is guessable from the neutral spelling of the same three chords, and
// the neutral spelling is deliberately absent from this file as a STRING — it exists here only as the
// parsed {@link MuxKey} structure, so no translation can ever be a match on somebody else's grammar.
//
// THE TABLE IS CLOSED, AND THAT IS A SAFETY PROPERTY, NOT TIDINESS. Probed on tmux 3.6b: a key name
// tmux does not recognise is **typed as literal text** — `send-keys -t %6 Nonsense` put the word
// "Nonsense" in the shell's input line, exit code 0. So a pass-through translation would silently
// convert a typo in an operator's `keys.toml` row into eight characters typed at a live agent. Every
// spelling below is one tmux answered to in the probe; anything outside the table is `refused`
// before a process is spawned.
//
// WHAT TMUX CAN SEND THAT HERDR CANNOT. The paging and edit block — `PageUp`, `PageDown`, `Home`,
// `End`, `Insert`, `Delete` — are all real tmux keys (`PPage`, `NPage`, `Home`, `End`, `IC`, `DC`),
// so tmux's `unsupportedKeys` is EMPTY where Herdr's has six entries. That asymmetry is the whole
// argument for the contract's alphabet being closed and complete rather than Herdr's (../keys.ts).
//
// WHAT TMUX HAS NO WORD FOR is the `meta` modifier. tmux's `M-` is Alt, which the contract already
// spells `alt`; there is no second modifier to map `meta` onto, and mapping it onto `M-` would send
// Alt where the operator asked for Super/Command. A `meta` chord is therefore `refused` at send time
// with a reason that says so. It is not an `unsupportedKeys` entry because that list holds KEYS —
// enumerating every `meta+<anything>` chord is not a list, and the Keys tray greys buttons off it.

import { MUX_NAMED_KEYS, parseMuxKey, type MuxModifier, type MuxNamedKey } from "../keys.ts";

/**
 * Every named key in the contract's alphabet, in tmux's spelling.
 *
 * Total over {@link MUX_NAMED_KEYS} by construction — the `satisfies` below is what makes a key added
 * to the contract fail this build until someone decides what tmux calls it, rather than falling
 * through to the literal-text path the header warns about.
 */
const TMUX_NAMED_KEYS = {
  Up: "Up",
  Down: "Down",
  Left: "Left",
  Right: "Right",
  Tab: "Tab",
  Enter: "Enter",
  Escape: "Escape",
  Space: "Space",
  Backspace: "BSpace",
  Delete: "DC",
  Insert: "IC",
  Home: "Home",
  End: "End",
  PageUp: "PPage",
  PageDown: "NPage",
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

/** The modifier prefixes tmux understands. `meta` is absent because tmux has no such key — header. */
const TMUX_MODIFIERS = {
  ctrl: "C-",
  alt: "M-",
  shift: "S-",
} satisfies Partial<Record<MuxModifier, string>>;

/**
 * tmux's own name for a shifted Tab.
 *
 * `S-Tab` is accepted by `send-keys` too, but `BTab` is the name tmux prints and binds, and it is the
 * one that reaches a terminal as the back-tab sequence agents actually read (the shifted Tab is
 * Claude's mode cycle — HERDR_API.md notes the same key is the awkward one on the Herdr side).
 */
const BACK_TAB = "BTab";

/** Why a chord never reached tmux, in the words the refusal detail prints. */
export type TmuxKeyRejection = "unparsed" | "meta";

/** A translated chord, or the reason tmux will not be asked for it. */
export type TmuxKeyResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: TmuxKeyRejection };

/**
 * tmux sends no key at all for these — the empty list, and it is a real answer rather than a stub.
 *
 * Every named key in the contract's alphabet has a tmux spelling above, so the Keys tray greys
 * nothing on tmux. Kept as an exported constant so the declaration in adapter.ts reads the same way
 * Herdr's does, and so the day tmux drops a key there is one place to say so.
 */
export const TMUX_UNSENDABLE_KEYS: readonly MuxNamedKey[] = [];

// A compile-time tie to the contract's alphabet, exactly as the Herdr table keeps one: a named key
// renamed in ../keys.ts stops being assignable here rather than quietly dropping out.
const _EVERY_UNSENDABLE_IS_A_NAMED_KEY: readonly (typeof MUX_NAMED_KEYS)[number][] = TMUX_UNSENDABLE_KEYS;
void _EVERY_UNSENDABLE_IS_A_NAMED_KEY;

/**
 * One neutral chord in tmux's spelling.
 *
 * A single literal character is passed through as itself (`a`, `A`, `1`), which is what `send-keys`
 * types — with one exception: a lone `;` is swallowed by tmux's argument lexer as a command
 * separator (probed: nothing was typed, exit code 0), and `\;` is how tmux is told it is a key. That
 * escape is applied to the KEY here rather than at the call site, so no caller has to remember it.
 */
export function toTmuxKey(spelling: string): TmuxKeyResult {
  const parsed = parseMuxKey(spelling);
  if (parsed === null) return { ok: false, reason: "unparsed" };
  if (parsed.modifiers.includes("meta")) return { ok: false, reason: "meta" };
  const prefixes: string[] = [];
  for (const modifier of parsed.modifiers) {
    // `meta` is already refused above, so every survivor is a key of TMUX_MODIFIERS.
    if (modifier === "ctrl") prefixes.push(TMUX_MODIFIERS.ctrl);
    if (modifier === "alt") prefixes.push(TMUX_MODIFIERS.alt);
    if (modifier === "shift") prefixes.push(TMUX_MODIFIERS.shift);
  }
  const named = namedKey(parsed.key);
  if (named === null) {
    // A literal character. `[...key].length === 1` is what parseMuxKey guarantees for anything that
    // is not a named key, so this branch is exactly one grapheme.
    return { ok: true, key: prefixes.join("") + escapeKey(parsed.key) };
  }
  // A shifted Tab is `BTab`, whole — tmux's back-tab is a key of its own, not a modified Tab.
  if (named === "Tab" && parsed.modifiers.length === 1 && parsed.modifiers[0] === "shift") {
    return { ok: true, key: BACK_TAB };
  }
  return { ok: true, key: prefixes.join("") + named };
}

// Keyed on the contract's spelling. A Map rather than a lookup on the object literal, so a key
// arriving from an operator's `keys.toml` row can never resolve through Object.prototype — the same
// reason the mux registry uses `Object.hasOwn` (registry.ts).
const NAMED_BY_CONTRACT_SPELLING = new Map<string, string>(Object.entries(TMUX_NAMED_KEYS));

/** tmux's spelling of a contract named key, or null when `key` is a literal character. */
function namedKey(key: string): string | null {
  return NAMED_BY_CONTRACT_SPELLING.get(key) ?? null;
}

/** The one character tmux's argument lexer would eat if it stood alone. */
function escapeKey(key: string): string {
  return key === ";" ? "\\;" : key;
}
